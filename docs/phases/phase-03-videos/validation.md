---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 8
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-08T18:57:34-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-08T18:51:31-03:00"
issues:
  - id: IC-1
    status: open
    summary: "TD-10 mandates real MinIO in tests; Testing Requirements says local adapter"
  - id: IC-2
    status: open
    summary: "Testing guide's queue section assumes Redis + BullModule; TD-01 chose neither"
  - id: AMB-1
    status: open
    summary: "\"extração de metadados\" does not name which metadata fields are persisted"
  - id: AMB-2
    status: open
    summary: "Thumbnail frame selection, dimensions and output format unspecified"
  - id: MD-1
    status: resolved
    summary: "No TD decides the queue producer/consumer test strategy"
    resolved_by: phase-03-videos/TD-11
  - id: MD-2
    status: resolved
    summary: "No TD decides where the 10GB ceiling is enforced under presigned multipart"
    resolved_by: phase-03-videos/TD-12
  - id: MD-3
    status: resolved
    summary: "No TD decides who may stream/download a video in Fase 03"
    resolved_by: phase-03-videos/TD-13
  - id: ICC-1
    status: open
    summary: "TD-02/TD-07 send the browser to a non-same-origin host vs strict-BFF"
  - id: OQ-1
    status: open
    summary: "TD-11 pending — queue producer/consumer test strategy"
  - id: OQ-2
    status: open
    summary: "TD-12 pending — upload size and content-type enforcement point"
  - id: OQ-3
    status: open
    summary: "TD-13 pending — authorization policy for streaming and download"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

- **IC-1** — `phase-03-videos/TD-10` decides "Single S3 adapter, **real MinIO in tests**" and its Recommendation states that a local driver "cannot even express" presigned multipart and range delivery. The `## Testing Requirements` table in `context.md` — sourced from the `testing-guide-nestjs-project` Skill — still prescribes for the artifact type _"Service with side-effect dep (email, storage)"_: `Integration: real capture service (Mailpit) or local adapter`. The two statements coexist in `context.md` and prescribe opposite setups for the same artifact type, so `/plan-build` would have two contradictory sources when it writes the storage SIs' test layers. The conflict is deliberate on TD-10's side (it explicitly calls for the reference file to be rewritten), but it is still unresolved in the Skill that `/implement` reads. Explicit choice: (a) accept TD-10 as the phase-local override and record the override in the phase artifacts, leaving the Skill untouched for now; (b) update `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` § "Object Storage" to describe MinIO as the integration-test target and re-run `/plan-context 03` so the `## Testing Requirements` digest reflects it; (c) revisit TD-10 (not recommended — the decision is `decided` and its rationale is specific to this phase's protocol-level storage usage).

- **IC-2** — The queue half of the same conflict, now separable because `TD-11` exists to own it. `context.md`'s `## Testing Requirements` note records that the guide's `references/external-systems.md` § "Message Queue" is a placeholder marked TBD whose setup example is `BullModule.forRoot({ connection: { host: REDIS_HOST … } })`, and that the guide's § 2 "Worth testing" list cites `BullModule.registerQueue()` as the module-wiring example. `phase-03-videos/TD-01` decided BullMQ 6 on the **PostgreSQL** backend and its Recommendation states explicitly that `@nestjs/bullmq` does not accept a backend factory, so `Queue` and `Worker` are hand-written providers — there is no `BullModule` in this phase and no Redis service. Every queue instruction the guide gives is therefore wrong for this phase, not merely incomplete, and the guide has no row for a producer or consumer artifact type at all. Distinct from IC-1: different section of the reference file, different artifact type, and the fix depends on how `OQ-1` resolves `TD-11`. Explicit choice: (a) rewrite § "Message Queue" for the PostgreSQL backend (connection via the existing `db` service, `runMigrations()` in setup, `obliterate()` for isolation), add a queue producer/consumer row to the guide's artifact table, correct the § 2 `BullModule.registerQueue()` example, then re-run `/plan-context 03`; (b) accept it as a phase-local override recorded in the phase artifacts and leave the Skill stale; (c) defer until `TD-11` is decided, since the rewrite's content follows that decision.

### Ambiguities

- **AMB-1** — Capability _"Processamento automático do vídeo após upload (extração de duração e metadados)"_ names `duração` explicitly but leaves `metadados` as an open noun. No TD enumerates the set: `TD-05` decides _how_ metadata is extracted (`ffprobe` via `spawn`), `TD-06` decides _from where_ (presigned URL input), `TD-09` decides the surrounding status transitions — none says which fields are persisted. `/plan-build` cannot emit the Data Model (columns, nullability, types) nor the worker's output contract without the list. Explicit choice: enumerate the persisted metadata set in the plan's Data Model — e.g. container/format, video codec, audio codec, width/height, bitrate, framerate, byte size — and decide whether it lands as discrete columns or a single `jsonb` column.

- **AMB-2** — Capability _"Geração automática de thumbnail a partir de um frame do vídeo"_ does not specify which frame, at what dimensions, or in what output format. `TD-05` and `TD-06` settle the FFmpeg invocation mechanism but not its parameters, and unlike the multipart part size — which `TD-02`'s Recommendation explicitly designates "a plan-level parameter" — no TD designates these as plan-level, so they are currently unowned. The thumbnails bucket is public and cacheable per `TD-03`, which makes the output format and size a contract consumed by Fases 04 and 07, not a private worker detail. Explicit choice: fix the frame-selection rule (fixed timestamp vs percentage of duration vs FFmpeg thumbnail filter), the output dimensions, and the image format in the plan's Technical Specifications.

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

- **ICC-1** — `phase-03-videos/TD-02` (presigned part URLs) and `phase-03-videos/TD-07` (presigned GET for streaming and download) are both marked `Scope: Cross-layer` precisely so the frontend inherits a settled contract in Fases 04/05/07. That contract requires the browser to `PUT` parts to, and `GET` media from, the object-storage host directly. The inherited `phase-02-auth-frontend/TD-01` carries the strict-BFF model as its load-bearing rationale — _"The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller"_ — a model whose stated rule is that the browser talks only to same-origin `/api/...`. Taken literally, the Fase 03 delivery contract is the first thing in the project that sends the browser off-origin, and the conflict surfaces in Fase 04/05 rather than here, when the player and upload screens are built against it. Note that `TD-07`'s Recommendation already rejected routing media through the application server on load-shape grounds, so resolving this by proxying would reopen a `decided` TD. The two TDs added this cycle do not widen the conflict: `TD-12` constrains the API's own initiate/complete endpoints, and `TD-13` governs who may ask for a URL, neither of which adds a new off-origin call. Explicit choice: (a) record an explicit, narrow exception — strict BFF governs calls to the NestJS API, and presigned storage URLs minted server-side are outside its scope — and carry it as a note on `TD-02`/`TD-07` so the FE phases inherit the exception alongside the contract; (b) surface the conflict to the frontend's own decisions lineage (a revision on `next-frontend-config-base/TD-03` via `/decide`) so the exception is documented where the FE constraint lives; (c) reopen `TD-07` to proxy media through the BFF (not recommended — contradicts the decided rationale and the phase's separation goal).

