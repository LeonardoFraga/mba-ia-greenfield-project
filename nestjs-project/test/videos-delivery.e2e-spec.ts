import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { registerConfirmAndLogin } from '../src/test/auth-e2e.helper';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { bodyOf, errorOf } from '../src/test/response-body';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

/**
 * Authored from `nestjs-project/specs/videos-delivery.plan.md`.
 *
 * The three public routes authorize on the video's **state**, never on the
 * caller's identity, so most cases here are deliberately anonymous.
 */

interface PublicVideoBody {
  publicId: string;
  title: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  createdAt: string;
}

interface SignedUrlBody {
  url: string;
  expiresIn: number;
}

const OBJECT_SIZE = 4096;

describe('Videos delivery (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;

  let counter = 0;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    channelRepository = dataSource.getRepository(Channel);
    storage = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 120000);

  afterAll(async () => {
    for (const key of createdKeys) {
      await storage.deleteObject(key).catch(() => undefined);
    }
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  const server = () => app.getHttpServer();

  /** Registers a user so a channel exists, then seeds a video on it. */
  async function seedVideo(
    status: VideoStatus,
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const suffix = ++counter;
    await registerConfirmAndLogin(app, `del_e2e_${suffix}@example.com`);
    const channel = await channelRepository.findOneByOrFail({
      nickname: `del_e2e_${suffix}`,
    });

    const storageKey = `${channel.id}/seed-${suffix}/source`;
    if (status === VideoStatus.READY) {
      await storage.putObject(
        storageKey,
        Buffer.alloc(OBJECT_SIZE, 'v'),
        'video/mp4',
        'videos',
      );
      createdKeys.push(storageKey);
    }

    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Vídeo semeado',
        public_id: `seed${String(suffix).padStart(7, '0')}`,
        status,
        storage_key: storageKey,
        declared_content_type: 'video/mp4',
        size_bytes: String(OBJECT_SIZE),
        duration_seconds: '12.480',
        width: 1920,
        height: 1080,
        ...overrides,
      }),
    );
  }

  describe('GET /videos/:publicId — metadata', () => {
    it('returns metadata for a ready video without a token', async () => {
      const video = await seedVideo(VideoStatus.READY, {
        thumbnail_key: 'seed/thumb.jpg',
      });

      const res = await request(server())
        .get(`/videos/${video.public_id}`)
        .expect(200);

      const body = bodyOf<PublicVideoBody>(res);
      expect(body.publicId).toBe(video.public_id);
      expect(body.durationSeconds).toBe(12.48);
      expect(body.width).toBe(1920);
      expect(body.thumbnailUrl).toContain('seed/thumb.jpg');

      // Storage internals must not reach an anonymous caller.
      expect(res.body).not.toHaveProperty('storage_key');
      expect(res.body).not.toHaveProperty('channel_id');
      expect(res.body).not.toHaveProperty('processing_error');
    });

    it.each([
      VideoStatus.DRAFT,
      VideoStatus.UPLOADING,
      VideoStatus.PROCESSING,
      VideoStatus.FAILED,
    ])('hides a video whose status is %s', async (status) => {
      const video = await seedVideo(status);

      const res = await request(server())
        .get(`/videos/${video.public_id}`)
        .expect(404);

      expect(errorOf(res)).toBe('VIDEO_NOT_FOUND');
    });

    it('answers identically for a publicId that never existed', async () => {
      const hidden = await seedVideo(VideoStatus.DRAFT);

      const onDraft = await request(server())
        .get(`/videos/${hidden.public_id}`)
        .expect(404);
      const onMissing = await request(server())
        .get('/videos/neverexisted')
        .expect(404);

      // Byte-identical: the existence of a draft must not leak.
      expect(onDraft.body).toEqual(onMissing.body);
    });

    it('returns the same body to an authenticated non-owner', async () => {
      const video = await seedVideo(VideoStatus.READY);
      const otherToken = await registerConfirmAndLogin(
        app,
        `del_other_${++counter}@example.com`,
      );

      const anonymous = await request(server())
        .get(`/videos/${video.public_id}`)
        .expect(200);
      const authenticated = await request(server())
        .get(`/videos/${video.public_id}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(200);

      expect(authenticated.body).toEqual(anonymous.body);
    });
  });

  describe('GET /videos/:publicId/stream', () => {
    it('issues a short-lived presigned URL without a token', async () => {
      const video = await seedVideo(VideoStatus.READY);

      const res = await request(server())
        .get(`/videos/${video.public_id}/stream`)
        .expect(200);

      const body = bodyOf<SignedUrlBody>(res);
      expect(body.url).toMatch(/^https?:\/\//);
      expect(body.url).toContain('X-Amz-Signature=');
      expect(body.url).not.toContain(':3000');
      // Minutes, not hours.
      expect(body.expiresIn).toBeGreaterThan(0);
      expect(body.expiresIn).toBeLessThanOrEqual(3600);
    });

    it('serves byte ranges on the issued URL', async () => {
      const video = await seedVideo(VideoStatus.READY);
      const res = await request(server())
        .get(`/videos/${video.public_id}/stream`)
        .expect(200);
      const { url } = bodyOf<SignedUrlBody>(res);

      const partial = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
      expect(partial.status).toBe(206);
      expect(partial.headers.get('content-range')).toBe(
        `bytes 0-1023/${OBJECT_SIZE}`,
      );
      expect(Buffer.from(await partial.arrayBuffer())).toHaveLength(1024);

      const whole = await fetch(url);
      expect(whole.status).toBe(200);
      expect(Buffer.from(await whole.arrayBuffer())).toHaveLength(OBJECT_SIZE);
    });

    it('refuses to sign for a video that is not ready', async () => {
      const video = await seedVideo(VideoStatus.PROCESSING);

      const res = await request(server())
        .get(`/videos/${video.public_id}/stream`)
        .expect(404);

      expect(errorOf(res)).toBe('VIDEO_NOT_FOUND');
      expect(res.body).not.toHaveProperty('url');
    });
  });

  describe('GET /videos/:publicId/download', () => {
    it('issues a URL carrying an attachment disposition', async () => {
      const video = await seedVideo(VideoStatus.READY);

      const res = await request(server())
        .get(`/videos/${video.public_id}/download`)
        .expect(200);

      const { url } = bodyOf<SignedUrlBody>(res);
      expect(decodeURIComponent(url)).toContain('attachment');
    });

    it('delivers the whole object with a Content-Disposition header', async () => {
      const video = await seedVideo(VideoStatus.READY);
      const res = await request(server())
        .get(`/videos/${video.public_id}/download`)
        .expect(200);
      const { url } = bodyOf<SignedUrlBody>(res);

      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain(
        'attachment',
      );
      expect(Buffer.from(await response.arrayBuffer())).toHaveLength(
        OBJECT_SIZE,
      );
    });

    it('refuses to sign for a failed video', async () => {
      const video = await seedVideo(VideoStatus.FAILED);

      const res = await request(server())
        .get(`/videos/${video.public_id}/download`)
        .expect(404);

      expect(errorOf(res)).toBe('VIDEO_NOT_FOUND');
      expect(res.body).not.toHaveProperty('url');
    });
  });
});
