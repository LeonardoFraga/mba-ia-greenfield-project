import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';

/** Which configured bucket an operation addresses. */
export type StorageBucket = 'videos' | 'thumbnails';

/** One finished part, as `CompleteMultipartUpload` expects it. */
export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface HeadObjectResult {
  contentLength: number;
  contentType: string | undefined;
}

export interface SignedUrl {
  url: string;
  expiresIn: number;
}

@Injectable()
export class StorageService implements OnModuleDestroy {
  /** Server-side calls: reaches storage over the Compose network. */
  private readonly client: S3Client;
  /**
   * Signs URLs that leave the network.
   *
   * SigV4 covers the `Host` header, so the host baked into a presigned URL
   * cannot be swapped afterwards — rewriting it yields
   * `SignatureDoesNotMatch`. A URL signed against the internal endpoint is
   * therefore unusable by a browser, which is why the signing endpoint is a
   * separate concern from the one server-side calls use (TD-10 revision).
   * In production both env vars name the same public S3 endpoint and the two
   * clients coincide.
   */
  private readonly signer: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    const common = {
      region: config.region,
      // Single-host MinIO is not addressable virtual-hosted-style without
      // per-bucket DNS, so path style is required locally and harmless on S3.
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    };

    this.client = new S3Client({ ...common, endpoint: config.endpoint });
    this.signer = new S3Client({ ...common, endpoint: config.publicUrl });
  }

  onModuleDestroy(): void {
    this.client.destroy();
    this.signer.destroy();
  }

  private bucketName(bucket: StorageBucket): string {
    return bucket === 'videos'
      ? this.config.videosBucket
      : this.config.thumbnailsBucket;
  }

  /**
   * Opens a multipart upload and returns its `UploadId`. The bytes never pass
   * through the API: the client PUTs each part straight to storage using the
   * URLs `signUploadPart` mints.
   */
  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const response = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucketName('videos'),
        Key: key,
        ContentType: contentType,
      }),
    );

    if (!response.UploadId) {
      throw new Error(
        `CreateMultipartUpload returned no UploadId for key "${key}"`,
      );
    }
    return response.UploadId;
  }

  /**
   * Presigns one `UploadPart` request.
   *
   * Note what this URL cannot do: the SDK signs the payload as
   * `UNSIGNED-PAYLOAD` and treats `content-type` as unsignable, so the URL
   * constrains neither the size nor the type of what is sent. That is why the
   * upload ceiling is enforced by the application at initiate and verified
   * against `headObject` at complete.
   */
  async signUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<SignedUrl> {
    const url = await getSignedUrl(
      this.signer,
      new UploadPartCommand({
        Bucket: this.bucketName('videos'),
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.config.presignTtlSeconds },
    );

    return { url, expiresIn: this.config.presignTtlSeconds };
  }

  /** Finalizes the upload. Parts are sorted by number, as S3 requires. */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);

    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucketName('videos'),
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: sorted.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
  }

  /** Discards an upload and every part already stored for it. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucketName('videos'),
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /** How many parts are currently stored for an open upload. */
  async countUploadedParts(key: string, uploadId: string): Promise<number> {
    const response = await this.client.send(
      new ListPartsCommand({
        Bucket: this.bucketName('videos'),
        Key: key,
        UploadId: uploadId,
      }),
    );
    return response.Parts?.length ?? 0;
  }

  /**
   * Reads object metadata without downloading the body — the check that makes
   * the declared upload size verifiable.
   */
  async headObject(
    key: string,
    bucket: StorageBucket = 'videos',
  ): Promise<HeadObjectResult> {
    const response = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucketName(bucket), Key: key }),
    );

    return {
      contentLength: Number(response.ContentLength ?? 0),
      contentType: response.ContentType,
    };
  }

  /**
   * Mints a short-lived GET **for a client outside the network** — a player or
   * a browser. Storage answers `Range` requests on this URL with
   * `206 Partial Content` natively, which is what makes playback possible
   * without downloading the whole object.
   *
   * `downloadFilename` turns the same URL into a download by overriding
   * content-disposition — one mechanism serving both capabilities.
   *
   * Signed against the public endpoint. For a URL consumed *inside* the
   * network, such as the worker handing it to FFmpeg, use
   * `signInternalGetObject`.
   */
  async signGetObject(
    key: string,
    options: { bucket?: StorageBucket; downloadFilename?: string } = {},
  ): Promise<SignedUrl> {
    const { bucket = 'videos', downloadFilename } = options;

    const url = await getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucketName(bucket),
        Key: key,
        ...(downloadFilename !== undefined && {
          ResponseContentDisposition: `attachment; filename="${downloadFilename}"`,
        }),
      }),
      { expiresIn: this.config.presignTtlSeconds },
    );

    return { url, expiresIn: this.config.presignTtlSeconds };
  }

  /**
   * Mints a short-lived GET **for a consumer inside the network** — today the
   * worker, which hands the URL to `ffprobe` and `ffmpeg` as an HTTP input.
   *
   * It must be signed against the internal endpoint: the worker resolves the
   * Compose service name, and the public endpoint (`localhost` in local
   * development) would point FFmpeg at the worker's own container.
   */
  async signInternalGetObject(
    key: string,
    bucket: StorageBucket = 'videos',
  ): Promise<SignedUrl> {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucketName(bucket), Key: key }),
      { expiresIn: this.config.presignTtlSeconds },
    );

    return { url, expiresIn: this.config.presignTtlSeconds };
  }

  /** Single-request upload. Used by the worker for the generated thumbnail. */
  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
    bucket: StorageBucket = 'thumbnails',
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName(bucket),
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /** Removes a stored object. Idempotent on S3 — a missing key is not an error. */
  async deleteObject(
    key: string,
    bucket: StorageBucket = 'videos',
  ): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucketName(bucket), Key: key }),
    );
  }

  /**
   * Permanent public URL for a thumbnail. Built from the browser-reachable
   * base URL, not the Compose service name, because a browser consumes it.
   */
  publicThumbnailUrl(key: string): string {
    const base = this.config.publicUrl.replace(/\/+$/, '');
    return `${base}/${this.config.thumbnailsBucket}/${key}`;
  }
}
