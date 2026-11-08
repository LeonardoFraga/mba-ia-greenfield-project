import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Video } from './entities/video.entity';

/**
 * Owns the `Video` entity. The `forFeature` registration below is what makes
 * the entity discoverable at runtime — `autoLoadEntities: true` alone does not
 * find it, and without it TypeORM cannot resolve `Channel`'s inverse
 * `@OneToMany(() => Video)` side and the whole app fails to boot.
 *
 * SI-03.8 extends this module with the controller and the service providers.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Video])],
  exports: [TypeOrmModule],
})
export class VideosModule {}
