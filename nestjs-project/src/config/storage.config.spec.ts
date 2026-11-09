import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from './storage.config';

const STORAGE_KEYS = [
  'STORAGE_ENDPOINT',
  'STORAGE_REGION',
  'STORAGE_ACCESS_KEY',
  'STORAGE_SECRET_KEY',
  'STORAGE_BUCKET_VIDEOS',
  'STORAGE_BUCKET_THUMBNAILS',
  'STORAGE_PUBLIC_URL',
  'STORAGE_PRESIGN_TTL_SECONDS',
  'STORAGE_UPLOAD_PART_SIZE_BYTES',
  'STORAGE_MAX_UPLOAD_BYTES',
  'STORAGE_ABANDONED_UPLOAD_CUTOFF_HOURS',
] as const;

/**
 * `.env` is loaded into `process.env` by jest's `setupFiles: ["dotenv/config"]`,
 * and the suite runs with `--runInBand`, so every test file shares one process.
 * Snapshot and restore instead of deleting, or these tests leak into others.
 */
const snapshot: Record<string, string | undefined> = {};

const loadConfig = async (
  env: Record<string, string> = {},
): Promise<ConfigType<typeof storageConfig>> => {
  for (const key of STORAGE_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, env);

  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, load: [storageConfig] }),
    ],
  }).compile();

  const config = module.get<ConfigType<typeof storageConfig>>(
    storageConfig.KEY,
  );
  await module.close();
  return config;
};

describe('storageConfig', () => {
  beforeAll(() => {
    for (const key of STORAGE_KEYS) {
      snapshot[key] = process.env[key];
    }
  });

  afterAll(() => {
    for (const key of STORAGE_KEYS) {
      if (snapshot[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = snapshot[key];
      }
    }
  });

  it('should coerce every numeric key to a number, not a string', async () => {
    const config = await loadConfig({
      STORAGE_PRESIGN_TTL_SECONDS: '600',
      STORAGE_UPLOAD_PART_SIZE_BYTES: '10485760',
      STORAGE_MAX_UPLOAD_BYTES: '2147483648',
      STORAGE_ABANDONED_UPLOAD_CUTOFF_HOURS: '6',
    });

    expect(config.presignTtlSeconds).toBe(600);
    expect(config.uploadPartSizeBytes).toBe(10485760);
    expect(config.maxUploadBytes).toBe(2147483648);
    expect(config.abandonedUploadCutoffHours).toBe(6);
  });

  it('should read string keys verbatim', async () => {
    const config = await loadConfig({
      STORAGE_ENDPOINT: 'http://storage.example:9000',
      STORAGE_REGION: 'sa-east-1',
      STORAGE_ACCESS_KEY: 'access',
      STORAGE_SECRET_KEY: 'secret',
      STORAGE_BUCKET_VIDEOS: 'v',
      STORAGE_BUCKET_THUMBNAILS: 't',
      STORAGE_PUBLIC_URL: 'https://cdn.example',
    });

    expect(config.endpoint).toBe('http://storage.example:9000');
    expect(config.region).toBe('sa-east-1');
    expect(config.accessKey).toBe('access');
    expect(config.secretKey).toBe('secret');
    expect(config.videosBucket).toBe('v');
    expect(config.thumbnailsBucket).toBe('t');
    expect(config.publicUrl).toBe('https://cdn.example');
  });

  it('should apply the local development defaults when nothing is set', async () => {
    const config = await loadConfig();

    expect(config.endpoint).toBe('http://minio:9000');
    expect(config.region).toBe('us-east-1');
    expect(config.videosBucket).toBe('videos');
    expect(config.thumbnailsBucket).toBe('thumbnails');
    expect(config.presignTtlSeconds).toBe(900);
    expect(config.abandonedUploadCutoffHours).toBe(24);
  });

  it('should default the upload ceiling to exactly 10GB', async () => {
    const config = await loadConfig();

    expect(config.maxUploadBytes).toBe(10 * 1024 * 1024 * 1024);
  });

  it('should default the part size so a 10GB upload stays under the 10000-part cap', async () => {
    const config = await loadConfig();

    expect(config.uploadPartSizeBytes).toBe(50 * 1024 * 1024);
    expect(
      Math.ceil(config.maxUploadBytes / config.uploadPartSizeBytes),
    ).toBeLessThanOrEqual(10000);
  });

  it('should point publicUrl at a host address, not the Compose service name', async () => {
    const config = await loadConfig();

    // The value is handed to a browser to build thumbnail URLs, so the
    // service-name rule that governs container-to-container traffic is the
    // wrong default here.
    expect(config.publicUrl).not.toContain('minio:9000');
  });
});
