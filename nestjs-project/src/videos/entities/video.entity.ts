import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

/**
 * Technical processing lifecycle. This enum describes *processing* only —
 * publication is editorial state and belongs to a separate field that Fase 04
 * adds, rather than new values here.
 */
export enum VideoStatus {
  /** Row pre-registered; the upload has not started. */
  DRAFT = 'draft',
  /** Multipart upload open and in flight. */
  UPLOADING = 'uploading',
  /** Bytes are in storage; the worker has been enqueued. */
  PROCESSING = 'processing',
  /** Metadata and thumbnail persisted; watchable. */
  READY = 'ready',
  /** Genuinely unprocessable after the queue exhausted its attempts. */
  FAILED = 'failed',
}

/** Container types accepted at the upload handshake. */
export const ALLOWED_VIDEO_CONTENT_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/webm',
] as const;

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  /**
   * The unique, unguessable identifier the public URL is built from: 11
   * URL-safe characters from `crypto.randomBytes(8)` base64url. The unique
   * index is the guarantee that actually holds — the insert retries on
   * conflict, a path 64 bits of entropy make essentially unreachable.
   */
  @Column({ type: 'varchar', length: 16, unique: true })
  public_id: string;

  @Index()
  @Column({ type: 'enum', enum: VideoStatus, default: VideoStatus.DRAFT })
  status: VideoStatus;

  /** Why a `failed` video failed, so the user is told more than "error". */
  @Column({ type: 'text', nullable: true })
  processing_error: string | null;

  /** Object key in the private videos bucket. */
  @Column({ type: 'varchar', length: 512, nullable: true })
  storage_key: string | null;

  /** Object key in the public, cacheable thumbnails bucket. */
  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnail_key: string | null;

  /** S3 `UploadId`, retained so complete and abort can address the upload. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  /**
   * Size and content type as declared by the client at initiate. `bigint`
   * because 10GB overflows `integer`; TypeORM maps it to `string` in JS, so
   * callers convert at the boundary instead of doing arithmetic on the column.
   */
  @Column({ type: 'bigint', nullable: true })
  declared_size_bytes: string | null;

  @Column({ type: 'varchar', length: 127, nullable: true })
  declared_content_type: string | null;

  /** Real size, read from `HeadObject.ContentLength` at complete. */
  @Column({ type: 'bigint', nullable: true })
  size_bytes: string | null;

  @Column({ type: 'numeric', precision: 10, scale: 3, nullable: true })
  duration_seconds: string | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  /**
   * The `ffprobe` long tail — container, video codec, audio codec, bitrate,
   * framerate. Discrete columns above carry what Fases 04 and 05 query; this
   * absorbs the rest so a new field does not force a migration.
   */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
