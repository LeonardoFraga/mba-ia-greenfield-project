---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-20T12:27:44-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-08T19:31:28-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-20T12:27:44-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-09-20T12:27:44-03:00"
  docs/phases/phase-02-auth/context.md: "2026-09-20T12:27:44-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-09-20T12:27:44-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-09-20T12:27:44-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified in project-plan.md._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` — project-plan.md names no subproject paths in the Fase 03 block; every capability is API/worker-side (storage service, queue-based background processing, upload, metadata/thumbnail generation, unique URLs, streaming/download delivery).

**Deferred subprojects:** `next-frontend/` — project-plan.md itself names none; the deferral is declared by `technical-decisions-phase-03-videos.md`'s `_Subprojects in scope:_` note, which records `next-frontend/` as having no open decision because the phase has no UI capability bullet. The video surfaces (player page, upload screen, management panel) belong to Fases 04, 05 and 07.

**Sequencing notes:** "> Depende de: Fase 01, Fase 02" (verbatim dependency line under the phase heading). Phase intro line: "Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única."

**Neighbors (for boundary detection only):**

- **Phase 02:** Fase 02 — Cadastro, Login e Gerenciamento de Conta — "Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha."
- **Phase 04:** Fase 04 — Gerenciamento de Vídeos e Canal — "Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública."

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message Queue Technology | superseded-by phase-03-videos/TD-14 | — | — |
|     └─ Last revision: 2026-11-08 — Testing-guide override recorded: `testing-guide-nestjs-project/references/exter… | | | | | | |
| phase-03-videos/TD-02 | phase | Cross-layer | Large File Upload Protocol (up to 10GB) | decided | A (S3 multipart with presigned part URLs) | — |
|     └─ Last revision: 2026-11-08 — Strict-BFF exception recorded: the inherited strict-BFF model (`next-frontend-c… | | | | | | |
| phase-03-videos/TD-03 | phase | Backend | Object Storage Bucket and Key Layout | decided | B (Separate buckets by access policy) | — |
| phase-03-videos/TD-04 | phase | Backend | Video Worker Process Model | decided | A (Separate container, same codebase, standalone Nest app) | — |
| phase-03-videos/TD-05 | phase | Backend | FFmpeg Distribution and Invocation | decided | A (Distro binaries + `spawn`) | — |
|     └─ Last revision: 2026-11-08 — Persisted metadata set fixed as a hybrid: discrete columns for what is queried… | | | | | | |
| phase-03-videos/TD-06 | phase | Backend | Worker Media Access Strategy | decided | B (Presigned URL as FFmpeg input) | — |
| phase-03-videos/TD-07 | phase | Cross-layer | Video Streaming and Download Delivery | decided | B (Short-lived presigned GET) | — |
|     └─ Last revision: 2026-11-08 — Strict-BFF exception recorded: as on TD-02, the inherited strict-BFF model gov… | | | | | | |
| phase-03-videos/TD-08 | phase | Backend | Unique Video URL Identifier | decided | C (`crypto.randomBytes` base64url) | — |
| phase-03-videos/TD-09 | phase | Backend | Video Status Lifecycle and Processing Failure Policy | decided | A (Single technical `status` enum) | — |
| phase-03-videos/TD-10 | phase | Backend | Object Storage Abstraction and Test Strategy | decided | A (Single S3 adapter, real MinIO in tests) | — |
|     └─ Last revision: 2026-11-08 — Testing-guide override recorded: `references/external-systems.md` § "Object Sto… | | | | | | |
| phase-03-videos/TD-11 | phase | Backend | Queue Producer and Consumer Test Strategy | decided | A (Real `Worker` in-process via `QueueEvents`) | bullmq, ioredis |
|     └─ Last revision: 2026-11-08 — Testing-guide override for the queue re-anchored here and on TD-14, since TD-01… | | | | | | |
| phase-03-videos/TD-12 | phase | Cross-layer | Upload Size and Content-Type Enforcement Point | decided | A (Declare at initiate, verify with `HeadObject` at complete) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-13 | phase | Cross-layer | Authorization Policy for Streaming and Download | decided | A (Public for `ready`, state-gated) | — |
| phase-03-videos/TD-14 | phase | Backend | Queue Broker Deployment Shape — supersedes phase-03-videos/TD-01 | decided | A (Redis service + hand-written `Queue`/`Worker` providers) | bullmq, ioredis |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

