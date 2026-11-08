---
libs:
  "bullmq":
    version: "^6.7.2"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-11-08T19:09:44-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1164.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-08T19:09:44-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1164.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-08T19:09:44-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-08T19:08:46-03:00"
---

# Library References — Phase 03 (Upload e Processamento de Vídeos)

Docs cache for the libraries this phase introduces. Fetched via the context7 MCP server; module shape and `engines` verified against the npm registry.

**Module-shape check (all three are CommonJS — compatible with the project's `nodenext` + CJS emit):**

| Lib | Latest | `main` | `engines.node` |
|-----|--------|--------|----------------|
| `bullmq` | 6.7.2 | `./dist/cjs/index.js` | `>=14.18.0` |
| `@aws-sdk/client-s3` | 3.1164.0 | `./dist-cjs/index.js` | `>=20.0.0` |
| `@aws-sdk/s3-request-presigner` | 3.1164.0 | `./dist-cjs/index.js` | `>=20.0.0` |

None declares `type: module`, so no `require(esm)` interop is needed — this is the property TD-01 and TD-02 relied on when rejecting `pg-boss@12`, `@tus/server@2` and `nanoid@6`.

---

### bullmq

Introduced by `phase-03-videos/TD-01` (BullMQ 6 on the PostgreSQL backend) and `phase-03-videos/TD-11` (real `Worker` in-process in tests).

**PostgreSQL backend — `createPostgresBackend` is passed as the LAST constructor argument.** The same API runs on PostgreSQL 13+ (the project runs 17). `pg` is already installed as a TypeORM peer.

```typescript
import { Queue, Worker, createPostgresBackend } from 'bullmq';

const opts = { connection: 'postgres://user:password@db:5432/streamtube' };

const queue = new Queue('video-processing', opts, createPostgresBackend);

const worker = new Worker(
  'video-processing',
  async job => {
    // ... process the job exactly as you would with the Redis backend
  },
  opts,
  createPostgresBackend,
);
```

`connection` accepts anything node-postgres understands — a connection string, a pool config, or a `pg.Pool`. TypeScript infers the backend and connection types from the factory.

**Schema migrations are NOT automatic.** Per the official docs: "Connections do not apply migrations automatically. The migration is idempotent and concurrency-safe, but schema downgrades are not supported." Run once, as a deployment step — and, per TD-11, in test setup before the first queue is constructed:

```typescript
import { Pool } from 'pg';
import { runMigrations } from 'bullmq';

const pool = new Pool({ connectionString: 'postgres://db:5432/streamtube' });
const client = await pool.connect();
try {
  await runMigrations(client);
} finally {
  client.release();
  await pool.end();
}
```

> Note: BullMQ initializes its own `bullmq` schema through `runMigrations()`, outside the project's TypeORM migration chain. TD-01 recorded this as a known cost.

**Retry and backoff — the primitives TD-09's failure policy depends on.** Queue-level retries absorb transient faults; the row only reaches `failed` once attempts are exhausted.

```typescript
await queue.add(
  'process-video',
  { videoId },
  {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },   // 2^(attempts-1) * delay ms
    removeOnComplete: true,
    removeOnFail: 1000,
  },
);
```

`backoff` also accepts `jitter` (0–1), which randomizes the delay between the computed exponential value and that value scaled by the jitter factor.

**Worker options** include `concurrency` (number of jobs processed in parallel) and `name`. Inside the processor, `job.attemptsMade` tells you which attempt is running — useful for deciding when a failure is terminal.

**Observing completion in tests (TD-11 Option A).** `QueueEvents` reports completion and failure globally, across workers:

```typescript
import { QueueEvents } from 'bullmq';

const queueEvents = new QueueEvents('video-processing');

queueEvents.on('completed', ({ jobId, returnvalue }) => { /* ... */ });
queueEvents.on('failed', ({ jobId, failedReason }) => { /* ... */ });
queueEvents.on('progress', ({ jobId, data }) => { /* ... */ });
queueEvents.on('waiting', ({ jobId }) => { /* ... */ });
queueEvents.on('active', ({ jobId, prev }) => { /* ... */ });
```

**Test isolation.** `queue.drain()` removes waiting and delayed jobs but keeps active, completed and failed ones; `queue.obliterate()` removes the queue and all of its contents, which is what TD-11 specifies between specs.

```typescript
await queue.drain();       // waiting + delayed only
await queue.obliterate();  // everything
```

> Reminder from TD-11: close the `Worker` (and the `QueueEvents` instance) in `afterEach`, or Jest leaks handles. The suite currently runs with `--forceExit`, which would mask the leak instead of reporting it.

> `@nestjs/bullmq` is NOT used in this phase — per TD-01 it does not accept a backend factory, so `Queue` and `Worker` are hand-written providers in a `QueueModule`.

---

### @aws-sdk/client-s3

Introduced by `phase-03-videos/TD-02`, `TD-03`, `TD-06`, `TD-07`, `TD-10` and `TD-12`.

**Client against MinIO.** A custom `endpoint` overrides the default rule-based resolution; `forcePathStyle` is what makes a single-host MinIO deployment addressable, since virtual-hosted-style would require per-bucket DNS.

```typescript
import { S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: 'http://minio:9000',   // Compose service name — never localhost
  forcePathStyle: true,
  credentials: { accessKeyId: '...', secretAccessKey: '...' },
});
```

**Multipart flow (TD-02).** `CreateMultipartUploadCommand` → presigned `UploadPartCommand` URLs the client `PUT`s → `CompleteMultipartUploadCommand` with the collected ETags → `AbortMultipartUploadCommand` on failure.

`CompleteMultipartUploadRequest` takes `Bucket`, `Key`, `UploadId` and `MultipartUpload: { Parts: CompletedPart[] }`, where each `CompletedPart` carries `ETag` and `PartNumber`. `PartNumber` is "a positive integer between 1 and 10,000", and for general-purpose buckets the numbers must start at 1 and be consecutive when a checksum algorithm is applied — otherwise S3 returns `400` with `InvalidPartOrder`. The SDK's own `lib-storage` implementation sorts parts by `PartNumber` before completing and calls `AbortMultipartUploadCommand` with the retained `UploadId` whenever an uploader fails or the operation is aborted, so no uploaded parts are stranded.

**`HeadObjectCommand` — the verification step TD-12 decided on.** Returns metadata without downloading the body:

```typescript
const { ContentLength, ContentType, ETag, LastModified } = await s3.send(
  new HeadObjectCommand({ Bucket: 'videos', Key: key }),
);
```

`ContentLength` is the object size in bytes — compared against the size declared at initiate, per TD-12.

---

### @aws-sdk/s3-request-presigner

Introduced by `phase-03-videos/TD-02` (presigned part URLs), `TD-06` (presigned URL as FFmpeg input), `TD-07` (presigned GET for streaming and download) and `TD-12`.

**Load-bearing constraint — a presigned URL cannot carry size or content-type restrictions.** From the SDK source: `content-type` is added to `unsignableHeaders` in `S3RequestPresigner.prepareRequest`, and the body payload is set to `UNSIGNED-PAYLOAD`, "so Content-Length is not pre-enforced at the signature level — for Content-Length range restrictions, use `s3-presigned-post` with a `["content-length-range", min, max]` policy condition instead." To sign `content-type` anyway, pass `signableHeaders`.

This is exactly why TD-12 chose application-level enforcement: `@aws-sdk/s3-presigned-post` does support a size condition —

```typescript
type ContentLengthRangeCondition = ["content-length-range", number, number];
```

```typescript
const { url, fields } = await createPresignedPost(client, {
  Bucket, Key, Conditions, Fields, Expires: 600,   // 3600s by default
});
```

— but `createPresignedPost` produces a **single-request POST form**, which does not apply to multipart `UploadPart` calls and is capped well below 10GB. TD-02 had already ruled out every single-request design because of the 5GB single-`PUT` ceiling. Hence: declare at initiate, verify with `HeadObject` at complete.

> TTL is a security parameter per TD-07 — keep presigned GET expiry in minutes, not hours. The `s3-presigned-post` default is 3600s; set it explicitly.
