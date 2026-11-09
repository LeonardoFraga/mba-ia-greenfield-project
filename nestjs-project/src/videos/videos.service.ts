import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-error.util';
import {
  ChannelNotFoundException,
  UnsupportedMediaTypeException,
  UploadNotInProgressException,
  UploadSizeExceededException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotOwnedException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { VideoProcessingQueue } from '../queue/video-processing.queue';
import type { SignedUrl } from '../storage/storage.service';
import { StorageService } from '../storage/storage.service';
import type { CompleteUploadDto } from './dto/complete-upload.dto';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import type { SignPartsDto } from './dto/sign-parts.dto';
import {
  ALLOWED_VIDEO_CONTENT_TYPES,
  Video,
  VideoStatus,
} from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import {
  CONTENT_TYPE_EXTENSIONS,
  DEFAULT_DOWNLOAD_EXTENSION,
  PUBLIC_ID_COLUMN,
  PUBLIC_ID_MAX_RETRIES,
} from './videos.constants';

/**
 * Builds a safe download filename from the title. The title is user input, so
 * it is reduced to a conservative character set before it reaches a
 * `Content-Disposition` header.
 */
function buildDownloadFilename(
  title: string,
  contentType: string | null,
): string {
  const slug =
    title
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
      .toLowerCase() || 'video';

  const extension =
    (contentType && CONTENT_TYPE_EXTENSIONS[contentType]) ??
    DEFAULT_DOWNLOAD_EXTENSION;

  return `${slug}.${extension}`;
}

export interface InitiateUploadResult {
  id: string;
  publicId: string;
  uploadId: string;
  partSize: number;
  partCount: number;
  status: VideoStatus;
}

export interface SignedPart {
  partNumber: number;
  url: string;
  expiresIn: number;
}

export interface CompleteUploadResult {
  id: string;
  publicId: string;
  status: VideoStatus;
}

/** Public projection of a ready video. Deliberately omits storage internals. */
export interface PublicVideo {
  publicId: string;
  title: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  createdAt: Date;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storage: StorageService,
    private readonly processingQueue: VideoProcessingQueue,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  /**
   * Opens an upload: validates the declared size and container, pre-registers
   * the video as a draft, opens the S3 multipart upload and moves the row to
   * `uploading`.
   *
   * The ceiling and the allowlist are checked *before* anything is created, so
   * a rejected request leaves neither a row nor an open multipart upload.
   */
  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    if (dto.size > this.config.maxUploadBytes) {
      throw new UploadSizeExceededException(this.config.maxUploadBytes);
    }

    const allowed: readonly string[] = ALLOWED_VIDEO_CONTENT_TYPES;
    if (!allowed.includes(dto.contentType)) {
      throw new UnsupportedMediaTypeException(dto.contentType);
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    // Born as `draft` — this is the "pré-cadastro automático como rascunho"
    // the phase asks for. It becomes `uploading` once the multipart is open.
    const video = await this.insertDraftWithUniquePublicId(
      channel.id,
      dto.title,
      dto.size,
      dto.contentType,
    );

    const storageKey = `${video.id}/source`;

    let uploadId: string;
    try {
      uploadId = await this.storage.createMultipartUpload(
        storageKey,
        dto.contentType,
      );
    } catch (err) {
      // Compensation: a failed handshake must not leave an orphan draft that
      // the reaper would later have to reason about.
      await this.videoRepository.delete({ id: video.id });
      throw err;
    }

    video.storage_key = storageKey;
    video.upload_id = uploadId;
    video.status = VideoStatus.UPLOADING;
    await this.videoRepository.save(video);

    const partSize = this.config.uploadPartSizeBytes;

    return {
      id: video.id,
      publicId: video.public_id,
      uploadId,
      partSize,
      partCount: Math.ceil(dto.size / partSize),
      status: video.status,
    };
  }

  /** Mints presigned `UploadPart` URLs for an upload already in flight. */
  async signParts(
    userId: string,
    videoId: string,
    dto: SignPartsDto,
  ): Promise<SignedPart[]> {
    const video = await this.findOwnedVideo(userId, videoId);
    this.assertUploadInProgress(video);

    const storageKey = video.storage_key as string;
    const uploadId = video.upload_id as string;

    return Promise.all(
      dto.partNumbers.map(async (partNumber) => {
        const { url, expiresIn } = await this.storage.signUploadPart(
          storageKey,
          uploadId,
          partNumber,
        );
        return { partNumber, url, expiresIn };
      }),
    );
  }

  /**
   * Finalizes the upload, verifies the stored object against what was
   * declared, and only then enqueues processing.
   *
   * Note on sequencing: the size can only be read after the parts are
   * assembled, so verification necessarily happens *after*
   * `CompleteMultipartUpload`. TD-12's prose says a mismatch "aborts the
   * multipart upload", which is not possible at that point — the upload no
   * longer exists, the object does. The equivalent cleanup is deleting the
   * object, which is what happens here; the observable outcome the Error
   * Catalog specifies (`409`, row `failed` with a reason, nothing enqueued) is
   * unchanged.
   */
  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.findOwnedVideo(userId, videoId);
    this.assertUploadInProgress(video);

    const storageKey = video.storage_key as string;
    const uploadId = video.upload_id as string;

    await this.storage.completeMultipartUpload(
      storageKey,
      uploadId,
      dto.parts.map((part) => ({
        partNumber: part.partNumber,
        etag: part.etag,
      })),
    );

    const { contentLength } = await this.storage.headObject(storageKey);
    const declared = Number(video.declared_size_bytes ?? '0');

    if (
      contentLength !== declared ||
      contentLength > this.config.maxUploadBytes
    ) {
      await this.storage.deleteObject(storageKey);

      video.status = VideoStatus.FAILED;
      video.processing_error =
        contentLength > this.config.maxUploadBytes
          ? `Stored object is ${contentLength} bytes, above the ${this.config.maxUploadBytes} byte ceiling`
          : `Stored object is ${contentLength} bytes but ${declared} were declared`;
      video.upload_id = null;
      await this.videoRepository.save(video);

      throw new UploadSizeMismatchException(String(declared), contentLength);
    }

    video.size_bytes = String(contentLength);
    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    await this.videoRepository.save(video);

    await this.processingQueue.enqueue({
      videoId: video.id,
      storageKey,
    });

    return {
      id: video.id,
      publicId: video.public_id,
      status: video.status,
    };
  }

  /** Aborts an in-flight upload and discards the draft row. */
  async abortUpload(userId: string, videoId: string): Promise<void> {
    const video = await this.findOwnedVideo(userId, videoId);

    if (video.storage_key && video.upload_id) {
      await this.storage.abortMultipartUpload(
        video.storage_key,
        video.upload_id,
      );
    }

    await this.videoRepository.delete({ id: video.id });
  }

  /** Public metadata for a ready video. */
  async findPublicByPublicId(publicId: string): Promise<PublicVideo> {
    const video = await this.findReadyByPublicId(publicId);

    return {
      publicId: video.public_id,
      title: video.title,
      // `numeric` and `bigint` arrive as strings from the driver.
      durationSeconds:
        video.duration_seconds === null ? null : Number(video.duration_seconds),
      width: video.width,
      height: video.height,
      thumbnailUrl: video.thumbnail_key
        ? this.storage.publicThumbnailUrl(video.thumbnail_key)
        : null,
      createdAt: video.created_at,
    };
  }

  /**
   * Short-lived presigned GET for playback. Storage answers `Range` requests
   * on this URL natively, so the API never serves video bytes.
   */
  async streamUrl(publicId: string): Promise<SignedUrl> {
    const video = await this.findReadyByPublicId(publicId);
    return this.storage.signGetObject(video.storage_key as string);
  }

  /** The same mechanism with a content-disposition override. */
  async downloadUrl(publicId: string): Promise<SignedUrl> {
    const video = await this.findReadyByPublicId(publicId);

    return this.storage.signGetObject(video.storage_key as string, {
      downloadFilename: buildDownloadFilename(
        video.title,
        video.declared_content_type,
      ),
    });
  }

  /**
   * The single authorization gate for every public route.
   *
   * It authorizes on **state, not identity**: a URL is issued only when the
   * video is `ready`, and every other status answers the same
   * `VIDEO_NOT_FOUND` as a `publicId` that never existed — so the existence of
   * a draft never leaks. Keeping it in one place is deliberate: Fase 04 will
   * tighten this rule when it introduces visibility, and one call site is one
   * edit instead of three.
   */
  private async findReadyByPublicId(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
    });

    if (!video || video.status !== VideoStatus.READY || !video.storage_key) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  /**
   * Loads a video and asserts the caller owns the channel it belongs to.
   *
   * Absence and non-ownership are deliberately different exceptions here —
   * these are authenticated, owner-scoped routes, so telling the owner that
   * someone else's video exists is not a leak. The public routes collapse both
   * into `VIDEO_NOT_FOUND`.
   */
  private async findOwnedVideo(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
      relations: ['channel'],
    });

    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel.user_id !== userId) {
      throw new VideoNotOwnedException();
    }
    return video;
  }

  private assertUploadInProgress(video: Video): void {
    if (
      video.status !== VideoStatus.UPLOADING ||
      !video.storage_key ||
      !video.upload_id
    ) {
      throw new UploadNotInProgressException();
    }
  }

  /**
   * Inserts the draft, regenerating the public id on collision.
   *
   * No enclosing transaction, so a unique violation does not poison a
   * surrounding transaction and no SAVEPOINT dance is needed: each attempt is
   * a standalone insert. With 64 bits of entropy the retry path is
   * essentially never taken — the unique index plus this loop is the
   * guarantee that actually holds.
   */
  private async insertDraftWithUniquePublicId(
    channelId: string,
    title: string,
    size: number,
    contentType: string,
  ): Promise<Video> {
    for (let attempt = 0; attempt < PUBLIC_ID_MAX_RETRIES; attempt++) {
      const candidate = this.videoRepository.create({
        channel_id: channelId,
        title,
        public_id: generatePublicId(),
        status: VideoStatus.DRAFT,
        declared_size_bytes: String(size),
        declared_content_type: contentType,
      });

      try {
        return await this.videoRepository.save(candidate);
      } catch (err) {
        if (!isPgUniqueViolationOnColumn(err, PUBLIC_ID_COLUMN)) {
          throw err;
        }
      }
    }

    throw new Error(
      `Could not allocate a unique public_id after ${PUBLIC_ID_MAX_RETRIES} attempts`,
    );
  }
}