_No `scope_type: ad-hoc` doc declares phase 3 in `related_phases`; the ad-hoc set contributing here comes from correlator confirmation (see `## Inherited Decisions Detail`). The correlator additionally ranked `next-frontend-openapi-typing` as `medium` and was not confirmed — its concern (making the cross-layer handshake and delivery contracts codegen-friendly) is inherited indirectly via `openapi-docs-nestjs/TD-02`._

_The `Renders in` column is omitted: no TD in the kept set declares a `**Renders in:**` field, so the table renders in its 7-column legacy form and default-by-inference is left for `plan-build` A2 to resolve. The three libraries this phase introduces are pinned in `library-refs.md`._

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-10 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-04, phase-03-videos/TD-11, phase-03-videos/TD-14 _(TD-01 superseded by TD-14)_ |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-12 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-09 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-09 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-06 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-08 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07, phase-03-videos/TD-13 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07, phase-03-videos/TD-13 |

## Decisions Detail

### phase-03-videos/TD-02

**Recommendation:** the 5GB single-`PUT` ceiling removes every single-request design, so the real choice is between orchestrating S3 multipart ourselves and delegating to tus. tus buys byte-level resumption over part-level, which matters for flaky mobile networks but little for a desktop upload that can simply retry a 50MB part; in exchange it adds a second protocol, a second auth surface, and an ESM dependency to a CJS build. Option A keeps everything inside the existing REST + JWT contract, uses the AWS SDK the storage already speaks, and makes the initiate call the natural home for the draft pre-registration the phase asks for. Part size is a plan-level parameter: at 50MB parts a 10GB file is 200 parts, comfortably under the 10,000-part limit.
**Libraries:** —

**Revisions:**
- 2026-11-08 — Strict-BFF exception recorded: the inherited strict-BFF model (`next-frontend-config-base/TD-03`, carried into this phase by `phase-02-auth-frontend/TD-01`) governs calls to the NestJS API, and presigned storage URLs minted server-side fall outside its scope — so the browser `PUT`ting parts directly to object storage does not violate it. Rationale: param tightened by new policy — the exception is deliberately narrow and travels with this cross-layer contract, so Fases 04/05/07 inherit both together instead of discovering the conflict when the upload screen is built.

### phase-03-videos/TD-03

**Recommendation:** the two artifact classes have genuinely different access profiles, and expressing that as bucket policy is safer and cheaper than signing every thumbnail. The decisive factor is downstream: Fases 04 and 07 render grids of many thumbnails at once, and public cacheable thumbnail URLs there are the difference between one request and N signing round-trips. The cost — a second bucket in bootstrap — is a few lines in the Compose init step. Either way, the videos bucket carries an `AbortIncompleteMultipartUpload` lifecycle rule so the abandoned uploads that TD-02 Option A can leave behind do not accumulate as invisible storage.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** it satisfies the architecture's process separation, which is the point of the phase, while keeping a single source of truth for entities and config. Option B's isolation is real but it is paying monorepo-tooling costs to solve a problem the project does not have; Option C reintroduces the coupling the phase is meant to remove. Concretely: one image built from the existing Dockerfile plus FFmpeg, two Compose services running the same image with different commands.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** with `fluent-ffmpeg` archived, the wrapper layer is not worth resurrecting for two commands, and `spawn` is what any wrapper would have done anyway. Between distro and npm-shipped binaries, the worker only ever runs in its own container (TD-04), so the Dockerfile is already the version-pinning surface and the reproducibility argument for Option B mostly evaporates — while its multi-architecture postinstall is a real hazard on a project developed on Apple Silicon and run in Linux containers. Pin the FFmpeg version explicitly in the Dockerfile rather than inheriting whatever the base image floats to.
**Libraries:** —

