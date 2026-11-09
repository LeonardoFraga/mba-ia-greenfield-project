import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

/**
 * Runs against the real MinIO container from `compose.yaml`, not a local
 * filesystem adapter and not a mock of presigning. Presigned multipart and
 * range delivery are the two mechanisms this phase is built on and the two a
 * filesystem driver cannot express at all, so they are exactly what must be
 * exercised for real.
 */

/** S3 requires every part except the last to be at least 5MB. */
const MIN_PART_SIZE = 5 * 1024 * 1024;
const LAST_PART_SIZE = 1024;

function buffer(size: number, fill: string): Buffer {
  return Buffer.alloc(size, fill);
}

describe('StorageService (integration — real MinIO)', () => {
  let module: TestingModule;
  let storage: StorageService;
  const createdKeys: { key: string; bucket: 'videos' | 'thumbnails' }[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    for (const { key, bucket } of createdKeys) {
      await storage.deleteObject(key, bucket).catch(() => undefined);
    }
    await module.close();
  });

  function trackedKey(
    suffix: string,
    bucket: 'videos' | 'thumbnails' = 'videos',
  ): string {
    const key = `test/${randomUUID()}-${suffix}`;
    createdKeys.push({ key, bucket });
    return key;
  }

  /** Uploads both parts through presigned URLs, as the real client does. */
  async function uploadTwoParts(
    key: string,
    uploadId: string,
  ): Promise<{ parts: { partNumber: number; etag: string }[]; total: number }> {
    const bodies = [
      buffer(MIN_PART_SIZE, 'a'),
      buffer(LAST_PART_SIZE, 'b'),
    ] as const;
    const parts: { partNumber: number; etag: string }[] = [];

    for (const [index, body] of bodies.entries()) {
      const partNumber = index + 1;
      const { url } = await storage.signUploadPart(key, uploadId, partNumber);

      // `fetch` accepts a Buffer at runtime, but the DOM `BodyInit` type does
      // not include it — a Uint8Array view is the type-correct equivalent.
      const response = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(body),
      });
      expect(response.status).toBe(200);

      const etag = response.headers.get('etag');
      expect(etag).toBeTruthy();
      parts.push({ partNumber, etag: etag as string });
    }

    return { parts, total: MIN_PART_SIZE + LAST_PART_SIZE };
  }

  it('should complete a two-part multipart upload sent through presigned URLs', async () => {
    const key = trackedKey('multipart.bin');
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    const { parts, total } = await uploadTwoParts(key, uploadId);
    await storage.completeMultipartUpload(key, uploadId, parts);

    const head = await storage.headObject(key);
    expect(head.contentLength).toBe(total);
    expect(head.contentType).toBe('video/mp4');
  }, 60000);

  it('should complete correctly even when parts are reported out of order', async () => {
    const key = trackedKey('unordered.bin');
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    const { parts, total } = await uploadTwoParts(key, uploadId);
    // The service sorts before sending; S3 rejects out-of-order parts.
    await storage.completeMultipartUpload(key, uploadId, [...parts].reverse());

    const head = await storage.headObject(key);
    expect(head.contentLength).toBe(total);
  }, 60000);

  it('should report ContentLength from headObject without downloading the body', async () => {
    const key = trackedKey('head.bin');
    const body = buffer(2048, 'c');
    await storage.putObject(key, body, 'application/octet-stream', 'videos');

    const head = await storage.headObject(key);

    expect(head.contentLength).toBe(2048);
    expect(head.contentType).toBe('application/octet-stream');
  }, 30000);

  it('should answer a Range request on the presigned GET with 206 and the exact slice', async () => {
    const key = trackedKey('range.bin');
    await storage.putObject(key, buffer(4096, 'd'), 'video/mp4', 'videos');

    const { url } = await storage.signGetObject(key);
    const response = await fetch(url, { headers: { Range: 'bytes=0-99' } });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-99/4096');

    const received = Buffer.from(await response.arrayBuffer());
    expect(received).toHaveLength(100);
  }, 30000);

  it('should serve the whole object on the presigned GET when no Range is sent', async () => {
    const key = trackedKey('whole.bin');
    await storage.putObject(key, buffer(4096, 'e'), 'video/mp4', 'videos');

    const { url } = await storage.signGetObject(key);
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toHaveLength(4096);
  }, 30000);

  it('should override content-disposition for the download variant', async () => {
    const key = trackedKey('download.bin');
    await storage.putObject(key, buffer(512, 'f'), 'video/mp4', 'videos');

    const { url } = await storage.signGetObject(key, {
      downloadFilename: 'meu-video.mp4',
    });
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('content-disposition')).toContain(
      'meu-video.mp4',
    );
  }, 30000);

  it('should bound the presigned URL lifetime to the configured TTL', async () => {
    const key = trackedKey('ttl.bin');
    const { expiresIn } = await storage.signGetObject(key);

    // Minutes, not hours — a leaked URL must expire quickly.
    expect(expiresIn).toBeGreaterThan(0);
    expect(expiresIn).toBeLessThanOrEqual(3600);
  }, 30000);

  it('should leave no stored parts after aborting an upload', async () => {
    const key = trackedKey('aborted.bin');
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    await uploadTwoParts(key, uploadId);

    await expect(storage.countUploadedParts(key, uploadId)).resolves.toBe(2);

    await storage.abortMultipartUpload(key, uploadId);

    // The upload no longer exists, so listing its parts fails outright.
    await expect(storage.countUploadedParts(key, uploadId)).rejects.toThrow();
    await expect(storage.headObject(key)).rejects.toThrow();
  }, 60000);

  it('should store a thumbnail in the public bucket and expose it by permanent URL', async () => {
    const key = trackedKey('thumb.jpg', 'thumbnails');
    await storage.putObject(key, buffer(256, 'g'), 'image/jpeg', 'thumbnails');

    const head = await storage.headObject(key, 'thumbnails');
    expect(head.contentLength).toBe(256);
    expect(head.contentType).toBe('image/jpeg');

    const publicUrl = storage.publicThumbnailUrl(key);
    expect(publicUrl).toContain(key);
    // The public URL is browser-facing, so it must not carry a signature.
    expect(publicUrl).not.toContain('X-Amz-Signature');
  }, 30000);

  it('should reject headObject for a key that does not exist', async () => {
    await expect(storage.headObject('test/does-not-exist')).rejects.toThrow();
  }, 30000);
});
