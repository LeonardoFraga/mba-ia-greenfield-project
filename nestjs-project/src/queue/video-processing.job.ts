/** Job name on the video-processing queue. */
export const VIDEO_PROCESSING_JOB_NAME = 'video.process' as const;

/**
 * Everything the worker needs to process one video. Deliberately minimal: the
 * worker re-reads the row, so the payload carries identity plus the object key
 * rather than a snapshot that could go stale between enqueue and execution.
 */
export interface VideoProcessingJobData {
  videoId: string;
  storageKey: string;
}
