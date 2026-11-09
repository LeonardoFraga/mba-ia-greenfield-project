import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import appConfig from '../../config/app.config';
import databaseConfig from '../../config/database.config';
import { envValidationSchema } from '../../config/env.validation';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import { Channel } from '../../channels/entities/channel.entity';
import { DatabaseModule } from '../../database/database.module';
import { StorageModule } from '../../storage/storage.module';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';

/**
 * Root module of the video worker — a separate process from the same codebase,
 * started with a different command against the same image (TD-04).
 *
 * It deliberately does NOT import `AppModule`: the worker exposes no HTTP
 * surface, so it loads only config, the database connection, the storage
 * adapter and its own entity. No controllers, no guards, no Swagger.
 *
 * SI-03.11 adds the processor provider and the real BullMQ `Worker` here.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, queueConfig, storageConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    DatabaseModule,
    // `Video` is what the worker reads and writes, but `autoLoadEntities` only
    // discovers what some module registers — and TypeORM cannot build
    // `Video#channel` without `Channel`, nor `Channel#user` without `User`.
    // Registering the relation closure is what makes the context boot.
    TypeOrmModule.forFeature([Video, Channel, User]),
    StorageModule,
  ],
})
export class WorkerModule {}
