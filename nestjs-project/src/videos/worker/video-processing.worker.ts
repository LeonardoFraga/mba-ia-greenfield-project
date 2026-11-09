import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Worker, type Job } from 'bullmq';
import queueConfig from '../../config/queue.config';
import type { VideoProcessingJobData } from '../../queue/video-processing.job';
import { VideoProcessingProcessor } from './video-processing.processor';

/**
 * Consumer side of the video-processing queue.
 *
 * Like the producer, the BullMQ `Worker` is a hand-written provider: TD-14
 * excluded `@nestjs/bullmq` because it is `type: module` and this project emits
 * CommonJS. The worker is started in `onModuleInit` rather than the
 * constructor so that constructing the provider does not open a Redis
 * connection as a side effect of DI.
 */
@Injectable()
export class VideoProcessingWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoProcessingWorker.name);
  private worker: Worker<VideoProcessingJobData> | undefined;

  constructor(
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
    private readonly processor: VideoProcessingProcessor,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker<VideoProcessingJobData>(
      this.config.videoProcessingQueue,
      (job) => this.processor.process(job.data, this.isFinalAttempt(job)),
      {
        connection: { host: this.config.host, port: this.config.port },
        // One job at a time: FFmpeg is CPU-bound, so concurrency here would
        // contend for the same cores rather than add throughput. Scaling out
        // means more worker containers, not a higher number.
        concurrency: 1,
      },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.warn(
        `job "${job?.id ?? 'unknown'}" failed on attempt ${job?.attemptsMade ?? '?'}: ${error.message}`,
      );
    });

    this.logger.log(
      `worker listening on "${this.config.videoProcessingQueue}" via redis ${this.config.host}:${this.config.port}`,
    );
  }

  /**
   * Whether the queue has no retries left after this run.
   *
   * Measured against the installed BullMQ, not assumed: inside the processor
   * `attemptsMade` counts the failures *already* recorded, so it reads 0, 1, 2
   * across three runs of a job with `attempts: 3`. The final run is therefore
   * the one where `attemptsMade + 1` reaches `attempts`.
   */
  private isFinalAttempt(job: Job<VideoProcessingJobData>): boolean {
    const attempts = job.opts.attempts ?? 1;
    return job.attemptsMade + 1 >= attempts;
  }

  async onModuleDestroy(): Promise<void> {
    // Closing the worker is what releases the Redis connection; without it
    // Jest reports an open handle — and `--forceExit` would hide it.
    await this.worker?.close();
  }
}