**Revisions:**
- 2026-11-08 — Thumbnail invocation parameters fixed: one frame seeked at 10% of the duration reported by `ffprobe`, scaled to 1280x720 preserving aspect ratio, encoded as JPEG at a fixed quality. Rationale: param tightened by new policy — a percentage never falls outside the file (a two-second clip and a two-hour film both resolve), unlike a fixed timestamp, and a single seek stays cheap over TD-06's presigned-URL input.
- 2026-11-08 — Persisted metadata set fixed as a hybrid: discrete columns for what is queried or displayed (`duration_seconds`, `width`, `height`, `size_bytes`) plus a `jsonb` `metadata` column for the `ffprobe` long tail (container, video codec, audio codec, bitrate, framerate). Rationale: param tightened by new policy — indexes the fields Fases 04 and 05 consume without forcing a migration for every additional field `ffprobe` starts returning.

### phase-03-videos/TD-06

**Recommendation:** the worker's job is to read a header and one frame, and Option A pays a full 10GB transfer plus matching disk for that. FFmpeg's HTTP input with range seeking is exactly the mechanism this case is designed for, and it keeps the worker container stateless, which matters directly for TD-04's separate-container model. The `moov`-at-the-end caveat is real but bounded — it costs extra range requests, not correctness — and if measurements later show it dominating, Option A remains available as a per-job fallback without changing anything else. Option C is a partial Option B that fails in exactly the cases Option B handles.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** it is what the architecture already specifies, and it lets storage do the one thing it is unambiguously better at than an application server: serving byte ranges of large objects. The decisive argument is load shape — under Option A the API's capacity is consumed by people watching videos, which is the opposite of the separation this phase builds everywhere else. The leaked-URL window is managed by keeping the TTL short (minutes, not hours), and it is the same trade already accepted on the upload side in TD-02. Download reuses the identical mechanism with a content-disposition override, so the two capabilities cost one implementation rather than two.
**Libraries:** —

**Revisions:**
- 2026-11-08 — Strict-BFF exception recorded: as on TD-02, the inherited strict-BFF model governs calls to the NestJS API only; a presigned GET minted server-side and consumed by the player as its `src` is outside that scope, so direct browser-to-storage range requests do not violate it. Rationale: param tightened by new policy — recorded here as well as on TD-02 because the two cross-layer contracts are inherited independently by different frontend phases.

### phase-03-videos/TD-08

**Recommendation:** Options A and C produce the same thing: 11 URL-safe characters from a CSPRNG. The only difference is whether a dependency is involved, and here that dependency carries a real cost, since `nanoid@6` is ESM-only against a CommonJS build and the alternative is freezing on `nanoid@3`. Option D is disqualified by enumerability once unlisted videos exist, and Option B is simply too long for the plan's stated goal. Whichever is chosen, the column carries a unique index and the insert retries on conflict — with 64 bits of entropy that path is essentially never taken, but it is the guarantee that actually holds.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** it is the lifecycle the plan describes, it is what the phase is evaluated against, and the `uploading` state earns its place by making abandoned uploads distinguishable from active ones, which TD-02's cleanup depends on. Option B is schema written for requirements that do not exist yet; the right way to protect that boundary is to name it — this enum describes *processing*, and Fase 04's publication flow adds its own field rather than adding values here. On failure, the split matters: queue-level retries handle transient faults invisibly, and `failed` is reserved for a genuinely unprocessable file, paired with a stored reason so the user is told something more useful than "error".
**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** the two-driver design in the testing guide was written for a phase where storage meant "put a file somewhere", and this phase's storage is a protocol, not a filesystem. Presigned multipart and range delivery are the parts most likely to break and least likely to be caught by review, so they are precisely what must run against a real S3 implementation; a local driver cannot even express them. MinIO is the same API as production S3, and the project already accepts this pattern for the database and for mail. The consequence is a documentation change, not just a code one: `references/external-systems.md` § "Object Storage" needs to be updated to describe MinIO, and its § "Message Queue" section — currently a Redis/BullMQ placeholder marked TBD — needs to follow whatever TD-01 decides.
**Libraries:** —

