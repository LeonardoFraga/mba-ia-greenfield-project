import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { VIDEO_PROCESSING_JOB_NAME } from './video-processing.job';
import { VideoProcessingQueue } from './video-processing.queue';

/**
 * Runs against the real Redis container. No `runMigrations()` here: that
 * bootstrap exists only for BullMQ's PostgreSQL backend, which TD-14
 * superseded in favour of a dedicated broker service.
 */
describe('VideoProcessingQueue (integration — real Redis)', () => {
  let module: TestingModule;
  let producer: VideoProcessingQueue;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();
    producer = module.get(VideoProcessingQueue);
  });

  afterAll(async () => {
    // Closes the Queue and its ioredis connection via onModuleDestroy.
    await module.close();
  });

  beforeEach(async () => {
    // Per-spec isolation, as TD-11 specifies.
    await producer.queue.obliterate({ force: true });
  });

  it('should enqueue a job carrying the videoId and storageKey', async () => {
    const data = { videoId: randomUUID(), storageKey: 'videos/abc.mp4' };

    const jobId = await producer.enqueue(data);

    expect(jobId).toBeTruthy();

    const waiting = await producer.queue.getJobs(['waiting']);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].name).toBe(VIDEO_PROCESSING_JOB_NAME);
    expect(waiting[0].data).toEqual(data);
  }, 30000);

  it('should attach the retry policy the status lifecycle depends on', async () => {
    await producer.enqueue({
      videoId: randomUUID(),
      storageKey: 'videos/retry.mp4',
    });

    const [job] = await producer.queue.getJobs(['waiting']);

    // Transient faults are absorbed by these retries; only exhausting them is
    // what lets a row reach `failed`.
    expect(job.opts.attempts).toBe(3);
    expect(job.opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
  }, 30000);

  it('should keep jobs durable across a fresh connection to the same queue', async () => {
    const data = { videoId: randomUUID(), storageKey: 'videos/durable.mp4' };
    await producer.enqueue(data);

    // A second module instance is a different client against the same broker —
    // the job must be visible there, not held in process memory.
    const other = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();
    const otherProducer = other.get(VideoProcessingQueue);

    const waiting = await otherProducer.queue.getJobs(['waiting']);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].data).toEqual(data);

    await other.close();
  }, 30000);

  it('should enqueue independent jobs for independent videos', async () => {
    await producer.enqueue({ videoId: randomUUID(), storageKey: 'a.mp4' });
    await producer.enqueue({ videoId: randomUUID(), storageKey: 'b.mp4' });

    const waiting = await producer.queue.getJobs(['waiting']);
    expect(waiting).toHaveLength(2);
    expect(new Set(waiting.map((j) => j.data.storageKey))).toEqual(
      new Set(['a.mp4', 'b.mp4']),
    );
  }, 30000);

  it('should leave the queue empty after obliterate', async () => {
    await producer.enqueue({ videoId: randomUUID(), storageKey: 'gone.mp4' });

    await producer.queue.obliterate({ force: true });

    await expect(producer.queue.getJobs(['waiting'])).resolves.toHaveLength(0);
  }, 30000);
});
