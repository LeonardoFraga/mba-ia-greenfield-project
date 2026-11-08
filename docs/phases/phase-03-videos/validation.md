---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 7
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-28T16:15:53-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-26T15:29:05-03:00"
issues:
  - id: IC-1
    status: open
    summary: "TD-10 mandates real MinIO in tests; Testing Requirements says local adapter"
  - id: AMB-1
    status: open
    summary: "\"extração de metadados\" does not name which metadata fields are persisted"
  - id: AMB-2
    status: open
    summary: "Thumbnail frame selection, dimensions and output format unspecified"
  - id: MD-1
    status: open
    summary: "No TD decides the queue producer/consumer test strategy"
  - id: MD-2
    status: open
    summary: "No TD decides where the 10GB ceiling is enforced under presigned multipart"
  - id: MD-3
    status: open
    summary: "No TD decides who may stream/download a video in Fase 03"
  - id: ICC-1
    status: open
    summary: "TD-02/TD-07 send the browser to a non-same-origin host vs strict-BFF"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

- **IC-1** — `phase-03-videos/TD-10` decides "Single S3 adapter, **real MinIO in tests**" and its Recommendation states that a local driver "cannot even express" presigned multipart and range delivery. The `## Testing Requirements` table in `context.md` — sourced from the `testing-guide-nestjs-project` Skill — still prescribes for the artifact type _"Service with side-effect dep (email, storage)"_: `Integration: real capture service (Mailpit) or local adapter`. The two statements coexist in `context.md` and prescribe opposite setups for the same artifact type, so `/plan-build` would have two contradictory sources when it writes the storage SIs' test layers. The conflict is deliberate on TD-10's side (it explicitly calls for the reference file to be rewritten), but it is still unresolved in the Skill that `/implement` reads. Explicit choice: (a) accept TD-10 as the phase-local override and record the override in the phase artifacts, leaving the Skill untouched for now; (b) update `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` § "Object Storage" to describe MinIO as the integration-test target and re-run `/plan-context 03` so the `## Testing Requirements` digest reflects it; (c) revisit TD-10 (not recommended — the decision is `decided` and its rationale is specific to this phase's protocol-level storage usage).

### Ambiguities

- **AMB-1** — Capability _"Processamento automático do vídeo após upload (extração de duração e metadados)"_ names `duração` explicitly but leaves `metadados` as an open noun. No TD enumerates the set: `TD-05` decides _how_ metadata is extracted (`ffprobe` via `spawn`), `TD-06` decides _from where_ (presigned URL input), `TD-09` decides the surrounding status transitions — none says which fields are persisted. `/plan-build` cannot emit the Data Model (columns, nullability, types) nor the worker's output contract without the list. Explicit choice: enumerate the persisted metadata set in the plan's Data Model — e.g. container/format, video codec, audio codec, width/height, bitrate, framerate, byte size — and decide whether it lands as discrete columns or a single `jsonb` column.

- **AMB-2** — Capability _"Geração automática de thumbnail a partir de um frame do vídeo"_ does not specify which frame, at what dimensions, or in what output format. `TD-05` and `TD-06` settle the FFmpeg invocation mechanism but not its parameters, and unlike the multipart part size — which `TD-02`'s Recommendation explicitly designates "a plan-level parameter" — no TD designates these as plan-level, so they are currently unowned. The thumbnails bucket is public and cacheable per `TD-03`, which makes the output format and size a contract consumed by Fases 04 and 07, not a private worker detail. Explicit choice: fix the frame-selection rule (fixed timestamp vs percentage of duration vs FFmpeg thumbnail filter), the output dimensions, and the image format in the plan's Technical Specifications.

### Missing Decisions

- **MD-1** — Capability _"Serviço de processamento em segundo plano (filas)"_ has queue-technology coverage (`TD-01`) and worker-process coverage (`TD-04`), but no TD decides **how the queue is tested**. `TD-10` covers the test strategy for storage only, and its Recommendation explicitly defers the queue side: _"its § 'Message Queue' section — currently a Redis/BullMQ placeholder marked TBD — needs to follow whatever TD-01 decides"_ — while `TD-01` decides the technology and says nothing about testing. The `## Testing Requirements` table has no row for a queue producer or consumer artifact type at all, so the gap is open on both the decision side and the guide side. This is a genuine strategic choice with the same shape as TD-10's: integration tests that enqueue and let a real BullMQ `Worker` drain the PostgreSQL-backed queue, versus unit tests that assert `Queue.add()` was called and invoke the processor function directly. Explicit choice: run `/research phase-03-videos` to add a TD covering the queue test strategy (and, for symmetry with TD-10, the corresponding update to `references/external-systems.md` § "Message Queue").

- **MD-2** — Capability _"Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"_ states a hard limit, and `TD-02` (S3 multipart with presigned part URLs) deliberately removes the API from the byte path — so no layer currently enforces the ceiling. `TD-02` fixes the protocol and designates part size as a plan-level parameter, but names no enforcement point for total size or content type; `TD-03` settles bucket policy, not request-time validation. Left undecided, the implementation either trusts a client-declared size or enforces nothing, which makes the phase's headline limit unenforceable and the videos bucket open to unbounded writes by any authenticated user. Explicit choice: run `/research phase-03-videos` to add a TD deciding where the limit lives — e.g. declared `size`/`contentType` validated at the initiate call plus a `HeadObject` verification at complete-multipart before enqueueing, versus a bucket/policy-level constraint, versus a per-channel quota — and what happens when the stored object exceeds the declared size.

- **MD-3** — Capabilities _"Reprodução via streaming (sem necessidade de download completo)"_ and _"Download do vídeo pelo usuário"_ are covered by `TD-07` (short-lived presigned GET), which decides the **delivery mechanism** but not **who may ask for a URL**. The phase inherits a global JWT guard (`phase-02-auth/TD-02`), and `TD-09` deliberately keeps the status enum technical-only — _"Fase 04's publication flow adds its own field rather than adding values here"_ — so in Fase 03 there is no published/visibility flag to authorize against. Meanwhile the project overview has anonymous users watching freely. `/plan-build` cannot emit the Authorization Matrix for the streaming and download endpoints without this. Explicit choice: run `/research phase-03-videos` to add a TD deciding the Fase 03 access policy for video delivery — e.g. owner-only until Fase 04 ships publication, versus any authenticated user, versus public for `ready` videos — and whether the thumbnail's public bucket (`TD-03`) implies anything about the video's own reachability.

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

- **ICC-1** — `phase-03-videos/TD-02` (presigned part URLs) and `phase-03-videos/TD-07` (presigned GET for streaming and download) are both marked `Scope: Cross-layer` precisely so the frontend inherits a settled contract in Fases 04/05/07. That contract requires the browser to `PUT` parts to, and `GET` media from, the object-storage host directly. The inherited `phase-02-auth-frontend/TD-01` carries the strict-BFF model as its load-bearing rationale — _"The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller"_ — a model whose stated rule is that the browser talks only to same-origin `/api/...`. Taken literally, the Fase 03 delivery contract is the first thing in the project that sends the browser off-origin, and the conflict surfaces in Fase 04/05 rather than here, when the player and upload screens are built against it. Note that `TD-07`'s Recommendation already rejected routing media through the application server on load-shape grounds, so resolving this by proxying would reopen a `decided` TD. Explicit choice: (a) record an explicit, narrow exception — strict BFF governs calls to the NestJS API, and presigned storage URLs minted server-side are outside its scope — and carry it as a note on `TD-02`/`TD-07` so the FE phases inherit the exception alongside the contract; (b) surface the conflict to the frontend's own decisions lineage (a revision on `next-frontend-config-base/TD-03` via `/decide`) so the exception is documented where the FE constraint lives; (c) reopen `TD-07` to proxy media through the BFF (not recommended — contradicts the decided rationale and the phase's separation goal).

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

_No issues resolved yet._