### Unresolved Open Questions

- **OQ-1** — TD-11 pending — Queue Producer and Consumer Test Strategy. Resolution: fill the **Decision:** field of TD-11 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate 03`. The recommendation on record is Option A (real `Worker` in-process driven by `QueueEvents`, keeping direct processor invocation for branch-level unit tests).

- **OQ-2** — TD-12 pending — Upload Size and Content-Type Enforcement Point. Resolution: fill the **Decision:** field of TD-12 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate 03`. The recommendation on record is Option A (declare `size`/`contentType` at initiate, verify the real `ContentLength` with `HeadObject` at complete).

- **OQ-3** — TD-13 pending — Authorization Policy for Streaming and Download. Resolution: fill the **Decision:** field of TD-13 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate 03`. The recommendation on record is Option A (public for `ready`, state-gated via the existing `@Public()` decorator).

### UI Coverage Gaps

_None._

## Resolved Issues

- **MD-1** _(resolved_by phase-03-videos/TD-11)_ — No TD decided the queue producer/consumer test strategy. `TD-11` now owns it; the decision itself is pending and tracked as `OQ-1`.
- **MD-2** _(resolved_by phase-03-videos/TD-12)_ — No TD decided where the 10GB ceiling and content-type are enforced once TD-02 removed the API from the byte path. `TD-12` now owns it; the decision itself is pending and tracked as `OQ-2`.
- **MD-3** _(resolved_by phase-03-videos/TD-13)_ — No TD decided who may obtain a streaming or download URL while Fase 03 has no visibility field. `TD-13` now owns it; the decision itself is pending and tracked as `OQ-3`.
