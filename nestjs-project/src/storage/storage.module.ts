import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StorageService } from './storage.service';

/**
 * Single S3 adapter, pointed at MinIO locally and at real S3 in production by
 * configuration alone. There is deliberately no second "local filesystem"
 * driver: a filesystem cannot express presigned multipart or range delivery,
 * which are the two mechanisms this phase is built on.
 */
@Module({
  imports: [ConfigModule],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
