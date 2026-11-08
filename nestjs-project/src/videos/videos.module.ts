import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

/**
 * Owns the `Video` entity. The `forFeature` registration is what makes the
 * entity discoverable at runtime — `autoLoadEntities: true` alone does not
 * find it, and without it TypeORM cannot resolve `Channel`'s inverse
 * `@OneToMany(() => Video)` side and the whole app fails to boot.
 *
 * `ChannelsModule` is imported rather than re-registering the `Channel`
 * repository here: resolving a user's channel is channel logic, so it stays
 * behind `ChannelsService`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ChannelsModule,
    StorageModule,
    QueueModule,
  ],
  providers: [VideosService],
  exports: [TypeOrmModule, VideosService],
})
export class VideosModule {}
