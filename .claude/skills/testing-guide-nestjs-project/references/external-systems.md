> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. These strategies were confirmed with the team.

---

## PostgreSQL — Real (Docker)

**Strategy:** Real database via the Docker `db` service (already in `compose.yaml`).

**Connection config for tests:**
```typescript
{
  type: 'postgres',
  host: process.env.DB_HOST ?? 'db',          // Compose service name, never localhost
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'streamtube',
  password: process.env.DB_PASSWORD ?? 'streamtube',
  database: process.env.DB_DATABASE ?? 'streamtube',
  synchronize: true, // auto-create tables in test setup
}
```

**Test isolation:**
- Use `dataSource.query('DELETE FROM "table_name"')` to clean tables between tests
- Do NOT use `repository.delete({})` — throws `Empty criteria(s) are not allowed`
- Alternative: `repository.clear()` (truncates the table)
- For complex foreign key chains, delete in reverse dependency order or use `TRUNCATE ... CASCADE`
- Use `beforeEach` for cleanup to ensure each test starts with a clean state

**Entity setup:**
- Use `synchronize: true` in test DataSource to auto-create tables from entities
- For integration tests, import only the entities needed by the test — not all entities
- For E2E tests, import `AppModule` which includes all entities via their domain modules

---

## Object Storage — Local Filesystem

**Strategy:** Local filesystem storage in development and tests. S3 in production.

**Approach:**
- The storage layer should use an abstraction (e.g., `StorageService` interface) that allows switching between local filesystem and S3
- In tests, use the local filesystem adapter — no mocking needed
- Use a temporary directory for test uploads: `os.tmpdir()` or a dedicated `test-uploads/` directory
- Clean up test files in `afterAll`

**Setup pattern:**
```typescript
// In test module setup
{
  provide: 'STORAGE_CONFIG',
  useValue: {
    driver: 'local',
    basePath: path.join(os.tmpdir(), 'streamtube-test-uploads'),
  },
}
```

**Integration test:**
```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('StorageService (integration)', () => {
  const testDir = path.join(os.tmpdir(), 'streamtube-test-uploads');

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should upload and retrieve a file', async () => {
    const buffer = Buffer.from('test content');
    const key = await storageService.upload(buffer, 'test.txt');

    const retrieved = await storageService.get(key);
    expect(retrieved.toString()).toBe('test content');
  });
});
```

---

## Message Queue — Real (Docker)

**Strategy:** real broker in Docker — **Redis with BullMQ 6** (`phase-03-videos/TD-14`). Never mock the queue: `redis` is a Compose service and both sides are exercisable for real.

**What this project does NOT use:** `@nestjs/bullmq`. It is `type: module` with its `require` condition pointing at the ESM build, and this project emits CommonJS — so there is no `BullModule`, no `registerQueue` and no `getQueueToken`. `Queue` and `Worker` are hand-written providers (`src/queue/`, `src/videos/worker/`). Reach for `src/config/queue.config.ts` for the connection, never a literal host, and never `localhost` — the host is the Compose service name.

**Test queue namespace.** `src/test/jest-queue-namespace.ts` runs after `dotenv/config` in both Jest configs and rewrites `QUEUE_VIDEO_PROCESSING_NAME` to `<name>-test`. This is load-bearing: the `video-worker` container drains the real queue, so a producer spec asserting `getJobs(['waiting'])` would otherwise race a live consumer. Read the queue name from config so your spec follows the namespace.

**Producer side** — import `QueueModule` and assert what was enqueued:

```typescript
const module = await Test.createTestingModule({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
    QueueModule,
  ],
}).compile();

const producer = module.get(VideoProcessingQueue);
await producer.enqueue({ videoId, storageKey });

const waiting = await producer.queue.getJobs(['waiting']);
expect(waiting).toHaveLength(1);
expect(waiting[0].data).toEqual({ videoId, storageKey });
```

**Consumer side** — register the real `Worker` and observe completion on `QueueEvents`. `compile()` does not run lifecycle hooks and the `Worker` starts in `onModuleInit`, so `await module.init()` is required or nothing drains:

```typescript
const module = await Test.createTestingModule({
  imports: [/* config, TypeORM, StorageModule, QueueModule */],
  providers: [VideoProcessingProcessor, VideoProcessingWorker],
}).compile();
await module.init();

const queueEvents = new QueueEvents(producer.queue.name, { connection });
await queueEvents.waitUntilReady();

const jobId = await producer.enqueue(data);
// resolve on 'completed' / 'failed' for this jobId, with a timeout
```

**Isolation and teardown:**
- `await producer.queue.obliterate({ force: true })` in `beforeEach` — `drain()` only removes waiting and delayed jobs, leaving active, completed and failed ones behind.
- Close the `QueueEvents` instance explicitly, and `module.close()` to trigger `onModuleDestroy` on the `Queue` and the `Worker`. Without it Jest leaks a handle, and the suite's `--forceExit` would hide the leak rather than report it.
- `attemptsMade` inside a processor counts the failures already recorded (0, 1, 2 for `attempts: 3`), so the final attempt is where `attemptsMade + 1` reaches `attempts`.

---

## Email — Mailpit (Real SMTP Capture)

**Strategy:** Mailpit — a local SMTP server that captures all emails for inspection via its API. No emails are actually delivered.

**Setup:**
- Add Mailpit to `compose.yaml`:
```yaml
mailpit:
  image: axllent/mailpit
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI / API
```

**NestJS configuration:**
```typescript
// In mail module or config
{
  transport: {
    host: process.env.MAIL_HOST ?? 'mailpit', // Compose service name, never localhost
    port: Number(process.env.SMTP_PORT ?? 1025),
  },
}
```

**Integration test:**
```typescript
describe('MailService (integration)', () => {
  beforeEach(async () => {
    // Clear all captured emails via Mailpit API
    await clearMailpitMessages(); // src/test/mailpit.ts wraps the REST API
  });

  it('should send confirmation email', async () => {
    await mailService.sendConfirmation('user@test.com', 'token-123');

    // Query Mailpit API for captured emails
    const messages = await getMailpitMessages(); // src/test/mailpit.ts

    expect(messages).toHaveLength(1);
    expect(messages[0].To[0].Address).toBe('user@test.com');
    expect(messages[0].Subject).toContain('confirm');
  });
});
```

**Key points:**
- Mailpit captures ALL emails — no mocking, no side effects
- Use the existing `src/test/mailpit.ts` helper (`getMailpitMessages`, `getMailpitMessage`, `clearMailpitMessages`) rather than calling `fetch` by hand — it resolves the host from `MAIL_HOST` (default `mailpit`). Tests run **inside** the container, so `localhost:8025` would be the container itself, not Mailpit
- Clear captured emails in `beforeEach` to ensure test isolation
- Web UI at `http://localhost:8025` for manual debugging **from the host** (the published port)
- Tests the full SMTP transport path — if the SMTP config is wrong, the test fails
