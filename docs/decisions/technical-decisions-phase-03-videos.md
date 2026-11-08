---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-09-22
scope_description: "Backend foundation for video upload and processing: queue technology and broker deployment shape, 10GB upload protocol, object-storage layout, video worker process model, FFmpeg integration, media access strategy, streaming/download delivery, unique URL identifier, video status lifecycle, the storage test strategy, the queue test strategy, upload size/content-type enforcement, and the authorization policy for media delivery."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the whole phase: video module and entity, object-storage integration, upload handshake endpoints, queue producer, video worker (FFmpeg), streaming/download endpoints, and the new Compose services (storage, queue broker if any, worker).
- `next-frontend/` — **no open decision in this document.** Fase 03 has no UI capability bullet; the video surfaces (player page, upload screen, management panel) belong to Fases 04, 05 and 07. Four TDs here are marked `Cross-layer` because their contract is consumed by a client (upload handshake in TD-02 and its size/content-type enforcement in TD-12, delivery mechanism in TD-07 and its authorization policy in TD-13) — they are decided once, now, so the frontend inherits a settled contract when those phases start.

> **Library documentation provenance.** TD-01–TD-10 were researched while the context7 MCP server was not registered in this repository's `.mcp.json`; their options were checked against primary sources instead — official documentation (AWS S3, BullMQ), the npm registry (installed/latest versions, `type`, `engines`, deprecation flags), and project manifests. context7 is registered and available as of TD-11–TD-13, which were researched against it: BullMQ 6.5.3 (PostgreSQL backend, `runMigrations`, `QueueEvents`, `drain`/`obliterate`) and the AWS SDK v3 presigning packages (`s3-request-presigner` header rules, `HeadObject`, `s3-presigned-post` `content-length-range`).

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

**Revisions:**
- 2026-11-08 — Testing-guide override recorded: `testing-guide-nestjs-project/references/external-systems.md` § "Message Queue" still prescribes Redis with `BullModule.forRoot`, and the guide's § 2 cites `BullModule.registerQueue()` as the module-wiring example; neither applies to this decision. The phase artifacts are authoritative — no `BullModule`, no Redis service, `Queue` and `Worker` as hand-written providers against the PostgreSQL backend. Rationale: path moved to follow ownership convention — `.claude/skills/` is provided foundation outside this phase's deliverable, so correcting the guide is tracked as a separate task per `CLAUDE.md` § Scope Limits.

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

**Revisions:**
- 2026-11-08 — Strict-BFF exception recorded: the inherited strict-BFF model (`next-frontend-config-base/TD-03`, carried into this phase by `phase-02-auth-frontend/TD-01`) governs calls to the NestJS API, and presigned storage URLs minted server-side fall outside its scope — so the browser `PUT`ting parts directly to object storage does not violate it. Rationale: param tightened by new policy — the exception is deliberately narrow and travels with this cross-layer contract, so Fases 04/05/07 inherit both together instead of discovering the conflict when the upload screen is built.

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

**Revisions:**
- 2026-11-08 — Thumbnail invocation parameters fixed: one frame seeked at 10% of the duration reported by `ffprobe`, scaled to 1280x720 preserving aspect ratio, encoded as JPEG at a fixed quality. Rationale: param tightened by new policy — a percentage never falls outside the file (a two-second clip and a two-hour film both resolve), unlike a fixed timestamp, and a single seek stays cheap over TD-06's presigned-URL input.
- 2026-11-08 — Persisted metadata set fixed as a hybrid: discrete columns for what is queried or displayed (`duration_seconds`, `width`, `height`, `size_bytes`) plus a `jsonb` `metadata` column for the `ffprobe` long tail (container, video codec, audio codec, bitrate, framerate). Rationale: param tightened by new policy — indexes the fields Fases 04 and 05 consume without forcing a migration for every additional field `ffprobe` starts returning.

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

**Revisions:**
- 2026-11-08 — Strict-BFF exception recorded: as on TD-02, the inherited strict-BFF model governs calls to the NestJS API only; a presigned GET minted server-side and consumed by the player as its `src` is outside that scope, so direct browser-to-storage range requests do not violate it. Rationale: param tightened by new policy — recorded here as well as on TD-02 because the two cross-layer contracts are inherited independently by different frontend phases.

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

**Revisions:**
- 2026-11-08 — Testing-guide override recorded: `references/external-systems.md` § "Object Storage" and the guide's artifact row for "Service with side-effect dep (email, storage)" still prescribe a local filesystem adapter; the phase artifacts are authoritative and the storage specs run against the real MinIO container. Rationale: path moved to follow ownership convention — `.claude/skills/` is provided foundation outside this phase's deliverable, so correcting the guide is tracked as a separate task per `CLAUDE.md` § Scope Limits.

