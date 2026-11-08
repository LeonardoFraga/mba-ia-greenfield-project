import type * as Joi from 'joi';
import { envValidationSchema } from './env.validation';

/** The subset of the validated env this suite asserts on. */
interface ValidatedEnv {
  SWAGGER_ENABLED: string;
  STORAGE_REGION: string;
  STORAGE_PRESIGN_TTL_SECONDS: number;
  STORAGE_UPLOAD_PART_SIZE_BYTES: number;
  STORAGE_MAX_UPLOAD_BYTES: number;
  STORAGE_ABANDONED_UPLOAD_CUTOFF_HOURS: number;
  REDIS_HOST: string;
  REDIS_PORT: number;
  QUEUE_VIDEO_PROCESSING_NAME: string;
  QUEUE_JOB_ATTEMPTS: number;
  QUEUE_JOB_BACKOFF_DELAY_MS: number;
}

/**
 * Joi's own `ValidationResult` is a union whose error branch types `value` as
 * `any`; flatten it so assertions on `value` stay type-checked.
 */
interface EnvValidation {
  error?: Joi.ValidationError;
  value: ValidatedEnv;
}

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ENDPOINT: 'http://minio:9000',
  STORAGE_ACCESS_KEY: 'key',
  STORAGE_SECRET_KEY: 'secret',
  STORAGE_BUCKET_VIDEOS: 'videos',
  STORAGE_BUCKET_THUMBNAILS: 'thumbnails',
  STORAGE_PUBLIC_URL: 'http://localhost:9000',
};

const validate = (env: Record<string, string>): EnvValidation =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage keys', () => {
  it.each([
    'STORAGE_ENDPOINT',
    'STORAGE_ACCESS_KEY',
    'STORAGE_SECRET_KEY',
    'STORAGE_BUCKET_VIDEOS',
    'STORAGE_BUCKET_THUMBNAILS',
    'STORAGE_PUBLIC_URL',
  ])('should reject a missing %s and name it in the error', (key) => {
    const withoutKey = { ...requiredEnv } as Record<string, string>;
    delete withoutKey[key];

    const { error } = envValidationSchema.validate(withoutKey, {
      allowUnknown: true,
      abortEarly: false,
    }) as EnvValidation;

    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should reject a STORAGE_ENDPOINT that is not a URI', () => {
    const { error } = validate({ STORAGE_ENDPOINT: 'not-a-uri' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ENDPOINT');
  });

  it('should reject a part size below the 5MB floor S3 imposes', () => {
    const { error } = validate({
      STORAGE_UPLOAD_PART_SIZE_BYTES: String(1024 * 1024),
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_UPLOAD_PART_SIZE_BYTES');
  });

  it('should accept a part size at exactly the 5MB floor', () => {
    const { error } = validate({
      STORAGE_UPLOAD_PART_SIZE_BYTES: String(5 * 1024 * 1024),
    });
    expect(error).toBeUndefined();
  });

  it('should reject a non-numeric STORAGE_PRESIGN_TTL_SECONDS', () => {
    const { error } = validate({ STORAGE_PRESIGN_TTL_SECONDS: 'soon' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_PRESIGN_TTL_SECONDS');
  });

  it('should coerce numeric storage keys and apply their defaults', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value.STORAGE_REGION).toBe('us-east-1');
    expect(value.STORAGE_PRESIGN_TTL_SECONDS).toBe(900);
    expect(value.STORAGE_UPLOAD_PART_SIZE_BYTES).toBe(50 * 1024 * 1024);
    expect(value.STORAGE_MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024 * 1024);
    expect(value.STORAGE_ABANDONED_UPLOAD_CUTOFF_HOURS).toBe(24);
  });
});

describe('envValidationSchema — queue keys', () => {
  it('should reject a non-numeric REDIS_PORT', () => {
    const { error } = validate({ REDIS_PORT: 'nope' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_PORT');
  });

  it('should reject a REDIS_PORT outside the valid port range', () => {
    const { error } = validate({ REDIS_PORT: '70000' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_PORT');
  });

  it('should apply the queue defaults the status lifecycle assumes', () => {
    const { value, error } = validate({});

    expect(error).toBeUndefined();
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.QUEUE_VIDEO_PROCESSING_NAME).toBe('video-processing');
    expect(value.QUEUE_JOB_ATTEMPTS).toBe(3);
    expect(value.QUEUE_JOB_BACKOFF_DELAY_MS).toBe(1000);
  });
});
