import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { VideoProcessingQueue } from '../src/queue/video-processing.queue';
import { StorageService } from '../src/storage/storage.service';
import { registerConfirmAndLogin } from '../src/test/auth-e2e.helper';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { bodyOf, errorOf } from '../src/test/response-body';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

/**
 * Authored from `nestjs-project/specs/videos-upload.plan.md`.
 *
 * Exercises the full handshake over HTTP against the real MinIO and Redis
 * containers — the parts are genuinely PUT to presigned URLs, so the ETags in
 * the complete call are real.
 */

interface InitiateBody {
  id: string;
  publicId: string;
  uploadId: string;
  partSize: number;
  partCount: number;
  status: string;
}

interface SignPartsBody {
  parts: { partNumber: number; url: string; expiresIn: number }[];
}

interface CompleteBody {
  id: string;
  publicId: string;
  status: string;
}

const TEN_GB = 10 * 1024 * 1024 * 1024;
const BODY_SIZE = 4096;
/** S3 floor for every part but the last. */
const MIN_PART_SIZE = 5 * 1024 * 1024;

describe('Videos upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let processingQueue: VideoProcessingQueue;
  let throttlerStorage: ThrottlerStorageService;

  let emailCounter = 0;
  const nextEmail = () => `vid_e2e_${++emailCounter}@example.com`;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // `Test.createTestingModule` does not run main.ts, so the global pipe and
    // filters have to be reproduced explicitly.
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
    storage = moduleFixture.get(StorageService);
    processingQueue = moduleFixture.get(VideoProcessingQueue);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 120000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await processingQueue.queue.obliterate({ force: true });
    // Registration is rate-limited; without this, later describes see 429s
    // leaked from earlier ones.
    throttlerStorage.storage.clear();
  });

  const server = () => app.getHttpServer();

  function initiate(token: string, overrides: Record<string, unknown> = {}) {
    return request(server())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Meu vídeo',
        size: BODY_SIZE,
        contentType: 'video/mp4',
        ...overrides,
      });
  }

  /** PUTs the whole body as part 1 and returns its real ETag. */
  async function putSinglePart(
    token: string,
    videoId: string,
    bytes = BODY_SIZE,
  ): Promise<{ partNumber: number; etag: string }> {
    const signed = await request(server())
      .post(`/videos/${videoId}/parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumbers: [1] })
      .expect(200);

    const { url } = bodyOf<SignPartsBody>(signed).parts[0];
    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(Buffer.alloc(bytes, 'z')),
    });
    expect(response.status).toBe(200);

    return { partNumber: 1, etag: response.headers.get('etag') as string };
  }

  /**
   * Uploads a genuinely multi-part object and returns both parts' real ETags.
   *
   * The first part is 5MiB because S3 requires every part but the last to be at
   * least that — the constraint that only shows up once an upload has more than
   * one part, which is exactly the path a 10GB file takes.
   */
  async function putTwoParts(
    token: string,
    videoId: string,
  ): Promise<{ parts: { partNumber: number; etag: string }[]; total: number }> {
    const sizes = [MIN_PART_SIZE, 4096];

    const signed = await request(server())
      .post(`/videos/${videoId}/parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumbers: [1, 2] })
      .expect(200);

    const urls = bodyOf<SignPartsBody>(signed).parts;
    expect(urls).toHaveLength(2);

    const parts: { partNumber: number; etag: string }[] = [];
    for (const [index, { partNumber, url }] of urls.entries()) {
      const response = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(Buffer.alloc(sizes[index], 'p')),
      });
      expect(response.status).toBe(200);
      parts.push({
        partNumber,
        etag: response.headers.get('etag') as string,
      });
    }

    return { parts, total: sizes[0] + sizes[1] };
  }

  describe('POST /videos — initiate', () => {
    it('rejects an anonymous caller', async () => {
      await request(server())
        .post('/videos')
        .send({ title: 'x', size: BODY_SIZE, contentType: 'video/mp4' })
        .expect(401);

      await expect(videoRepository.count()).resolves.toBe(0);
    });

    it('creates the draft and opens the multipart upload', async () => {
      const token = await registerConfirmAndLogin(app, nextEmail());

      const res = await initiate(token).expect(201);
      const body = bodyOf<InitiateBody>(res);

      expect(body.publicId).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(body.uploadId).toBeTruthy();
      expect(body.status).toBe(VideoStatus.UPLOADING);
      expect(body.partCount).toBe(Math.ceil(BODY_SIZE / body.partSize));

      const row = await videoRepository.findOneByOrFail({ id: body.id });
      expect(row.status).toBe(VideoStatus.UPLOADING);
      expect(row.upload_id).toBe(body.uploadId);
      expect(row.declared_size_bytes).toBe(String(BODY_SIZE));

      await request(server())
        .delete(`/videos/${body.id}`)
        .set('Authorization', `Bearer ${token}`);
    });

    it('rejects a size above the 10GB ceiling', async () => {
      const token = await registerConfirmAndLogin(app, nextEmail());

      const res = await initiate(token, { size: TEN_GB + 1 }).expect(413);

      expect(errorOf(res)).toBe('UPLOAD_SIZE_EXCEEDED');
      // Nothing is created: the ceiling is checked before the draft exists.
      await expect(videoRepository.count()).resolves.toBe(0);
    });

    it('rejects a content type outside the allowlist', async () => {
      const token = await registerConfirmAndLogin(app, nextEmail());

      const res = await initiate(token, {
        contentType: 'application/zip',
      }).expect(415);

      expect(errorOf(res)).toBe('UNSUPPORTED_MEDIA_TYPE');
      await expect(videoRepository.count()).resolves.toBe(0);
    });

    it('rejects a body that fails schema validation', async () => {
      const token = await registerConfirmAndLogin(app, nextEmail());

      await request(server())
        .post('/videos')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: '', size: 0, contentType: '' })
        .expect(400);
    });
  });

  describe('POST /videos/:id/parts — sign', () => {
    it('signs the requested part URLs', async () => {
      const token = await registerConfirmAndLogin(app, nextEmail());
      const { id } = bodyOf<InitiateBody>(await initiate(token).expect(201));

      const res = await request(server())
        .post(`/videos/${id}/parts`)
        .set('Authorization', `Bearer ${token}`)
        .send({ partNumbers: [1, 2] })
        .expect(200);

      const { parts } = bodyOf<SignPartsBody>(res);
      expect(parts.map((p) => p.partNumber)).toEqual([1, 2]);
      for (const part of parts) {
        // A presigned, direct-to-storage URL: absolute, SigV4-signed, and
        // addressing the part by number. (It legitimately contains "/videos/"
        // — that is the bucket name under path-style addressing.)
        expect(part.url).toMatch(/^https?:\/\//);
        expect(part.url).toContain('X-Amz-Signature=');
        expect(part.url).toContain(`partNumber=${part.partNumber}`);
        expect(part.url).not.toContain(':3000');
        expect(part.expiresIn).toBeGreaterThan(0);
      }

      await request(server())
        .delete(`/videos/${id}`)
        .set('Authorization', `Bearer ${token}`);
    });

    it('denies a caller who does not own the video', async () => {
      const ownerToken = await registerConfirmAndLogin(app, nextEmail());
      const otherToken = await registerConfirmAndLogin(app, nextEmail());
      const { id } = bodyOf<InitiateBody>(
        await initiate(ownerToken).expect(201),
      );

      const res = await request(server())
        .post(`/videos/${id}/parts`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ partNumbers: [1] })
        .expect(403);

      expect(errorOf(res)).toBe('VIDEO_NOT_OWNED');

      await request(server())
        .delete(`/videos/${id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
    });

    it.each([[[0]], [[10001]], [[]]])(
      'rejects part numbers %j as invalid',
      async (partNumbers) => {
        const token = await registerConfirmAndLogin(app, nextEmail());
        const { id } = bodyOf<InitiateBody>(await initiate(token).expect(201));

        await request(server())
          .post(`/videos/${id}/parts`)
          .set('Authorization', `Bearer ${token}`)
          .send({ partNumbers })
          .expect(400);

        await request(server())
          .delete(`/videos/${id}`)
          .set('Authorization', `Bearer ${token}`);
      },
    );

    it('rejects a malformed video id before reaching the database', async () => {
      const token = await registerConfirmAndLogin(app, nextEmail());

      await request(server())
        .post('/videos/not-a-uuid/parts')
        .set('Authorization', `Bearer ${token}`)
        .send({ partNumbers: [1] })
        .expect(400);
    });
  });

  describe('POST /videos/:id/complete — complete', () => {
    it('completes the upload and enqueues processing', async () => {
      const token = await registerConfirmAndLogin(app, nextEmail());
      const { id } = bodyOf<InitiateBody>(await initiate(token).expect(201));
      const part = await putSinglePart(token, id);

      const res = await request(server())
        .post(`/videos/${id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [part] })
        .expect(200);

      expect(bodyOf<CompleteBody>(res).status).toBe(VideoStatus.PROCESSING);

      const row = await videoRepository.findOneByOrFail({ id });
      expect(row.status).toBe(VideoStatus.PROCESSING);
      expect(row.size_bytes).toBe(String(BODY_SIZE));

      const waiting = await processingQueue.queue.getJobs(['waiting']);
      expect(waiting).toHaveLength(1);
      expect(waiting[0].data.videoId).toBe(id);

      await storage.deleteObject(row.storage_key as string);
    });

    it('assembles a genuinely multi-part upload into one object', async () => {
      // The headline capability of the phase is a 10GB upload, which is only
      // possible because N parts are assembled into a single object. Every
      // other case here completes with one part, so this is the one that
      // actually exercises that path — including S3's 5MiB floor for
      // non-final parts.
      const token = await registerConfirmAndLogin(app, nextEmail());
      const { id } = bodyOf<InitiateBody>(
        await initiate(token, { size: MIN_PART_SIZE + 4096 }).expect(201),
      );

      const { parts, total } = await putTwoParts(token, id);

      await request(server())
        .post(`/videos/${id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts })
        .expect(200);

      const row = await videoRepository.findOneByOrFail({ id });
      expect(row.status).toBe(VideoStatus.PROCESSING);
      // Verified against storage, not against what the client claimed: the
      // assembled object must weigh exactly the sum of the parts.
      expect(row.size_bytes).toBe(String(total));

      const head = await storage.headObject(row.storage_key as string);
      expect(head.contentLength).toBe(total);

      await storage.deleteObject(row.storage_key as string);
    });

    it('fails the video when fewer bytes arrived than declared', async () => {
      const token = await registerConfirmAndLogin(app, nextEmail());
      const res0 = await initiate(token, { size: BODY_SIZE * 2 }).expect(201);
      const { id } = bodyOf<InitiateBody>(res0);
      const part = await putSinglePart(token, id, BODY_SIZE);

      const res = await request(server())
        .post(`/videos/${id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [part] })
        .expect(409);

      expect(errorOf(res)).toBe('UPLOAD_SIZE_MISMATCH');

      const row = await videoRepository.findOneByOrFail({ id });
      expect(row.status).toBe(VideoStatus.FAILED);
      expect(row.processing_error).toBeTruthy();

      // Nothing enqueued for a video that will never be processable.
      await expect(
        processingQueue.queue.getJobs(['waiting']),
      ).resolves.toHaveLength(0);
    });

    it('rejects completing a video that is no longer uploading', async () => {
      const token = await registerConfirmAndLogin(app, nextEmail());
      const { id } = bodyOf<InitiateBody>(await initiate(token).expect(201));
      const part = await putSinglePart(token, id);

      await request(server())
        .post(`/videos/${id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [part] })
        .expect(200);

      const res = await request(server())
        .post(`/videos/${id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [part] })
        .expect(409);

      expect(errorOf(res)).toBe('UPLOAD_NOT_IN_PROGRESS');

      const row = await videoRepository.findOneByOrFail({ id });
      await storage.deleteObject(row.storage_key as string);
    });

    it('rejects parts that do not start at 1', async () => {
      const token = await registerConfirmAndLogin(app, nextEmail());
      const { id } = bodyOf<InitiateBody>(await initiate(token).expect(201));

      await request(server())
        .post(`/videos/${id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ partNumber: 2, etag: 'e' }] })
        .expect(400);

      await request(server())
        .delete(`/videos/${id}`)
        .set('Authorization', `Bearer ${token}`);
    });
  });

  describe('DELETE /videos/:id — abort', () => {
    it('aborts the upload and discards the draft', async () => {
      const token = await registerConfirmAndLogin(app, nextEmail());
      const { id } = bodyOf<InitiateBody>(await initiate(token).expect(201));

      await request(server())
        .delete(`/videos/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      await expect(videoRepository.countBy({ id })).resolves.toBe(0);

      const res = await request(server())
        .delete(`/videos/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
      expect(errorOf(res)).toBe('VIDEO_NOT_FOUND');
    });

    it('denies an abort by someone who does not own the video', async () => {
      const ownerToken = await registerConfirmAndLogin(app, nextEmail());
      const otherToken = await registerConfirmAndLogin(app, nextEmail());
      const { id } = bodyOf<InitiateBody>(
        await initiate(ownerToken).expect(201),
      );

      const res = await request(server())
        .delete(`/videos/${id}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(403);

      expect(errorOf(res)).toBe('VIDEO_NOT_OWNED');
      await expect(videoRepository.countBy({ id })).resolves.toBe(1);

      await request(server())
        .delete(`/videos/${id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
    });
  });
});