---

## TD-11: Queue Producer and Consumer Test Strategy

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** TD-10 settled the storage half of the phase's test strategy and explicitly deferred the queue half — its Recommendation states that `references/external-systems.md` § "Message Queue", currently a placeholder marked TBD that assumes Redis and `BullModule.forRoot`, "needs to follow whatever TD-01 decides". TD-01 then decided the technology without addressing testing, so no document covers how the producer and the worker are verified, and the testing guide has no row for either artifact type. The choice is strategic for the same reason TD-10 was: the worker holds the phase's riskiest logic (FFmpeg invocation, presigned-URL input, status transitions), and this decides whether that logic is exercised against a real queue or only around it. Two prior decisions constrain the options. TD-01's PostgreSQL backend means a test queue needs no container beyond the `db` already in Compose, but does require `runMigrations()` to initialize BullMQ's own schema — per the official docs, connections do not apply migrations automatically, and the migration is idempotent and concurrency-safe. TD-04's single-image model (one image with FFmpeg, two Compose services with different commands) means FFmpeg is present in whatever container runs the suite.

**Options:**

### Option A: Real `Worker` in-process, driven by `QueueEvents`
- An integration spec enqueues through the real producer, starts a real `Worker` bound to the real processor against the PostgreSQL-backed queue, awaits the `completed` or `failed` event on a `QueueEvents` instance, then asserts the database row and the MinIO objects. Isolation per spec via a unique queue name plus `queue.obliterate()`.
- **Pros:** exercises the whole path production runs — job serialization, backend wiring, the processor, and the status transition TD-09 depends on. Retry-to-`failed` becomes observable by feeding a deliberately unprocessable file. No new infrastructure: the queue lives in the `db` service and FFmpeg is in the image per TD-04. Same posture TD-10 chose for storage, and the guide's own placeholder already sketches both producer and consumer assertions.
- **Cons:** slowest option — a real FFmpeg pass over a fixture plus event round-trips. Worker lifecycle must be closed in `afterEach` or Jest leaks handles, and the suite already runs with `--forceExit`, so a leak would be masked rather than reported. Setup must call `runMigrations()` before the first queue is constructed.

### Option B: Split — real queue for the producer, direct invocation for the processor
- The producer is asserted against the real queue (`getJobs(['waiting'])`, payload shape) with no `Worker` started; the processor is tested as a plain function invoked with a hand-built `Job`-like argument.
- **Pros:** fast and deterministic — no worker lifecycle, no event timing, no FFmpeg in the critical path of most specs. Each half is isolated, so a failure points directly at producer or processor.
- **Cons:** nothing ever runs a real `Worker`, so the hand-written `Queue`/`Worker` provider wiring that TD-01 named as the actual price of its choice is exactly what stays untested. Retry, backoff and the exhausted-attempts transition to `failed` are queue behaviours a direct call cannot reproduce, leaving TD-09's failure policy unverified.

### Option C: Full E2E through the Compose worker service
- The suite drives the HTTP API and lets the real `video-worker` container pick the job up, polling until the video reports `ready`.
- **Pros:** the most faithful — the deployed topology, including the container boundary and its FFmpeg build.
- **Cons:** depends on a second container the test does not control, so failures are hard to attribute and the suite cannot force a failure path. Polling turns timeouts into a tuning parameter. Duplicates Option A's coverage at materially worse diagnosability.

**Recommendation:** **Option A for the job path, keeping Option B's direct invocation for branch-level unit tests** — the phase is graded on the worker actually producing duration, metadata and a thumbnail, and TD-10 already established that the mechanisms most likely to break are the ones that must run for real. Option A costs no new infrastructure here precisely because TD-01 chose the PostgreSQL backend. Option B alone is rejected not for speed but for coverage: it cannot observe the retry-to-`failed` transition TD-09 specifies, and it leaves TD-01's acknowledged wiring cost unexercised. Keeping direct invocation for pure branch logic follows the guide's existing "Service with branching + DB → Unit + Integration" rule rather than replacing it. The consequence is the documentation change TD-10 anticipated: § "Message Queue" must be rewritten from the Redis/`BullModule` placeholder to the PostgreSQL backend with `runMigrations()` in setup and `obliterate()` for isolation, plus a queue producer/consumer row in the guide's artifact table.

**Decision:** A (Real `Worker` in-process via `QueueEvents`; direct processor invocation kept for branch-level unit tests)
**Libraries:** bullmq

---

