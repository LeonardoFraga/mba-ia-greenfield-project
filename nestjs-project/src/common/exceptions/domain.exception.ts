export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class UploadSizeExceededException extends DomainException {
  constructor(maxBytes: number) {
    super(
      'UPLOAD_SIZE_EXCEEDED',
      413,
      `Declared upload size exceeds the ${maxBytes} byte ceiling`,
    );
  }
}

export class UnsupportedMediaTypeException extends DomainException {
  constructor(contentType: string) {
    super(
      'UNSUPPORTED_MEDIA_TYPE',
      415,
      `Content type "${contentType}" is not an accepted video container`,
    );
  }
}

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super('CHANNEL_NOT_FOUND', 404, 'Authenticated user has no channel');
  }
}

/**
 * Also thrown when a video exists but is not `ready` on a public route, so the
 * existence of a draft never leaks through a different status code.
 */
export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotOwnedException extends DomainException {
  constructor() {
    super(
      'VIDEO_NOT_OWNED',
      403,
      'Video belongs to a channel the requester does not own',
    );
  }
}

export class UploadNotInProgressException extends DomainException {
  constructor() {
    super('UPLOAD_NOT_IN_PROGRESS', 409, 'Video has no upload in progress');
  }
}

export class UploadSizeMismatchException extends DomainException {
  constructor(declared: string, actual: number) {
    super(
      'UPLOAD_SIZE_MISMATCH',
      409,
      `Stored object is ${actual} bytes but ${declared} were declared`,
    );
  }
}
