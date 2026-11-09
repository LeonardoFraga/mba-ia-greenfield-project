import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';

/** What one sweep did, so a caller can log or assert on it. */
export interface ReapResult {
  /** Rows removed. */
  reaped: number;
  /** Rows whose multipart could not be aborted but were removed anyway. */
  abortFailures: number;
}

/**
 * Collects uploads that were started and never finished.
 *
 * This closes the cycle `phase-03-videos/TD-09` opened: the `uploading` state
 * earns its place by telling an abandoned handshake apart from an upload still
 * in flight, which is only useful if something eventually clears the former.
 *
 * Note what this service does NOT do: it is not scheduled. No decision in this
 * phase covers a scheduler and the plan does not ask for one, so the sweep is
 * exposed as a method and left for a caller to drive. Wiring it to a cron is
 * recorded as separate work rather than invented here.
 */
@Injectable()
export class UploadReaperService {
  private readonly logger = new Logger(UploadReaperService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  /**
   * Aborts and removes every `uploading` video untouched for longer than the
   * configured cutoff.
   *
   * The cutoff is read against `updated_at`, the row's last touch — the
   * handshake writes it at initiate and `complete` writes it again, so a row
   * sitting at `uploading` with an old timestamp is one whose client never
   * came back. The window must stay comfortably longer than a legitimate
   * upload: signing parts does not touch the row, so a genuine multi-hour
   * upload looks idle to this query for its whole duration.
   *
   * Only `uploading` is eligible. A `processing`, `ready` or `failed` row has
   * bytes in storage and is never the reaper's business.
   */
  async reapAbandonedUploads(): Promise<ReapResult> {
    const cutoff = new Date(
      Date.now() - this.config.abandonedUploadCutoffHours * 60 * 60 * 1000,
    );

    const abandoned = await this.videoRepository.find({
      where: { status: VideoStatus.UPLOADING, updated_at: LessThan(cutoff) },
    });

    if (abandoned.length === 0) {
      return { reaped: 0, abortFailures: 0 };
    }

    let abortFailures = 0;

    for (const video of abandoned) {
      if (video.storage_key && video.upload_id) {
        try {
          await this.storage.abortMultipartUpload(
            video.storage_key,
            video.upload_id,
          );
        } catch (error) {
          // A failed abort must not strand the sweep or the row: the parts are
          // unreachable without the row's `upload_id` anyway, and on real S3
          // the bucket's `AbortIncompleteMultipartUpload` rule collects them
          // (a rule this MinIO build does not implement — see TD-03's
          // revision). Drop the row and record the miss.
          abortFailures += 1;
          this.logger.warn(
            `could not abort the multipart for video "${video.id}": ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      await this.videoRepository.delete({ id: video.id });
    }

    this.logger.log(
      `reaped ${abandoned.length} abandoned upload(s) older than ${this.config.abandonedUploadCutoffHours}h` +
        (abortFailures > 0
          ? `, ${abortFailures} multipart abort(s) failed`
          : ''),
    );

    return { reaped: abandoned.length, abortFailures };
  }
}