**Revisions:**
- 2026-11-08 — Testing-guide override recorded: `references/external-systems.md` § "Object Storage" and the guide's artifact row for "Service with side-effect dep (email, storage)" still prescribe a local filesystem adapter; the phase artifacts are authoritative and the storage specs run against the real MinIO container. Rationale: path moved to follow ownership convention — `.claude/skills/` is provided foundation outside this phase's deliverable, so correcting the guide is tracked as a separate task per `CLAUDE.md` § Scope Limits.

### phase-03-videos/TD-11

**Recommendation:** the phase is graded on the worker actually producing duration, metadata and a thumbnail, and TD-10 already established that the mechanisms most likely to break are the ones that must run for real. Option A costs no new infrastructure here precisely because TD-01 chose the PostgreSQL backend. Option B alone is rejected not for speed but for coverage: it cannot observe the retry-to-`failed` transition TD-09 specifies, and it leaves TD-01's acknowledged wiring cost unexercised. Keeping direct invocation for pure branch logic follows the guide's existing "Service with branching + DB → Unit + Integration" rule rather than replacing it. The consequence is the documentation change TD-10 anticipated: § "Message Queue" must be rewritten from the Redis/`BullModule` placeholder to the PostgreSQL backend with `runMigrations()` in setup and `obliterate()` for isolation, plus a queue producer/consumer row in the guide's artifact table.
**Libraries:** bullmq, ioredis

**Revisions:**
- 2026-11-08 — Backend mechanics updated for TD-14: the connection target is the `redis` Compose service rather than the `db` service, and setup no longer calls `runMigrations()` — that step exists only for BullMQ's PostgreSQL backend, which TD-14 supersedes. `ioredis` joins the Libraries line as BullMQ's optional peer for the Redis driver. Unchanged: the chosen strategy itself (real `Worker` in-process awaiting `completed`/`failed` on `QueueEvents`, `obliterate()` for per-spec isolation, `worker.close()` in `afterEach`, direct processor invocation kept for branch-level units) — every one of those is backend-independent. Rationale: param updated to match new lib version — the superseding TD changed the broker, not the test strategy.
- 2026-11-08 — Testing-guide override for the queue re-anchored here and on TD-14, since TD-01 is now superseded and drops out of active enumeration. The guide's § "Message Queue" (Redis + `BullModule.forRoot`) and its § 2 `BullModule.registerQueue()` example remain inapplicable: TD-14 keeps `Queue` and `Worker` as hand-written providers with no `BullModule`, so the only part of the guide's placeholder that TD-14 happens to vindicate is Redis as the broker. Rationale: path moved to follow ownership convention — correcting the guide stays a separate task per `CLAUDE.md` § Scope Limits.

> The Recommendation prose above predates TD-14 and still argues from the PostgreSQL backend ("Option A costs no new infrastructure here precisely because TD-01 chose the PostgreSQL backend", and the § "Message Queue" rewrite target). Per the decisions history model the Recommendation is append-only history; the two Revisions entries are what currently applies.

### phase-03-videos/TD-12

**Recommendation:** the SDK's presigning model forecloses the elegant answer: a presigned `PUT` cannot carry a size or type constraint, and the mechanism that can (`createPresignedPost`'s `content-length-range`) is a single-request POST form, which the 5GB `PUT` ceiling already ruled out in TD-02. That leaves application-level enforcement, and the two checks belong at the two handshake ends TD-02 already defines: a cheap reject before anything is created, and a verification against reality before anything is enqueued. The residual exposure — bytes written before the complete call rejects them — is bounded by the ceiling and already swept by the `AbortIncompleteMultipartUpload` lifecycle rule TD-03 established. The exact ceiling, the allowed container types and the part size are plan-level parameters; what this TD fixes is that both checks exist and where they live.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-13

**Recommendation:** the product rule is explicit that watching is anonymous, the phase is graded on streaming and download working, and the mechanism already exists in `@Public()`. The decisive point is what actually guards the sensitive cases: the `status = ready` condition, not the caller's identity, and that condition is equally effective against anonymous and authenticated strangers. Option B's safety is real, but it buys protection for a concept — unpublished-but-ready — that TD-09 deliberately declined to model in this phase, and it would make the phase's own deliverable undemonstrable without credentials. The cost worth recording is directional: Fase 04 will tighten this route when it introduces visibility, so the authorization decision should live in one place in the signing path rather than being inlined at each call site. Download follows the identical rule, since TD-07 already made it the same mechanism with a content-disposition override.
**Libraries:** —

