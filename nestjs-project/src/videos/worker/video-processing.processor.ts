import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, type QueryDeepPartialEntity } from 'typeorm';
import {
  VIDEO_PROCESSING_JOB_NAME,
  type VideoProcessingJobData,
} from '../../queue/video-processing.job';
import { StorageService } from '../../storage/storage.service';
import { Video, VideoStatus } from '../entities/video.entity';
import { extractThumbnail, probeVideo } from './ffmpeg.util';
import { buildThumbnailKey, THUMBNAIL } from './video-processing.constants';

/**
 * The phase's actual work: read the metadata and one frame of an uploaded
 * video, then move the row to `ready`.
 *
 * Nothing is downloaded. A presigned GET is handed to `ffprobe` and `ffmpeg`
 * as an HTTP input (TD-06), so both read byte ranges straight from storage —
 * measured at ~1% of a 12.8MB object for the probe and ~2% for the frame,
 * bounded by the GOP rather than by the file size. The container stays
 * stateless and a 10GB upload never touches its filesystem.
 *
 * Deciding that a failure is terminal is NOT this class's job: the queue owns
 * the retry policy, and `finalAttempt` is computed by the worker wiring from
 * the BullMQ job. That keeps the policy in one place and leaves this unit
 * testable without faking a `Job` (TD-09).
 */
@Injectable()
export class VideoProcessingProcessor {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
  ) {}

  /**
   * Processes one job.
   *
   * Idempotent by construction rather than by a status guard: the row is
   * overwritten with the probe's output and the thumbnail goes to a
   * deterministic key, so running the same job twice converges to the same row
   * and the same single object.
   *
   * @param finalAttempt whether the queue has no retries left after this run —
   *   the only condition under which the row is allowed to reach `failed`.
   */
  async process(
    data: VideoProcessingJobData,
    finalAttempt: boolean,
  ): Promise<void> {
    const video = await this.videos.findOne({ where: { id: data.videoId } });

    if (!video) {
      // The video was deleted between enqueue and execution. Retrying cannot
      // make it exist, so this is a successful no-op rather than a failure.
      this.logger.warn(
        `${VIDEO_PROCESSING_JOB_NAME}: video "${data.videoId}" no longer exists, skipping`,
      );
      return;
    }

    try {
      // Internal endpoint on purpose: this URL is consumed by FFmpeg inside
      // this container, not by a browser.
      const { url } = await this.storage.signInternalGetObject(data.storageKey);

      const probe = await probeVideo(url);

      const seekSeconds =
        probe.durationSeconds !== null
          ? probe.durationSeconds * THUMBNAIL.SEEK_FRACTION
          : 0;

      const jpeg = await extractThumbnail(url, seekSeconds, {
        width: THUMBNAIL.WIDTH,
        height: THUMBNAIL.HEIGHT,
        quality: THUMBNAIL.QUALITY,
      });

      const thumbnailKey = buildThumbnailKey(video.id);
      await this.storage.putObject(
        thumbnailKey,
        jpeg,
        THUMBNAIL.CONTENT_TYPE,
        'thumbnails',
      );

      await this.videos.update(
        { id: video.id },
        {
          // `numeric` maps to string in TypeORM; 3 decimals matches the column.
          duration_seconds:
            probe.durationSeconds !== null
              ? probe.durationSeconds.toFixed(3)
              : null,
          width: probe.width,
          height: probe.height,
          // `size_bytes` is deliberately NOT written here. It is set at
          // complete from `HeadObject.ContentLength`, which is authoritative;
          // `ffprobe`'s `format.size` is only the Content-Length it was
          // served. One column, one writer.
          // Cast at the boundary, per the project's TypeScript rules. The
          // column is plain jsonb, but TypeORM's `QueryDeepPartialEntity`
          // recurses into the value and collapses its leaves to `{}`, which
          // excludes `null` — so a jsonb object with nullable members (no
          // audio stream, no reported bitrate) is simply inexpressible in
          // that type. The cast is on the value, not on the patch, so every
          // other column stays type-checked.
          metadata: probe.metadata as QueryDeepPartialEntity<Video>['metadata'],
          thumbnail_key: thumbnailKey,
          status: VideoStatus.READY,
          processing_error: null,
        },
      );

      this.logger.log(
        `video "${video.id}" is ready — ${probe.width}x${probe.height}, ${probe.durationSeconds}s`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      if (!finalAttempt) {
        // Transient faults are absorbed by the queue's own retry, so the row
        // keeps its `processing` status and the user sees no failure (TD-09).
        this.logger.warn(
          `video "${video.id}" failed but the queue will retry: ${reason}`,
        );
        throw error;
      }

      this.logger.error(`video "${video.id}" is unprocessable: ${reason}`);
      await this.videos.update(
        { id: video.id },
        { status: VideoStatus.FAILED, processing_error: reason },
      );

      // Rethrown so the queue records the job as failed rather than completed —
      // the row and the queue must agree on what happened.
      throw error;
    }
  }
}
