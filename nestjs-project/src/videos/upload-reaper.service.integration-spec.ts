import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { UploadReaperService } from './upload-reaper.service';
import { VideosModule } from './videos.module';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/**
 * Proves the reaper against the real multipart it has to clean up: a row alone
 * says nothing about whether the parts in storage actually went away.
 */
describe('UploadReaperService (integration — real DB + MinIO)', () => {
  let module: TestingModule;
  let reaper: UploadReaperService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let cutoffHours: number;
  let counter = 0;

  async function createChannel(): Promise<Channel> {
    const suffix = ++counter;
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `reaper_${suffix}@example.com`,
        password: 'hashed',
      }),
    );
    return dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: `Canal ${suffix}`,
        nickname: `reaper_chan_${suffix}`,
        user_id: user.id,
      }),
    );
  }

  /**
   * Seeds a video and, for `uploading` rows, opens a real multipart with one
   * part already stored.
   *
   * `updated_at` is forced with raw SQL on purpose: it is an
   * `@UpdateDateColumn`, so any repository write would stamp it back to now
   * and the row would never look abandoned.
   */
  async function seedVideo(
    status: VideoStatus,
    ageHours: number,
  ): Promise<Video> {
    const channel = await createChannel();
    const suffix = ++counter;

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Abandonado',
        public_id: `rpr${String(suffix).padStart(8, '0')}`,
        status,
      }),
    );

    if (status === VideoStatus.UPLOADING) {
      const storageKey = `${video.id}/source`;
      const uploadId = await storage.createMultipartUpload(
        storageKey,
        'video/mp4',
      );
      const part = await storage.signUploadPart(storageKey, uploadId, 1);
      const response = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(Buffer.alloc(1024, 'a')),
      });
      expect(response.status).toBe(200);

      await videoRepository.update(
        { id: video.id },
        { storage_key: storageKey, upload_id: uploadId },
      );
      Object.assign(video, { storage_key: storageKey, upload_id: uploadId });
    }

    await dataSource.query(
      `UPDATE videos SET updated_at = now() - ($1 || ' hours')::interval WHERE id = $2`,
      [String(ageHours), video.id],
    );

    return video;
  }

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    reaper = module.get(UploadReaperService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    cutoffHours = module.get<{ abandonedUploadCutoffHours: number }>(
      storageConfig.KEY,
    ).abandonedUploadCutoffHours;
  }, 60000);

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  it('should remove an abandoned upload and abort its multipart in the bucket', async () => {
    const video = await seedVideo(VideoStatus.UPLOADING, cutoffHours + 1);

    // The part really is in storage before the sweep.
    await expect(
      storage.countUploadedParts(
        video.storage_key as string,
        video.upload_id as string,
      ),
    ).resolves.toBe(1);

    const result = await reaper.reapAbandonedUploads();

    expect(result).toEqual({ reaped: 1, abortFailures: 0 });
    expect(await videoRepository.findOneBy({ id: video.id })).toBeNull();

    // After the abort the upload no longer exists, so listing its parts is an
    // error rather than an empty list — the strongest available evidence that
    // the bytes are gone.
    await expect(
      storage.countUploadedParts(
        video.storage_key as string,
        video.upload_id as string,
      ),
    ).rejects.toThrow();
  }, 60000);

  it('should leave an upload that is still within the cutoff untouched', async () => {
    const video = await seedVideo(VideoStatus.UPLOADING, cutoffHours - 1);

    const result = await reaper.reapAbandonedUploads();

    expect(result).toEqual({ reaped: 0, abortFailures: 0 });
    const survivor = await videoRepository.findOneByOrFail({ id: video.id });
    expect(survivor.status).toBe(VideoStatus.UPLOADING);
    await expect(
      storage.countUploadedParts(
        video.storage_key as string,
        video.upload_id as string,
      ),
    ).resolves.toBe(1);

    await storage.abortMultipartUpload(
      video.storage_key as string,
      video.upload_id as string,
    );
  }, 60000);

  it.each([
    VideoStatus.DRAFT,
    VideoStatus.PROCESSING,
    VideoStatus.READY,
    VideoStatus.FAILED,
  ])(
    'should never touch a %s video, however old',
    async (status) => {
      const video = await seedVideo(status, cutoffHours * 10);

      const result = await reaper.reapAbandonedUploads();

      expect(result.reaped).toBe(0);
      await expect(
        videoRepository.findOneByOrFail({ id: video.id }),
      ).resolves.toMatchObject({ status });
    },
    60000,
  );

  it('should reap several abandoned uploads in one sweep and keep the recent one', async () => {
    const old1 = await seedVideo(VideoStatus.UPLOADING, cutoffHours + 2);
    const old2 = await seedVideo(VideoStatus.UPLOADING, cutoffHours + 48);
    const recent = await seedVideo(VideoStatus.UPLOADING, 1);

    const result = await reaper.reapAbandonedUploads();

    expect(result.reaped).toBe(2);
    expect(await videoRepository.findOneBy({ id: old1.id })).toBeNull();
    expect(await videoRepository.findOneBy({ id: old2.id })).toBeNull();
    expect(await videoRepository.findOneBy({ id: recent.id })).not.toBeNull();

    await storage.abortMultipartUpload(
      recent.storage_key as string,
      recent.upload_id as string,
    );
  }, 90000);
});
