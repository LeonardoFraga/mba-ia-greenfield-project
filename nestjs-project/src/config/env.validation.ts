import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),

  // Object storage. Credentials, endpoint and bucket names are required so a
  // misconfigured deployment fails at startup instead of silently falling back
  // to the local development values baked into storage.config.ts.
  STORAGE_ENDPOINT: Joi.string().uri().required(),
  STORAGE_REGION: Joi.string().default('us-east-1'),
  STORAGE_ACCESS_KEY: Joi.string().required(),
  STORAGE_SECRET_KEY: Joi.string().required(),
  STORAGE_BUCKET_VIDEOS: Joi.string().required(),
  STORAGE_BUCKET_THUMBNAILS: Joi.string().required(),
  STORAGE_PUBLIC_URL: Joi.string().uri().required(),
  STORAGE_PRESIGN_TTL_SECONDS: Joi.number().integer().positive().default(900),
  // S3 rejects parts below 5MB (except the last), so the floor is a platform
  // limit, not a preference.
  STORAGE_UPLOAD_PART_SIZE_BYTES: Joi.number()
    .integer()
    .min(5 * 1024 * 1024)
    .default(50 * 1024 * 1024),
  STORAGE_MAX_UPLOAD_BYTES: Joi.number()
    .integer()
    .positive()
    .default(10 * 1024 * 1024 * 1024),
  STORAGE_ABANDONED_UPLOAD_CUTOFF_HOURS: Joi.number()
    .integer()
    .positive()
    .default(24),

  // Queue (BullMQ 6 on Redis).
  REDIS_HOST: Joi.string().default('redis'),
  REDIS_PORT: Joi.number().port().default(6379),
  QUEUE_VIDEO_PROCESSING_NAME: Joi.string().default('video-processing'),
  QUEUE_JOB_ATTEMPTS: Joi.number().integer().positive().default(3),
  QUEUE_JOB_BACKOFF_DELAY_MS: Joi.number().integer().positive().default(1000),
});
