import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

const INTERNAL = 'http://minio:9000';
const PUBLIC = 'http://localhost:9000';

/**
 * Guards which endpoint each presigned URL is signed against.
 *
 * This is a unit test on purpose: the integration suites run inside the
 * container, where the public and internal endpoints are deliberately the same
 * value, so only a configuration with the two set *differently* can tell the
 * two code paths apart — and that is exactly the bug this protects against. A
 * URL signed against the internal endpoint is unusable by a browser, because
 * SigV4 covers the `Host` header and rewriting it yields
 * `SignatureDoesNotMatch`.
 */
describe('StorageService — presigned URL endpoints', () => {
  let module: TestingModule;
  let storage: StorageService;

  const hostOf = (url: string): string => new URL(url).host;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [
        StorageService,
        {
          provide: storageConfig.KEY,
          useValue: {
            endpoint: INTERNAL,
            publicUrl: PUBLIC,
            region: 'us-east-1',
            accessKey: 'streamtube',
            secretKey: 'streamtube',
            videosBucket: 'videos',
            thumbnailsBucket: 'thumbnails',
            presignTtlSeconds: 900,
          },
        },
      ],
    }).compile();

    storage = module.get(StorageService);
  });

  afterAll(async () => {
    await module.close();
  });

  describe('URLs that leave the network', () => {
    it('should sign an upload part against the public endpoint', async () => {
      const { url } = await storage.signUploadPart('v1/source', 'upload-1', 1);

      expect(hostOf(url)).toBe('localhost:9000');
      expect(url).toContain('X-Amz-Signature=');
    });

    it('should sign a streaming GET against the public endpoint', async () => {
      const { url } = await storage.signGetObject('v1/source');

      // The whole point: a player on the host must be able to resolve this.
      expect(hostOf(url)).toBe('localhost:9000');
      expect(hostOf(url)).not.toBe('minio:9000');
    });

    it('should sign a download GET against the public endpoint', async () => {
      const { url } = await storage.signGetObject('v1/source', {
        downloadFilename: 'video.mp4',
      });

      expect(hostOf(url)).toBe('localhost:9000');
      expect(url).toContain('response-content-disposition');
    });
  });

  describe('URLs consumed inside the network', () => {
    it('should sign the worker GET against the internal endpoint', async () => {
      const { url } = await storage.signInternalGetObject('v1/source');

      // FFmpeg runs in the worker container; `localhost` there is the worker.
      expect(hostOf(url)).toBe('minio:9000');
    });

    it('should address the configured bucket on either endpoint', async () => {
      const external = await storage.signGetObject('v1/source');
      const internal = await storage.signInternalGetObject('v1/source');

      for (const { url } of [external, internal]) {
        expect(new URL(url).pathname).toBe('/videos/v1/source');
      }
    });
  });

  it('should build the public thumbnail URL from the same public base', () => {
    expect(storage.publicThumbnailUrl('v1/thumbnail.jpg')).toBe(
      `${PUBLIC}/thumbnails/v1/thumbnail.jpg`,
    );
  });
});
