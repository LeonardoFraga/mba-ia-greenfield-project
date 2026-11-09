import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueEvents } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import databaseConfig from '../../config/database.config';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import { QueueModule } from '../../queue/queue.module';
import { VideoProcessingQueue } from '../../queue/video-processing.queue';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import {
  generateNonVideoFixture,
  generateVideoFixture,
} from '../../test/video-fixture.helper';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from '../entities/video.entity';
import { probeVideo } from './ffmpeg.util';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingWorker } from './video-processing.worker';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/**
 * The full round trip: the real producer enqueues, the real BullMQ `Worker`
 * drains Redis, the real FFmpeg binaries read the object out of MinIO and the
 * row lands in `ready` — per TD-11, which chose a real worker in-process over
 * calling the handler directly, precisely so the wiring is covered too.
 */
describe('Video processing (integration — real queue + MinIO + FFmpeg)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let producer: VideoProcessingQueue;
  let queueEvents: QueueEvents;
  let videoRepository: Repository<Video>;
  let fixture: Buffer;
  let counter = 0;
  let config: { host: string; port: number; jobAttempts: number };

  /** Resolves when the queue reports this job finished, either way. */
  function waitForJob(
    jobId: string,
    timeoutMs = 90_000,
  ): Promise<{ outcome: 'completed' | 'failed'; reason?: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`job ${jobId} did not finish within ${timeoutMs}ms`));
      }, timeoutMs);

      const onCompleted = (args: { jobId: string }): void => {
        if (args.jobId !== jobId) return;
        cleanup();
        resolve({ outcome: 'completed' });
      };
      const onFailed = (args: {
        jobId: string;
        failedReason: string;
      }): void => {
        if (args.jobId !== jobId) return;
        cleanup();
        resolve({ outcome: 'failed', reason: args.failedReason });
      };

      function cleanup(): void {
        clearTimeout(timer);
        queueEvents.off('completed', onCompleted);
        queueEvents.off('failed', onFailed);
      }

      queueEvents.on('completed', onCompleted);
      queueEvents.on('failed', onFailed);
    });
  }

  async function seedProcessingVideo(body: Buffer): Promise<Video> {
    const suffix = ++counter;
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `worker_${suffix}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: `Canal ${suffix}`,
        nickname: `worker_chan_${suffix}`,
        user_id: user.id,
      }),
    );
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Fixture',
        public_id: `wrk${String(suffix).padStart(8, '0')}`,
        status: VideoStatus.PROCESSING,
      }),
    );

    const storageKey = `${video.id}/source`;
    await storage.putObject(storageKey, body, 'video/mp4', 'videos');
    await videoRepository.update({ id: video.id }, { storage_key: storageKey });

    return { ...video, storage_key: storageKey };
  }

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        QueueModule,
      ],
      providers: [VideoProcessingProcessor, VideoProcessingWorker],
    }).compile();

    // `compile()` does not run lifecycle hooks, and the `Worker` is started in
    // `onModuleInit` — without this the queue would never be drained.
    await module.init();

    dataSource = module.get(DataSource);
    storage = module.get(StorageService);
    producer = module.get(VideoProcessingQueue);
    videoRepository = dataSource.getRepository(Video);

    config = module.get<{ host: string; port: number; jobAttempts: number }>(
      queueConfig.KEY,
    );
    queueEvents = new QueueEvents(producer.queue.name, {
      connection: { host: config.host, port: config.port },
    });
    await queueEvents.waitUntilReady();

    fixture = await generateVideoFixture({ durationSeconds: 4 });
  }, 180_000);

  afterAll(async () => {
    await queueEvents.close();
    // Closes the `Worker` through its `onModuleDestroy` — the handle Jest
    // would otherwise report as leaked.
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await producer.queue.obliterate({ force: true });
  });

  describe('success path', () => {
    it('should process a real video and land the row in ready with its metadata', async () => {
      const video = await seedProcessingVideo(fixture);

      const jobId = await producer.enqueue({
        videoId: video.id,
        storageKey: video.storage_key as string,
      });
      const result = await waitForJob(jobId);

      expect(result).toEqual({ outcome: 'completed' });

      const processed = await videoRepository.findOneByOrFail({ id: video.id });
      expect(processed.status).toBe(VideoStatus.READY);
      expect(processed.processing_error).toBeNull();
      expect(Number(processed.duration_seconds)).toBeCloseTo(4, 0);
      expect(processed.width).toBe(1920);
      expect(processed.height).toBe(1080);
      expect(processed.metadata).toMatchObject({
        videoCodec: 'h264',
        container: expect.stringContaining('mp4') as string,
      });
    }, 180_000);

    it('should store a 1280-wide JPEG thumbnail in the public bucket', async () => {
      const video = await seedProcessingVideo(fixture);

      const jobId = await producer.enqueue({
        videoId: video.id,
        storageKey: video.storage_key as string,
      });
      await waitForJob(jobId);

      const processed = await videoRepository.findOneByOrFail({ id: video.id });
      expect(processed.thumbnail_key).toBe(`${video.id}/thumbnail.jpg`);

      const head = await storage.headObject(
        processed.thumbnail_key as string,
        'thumbnails',
      );
      expect(head.contentType).toBe('image/jpeg');
      expect(head.contentLength).toBeGreaterThan(0);

      // Probe the stored object itself: the 1080p source must have been fitted
      // into the 1280x720 box, which only a real decode can confirm.
      // Internal endpoint: this spec fetches the object from inside the
      // container, like the worker does.
      const { url } = await storage.signInternalGetObject(
        processed.thumbnail_key as string,
        'thumbnails',
      );
      const thumbnailProbe = await probeVideo(url);
      expect(thumbnailProbe.width).toBe(1280);
      expect(thumbnailProbe.height).toBe(720);
      expect(thumbnailProbe.metadata.videoCodec).toBe('mjpeg');
    }, 180_000);

    it('should converge to the same row and one thumbnail when the job runs twice', async () => {
      const video = await seedProcessingVideo(fixture);
      const data = {
        videoId: video.id,
        storageKey: video.storage_key as string,
      };

      await waitForJob(await producer.enqueue(data));
      const first = await videoRepository.findOneByOrFail({ id: video.id });

      await waitForJob(await producer.enqueue(data));
      const second = await videoRepository.findOneByOrFail({ id: video.id });

      expect(second.thumbnail_key).toBe(first.thumbnail_key);
      expect(second.status).toBe(first.status);
      expect(second.width).toBe(first.width);
      expect(second.duration_seconds).toBe(first.duration_seconds);
      expect(second.metadata).toEqual(first.metadata);
    }, 240_000);
  });

  describe('terminal failure path', () => {
    it('should exhaust the attempts and land the row in failed with a reason', async () => {
      const video = await seedProcessingVideo(generateNonVideoFixture());

      const jobId = await producer.enqueue({
        videoId: video.id,
        storageKey: video.storage_key as string,
      });
      const result = await waitForJob(jobId);

      expect(result.outcome).toBe('failed');

      const processed = await videoRepository.findOneByOrFail({ id: video.id });
      expect(processed.status).toBe(VideoStatus.FAILED);
      expect(processed.processing_error).toBeTruthy();
      expect(processed.thumbnail_key).toBeNull();

      // Exhausted, not abandoned: the queue really tried the configured number
      // of times before the row was allowed to fail. `attempts` is set per job
      // by the producer, so the configured value is the thing to compare to.
      const job = await producer.queue.getJob(jobId);
      expect(job?.attemptsMade).toBe(config.jobAttempts);
      expect(config.jobAttempts).toBe(3);
    }, 180_000);
  });
});
