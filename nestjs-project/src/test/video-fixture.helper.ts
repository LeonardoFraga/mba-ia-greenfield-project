import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface VideoFixtureOptions {
  /** Seconds of generated content. */
  durationSeconds?: number;
  width?: number;
  height?: number;
  fps?: number;
  /**
   * `testsrc` is a clean pattern that compresses to almost nothing; `testsrc2`
   * is noisy and produces a file tens of times larger at the same CRF. Tests
   * that need a genuinely large object pick `testsrc2`.
   */
  pattern?: 'testsrc' | 'testsrc2';
  /** x264 quality. Lower is bigger: 28 is tiny, 16 is ~2.5MB per second. */
  crf?: number;
}

/**
 * Builds a real, decodable MP4 with FFmpeg and returns its bytes.
 *
 * Generated rather than committed: the worker tests need a file FFmpeg can
 * genuinely probe and seek, and `lavfi`'s `testsrc` produces one from nothing
 * — so no binary fixture has to live in the repository. The default is
 * 1920x1080 because the thumbnail is fitted into 1280x720 *without upscaling*,
 * so only a source at least that wide proves the scaling actually happened.
 */
export async function generateVideoFixture(
  options: VideoFixtureOptions = {},
): Promise<Buffer> {
  const {
    durationSeconds = 4,
    width = 1920,
    height = 1080,
    fps = 15,
    pattern = 'testsrc',
    crf = 28,
  } = options;

  const dir = await mkdtemp(join(tmpdir(), 'video-fixture-'));
  const output = join(dir, 'fixture.mp4');

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('ffmpeg', [
        '-hide_banner',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `${pattern}=duration=${durationSeconds}:size=${width}x${height}:rate=${fps}`,
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        // A keyframe every two seconds, as a real encode would have. This is
        // what bounds how much the thumbnail seek has to read.
        '-g',
        String(fps * 2),
        '-crf',
        String(crf),
        '-movflags',
        '+faststart',
        '-y',
        output,
      ]);

      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`ffmpeg fixture generation failed: ${stderr}`)),
      );
    });

    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Bytes that are not a video at all. Used for the terminal-failure path: this
 * is the input FFmpeg must reject on every attempt, so the row ends `failed`.
 */
export function generateNonVideoFixture(sizeBytes = 2048): Buffer {
  return randomBytes(sizeBytes);
}
