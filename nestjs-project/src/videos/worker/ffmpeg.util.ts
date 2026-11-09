import { spawn } from 'node:child_process';

/**
 * Thin `spawn` wrappers around the distro `ffprobe` / `ffmpeg` binaries.
 *
 * No wrapper library: `fluent-ffmpeg` is archived and `spawn` is what any
 * wrapper would do anyway for two commands (TD-05). Both calls take an HTTP URL
 * as input so the worker reads byte ranges straight from storage instead of
 * downloading the object — which is what keeps the container stateless (TD-06).
 */

export interface VideoProbe {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  /** The long tail that lands in the `metadata` jsonb column. */
  metadata: {
    container: string | null;
    videoCodec: string | null;
    audioCodec: string | null;
    bitrate: number | null;
    framerate: string | null;
  };
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    duration?: string;
    size?: string;
    bit_rate?: string;
    format_name?: string;
  };
}

/** Raised when a binary exits non-zero, carrying its stderr for the row. */
export class FfmpegError extends Error {
  constructor(
    readonly binary: string,
    readonly exitCode: number | null,
    stderr: string,
  ) {
    super(
      `${binary} exited with ${exitCode ?? 'signal'}: ${stderr.trim().slice(0, 400)}`,
    );
    this.name = 'FfmpegError';
  }
}

function run(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const stdout: Buffer[] = [];
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new FfmpegError(binary, null, `timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      // Bound the buffer: a pathological input can produce endless warnings.
      if (stderr.length < 64_000) stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new FfmpegError(binary, null, err.message));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdout), stderr });
      } else {
        reject(new FfmpegError(binary, code, stderr));
      }
    });
  });
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Reads duration, dimensions and codec data without downloading the object. */
export async function probeVideo(
  url: string,
  timeoutMs = 60_000,
): Promise<VideoProbe> {
  const { stdout } = await run(
    'ffprobe',
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      url,
    ],
    timeoutMs,
  );

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout.toString()) as FfprobeOutput;
  } catch {
    throw new FfmpegError('ffprobe', 0, 'output was not valid JSON');
  }

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  if (!video) {
    throw new FfmpegError('ffprobe', 0, 'file contains no video stream');
  }

  return {
    durationSeconds: toNumber(parsed.format?.duration),
    width: video.width ?? null,
    height: video.height ?? null,
    sizeBytes: toNumber(parsed.format?.size),
    metadata: {
      container: parsed.format?.format_name ?? null,
      videoCodec: video.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      bitrate: toNumber(parsed.format?.bit_rate),
      framerate: video.r_frame_rate ?? null,
    },
  };
}

export interface ThumbnailOptions {
  /** Longest edge box the frame is fitted into. Never upscales. */
  width: number;
  height: number;
  /** JPEG quality for `-q:v` (2 = best, 31 = worst). */
  quality: number;
  timeoutMs?: number;
}

/**
 * Extracts one frame at `seekSeconds` and returns it as a JPEG buffer.
 *
 * `-ss` precedes `-i` so the seek happens on the input (a range request)
 * rather than by decoding forward, and the frame is written to stdout so no
 * temporary file is ever created.
 */
export async function extractThumbnail(
  url: string,
  seekSeconds: number,
  options: ThumbnailOptions,
): Promise<Buffer> {
  const { width, height, quality, timeoutMs = 120_000 } = options;

  const { stdout } = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-v',
      'error',
      '-ss',
      seekSeconds.toFixed(3),
      '-i',
      url,
      '-frames:v',
      '1',
      '-vf',
      // `decrease` fits inside the box and never upscales a small source.
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      '-f',
      'mjpeg',
      '-q:v',
      String(quality),
      'pipe:1',
    ],
    timeoutMs,
  );

  if (stdout.length === 0) {
    throw new FfmpegError('ffmpeg', 0, 'produced an empty thumbnail');
  }
  return stdout;
}
