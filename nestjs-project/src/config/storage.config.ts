import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  /** S3 API endpoint. MinIO locally, real S3 in production — same adapter. */
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKey: process.env.STORAGE_ACCESS_KEY || 'streamtube',
  secretKey: process.env.STORAGE_SECRET_KEY || 'streamtube',
  /** Private bucket: every read goes through a presigned GET. */
  videosBucket: process.env.STORAGE_BUCKET_VIDEOS || 'videos',
  /** Public, cacheable bucket — thumbnails are served by permanent URL. */
  thumbnailsBucket: process.env.STORAGE_BUCKET_THUMBNAILS || 'thumbnails',
  /**
   * Browser-reachable base URL used to build public thumbnail URLs. This is the
   * one value that must NOT be the Compose service name: it is handed to a
   * browser, not used for container-to-container traffic.
   */
  publicUrl: process.env.STORAGE_PUBLIC_URL || 'http://localhost:9000',
  /** Presigned URL lifetime. Minutes, not hours. */
  presignTtlSeconds: parseInt(
    process.env.STORAGE_PRESIGN_TTL_SECONDS || '900',
    10,
  ),
  /** Multipart part size. At 50MB, a 10GB file is 200 parts (cap is 10,000). */
  uploadPartSizeBytes: parseInt(
    process.env.STORAGE_UPLOAD_PART_SIZE_BYTES || '52428800',
    10,
  ),
  /** Hard upload ceiling, enforced at initiate and verified at complete. */
  maxUploadBytes: parseInt(
    process.env.STORAGE_MAX_UPLOAD_BYTES || '10737418240',
    10,
  ),
  /** How long an upload may sit in `uploading` before the reaper collects it. */
  abandonedUploadCutoffHours: parseInt(
    process.env.STORAGE_ABANDONED_UPLOAD_CUTOFF_HOURS || '24',
    10,
  ),
}));
