import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppModule } from '../../app.module';
import { StorageService } from '../../storage/storage.service';
import { Video } from '../entities/video.entity';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile with the database, storage and the Video relation closure', async () => {
    // Real compilation against the `db` container: the point of this test is
    // that TypeORM can build the metadata for `Video` and everything it
    // relates to, which is what crashed the worker before `Channel` and `User`
    // were registered.
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
    expect(module.get(getRepositoryToken(Video))).toBeDefined();

    await module.close();
  }, 60000);

  it('should not pull the HTTP surface into the worker', () => {
    // The worker is a separate process with no HTTP surface (TD-04). Importing
    // AppModule here would drag controllers, guards and Swagger along.
    const workerImports = Reflect.getMetadata(
      'imports',
      WorkerModule,
    ) as unknown[];

    expect(workerImports).not.toContain(AppModule);
  });
});
