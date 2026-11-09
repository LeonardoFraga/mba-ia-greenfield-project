import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { VideoProcessingQueue } from './video-processing.queue';

/**
 * Queue wiring, hand-written on purpose.
 *
 * There is no `BullModule` here and no `createPostgresBackend`: TD-14 chose a
 * dedicated Redis service, and `@nestjs/bullmq` is `type: module` with its
 * `require` export condition pointing at the ESM build, which this
 * `nodenext`/CommonJS project reaches only through `require(esm)` interop.
 * BullMQ's own `runMigrations()` bootstrap does not apply either — that step
 * exists only for the PostgreSQL backend.
 */
@Module({
  imports: [ConfigModule],
  providers: [VideoProcessingQueue],
  exports: [VideoProcessingQueue],
})
export class QueueModule {}
