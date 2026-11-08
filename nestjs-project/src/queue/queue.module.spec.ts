import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { VideoProcessingQueue } from './video-processing.queue';

describe('QueueModule', () => {
  it('should compile and expose VideoProcessingQueue', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    expect(module.get(VideoProcessingQueue)).toBeInstanceOf(
      VideoProcessingQueue,
    );
    await module.close();
  }, 30000);

  it('should not pull @nestjs/bullmq into the dependency tree', () => {
    // TD-14 excluded it: the package is `type: module` with its `require`
    // export condition pointing at the ESM build, which this CommonJS project
    // reaches only through require(esm) interop.
    // Read from disk rather than importing: `resolveJsonModule` is off in this
    // tsconfig, and a `require()` import is forbidden by ESLint.
    const manifestPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(pkg.dependencies?.['@nestjs/bullmq']).toBeUndefined();
    expect(pkg.devDependencies?.['@nestjs/bullmq']).toBeUndefined();
    // Sanity: the manifest really was read, so the assertions above are not
    // passing on an empty object.
    expect(pkg.dependencies?.bullmq).toBeDefined();
  });
});
