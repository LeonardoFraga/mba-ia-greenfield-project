import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import {
  VIDEO_PROCESSING_JOB_NAME,
  type VideoProcessingJobData,
} from './video-processing.job';

/**
 * Producer side of the video-processing queue.
 *
 * `Queue` is constructed here as an explicit provider rather than through
 * `@nestjs/bullmq`: that package is ESM-only against this CommonJS build, so
 * the wiring is hand-written — which is also what keeps the retry policy in
 * one place instead of scattered across call sites.
 */
@Injectable()
export class VideoProcessingQueue implements OnModuleDestroy {
  /** Exposed so the worker specs can drain and obliterate between cases. */
  readonly queue: Queue<VideoProcessingJobData>;

  constructor(
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {
    this.queue = new Queue<VideoProcessingJobData>(
      config.videoProcessingQueue,
      { connection: { host: config.host, port: config.port } },
    );
  }

  /**
   * Enqueues one processing job. Queue-level retries absorb transient faults
   * invisibly; only exhausting `attempts` is what lets the row reach `failed`.
   */
  async enqueue(data: VideoProcessingJobData): Promise<string> {
    const job = await this.queue.add(VIDEO_PROCESSING_JOB_NAME, data, {
      attempts: this.config.jobAttempts,
      backoff: { type: 'exponential', delay: this.config.jobBackoffDelayMs },
      removeOnComplete: true,
      // Keep a bounded tail of failures for diagnosis.
      removeOnFail: 1000,
    });

    if (job.id === undefined) {
      throw new Error(
        `Queue.add returned a job without an id for video "${data.videoId}"`,
      );
    }
    return job.id;
  }

  async onModuleDestroy(): Promise<void> {
    // Without this the ioredis connection stays open and Jest leaks a handle —
    // which `--forceExit` would hide rather than report.
    await this.queue.close();
  }
}
