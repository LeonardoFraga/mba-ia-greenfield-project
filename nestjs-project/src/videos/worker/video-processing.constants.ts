/**
 * Thumbnail generation parameters, fixed by `phase-03-videos/TD-05` Revisions:
 * one frame seeked at 10% of the duration `ffprobe` reports, fitted into
 * 1280x720 preserving aspect ratio, JPEG at a fixed quality.
 */
export const THUMBNAIL = {
  /**
   * Fraction of the duration to seek to. A percentage never falls outside the
   * file — a two-second clip and a two-hour film both resolve — unlike a fixed
   * timestamp, and a single seek stays cheap over the presigned URL (TD-06).
   */
  SEEK_FRACTION: 0.1,
  WIDTH: 1280,
  HEIGHT: 720,
  /** `-q:v` for mjpeg: 2 is best, 31 worst. 3 is visually clean and small. */
  QUALITY: 3,
  CONTENT_TYPE: 'image/jpeg',
} as const;

/** Deterministic key in the public bucket: re-processing overwrites it. */
export function buildThumbnailKey(videoId: string): string {
  return `${videoId}/thumbnail.jpg`;
}
