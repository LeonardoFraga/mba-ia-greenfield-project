import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import queueConfig from './queue.config';

const QUEUE_KEYS = [
  'REDIS_HOST',
  'REDIS_PORT',
  'QUEUE_VIDEO_PROCESSING_NAME',
  'QUEUE_JOB_ATTEMPTS',
  'QUEUE_JOB_BACKOFF_DELAY_MS',
] as const;

/** See the note in `storage.config.spec.ts` — `--runInBand` shares process.env. */
const snapshot: Record<string, string | undefined> = {};

const loadConfig = async (
  env: Record<string, string> = {},
): Promise<ConfigType<typeof queueConfig>> => {
  for (const key of QUEUE_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, env);

  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, load: [queueConfig] }),
    ],
  }).compile();

  const config = module.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
  await module.close();
  return config;
};

describe('queueConfig', () => {
  beforeAll(() => {
    for (const key of QUEUE_KEYS) {
      snapshot[key] = process.env[key];
    }
  });

  afterAll(() => {
    for (const key of QUEUE_KEYS) {
      if (snapshot[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = snapshot[key];
      }
    }
  });

  it('should coerce the port and the retry policy to numbers', async () => {
    const config = await loadConfig({
      REDIS_PORT: '6380',
      QUEUE_JOB_ATTEMPTS: '5',
      QUEUE_JOB_BACKOFF_DELAY_MS: '2500',
    });

    expect(config.port).toBe(6380);
    expect(config.jobAttempts).toBe(5);
    expect(config.jobBackoffDelayMs).toBe(2500);
  });

  it('should read the host and queue name verbatim', async () => {
    const config = await loadConfig({
      REDIS_HOST: 'redis.example',
      QUEUE_VIDEO_PROCESSING_NAME: 'custom-queue',
    });

    expect(config.host).toBe('redis.example');
    expect(config.videoProcessingQueue).toBe('custom-queue');
  });

  it('should default the host to the Compose service name', async () => {
    const config = await loadConfig();

    // Container-to-container traffic: the service name is correct here, unlike
    // storage's publicUrl which a browser consumes.
    expect(config.host).toBe('redis');
    expect(config.port).toBe(6379);
  });

  it('should default the retry policy to the values the status lifecycle assumes', async () => {
    const config = await loadConfig();

    expect(config.videoProcessingQueue).toBe('video-processing');
    expect(config.jobAttempts).toBe(3);
    expect(config.jobBackoffDelayMs).toBe(1000);
  });
});