## TD-12: Upload Size and Content-Type Enforcement Point

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** 10GB is the phase's headline limit, but TD-02 deliberately removed the API from the byte path, so nothing in the current design enforces it — and the AWS SDK cannot help at the signature level. The SDK's presigner sets the payload to `UNSIGNED-PAYLOAD` and adds `content-type` to `unsignableHeaders`, so a presigned `UploadPart` URL constrains neither the size nor the type of what is sent; the SDK's own source notes that content-length range restrictions require `@aws-sdk/s3-presigned-post` with a `["content-length-range", min, max]` policy condition — a POST-form mechanism that does not apply to multipart part uploads. The limit therefore has to be enforced by the application at the handshake boundaries TD-02 defined, or not at all. Cross-layer because whatever is decided becomes a precondition the upload client must satisfy: it fixes what the initiate call declares and which rejection the client handles mid-upload.

**Options:**

### Option A: Declare at initiate, verify with `HeadObject` at complete
- The initiate call requires `size` and `contentType` and rejects anything above the ceiling or outside the allowed types before creating the draft row or the multipart upload. At complete, the API calls `HeadObject` and compares the real `ContentLength` against the declared value before enqueueing; a mismatch or an over-ceiling object aborts the multipart upload, marks the row `failed` and stores the reason.
- **Pros:** the only option that actually closes the hole, because it checks the bytes that landed rather than the bytes that were promised — `HeadObject` returns `ContentLength` without downloading the body, so the check is one cheap call. Both enforcement points are endpoints TD-02 already specifies, so no new surface is introduced. The declared size is independently useful: the client needs it to compute a part count, and the orphan-draft reaper needs to know what it is cleaning up.
- **Cons:** a client can still write up to the ceiling's worth of parts before the complete call rejects them, so a bad-faith upload's storage cost is bounded by the ceiling rather than by zero. Trusting `contentType` at initiate means the real container is only confirmed later, when `ffprobe` reads it in the worker.

### Option B: Sign an exact `ContentLength` into every part URL
- Each presigned part URL is generated with `content-length` promoted into `signableHeaders`, pinning that part's byte count, so the ceiling becomes `partSize × maxParts` by construction.
- **Pros:** enforcement moves into the signature, so a part that does not match is rejected by storage itself, before the bytes are accepted.
- **Cons:** the client must know each part's exact size up front and send it byte-for-byte, which makes the final short part a special case and removes any client-side freedom over part sizing. It bounds each part, not the object, so a total check is still needed somewhere. Promoting extra signable headers also diverges from the SDK's default presigning path for no gain the complete-time check does not already deliver.

### Option C: Quota or policy at the storage layer
- Express the limit outside the application — a bucket policy or MinIO quota capping object or bucket size.
- **Pros:** cannot be bypassed by an application bug, and it is declarative infrastructure rather than code.
- **Cons:** neither S3 nor MinIO offers a per-object maximum size as a bucket-level control, so the closest knob is a bucket-wide quota, which caps total storage rather than one upload and fails for every user at once when reached. It also surfaces a storage-level error the API must translate, with no way to tell the user which rule they broke.

**Recommendation:** **Option A (declare at initiate, verify with `HeadObject` at complete)** — the SDK's presigning model forecloses the elegant answer: a presigned `PUT` cannot carry a size or type constraint, and the mechanism that can (`createPresignedPost`'s `content-length-range`) is a single-request POST form, which the 5GB `PUT` ceiling already ruled out in TD-02. That leaves application-level enforcement, and the two checks belong at the two handshake ends TD-02 already defines: a cheap reject before anything is created, and a verification against reality before anything is enqueued. The residual exposure — bytes written before the complete call rejects them — is bounded by the ceiling and already swept by the `AbortIncompleteMultipartUpload` lifecycle rule TD-03 established. The exact ceiling, the allowed container types and the part size are plan-level parameters; what this TD fixes is that both checks exist and where they live.

**Decision:** A (Declare at initiate, verify with `HeadObject` at complete)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-13: Authorization Policy for Streaming and Download

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** TD-07 decided *how* media is delivered — a short-lived presigned GET minted by the API — and both of its options reason about authorization being enforced "at the moment the URL is issued", but neither says who passes that check. The question cannot be deferred to Fase 04, because the global `JwtAuthGuard` from `phase-02-auth/TD-02` makes every new endpoint authenticated unless it carries the existing `@Public()` decorator: declining to decide is itself a decision, and the strictest one. Meanwhile TD-09 deliberately kept the status enum technical and left publication to Fase 04, so Fase 03 has no visibility column to authorize against, while `CLAUDE.md` states that anonymous users watch freely and only social features require authentication. Cross-layer because the answer determines whether the Fase 04/05 player page is a public route or sits inside the authenticated chrome.

