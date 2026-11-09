import { IsInt, IsString, Min, MinLength, MaxLength } from 'class-validator';

export class InitiateUploadDto {
  /** Título do vídeo. */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;

  /** Tamanho declarado do arquivo, em bytes. */
  // Only type and positivity are checked here. The 10GB ceiling is enforced in
  // the service so it can answer `413 UPLOAD_SIZE_EXCEEDED` from the Error
  // Catalog instead of the generic `400` a validation failure produces — and so
  // the limit stays a config value rather than a literal in a decorator.
  @IsInt()
  @Min(1)
  size: number;

  /** Content type do container de vídeo (ex.: `video/mp4`). */
  // The allowlist check also lives in the service, for the same reason: it
  // answers `415 UNSUPPORTED_MEDIA_TYPE`.
  @IsString()
  @MinLength(1)
  contentType: string;
}
