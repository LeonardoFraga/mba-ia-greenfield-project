---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-22
scope_description: "Backend foundation for video upload and processing: queue technology, 10GB upload protocol, object-storage layout, video worker process model, FFmpeg integration, media access strategy, streaming/download delivery, unique URL identifier, video status lifecycle, and the storage test strategy."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the whole phase: video module and entity, object-storage integration, upload handshake endpoints, queue producer, video worker (FFmpeg), streaming/download endpoints, and the new Compose services (storage, queue broker if any, worker).
- `next-frontend/` — **no open decision in this document.** Fase 03 has no UI capability bullet; the video surfaces (player page, upload screen, management panel) belong to Fases 04, 05 and 07. Two TDs here are marked `Cross-layer` because their contract is consumed by a client (upload handshake in TD-02, delivery mechanism in TD-07) — they are decided once, now, so the frontend inherits a settled contract when those phases start.

> **Context7 unavailable.** `CLAUDE.md` mandates library documentation lookup via the context7 MCP server, but this repository's `.mcp.json` registers only `postgres` (and `figma` in `.mcp.json.example`). Options below were researched against primary sources instead — official documentation (AWS S3, BullMQ), the npm registry (installed/latest versions, `type`, `engines`, deprecation flags), and project manifests. Add context7 to `.mcp.json` before `/implement`, where the mandate binds hardest.

**Installed stack this document is constrained by:** Node 25.6 (container base image), TypeScript 5.7 with `module: nodenext` + `moduleResolution: nodenext` (CommonJS emit), NestJS 11, TypeORM 0.3.28, PostgreSQL 17, Jest 30.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram (`docs/diagrams/software-arch.mermaid`) leaves the Message Queue container explicitly as `TBD`. This is the phase's primary stack decision: it determines whether a fourth infrastructure service joins Compose, which library the producer (API) and consumer (worker) share, and what retry/backoff/dead-letter semantics TD-09 can rely on. Expected load is a handful of jobs per minute — one per completed upload — with each job running for seconds to minutes.

**Options:**

### Option A: BullMQ 6 + Redis + `@nestjs/bullmq`
- The conventional Node path. Adds a Redis container to Compose; `@nestjs/bullmq` supplies `@Processor`/`@InjectQueue` decorators and module wiring.
- **Pros:** Best-supported combination — official NestJS wrapper, largest ecosystem (~3.2M weekly downloads), highest throughput. The project's own testing guide already documents this exact setup in `references/external-systems.md`.
- **Cons:** Adds a fourth infrastructure service purely to hold a low-volume queue. Redis is in-memory by default — durability of enqueued jobs needs deliberate persistence configuration. One more config namespace, healthcheck and env block.