**Options:**

### Option A: Public for `ready` videos; every other state refuses
- The signing endpoints carry `@Public()` and authorize on the video's own state: a URL is issued only when `status = ready`, and `draft` / `uploading` / `processing` / `failed` return the same not-found response regardless of who asks.
- **Pros:** matches the product rule in `CLAUDE.md` — anonymous watching is the platform's default — and the phase's deliverable "streaming funcionando" is demonstrable without a token. Drafts and failures stay protected because what guards them is the status check, not an identity check. Consistent with TD-03, which already made the thumbnail bucket public. The owner can watch their own video before Fase 04 ships publication, with no special case. TD-08's 64-bit unguessable identifier is the de-facto unlisted mechanism in the interval — precisely the gap Fase 04 closes with an explicit visibility field.
- **Cons:** every `ready` video is watchable by anyone holding its URL as soon as processing finishes, with no way to express "not yet published" until Fase 04 adds the field. Fase 04 must then *restrict* this route, and tightening is the direction in which an existing client can break.

### Option B: Owner-only until Fase 04 introduces visibility
- The endpoints stay under the global guard and additionally require the requesting user to own the video's channel.
- **Pros:** the most conservative reading of a phase with no visibility model — nothing is reachable by a third party before publication exists, so no window of accidental exposure opens. Fase 04 then *widens* the rule, which cannot break an existing consumer.
- **Cons:** contradicts the product rule that anonymous users watch freely, so the phase ships a streaming capability no anonymous viewer can use and an acceptance criterion demonstrable only with a token. It also encodes an authorization model that exists purely as a placeholder — the same speculative-schema objection TD-09 raised against its own Option B.

### Option C: Any authenticated user
- Require a valid JWT but perform no ownership check; `ready` is still the gate.
- **Pros:** trivially simple, and it keeps an audit identity on every signing call, which a future view-count or abuse-limit feature could use.
- **Cons:** has no basis in the product — authentication gates social features, not watching — and it protects nothing Option A does not, since anyone can register. It is Option A's exposure with Option B's friction.

**Recommendation:** **Option A (public for `ready`, state-gated)** — the product rule is explicit that watching is anonymous, the phase is graded on streaming and download working, and the mechanism already exists in `@Public()`. The decisive point is what actually guards the sensitive cases: the `status = ready` condition, not the caller's identity, and that condition is equally effective against anonymous and authenticated strangers. Option B's safety is real, but it buys protection for a concept — unpublished-but-ready — that TD-09 deliberately declined to model in this phase, and it would make the phase's own deliverable undemonstrable without credentials. The cost worth recording is directional: Fase 04 will tighten this route when it introduces visibility, so the authorization decision should live in one place in the signing path rather than being inlined at each call site. Download follows the identical rule, since TD-07 already made it the same mechanism with a content-disposition override.

**Decision:** A (Public for `ready`, state-gated)
**Libraries:** —

---

## TD-14: Queue Broker Deployment Shape — supersedes phase-03-videos/TD-01

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** TD-01 chose the PostgreSQL backend and weighed the fourth container as its decisive cost. That reasoning holds on engineering grounds and is not what reopens it. What reopens it is the acceptance contract: the phase is graded on "object storage, **fila** e worker subindo via `docker compose` junto com o backend", and "não ter fila, worker e storage reais subindo no Compose" is listed under reprova automática. Under TD-01's decision the queue is real and does run inside Compose — in the `db` service's `bullmq` schema — but `compose.yaml` shows `api`, `db`, `mailpit`, `minio` and `video-worker` and **no service a reader can point at as the queue**. Satisfying the criterion in substance while failing it on inspection is a risk the phase does not need to carry, and it is cheapest to settle now, before `/plan-build` writes the Deliverables and the Events/Messages spec. Note what is *not* at stake: BullMQ's `Queue`/`Worker`/`QueueEvents` API is identical across backends, so the job-handling code, the retry/backoff semantics TD-09 depends on, and TD-11's chosen test strategy all survive any option here unchanged — only the deployment shape and the connection move. This TD also constrains TD-11's mechanics (`runMigrations()` is a PostgreSQL-backend-only step) and TD-11 must be revised to match whatever is chosen.

**Options:**