### phase-03-videos/TD-14

**Recommendation:** the criterion asks for a queue running in Compose, and the only option that makes that true by inspection rather than by explanation is a broker service of its own. Between the two Redis shapes, Option A is strictly cheaper here: the hand-written `QueueModule` is already what the plan assumed under TD-01, so nothing in the job code or the module layout changes, while Option B would reintroduce the ESM-only dependency this build has twice avoided to buy decorator sugar the project does not need — and the stale testing-guide snippets it would fix are already owned by the separate guide-correction task. Option C remains the better decision on engineering merit alone and is recorded here as such; it loses on a non-engineering criterion that is nonetheless the one the phase is graded against. The durability gap is the real cost to accept: pin `appendonly yes` on the Redis service so an enqueued job survives a broker restart, which is the property TD-01 got for free from PostgreSQL.
**Libraries:** bullmq, ioredis

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use.
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection. (2) **Single cookie to manage** simplifies logout and avoids the orphan-cookie failure mode. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome without a per-render `/auth/me` round-trip.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh). Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions. (2) **Aligned with shadcn's canonical form primitive** — `npx shadcn@latest add form` produces react-hook-form wrappers. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface. (2) **Test scaffold already exists** — authored for Route-Handlers-as-functions. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it. The `router.refresh()` requirement after mid-session mutations is a small price for the structural benefits.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 02)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 02)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 02)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 02)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 02)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 02)_

_Phase 01 contributes no inheritable conventions block of its own — its `## Inherited Conventions` is the first-phase placeholder. The bullets above are the union across both phase-02 slices after dedupe; all originate from `phase-02-auth` and are themselves attributed to phase 01 in that slice's context.md._

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| _None._ | | | |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Specific layer coverage by SI is recorded in `progress.md`.

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

**Phase-local overrides — the phase artifacts win over the guide for these two artifact classes.** The guide's `references/external-systems.md` predates this phase and is stale in two sections; correcting it is tracked as a separate task (`.claude/skills/` is provided foundation outside this phase's deliverable, per `CLAUDE.md` § Scope Limits). The overrides are recorded as `**Revisions:**` entries on the governing TDs and are authoritative for `/implement`:

| Artifact class | Guide says | This phase does | Recorded on |
|----------------|-----------|-----------------|-------------|
| Storage service (side-effect dep) | `local adapter` / filesystem driver, § "Object Storage" | Single S3 adapter exercised against the **real MinIO container**; a filesystem driver cannot express presigned multipart or range delivery | `phase-03-videos/TD-10` |
| Queue producer / consumer (no row in the table) | § "Message Queue" is a TBD placeholder whose setup example is `BullModule.forRoot` + `getQueueToken`; § 2 cites `BullModule.registerQueue()` | BullMQ 6 against the `redis` Compose service, with `Queue` and `Worker` as hand-written providers — **no `BullModule`**, no `runMigrations()` (that step is PostgreSQL-backend-only). Tests start a real `Worker` and await `completed`/`failed` on `QueueEvents`, isolate per spec with `obliterate()`, and close the `Worker` in `afterEach`; direct processor invocation is kept for branch-level units | `phase-03-videos/TD-11`, `phase-03-videos/TD-14` |

> **Note on the queue row.** `phase-03-videos/TD-14` superseded `TD-01`, so the broker is now a dedicated Redis service rather than the PostgreSQL backend — which means the guide's placeholder happens to be right about Redis and still wrong about everything else it prescribes (`BullModule.forRoot`, `BullModule.registerQueue()`, `getQueueToken`). The override above is anchored on `TD-11` and `TD-14`; `TD-01` is superseded and drops out of active enumeration, so it is no longer cited here. Durability is a configuration item, not a default: the Redis service carries `appendonly yes` so an enqueued job survives a broker restart.

### next-frontend

_Deferred subproject — no capability of this phase touches it._