### Option B: BullMQ 6 with the PostgreSQL backend
- BullMQ 6 (2026) introduced pluggable backends via an `IQueueBackend` abstraction; `createPostgresBackend` runs the identical `Queue`/`Worker`/`QueueEvents`/`FlowProducer` API on PostgreSQL, in its own `bullmq` schema. Requires PG 13+ (we run 17) and the `pg` package (already installed as a TypeORM peer).
- **Pros:** No new infrastructure — reuses the Postgres already in Compose. Full feature parity with the Redis backend (retries, backoff, delayed jobs, prioritization, deduplication, rate limiting, events, schedulers). Durable by construction (WAL/fsync), so an enqueued job survives a broker restart without extra configuration. `bullmq@6` ships CommonJS (`main: ./dist/cjs/index.js`), matching the project's `nodenext`/CJS emit.
- **Cons:** `@nestjs/bullmq@12` does not yet accept a `BackendFactory` — it still only takes Redis connection options ([nestjs/bull#2903](https://github.com/nestjs/bull/issues/2903), open since 2026-09-04). `Queue` and `Worker` must be wired as hand-written Nest providers instead of via the module's decorators. Throughput is 1.5–2× below Redis, and schema migrations are initialized by BullMQ's own `runMigrations()`, separate from the project's TypeORM migration chain.

### Option C: pg-boss 12
- A Postgres-native job queue built on `SKIP LOCKED`, with its own schema, scheduling and archival.
- **Pros:** No Redis. Mature Postgres queue semantics; smaller surface than BullMQ.
- **Cons:** No official NestJS module — all wiring is hand-written either way, so it gives up BullMQ's ecosystem without buying anything back. `pg-boss@12` is ESM-only (`type: module`, no `require` export condition, `engines.node >= 22.12`), so a `nodenext`/CJS project reaches it through Node's `require(esm)` interop — workable on Node 25 but an extra compatibility edge on every import. Roughly a tenth of BullMQ's adoption.

**Recommendation:** **Option B (BullMQ 6 + PostgreSQL backend)** — the queue carries a handful of jobs per minute, so Redis's throughput advantage buys nothing, while the fourth container costs a service, a config namespace and a healthcheck in every environment. BullMQ's PG backend is not a downgrade path: it is the same API with documented feature parity, and it is durable without tuning. The real price is the missing `@nestjs/bullmq` integration — `Queue` and `Worker` become explicit providers in a `QueueModule`, which is perhaps thirty lines and arguably clearer than decorator magic for a two-queue system. If that wiring turns out to fight the framework during implementation, Option A is the fallback and the job-handling code is unchanged, since both options are the same BullMQ API.

**Decision:** B (BullMQ 6 + PostgreSQL backend)

---

## TD-02: Large File Upload Protocol (up to 10GB)

**Scope:** Cross-layer

**Capability:** Transversal — covers: Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** This is the phase's defining non-functional requirement, and it is constrained by a hard platform limit: **a single S3 `PUT` accepts at most 5GB**, while multipart upload accepts parts of 5MB–5GB and objects far beyond 10GB. A 10GB file therefore *cannot* be one request under any scheme that ends in a plain `PUT`. The decision also fixes where the draft row is created — the handshake that starts an upload is the natural place to pre-register the video. `docs/project-plan.md` § Pontos de Atenção additionally asks that the upload "permita retomar em caso de falha de conexão". Cross-layer because the handshake sequence is implemented on both sides: the API issues and finalizes, the client slices and sends.

**Options:**

### Option A: S3 multipart upload with presigned part URLs
- The client asks the API to start an upload; the API creates the draft row, calls `CreateMultipartUpload`, and returns the `uploadId` plus a batch of presigned `UploadPart` URLs. The client `PUT`s parts directly to storage in parallel and reports back the ETags; the API calls `CompleteMultipartUpload` and enqueues the processing job.
- **Pros:** Bytes never touch the API — it handles only small JSON calls, so API memory and uptime are decoupled from a 10GB transfer. Resumable at part granularity: a failed part is re-`PUT` without restarting. Native to S3 and MinIO, with `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (both CommonJS, Node ≥20). An `AbortIncompleteMultipartUpload` lifecycle rule reclaims abandoned uploads.
- **Cons:** The most moving parts of the three: four endpoints (initiate / sign-parts / complete / abort), ETag bookkeeping, and a client that must slice the file. Requires CORS configuration on the bucket for browser `PUT`s. Orphaned drafts need a reaper when a client vanishes mid-upload.

### Option B: tus resumable upload protocol
- `@tus/server` mounted behind the API (or in its own container) speaks the tus protocol and persists to an S3 store, which internally uses multipart.
- **Pros:** Byte-level resumability — the strongest answer to the "retomar em caso de falha de conexão" note. Offset negotiation and chunking are protocol concerns, not application code; mature browser clients exist (`tus-js-client`, Uppy).
- **Cons:** Introduces a second HTTP protocol and its own auth/hook model alongside the REST API — the phase's auth (JWT guard) has to be bridged into tus hooks. `@tus/server@2` is ESM-only (`type: module`, `engines.node >= 20.19`), so it lands in the project's CJS build through `require(esm)`. If mounted inside the API process, the bytes flow through the API after all, undoing the main benefit; keeping it out means a separate container just for uploads.

### Option C: Client streams the file to the API, API pipes to storage
- One long-lived `POST` to the API, which streams the request body straight into storage without buffering to disk.
- **Pros:** Simplest contract — one endpoint, no CORS on the bucket, no presigned URLs, credentials never leave the server. Easiest to test.
- **Cons:** Fails the phase requirement. Even streamed, a 10GB transfer occupies an API connection and its event loop for the whole upload; API restarts and deploys kill in-flight uploads; nothing is resumable; scaling the API becomes a function of upload traffic rather than request traffic. The challenge brief calls this out explicitly as the path that does not qualify.

**Recommendation:** **Option A (multipart with presigned part URLs)** — the 5GB single-`PUT` ceiling removes every single-request design, so the real choice is between orchestrating S3 multipart ourselves and delegating to tus. tus buys byte-level resumption over part-level, which matters for flaky mobile networks but little for a desktop upload that can simply retry a 50MB part; in exchange it adds a second protocol, a second auth surface, and an ESM dependency to a CJS build. Option A keeps everything inside the existing REST + JWT contract, uses the AWS SDK the storage already speaks, and makes the initiate call the natural home for the draft pre-registration the phase asks for. Part size is a plan-level parameter: at 50MB parts a 10GB file is 200 parts, comfortably under the 10,000-part limit.

**Decision:** A (S3 multipart with presigned part URLs)

---

## TD-03: Object Storage Bucket and Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage backend itself is not open — the architecture fixes S3-compatible storage, realized as MinIO in Compose and swappable for S3 in production. What is open is how it is organized: buckets, key structure, and access policy. This is decided once and is expensive to change later, because keys are persisted in the video row and later phases (channel page, home grid) read thumbnails at scale. Depends on TD-02 for the multipart lifecycle rule.

**Options:**

### Option A: Single private bucket with per-artifact prefixes
- One bucket, e.g. `videos/{videoId}/source.mp4` and `thumbnails/{videoId}/default.jpg`.
- **Pros:** One bucket to create, configure and back up. Everything private by default; all reads go through the delivery mechanism chosen in TD-07. Prefixes keep a video's artifacts adjacent, so a delete is a single prefix sweep.
- **Cons:** Thumbnails inherit the video's private policy, so every thumbnail in a grid needs a signed URL — costly for a listing page in later phases, and unfriendly to CDN/browser caching.

### Option B: Separate buckets by access policy
- `streamtube-videos` (private, signed access only) and `streamtube-thumbnails` (public read), each keyed by `{videoId}/...`.
- **Pros:** Access policy lives at the bucket level instead of per object — the strongest place to enforce "video bytes are never public". Thumbnails get stable, cacheable, CDN-friendly URLs, which is exactly what the Fase 04 management panel and the Fase 07 home grid need. Different lifecycle and storage-class rules per bucket (video sources are large and cold; thumbnails are small and hot).
- **Cons:** Two buckets to provision in Compose bootstrap, in tests, and in production. A video's artifacts are split across buckets, so deletion touches two places.

### Option C: Single bucket with per-channel prefixes
- `{channelId}/{videoId}/source.mp4`.
- **Pros:** Per-channel policies and usage accounting become trivial prefix queries — useful if per-channel quotas ever appear.
- **Cons:** No such requirement exists in the project plan. Channel ownership is already a database relation; encoding it in the key duplicates it, and a future channel transfer would orphan every key.

**Recommendation:** **Option B (separate buckets by access policy)** — the two artifact classes have genuinely different access profiles, and expressing that as bucket policy is safer and cheaper than signing every thumbnail. The decisive factor is downstream: Fases 04 and 07 render grids of many thumbnails at once, and public cacheable thumbnail URLs there are the difference between one request and N signing round-trips. The cost — a second bucket in bootstrap — is a few lines in the Compose init step. Either way, the videos bucket carries an `AbortIncompleteMultipartUpload` lifecycle rule so the abandoned uploads that TD-02 Option A can leave behind do not accumulate as invisible storage.

**Decision:** B (Separate buckets by access policy)

---

## TD-04: Video Worker Process Model

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The architecture diagram shows the Video Worker as its own container, consuming from the queue and writing to storage and the database. What is open is how that container relates to the existing NestJS codebase — whether it shares it, and how it boots. This shapes the repository layout, the Dockerfile set, and whether worker code can reuse the API's services, entities and config namespaces. Depends on TD-01 for the consumer API.

**Options:**

### Option A: Separate container, same codebase, NestJS standalone application
- A second entrypoint (e.g. `src/worker.ts`) boots `NestFactory.createApplicationContext(WorkerModule)` — no HTTP listener — and the same image runs with a different command.
- **Pros:** Full reuse of entities, repositories, config namespaces, the storage service and the domain exceptions, with one `package.json`, one test suite and one type-check. The worker updates video rows through the same TypeORM entities the API uses, so the two can never drift. FFmpeg is the only extra the worker image needs on top of the API image.
- **Cons:** The API image and the worker image diverge (the worker needs FFmpeg binaries), so either both carry FFmpeg or the Dockerfile grows a second stage/target. Module boundaries must be deliberate — it is easy to accidentally import HTTP-layer code into the worker graph.

### Option B: Separate container, separate standalone project
- A sibling directory with its own `package.json`, its own TypeORM setup and its own build.
- **Pros:** Hard isolation: the worker's dependency tree and image stay minimal, and a worker crash cannot involve API code.
- **Cons:** Entities, DTOs and config would be duplicated or extracted into a shared package — a monorepo-tooling decision the project has deliberately not taken. Two test suites, two lint configs, two Definition-of-Done runs. Schema drift between two TypeORM definitions of the same tables is a real and recurring failure mode.

### Option C: In-process worker inside the API
- The API process also registers the BullMQ `Worker` and consumes its own jobs.
- **Pros:** No new container, no new image, simplest possible Compose change.
- **Cons:** FFmpeg is CPU-bound; running it inside the API starves the event loop that is serving requests, which is the exact coupling this phase exists to avoid. Contradicts the architecture diagram, and makes it impossible to scale processing independently of traffic.

**Recommendation:** **Option A (separate container, same codebase, standalone Nest app)** — it satisfies the architecture's process separation, which is the point of the phase, while keeping a single source of truth for entities and config. Option B's isolation is real but it is paying monorepo-tooling costs to solve a problem the project does not have; Option C reintroduces the coupling the phase is meant to remove. Concretely: one image built from the existing Dockerfile plus FFmpeg, two Compose services running the same image with different commands.

**Decision:** A (Separate container, same codebase, standalone Nest app)

---

## TD-05: FFmpeg Distribution and Invocation

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** Metadata extraction (`ffprobe`) and frame capture (`ffmpeg`) are the worker's actual work. Two coupled questions: where the binaries come from in the worker image, and how Node invokes them. Relevant fact: **`fluent-ffmpeg`, the long-standing Node wrapper, was archived in May 2025 and is flagged on npm as "Package no longer supported"** — the ecosystem currently has no actively maintained wrapper, so the reflex choice is no longer available. Depends on TD-04 for where this runs.

**Options:**

### Option A: Distro binaries (`apt install ffmpeg`) invoked via `child_process.spawn`
- The worker Dockerfile installs FFmpeg from the base image's package manager; the worker spawns `ffprobe -print_format json -show_format -show_streams` and parses stdout, then spawns `ffmpeg` for the thumbnail.
- **Pros:** No npm dependency and no wrapper to be abandoned. `spawn` gives exact control over arguments, stdio and timeouts, and lets a runaway job be killed. `ffprobe`'s JSON output is a stable, documented contract. The binaries are the same ones the rest of the world debugs against.
- **Cons:** The FFmpeg version is whatever the distro ships and changes when the base image changes — worth pinning deliberately. Argument construction is hand-rolled, so the codebase owns a small amount of CLI-building code.

### Option B: npm-shipped static binaries (`@ffmpeg-installer/ffmpeg`, `ffprobe-static`) + `spawn`
- The binaries arrive as npm dependencies with a resolved path, invoked the same way.
- **Pros:** Version pinned in `package-lock.json` like any other dependency — reproducible across image rebuilds without touching the Dockerfile. Works identically if anyone runs the worker outside Docker.
- **Cons:** Adds tens of megabytes of platform-specific binaries to `node_modules`, downloaded on every clean install. Ties the install to a postinstall step fetching platform binaries, which is fragile in restricted networks and on architecture changes (arm64 vs amd64 matters on Apple Silicon).

### Option C: `fluent-ffmpeg` wrapper over system binaries
- The familiar chainable API (`ffmpeg(input).screenshots({...})`) on top of Option A's binaries.
- **Pros:** Readable call sites, `ffprobe` results already parsed into objects, and an enormous corpus of examples.
- **Cons:** Archived and deprecated — no bug fixes and no security patches. Its maintainer's own stated rationale for archiving was that the package is "just a fancy command-line generator", which is precisely the value Option A gives up nothing by writing directly. Adopting a dead dependency in a greenfield phase is debt taken on knowingly.

**Recommendation:** **Option A (distro binaries + `spawn`)** — with `fluent-ffmpeg` archived, the wrapper layer is not worth resurrecting for two commands, and `spawn` is what any wrapper would have done anyway. Between distro and npm-shipped binaries, the worker only ever runs in its own container (TD-04), so the Dockerfile is already the version-pinning surface and the reproducibility argument for Option B mostly evaporates — while its multi-architecture postinstall is a real hazard on a project developed on Apple Silicon and run in Linux containers. Pin the FFmpeg version explicitly in the Dockerfile rather than inheriting whatever the base image floats to.

**Decision:** A (Distro binaries + `spawn`)

---

## TD-06: Worker Media Access Strategy

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** To read duration and codecs and to capture one frame, the worker needs the object — which may be 10GB. How it reaches those bytes decides the worker container's disk requirement and how long a job holds resources. Naively downloading every upload means provisioning scratch space for the largest file times the concurrency, to extract a few kilobytes of metadata and one frame. Depends on TD-03 (where the object lives) and TD-05 (how FFmpeg is invoked).

**Options:**

### Option A: Download the whole object to a temp volume, then process locally
- The worker `GET`s the object to disk, runs `ffprobe` and `ffmpeg` against the local path, uploads the thumbnail, and deletes the temp file.
- **Pros:** Simplest and most predictable — FFmpeg reads a local file, so seeking is free and there are no network stalls mid-process. Easy to reason about and to test.
- **Cons:** Requires up to 10GB of scratch disk per concurrent job, plus the time and bandwidth to transfer the full object before any work starts. A crashed worker leaves orphaned temp files. Almost all of that transfer is wasted: metadata lives in the header and the thumbnail needs one frame.

### Option B: Give FFmpeg a presigned GET URL and let it read over HTTP
- The worker generates a short-lived presigned URL and passes it as FFmpeg's input; FFmpeg's HTTP protocol issues range requests and seeks server-side.
- **Pros:** No scratch disk and no full transfer — typically a few megabytes read instead of gigabytes. Processing starts immediately. The worker container stays stateless, so scaling it is trivial.
- **Cons:** Sensitive to MP4 layout: if the `moov` atom sits at the end of the file (not "faststart"), FFmpeg must range-seek to the tail first, costing extra requests — correct, but slower and worth measuring. The presigned URL must outlive the job, so its TTL becomes a tuning parameter. Network hiccups now surface as FFmpeg errors mid-process rather than as a clean download failure.

### Option C: Fetch a bounded byte prefix and probe that
- Download only the first N megabytes and run `ffprobe` on the fragment.
- **Pros:** Bounded, predictable cost with no dependency on FFmpeg's HTTP support.
- **Cons:** Only works when the metadata happens to be within the prefix — for non-faststart MP4s it simply fails, and the fallback is Option A anyway. Frame capture from an arbitrary timestamp is not possible from a prefix, so the thumbnail still needs another strategy.

**Recommendation:** **Option B (presigned URL as FFmpeg input)** — the worker's job is to read a header and one frame, and Option A pays a full 10GB transfer plus matching disk for that. FFmpeg's HTTP input with range seeking is exactly the mechanism this case is designed for, and it keeps the worker container stateless, which matters directly for TD-04's separate-container model. The `moov`-at-the-end caveat is real but bounded — it costs extra range requests, not correctness — and if measurements later show it dominating, Option A remains available as a per-job fallback without changing anything else. Option C is a partial Option B that fails in exactly the cases Option B handles.

**Decision:** B (Presigned URL as FFmpeg input)

---

## TD-07: Video Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must start without downloading the whole file, which means HTTP range requests and `206 Partial Content` — a player seeks by asking for byte ranges. Download is the same bytes with different response headers. The open question is who serves those bytes. The C4 diagram already draws `Frontend → Object Storage: Streams` as a direct relation, distinct from `Frontend → API: REST`, which is a strong prior. Cross-layer because the client's `<video src>` and download link are built from whatever this decision returns.

**Options:**

### Option A: API proxies the bytes, implementing Range/206 itself
- The player points at an API endpoint; the API reads the requested range from storage and pipes it back with `Content-Range` and `206`.
- **Pros:** One origin for the client — no CORS, no URL expiry to manage. Authorization is enforced per request by the existing JWT guard, so unlisted or draft videos are naturally protected. View counting (a Fase 05 capability) has an obvious hook.
- **Cons:** Every byte watched crosses the API, so video traffic and request traffic scale together — the same coupling TD-02 rejected for uploads, now on the read side and at far higher volume. Contradicts the architecture diagram. A CDN in front of the API would be caching authenticated responses.

### Option B: API returns a short-lived presigned GET URL; storage serves the bytes
- A small API call returns a signed URL; the player uses it as its source and the storage service answers the range requests natively. Download is the same URL with `response-content-disposition=attachment`.
- **Pros:** Matches the architecture diagram exactly. S3 and MinIO implement range requests and `206` natively and well-tested, so no byte-serving code is written at all. API load stays proportional to page views, not to watch time. The URL's TTL bounds sharing, and authorization is still enforced — at the moment the URL is issued.
- **Cons:** Access is checked when the URL is minted, not on every byte, so a leaked URL is valid until it expires — TTL becomes a security parameter. Requires CORS on the bucket. View counting must hook the signing call rather than the byte stream. Two round-trips before playback starts.

### Option C: Public bucket, permanent direct URLs
- Video objects are world-readable; the API just returns the URL.
- **Pros:** Simplest and most cacheable; no signing, no expiry.
- **Cons:** Incompatible with the product: Fase 04 introduces unlisted visibility and drafts, and a permanently public URL cannot express either. Once a URL leaks it is public forever.

**Recommendation:** **Option B (short-lived presigned GET)** — it is what the architecture already specifies, and it lets storage do the one thing it is unambiguously better at than an application server: serving byte ranges of large objects. The decisive argument is load shape — under Option A the API's capacity is consumed by people watching videos, which is the opposite of the separation this phase builds everywhere else. The leaked-URL window is managed by keeping the TTL short (minutes, not hours), and it is the same trade already accepted on the upload side in TD-02. Download reuses the identical mechanism with a content-disposition override, so the two capabilities cost one implementation rather than two.

**Decision:** B (Short-lived presigned GET)

---

## TD-08: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a short, collision-free public identifier for its URL, separate from concerns like the database primary key. `docs/project-plan.md` § Pontos de Atenção asks for "uma URL curta e única que nunca conflite com outro vídeo". The identifier is persisted, indexed, and becomes permanent public API the moment a link is shared. A stack constraint shapes the library options: the project compiles to CommonJS under `module: nodenext`.

**Options:**

### Option A: `nanoid`
- The standard short-ID library; `nanoid(11)` gives a URL-safe 11-character ID from a 64-symbol alphabet.
- **Pros:** Purpose-built, audited, cryptographically strong by default, with a well-known collision-probability model. Configurable alphabet and length.
- **Cons:** `nanoid@6` is ESM-only — `type: module`, and its `exports` map offers no `require` condition — so a `nodenext`/CJS build reaches it only through Node's `require(esm)` interop. Staying on the CJS line means pinning `nanoid@3`, which is two majors behind. A dependency for roughly four lines of code.

### Option B: UUIDv4 via `crypto.randomUUID()`
- Use a second UUID column as the public identifier, or expose the primary key itself.
- **Pros:** Zero dependencies, built into Node. Collision probability is a solved question. If the primary key is reused, there is no second column and no second index at all.
- **Cons:** 36 characters, with hyphens — the opposite of the "URL curta" the plan asks for. Exposing the primary key also leaks the internal identifier into public URLs, which is a boundary worth keeping.

### Option C: `crypto.randomBytes` encoded as base64url
- `crypto.randomBytes(8).toString('base64url')` yields an 11-character URL-safe ID with 64 bits of entropy.
- **Pros:** Zero dependencies and no ESM/CJS friction — `node:crypto` is built in. Same length and the same URL-safe alphabet as a `nanoid(11)`, from the same CSPRNG. The implementation is one line, and the unique index on the column is the real collision guarantee in every option anyway.
- **Cons:** Hand-rolled rather than delegated, so the entropy reasoning lives in a comment instead of in a library's README. No built-in custom alphabet if the format ever needs to change.

### Option D: Base62-encoded database sequence
- A Postgres sequence encoded to base62 produces very short IDs (3–4 characters early on).
- **Pros:** The shortest possible URLs; guaranteed unique by construction with no randomness and no retry.
- **Cons:** Sequential and therefore enumerable — anyone can walk the catalog and discover unlisted videos, which directly conflicts with the unlisted visibility Fase 04 introduces. Also leaks total video count.

**Recommendation:** **Option C (`crypto.randomBytes` base64url)** — Options A and C produce the same thing: 11 URL-safe characters from a CSPRNG. The only difference is whether a dependency is involved, and here that dependency carries a real cost, since `nanoid@6` is ESM-only against a CommonJS build and the alternative is freezing on `nanoid@3`. Option D is disqualified by enumerability once unlisted videos exist, and Option B is simply too long for the plan's stated goal. Whichever is chosen, the column carries a unique index and the insert retries on conflict — with 64 bits of entropy that path is essentially never taken, but it is the guarantee that actually holds.

**Decision:** C (`crypto.randomBytes` base64url)

---

## TD-09: Video Status Lifecycle and Processing Failure Policy

**Scope:** Backend

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The video row is created before its bytes exist (TD-02) and is completed asynchronously by the worker (TD-04), so its state must be explicit and durable. Two coupled questions: which states exist, and what happens when processing fails — how many retries, with what backoff, and what terminal state. There is also a boundary to get right: Fase 04 introduces "Fluxo de rascunho → publicação" and public/unlisted visibility, which are *editorial* states, while this phase's states are *technical*. Conflating them now is a migration later. Depends on TD-01 for the retry primitives.

**Options:**

### Option A: Single `status` enum for the technical lifecycle
- `draft → uploading → processing → ready | failed`, with `draft` meaning "row pre-registered, upload not started". A `processing_error` column records why a `failed` video failed. BullMQ retries the job a bounded number of times with exponential backoff; only after attempts are exhausted does the row become `failed`.
- **Pros:** Directly matches the lifecycle the project plan and the phase's acceptance criteria describe. One column, one enum, one index — every query for "videos ready to watch" is a single equality check. Transient failures (a storage blip, a worker restart) are absorbed by the queue's own retry, so the row only reaches `failed` when the failure is real.
- **Cons:** Says nothing about publication, so Fase 04 must add its own column rather than extending this enum — which is the intent, but must be stated so it is not "fixed" later by merging them.

### Option B: Separate `processing_status` and `publication_status` columns now
- Split technical and editorial state from the start, anticipating Fase 04.
- **Pros:** The boundary is explicit in the schema from day one, and Fase 04 adds no migration.
- **Cons:** Builds a column this phase never writes and no endpoint reads — speculative schema for a phase whose requirements are not yet detailed. The phase's acceptance criterion asks for the technical cycle to be reflected in the database; a second empty column does not help satisfy it.

### Option C: Minimal lifecycle without an upload state
- `draft → processing → ready | failed`, treating the whole pre-completion window as `draft`.
- **Pros:** Fewer states and fewer transitions to test.
- **Cons:** Loses the distinction between "pre-registered, nothing uploaded" and "upload in flight", which is exactly what the orphan-draft reaper from TD-02 needs to decide what is safe to clean up. Collapsing them means the reaper cannot tell an abandoned handshake from an active multi-hour upload.

**Recommendation:** **Option A (single technical `status` enum)** — it is the lifecycle the plan describes, it is what the phase is evaluated against, and the `uploading` state earns its place by making abandoned uploads distinguishable from active ones, which TD-02's cleanup depends on. Option B is schema written for requirements that do not exist yet; the right way to protect that boundary is to name it — this enum describes *processing*, and Fase 04's publication flow adds its own field rather than adding values here. On failure, the split matters: queue-level retries handle transient faults invisibly, and `failed` is reserved for a genuinely unprocessable file, paired with a stored reason so the user is told something more useful than "error".

**Decision:** A (Single technical `status` enum)

---

## TD-10: Object Storage Abstraction and Test Strategy

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** This TD exists because of a direct conflict. The project's own testing guide (`testing-guide-nestjs-project`, `references/external-systems.md` § "Object Storage — Local Filesystem") prescribes a two-driver abstraction with a **local filesystem adapter in development and tests, and S3 only in production**. That guidance predates this phase and is incompatible with what the phase requires: a filesystem adapter cannot issue presigned URLs (TD-02, TD-07) and cannot serve range requests the way the delivery path assumes, so the two central mechanisms of the phase would be untested exactly where they are riskiest. Meanwhile the architecture and the phase brief both call for real object storage running in Compose. The conflict must be resolved before implementation, not discovered during it.

**Options:**

### Option A: One S3 adapter; real MinIO in Compose for dev, integration and E2E
- A single storage service speaking the S3 API via `@aws-sdk/client-s3`, pointed at MinIO locally and at S3 in production by configuration alone. Tests run against the MinIO container, with a dedicated test bucket prefix cleaned between specs.
- **Pros:** Dev and CI exercise the same API and the same code path as production — presigned URLs, multipart, and range requests are all really tested. No adapter interface to maintain and no second implementation to keep honest. Matches the phase's explicit instruction not to mock what Compose can run for real, and mirrors how Mailpit already serves the mail layer.
- **Cons:** Tests now require the MinIO container to be up, so the suite's infrastructure dependency grows (as it already did for Postgres and Mailpit). Bucket state must be cleaned between specs the way tables are. Requires updating the testing guide, which currently says otherwise.

### Option B: Keep the two-driver abstraction, test the S3 driver against MinIO
- Preserve the `StorageService` interface with both local and S3 drivers; use MinIO for the tests that matter and keep local as a no-container convenience.
- **Pros:** Honors the existing testing guide while still covering the S3 path. Contributors can run parts of the suite without MinIO.
- **Cons:** The local driver cannot implement presigned URLs or multipart at all, so the interface degenerates into "the subset both can do" plus S3-only escape hatches — the abstraction stops abstracting. Two implementations where one is structurally incapable of the phase's core operations is maintenance cost with no coverage benefit.

### Option C: Local filesystem in tests, mock presigning and range behaviour
- Follow the testing guide literally and stub the S3-specific behaviour.
- **Pros:** Fastest suite, no container dependency for storage.
- **Cons:** The phase's highest-risk logic — multipart orchestration, presigned URL correctness, range delivery — would be verified only against a mock of itself. Explicitly contrary to the phase's testing instruction.

**Recommendation:** **Option A (single S3 adapter, real MinIO in tests)** — the two-driver design in the testing guide was written for a phase where storage meant "put a file somewhere", and this phase's storage is a protocol, not a filesystem. Presigned multipart and range delivery are the parts most likely to break and least likely to be caught by review, so they are precisely what must run against a real S3 implementation; a local driver cannot even express them. MinIO is the same API as production S3, and the project already accepts this pattern for the database and for mail. The consequence is a documentation change, not just a code one: `references/external-systems.md` § "Object Storage" needs to be updated to describe MinIO, and its § "Message Queue" section — currently a Redis/BullMQ placeholder marked TBD — needs to follow whatever TD-01 decides.

**Decision:** A (Single S3 adapter, real MinIO in tests)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | B (BullMQ 6 + PostgreSQL backend) | B (BullMQ 6 + PostgreSQL backend) |
| TD-02 | Cross-layer | Large File Upload Protocol (up to 10GB) | A (S3 multipart with presigned part URLs) | A (S3 multipart with presigned part URLs) |
| TD-03 | Backend | Object Storage Bucket and Key Layout | B (separate buckets by access policy) | B (Separate buckets by access policy) |
| TD-04 | Backend | Video Worker Process Model | A (separate container, same codebase, standalone Nest app) | A (Separate container, same codebase, standalone Nest app) |
| TD-05 | Backend | FFmpeg Distribution and Invocation | A (distro binaries + `spawn`) | A (Distro binaries + `spawn`) |
| TD-06 | Backend | Worker Media Access Strategy | B (presigned URL as FFmpeg input) | B (Presigned URL as FFmpeg input) |
| TD-07 | Cross-layer | Video Streaming and Download Delivery | B (short-lived presigned GET) | B (Short-lived presigned GET) |
| TD-08 | Backend | Unique Video URL Identifier | C (`crypto.randomBytes` base64url) | C (`crypto.randomBytes` base64url) |
| TD-09 | Backend | Video Status Lifecycle and Processing Failure Policy | A (single technical `status` enum) | A (Single technical `status` enum) |
| TD-10 | Backend | Object Storage Abstraction and Test Strategy | A (single S3 adapter, real MinIO in tests) | A (Single S3 adapter, real MinIO in tests) |