### Option A: BullMQ 6 + Redis, with hand-written `Queue`/`Worker` providers
- A `redis` service joins Compose; `Queue` and `Worker` stay explicit providers in a `QueueModule`, exactly the wiring TD-01's chosen option already accepted. `bullmq@6` declares `ioredis` as an **optional peer dependency** (alongside `pg` and `redis`), so the Redis driver is installed explicitly — `ioredis@6` is CommonJS (`main: ./built/index.js`), matching the project's `nodenext`/CJS emit.
- **Pros:** delivers an unmistakable queue service in `compose.yaml` at the lowest change cost, because the provider wiring is already what the plan assumed. Dependency surface stays CJS-clean, consistent with TD-02 and TD-08, which both rejected ESM-only packages in this build. Drops the `runMigrations()` bootstrap step and BullMQ's out-of-band schema, which TD-01 had recorded as a known cost. Redis is the backend BullMQ is primarily developed against, so it is the best-trodden path for the retry and event semantics TD-09 and TD-11 rely on.
- **Cons:** the fourth container TD-01 was trying to avoid — a service, a config namespace, a healthcheck and an env block in every environment. Redis is in-memory by default, so job durability across a broker restart needs deliberate configuration (`appendonly yes`, or accepting that a video stuck in `processing` is re-enqueued by hand). Adds one direct dependency that the PostgreSQL backend did not need.

### Option B: BullMQ 6 + Redis + `@nestjs/bullmq`
- The same Redis service, plus the official Nest wrapper supplying `@Processor` / `@InjectQueue` decorators and module wiring in place of hand-written providers.
- **Pros:** everything Option A delivers, plus the decorator ergonomics, and it would make the project's own testing-guide snippets (`BullModule.forRoot`, `BullModule.registerQueue()`, `getQueueToken`) correct again — shrinking the scope of the separate guide-correction task.
- **Cons:** `@nestjs/bullmq@12.0.1` is `type: module` and its exports map points the `require` condition at the same ESM build, so a `nodenext`/CJS project reaches it only through Node's `require(esm)` interop — workable on Node 25 but precisely the compatibility edge this project has now declined twice (TD-01's own Option C on `pg-boss@12`, TD-08 on `nanoid@6`). Peer ranges are otherwise fine (`@nestjs/core ^11`, `bullmq ^6`). Note that TD-01's Option A presented `@nestjs/bullmq` as an unqualified win; the registry says it is ESM-only, which was not checked at the time.

### Option C: Keep the PostgreSQL backend and make it explicit in the docs
- No infrastructure change. The Events/Messages spec and `CLAUDE.md` state plainly that the broker is PostgreSQL, with a dedicated healthcheck surfacing queue liveness.
- **Pros:** zero new infrastructure, and TD-01's reasoning — durable by construction, no fourth service, no extra config namespace — remains fully intact. Strictly the better engineering choice for a queue carrying a handful of jobs per minute.
- **Cons:** relies on the reader doing the mapping from "no queue service" to "the queue is a schema inside `db`". It protects the criterion only if someone reads the explanation, which is exactly the assumption the phase should not make. Leaves the most important non-functional claim of the phase resting on documentation rather than on something visible.

**Recommendation:** **Option A (Redis with hand-written providers)** — the criterion asks for a queue running in Compose, and the only option that makes that true by inspection rather than by explanation is a broker service of its own. Between the two Redis shapes, Option A is strictly cheaper here: the hand-written `QueueModule` is already what the plan assumed under TD-01, so nothing in the job code or the module layout changes, while Option B would reintroduce the ESM-only dependency this build has twice avoided to buy decorator sugar the project does not need — and the stale testing-guide snippets it would fix are already owned by the separate guide-correction task. Option C remains the better decision on engineering merit alone and is recorded here as such; it loses on a non-engineering criterion that is nonetheless the one the phase is graded against. The durability gap is the real cost to accept: pin `appendonly yes` on the Redis service so an enqueued job survives a broker restart, which is the property TD-01 got for free from PostgreSQL.

**Decision:** _[pending]_

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
| TD-11 | Backend | Queue Producer and Consumer Test Strategy | A (real `Worker` in-process via `QueueEvents`, direct invocation kept for branch units) | A (Real `Worker` in-process via `QueueEvents`; direct processor invocation kept for branch-level unit tests) |
| TD-12 | Cross-layer | Upload Size and Content-Type Enforcement Point | A (declare at initiate, verify with `HeadObject` at complete) | A (Declare at initiate, verify with `HeadObject` at complete) |
| TD-13 | Cross-layer | Authorization Policy for Streaming and Download | A (public for `ready`, state-gated) | A (Public for `ready`, state-gated) |
| TD-14 | Backend | Queue Broker Deployment Shape _(supersedes TD-01)_ | A (Redis service + hand-written `Queue`/`Worker` providers) | _[pending]_ |
