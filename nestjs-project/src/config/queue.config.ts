import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  /**
   * Redis connection for BullMQ. `Queue` and `Worker` are hand-written
   * providers — this project does not use `@nestjs/bullmq`.
   */
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  videoProcessingQueue:
    process.env.QUEUE_VIDEO_PROCESSING_NAME || 'video-processing',
  /** Queue-level retry policy; exhausting it is what makes a video `failed`. */
  jobAttempts: parseInt(process.env.QUEUE_JOB_ATTEMPTS || '3', 10),
  jobBackoffDelayMs: parseInt(
    process.env.QUEUE_JOB_BACKOFF_DELAY_MS || '1000',
    10,
  ),
}));
