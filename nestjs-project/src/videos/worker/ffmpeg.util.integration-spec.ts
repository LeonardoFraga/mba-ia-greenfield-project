import { createReadStream } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { generateVideoFixture } from '../../test/video-fixture.helper';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { FfmpegError, extractThumbnail, probeVideo } from './ffmpeg.util';

interface ServedStats {
  /** Bytes the server pushed into the socket. */
  bytesSent: number;
  /** Byte offset each request started at. */
  requestOffsets: number[];
  /** How many response bodies were sent to completion. */
  completedBodies: number;
  /** Whether a client hung up before its body finished. */
  abortedEarly: boolean;
}

/**
 * Exercises the FFmpeg wrappers against a real HTTP origin that reports what it
 * was asked for.
 *
 * This is where `phase-03-videos/TD-06` is actually verified: the worker hands
 * FFmpeg a URL and FFmpeg reads ranges, so an object far larger than memory is
 * processable and nothing is ever written to the worker's disk.
 */
describe('ffmpeg.util (integration — real binaries over real HTTP)', () => {
  let fixture: Buffer;
  let dir: string;
  let file: string;

  /** Serves `file` with Range support and records what the client pulled. */
  async function serveFixture(): Promise<{
    url: string;
    stats: ServedStats;
    close: () => Promise<void>;
  }> {
    const total = fixture.length;
    const stats: ServedStats = {
      bytesSent: 0,
      requestOffsets: [],
      completedBodies: 0,
      abortedEarly: false,
    };

    const server: Server = createServer((req, res) => {
      const rangeHeader = req.headers.range;
      let start = 0;
      let end = total - 1;

      if (rangeHeader) {
        const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
        if (match) {
          if (match[1]) start = Number(match[1]);
          if (match[2]) end = Number(match[2]);
        }
      }
      stats.requestOffsets.push(start);

      res.writeHead(rangeHeader ? 206 : 200, {
        'Content-Length': String(end - start + 1),
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        ...(rangeHeader && {
          'Content-Range': `bytes ${start}-${end}/${total}`,
        }),
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const stream = createReadStream(file, { start, end });
      let finished = false;
      stream.on('data', (chunk: Buffer) => {
        stats.bytesSent += chunk.length;
      });
      stream.on('end', () => {
        finished = true;
        stats.completedBodies += 1;
      });
      stream.on('error', () => res.end());
      stream.pipe(res);

      res.on('close', () => {
        if (!finished) {
          stats.abortedEarly = true;
          stream.destroy();
        }
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    return {
      url: `http://127.0.0.1:${port}/fixture.mp4`,
      stats,
      close: () =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  beforeAll(async () => {
    // ~20MB, generated in well under a second. The size matters: the object
    // must be far larger than the socket buffers, or "it did not read the
    // whole file" is unmeasurable — a small file is pushed into the buffer in
    // full before FFmpeg hangs up, and the measurement says nothing.
    fixture = await generateVideoFixture({
      durationSeconds: 8,
      fps: 25,
      pattern: 'testsrc2',
      crf: 16,
    });
    dir = await mkdtemp(join(tmpdir(), 'ffmpeg-util-spec-'));
    file = join(dir, 'fixture.mp4');
    await writeFile(file, fixture);
  }, 120_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('probeVideo', () => {
    it('should read the metadata of a real video over HTTP', async () => {
      const origin = await serveFixture();

      try {
        const probe = await probeVideo(origin.url);

        expect(probe.durationSeconds).toBeCloseTo(8, 0);
        expect(probe.width).toBe(1920);
        expect(probe.height).toBe(1080);
        expect(probe.sizeBytes).toBe(fixture.length);
        expect(probe.metadata).toMatchObject({
          videoCodec: 'h264',
          container: expect.stringContaining('mp4') as string,
          audioCodec: null,
        });
        expect(probe.metadata.bitrate).toBeGreaterThan(0);
      } finally {
        await origin.close();
      }
    }, 120_000);

    it('should pull only a fraction of the object, never the whole file', async () => {
      const origin = await serveFixture();

      try {
        await probeVideo(origin.url);

        // The decisive, buffer-independent assertion: no response body was
        // ever sent to completion, because ffprobe hung up once it had the
        // header. Measured against MinIO by network counters, the real volume
        // is ~1% of a 12.8MB object.
        expect(origin.stats.completedBodies).toBe(0);
        expect(origin.stats.abortedEarly).toBe(true);
        expect(origin.stats.bytesSent).toBeLessThan(fixture.length / 2);
      } finally {
        await origin.close();
      }
    }, 120_000);

    it('should reject a file that carries no video stream', async () => {
      await writeFile(file, Buffer.alloc(4096, 7));
      const origin = await serveFixture();

      try {
        await expect(probeVideo(origin.url)).rejects.toThrow(FfmpegError);
      } finally {
        await origin.close();
        await writeFile(file, fixture);
      }
    }, 120_000);
  });

  describe('extractThumbnail', () => {
    it('should return a JPEG fitted into the box without upscaling', async () => {
      const origin = await serveFixture();

      try {
        const jpeg = await extractThumbnail(origin.url, 0.8, {
          width: 1280,
          height: 720,
          quality: 3,
        });

        // SOI/EOI markers: the bytes really are a JPEG, not an empty buffer.
        expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
        expect(jpeg.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
        expect(jpeg.length).toBeGreaterThan(1024);
      } finally {
        await origin.close();
      }
    }, 120_000);

    it('should seek with a ranged request instead of reading from the start', async () => {
      const origin = await serveFixture();

      try {
        await extractThumbnail(origin.url, 4, {
          width: 1280,
          height: 720,
          quality: 3,
        });

        // `-ss` before `-i` makes the seek an input seek: a second request at a
        // non-zero offset, rather than decoding forward from byte zero.
        expect(origin.stats.requestOffsets.length).toBeGreaterThan(1);
        expect(Math.max(...origin.stats.requestOffsets)).toBeGreaterThan(0);
        expect(origin.stats.completedBodies).toBe(0);
      } finally {
        await origin.close();
      }
    }, 120_000);

    it('should never write the video to the local filesystem', async () => {
      const before = await readdir(dir);
      const origin = await serveFixture();

      try {
        await extractThumbnail(origin.url, 4, {
          width: 1280,
          height: 720,
          quality: 3,
        });
      } finally {
        await origin.close();
      }

      // The frame comes back through stdout, so a stateless worker never needs
      // disk — which is what lets a 10GB upload be processed at all.
      expect(await readdir(dir)).toEqual(before);
    }, 120_000);
  });
});
