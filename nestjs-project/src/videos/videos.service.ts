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
import { PUBLIC_ID_COLUMN, PUBLIC_ID_MAX_RETRIES } from './videos.constants';

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
