/** Bytes of entropy behind the public id — 8 bytes base64url is 11 chars. */
export const PUBLIC_ID_BYTES = 8;

/** Expected rendered length of a public id, asserted by tests. */
export const PUBLIC_ID_LENGTH = 11;

/** Column name used to recognise a public-id collision from the driver error. */
export const PUBLIC_ID_COLUMN = 'public_id';

/**
 * Retries on public-id collision. With 64 bits of entropy this path is
 * essentially never taken; the unique index plus the retry is the guarantee
 * that actually holds.
 */
export const PUBLIC_ID_MAX_RETRIES = 5;

/** S3 part numbers are a positive integer between 1 and 10,000. */
export const MIN_PART_NUMBER = 1;
export const MAX_PART_NUMBER = 10000;

/** How many part URLs one sign request may ask for. */
export const MAX_PARTS_PER_SIGN_REQUEST = 100;

export const VIDEO_STORAGE_KEY_PREFIX = 'videos';
export const THUMBNAIL_STORAGE_KEY_PREFIX = 'thumbnails';

/** Filename extension offered on download, per accepted container. */
export const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/webm': 'webm',
};

export const DEFAULT_DOWNLOAD_EXTENSION = 'mp4';
