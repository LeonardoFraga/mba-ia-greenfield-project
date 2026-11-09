import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  UnsupportedMediaTypeException,
  UploadNotInProgressException,
  UploadSizeExceededException,
  UploadSizeMismatchException,
  VideoNotOwnedException,
} from '../common/exceptions/domain.exception';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import { VideoProcessingQueue } from '../queue/video-processing.queue';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/** Exercises the DB contract and the real multipart handshake in MinIO. */
describe('VideosService (integration — real DB + MinIO)', () => {
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let processingQueue: VideoProcessingQueue;

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

    service = module.get(VideosService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    processingQueue = module.get(VideoProcessingQueue);
  }, 60000);

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await processingQueue.queue.obliterate({ force: true });
  });

  let counter = 0;
  async function createUserWithChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const suffix = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `vsvc_${suffix}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Canal ${suffix}`,
        nickname: `vsvc_chan_${suffix}`,
        user_id: user.id,
      }),
    );
    return { user, channel };
  }

  const dto = { title: 'Meu vídeo', size: 4096, contentType: 'video/mp4' };

  it('should persist the draft and open a real multipart upload', async () => {
    const { user, channel } = await createUserWithChannel();

    const result = await service.initiateUpload(user.id, dto);

    expect(result.status).toBe(VideoStatus.UPLOADING);
    expect(result.uploadId).toBeTruthy();

    const row = await videoRepository.findOneByOrFail({ id: result.id });
    expect(row.channel_id).toBe(channel.id);
    expect(row.status).toBe(VideoStatus.UPLOADING);
    expect(row.upload_id).toBe(result.uploadId);
    expect(row.storage_key).toBe(`${result.id}/source`);
    expect(row.declared_size_bytes).toBe(String(dto.size));
    expect(row.declared_content_type).toBe(dto.contentType);

    // The upload genuinely exists in storage: listing its parts succeeds.
    await expect(
      storage.countUploadedParts(row.storage_key as string, result.uploadId),
    ).resolves.toBe(0);

    await service.abortUpload(user.id, result.id);
  }, 60000);

  it('should reject an over-ceiling size without touching the database', async () => {
    const { user } = await createUserWithChannel();

    await expect(
      service.initiateUpload(user.id, { ...dto, size: 10 * 1024 ** 3 + 1 }),
    ).rejects.toBeInstanceOf(UploadSizeExceededException);

    await expect(videoRepository.count()).resolves.toBe(0);
  }, 30000);

  it('should reject a disallowed container without touching the database', async () => {
    const { user } = await createUserWithChannel();

    await expect(
      service.initiateUpload(user.id, {
        ...dto,
        contentType: 'application/zip',
      }),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);

    await expect(videoRepository.count()).resolves.toBe(0);
  }, 30000);

  it('should reject a user without a channel', async () => {
    const orphan = await userRepository.save(
      userRepository.create({
        email: `no_channel_${++counter}@example.com`,
        password: 'hashed',
      }),
    );

    await expect(service.initiateUpload(orphan.id, dto)).rejects.toBeInstanceOf(
      ChannelNotFoundException,
    );

    await expect(videoRepository.count()).resolves.toBe(0);
  }, 30000);

  it('should allocate distinct public ids across videos', async () => {
    const { user } = await createUserWithChannel();

    const first = await service.initiateUpload(user.id, dto);
    const second = await service.initiateUpload(user.id, dto);

    expect(first.publicId).not.toBe(second.publicId);

    await service.abortUpload(user.id, first.id);
    await service.abortUpload(user.id, second.id);
  }, 60000);

  it('should sign part URLs that storage actually accepts', async () => {
    const { user } = await createUserWithChannel();
    const result = await service.initiateUpload(user.id, dto);

    const [part] = await service.signParts(user.id, result.id, {
      partNumbers: [1],
    });

    // 5MB is the S3 floor for a non-final part; a single part may be smaller.
    const response = await fetch(part.url, {
      method: 'PUT',
      body: new Uint8Array(Buffer.alloc(dto.size, 'x')),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBeTruthy();

    await expect(
      storage.countUploadedParts(`${result.id}/source`, result.uploadId),
    ).resolves.toBe(1);

    await service.abortUpload(user.id, result.id);
  }, 60000);

  it('should refuse to sign parts for a video owned by someone else', async () => {
    const owner = await createUserWithChannel();
    const other = await createUserWithChannel();
    const result = await service.initiateUpload(owner.user.id, dto);

    await expect(
      service.signParts(other.user.id, result.id, { partNumbers: [1] }),
    ).rejects.toBeInstanceOf(VideoNotOwnedException);

    await service.abortUpload(owner.user.id, result.id);
  }, 60000);

  it('should refuse to sign parts once the upload is no longer in progress', async () => {
    const { user } = await createUserWithChannel();
    const result = await service.initiateUpload(user.id, dto);

    await videoRepository.update(
      { id: result.id },
      { status: VideoStatus.PROCESSING },
    );

    await expect(
      service.signParts(user.id, result.id, { partNumbers: [1] }),
    ).rejects.toBeInstanceOf(UploadNotInProgressException);

    await videoRepository.update(
      { id: result.id },
      { status: VideoStatus.UPLOADING },
    );
    await service.abortUpload(user.id, result.id);
  }, 60000);

  it('should remove the row and the storage upload on abort', async () => {
    const { user } = await createUserWithChannel();
    const result = await service.initiateUpload(user.id, dto);
    const storageKey = `${result.id}/source`;

    await service.abortUpload(user.id, result.id);

    await expect(videoRepository.countBy({ id: result.id })).resolves.toBe(0);
    // The upload no longer exists, so listing its parts fails outright.
    await expect(
      storage.countUploadedParts(storageKey, result.uploadId),
    ).rejects.toThrow();
  }, 60000);

  it('should refuse to abort a video owned by someone else', async () => {
    const owner = await createUserWithChannel();
    const other = await createUserWithChannel();
    const result = await service.initiateUpload(owner.user.id, dto);

    await expect(
      service.abortUpload(other.user.id, result.id),
    ).rejects.toBeInstanceOf(VideoNotOwnedException);

    await expect(videoRepository.countBy({ id: result.id })).resolves.toBe(1);

    await service.abortUpload(owner.user.id, result.id);
  }, 60000);
  /** Uploads the whole object as one part and returns the ETag. */
  async function uploadSinglePart(
    videoId: string,
    uploadId: string,
    userId: string,
    bytes: number,
  ): Promise<{ partNumber: number; etag: string }> {
    const [part] = await service.signParts(userId, videoId, {
      partNumbers: [1],
    });
    const response = await fetch(part.url, {
      method: 'PUT',
      body: new Uint8Array(Buffer.alloc(bytes, 'z')),
    });
    expect(response.status).toBe(200);
    return { partNumber: 1, etag: response.headers.get('etag') as string };
  }

  it('should complete the upload, persist the real size and enqueue the job', async () => {
    const { user } = await createUserWithChannel();
    const started = await service.initiateUpload(user.id, dto);
    const part = await uploadSinglePart(
      started.id,
      started.uploadId,
      user.id,
      dto.size,
    );

    const result = await service.completeUpload(user.id, started.id, {
      parts: [part],
    });

    expect(result.status).toBe(VideoStatus.PROCESSING);

    const row = await videoRepository.findOneByOrFail({ id: started.id });
    expect(row.status).toBe(VideoStatus.PROCESSING);
    expect(row.size_bytes).toBe(String(dto.size));
    expect(row.upload_id).toBeNull();

    // The object really is assembled in storage.
    await expect(
      storage.headObject(row.storage_key as string),
    ).resolves.toMatchObject({ contentLength: dto.size });

    // And the job really reached the broker.
    const waiting = await processingQueue.queue.getJobs(['waiting']);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].data).toEqual({
      videoId: started.id,
      storageKey: row.storage_key,
    });

    await storage.deleteObject(row.storage_key as string);
  }, 60000);

  it('should fail the row and delete the object when fewer bytes arrive than declared', async () => {
    const { user } = await createUserWithChannel();
    // Declare twice what will actually be uploaded.
    const started = await service.initiateUpload(user.id, {
      ...dto,
      size: dto.size * 2,
    });
    const part = await uploadSinglePart(
      started.id,
      started.uploadId,
      user.id,
      dto.size,
    );

    await expect(
      service.completeUpload(user.id, started.id, { parts: [part] }),
    ).rejects.toBeInstanceOf(UploadSizeMismatchException);

    const row = await videoRepository.findOneByOrFail({ id: started.id });
    expect(row.status).toBe(VideoStatus.FAILED);
    expect(row.processing_error).toContain(String(dto.size));
    expect(row.upload_id).toBeNull();

    // The over/under-sized object is gone, not left behind as dead storage.
    await expect(
      storage.headObject(row.storage_key as string),
    ).rejects.toThrow();

    // And nothing was enqueued for a video that will never be processable.
    await expect(
      processingQueue.queue.getJobs(['waiting']),
    ).resolves.toHaveLength(0);
  }, 60000);

  it('should refuse to complete twice', async () => {
    const { user } = await createUserWithChannel();
    const started = await service.initiateUpload(user.id, dto);
    const part = await uploadSinglePart(
      started.id,
      started.uploadId,
      user.id,
      dto.size,
    );
    await service.completeUpload(user.id, started.id, { parts: [part] });

    await expect(
      service.completeUpload(user.id, started.id, { parts: [part] }),
    ).rejects.toBeInstanceOf(UploadNotInProgressException);

    const row = await videoRepository.findOneByOrFail({ id: started.id });
    await storage.deleteObject(row.storage_key as string);
  }, 60000);
  describe('public delivery', () => {
    /** Seeds a ready video with a real object behind it. */
    async function seedReady(): Promise<{ publicId: string; key: string }> {
      const { channel } = await createUserWithChannel();
      const key = `${channel.id}/ready-${++counter}/source`;
      await storage.putObject(
        key,
        Buffer.alloc(2048, 'r'),
        'video/mp4',
        'videos',
      );
      const publicId = `rdy${String(counter).padStart(8, '0')}`;
      await videoRepository.save(
        videoRepository.create({
          channel_id: channel.id,
          title: 'Pronto',
          public_id: publicId,
          status: VideoStatus.READY,
          storage_key: key,
          declared_content_type: 'video/mp4',
          size_bytes: '2048',
        }),
      );
      return { publicId, key };
    }

    it('should issue a stream URL that answers a Range with 206', async () => {
      const { publicId, key } = await seedReady();

      const { url, expiresIn } = await service.streamUrl(publicId);
      expect(expiresIn).toBeGreaterThan(0);

      const partial = await fetch(url, { headers: { Range: 'bytes=0-99' } });
      expect(partial.status).toBe(206);
      expect(partial.headers.get('content-range')).toBe('bytes 0-99/2048');

      await storage.deleteObject(key);
    }, 60000);

    it('should issue a download URL that storage serves as an attachment', async () => {
      const { publicId, key } = await seedReady();

      const { url } = await service.downloadUrl(publicId);
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain(
        'attachment',
      );

      await storage.deleteObject(key);
    }, 60000);
  });
});
