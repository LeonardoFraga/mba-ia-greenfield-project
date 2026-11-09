import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './videos/worker/worker.module';

/**
 * Entry point of the `video-worker` Compose service.
 *
 * `createApplicationContext` rather than `create`: the worker has no HTTP
 * surface, so no server is opened and no port is bound.
 */
async function bootstrap(): Promise<void> {
  const context = await NestFactory.createApplicationContext(WorkerModule);

  // Makes `onModuleDestroy` run on SIGTERM, which is what closes the BullMQ
  // Worker and its Redis connection cleanly when Compose stops the container.
  context.enableShutdownHooks();

  new Logger('VideoWorker').log('Video worker context started');
}

void bootstrap();
