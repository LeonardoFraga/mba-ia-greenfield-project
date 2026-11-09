---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-08T20:02:50-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-09T18:58:48-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "TD-10 mandates real MinIO in tests; Testing Requirements says local adapter"
    resolved_by: phase-03-videos/TD-10
  - id: IC-2
    status: resolved
    summary: "Testing guide's queue section assumes Redis + BullModule; TD-01 chose neither"
    resolved_by: phase-03-videos/TD-01
  - id: AMB-1
    status: resolved
    summary: "\"extração de metadados\" does not name which metadata fields are persisted"
    resolved_by: phase-03-videos/TD-05
  - id: AMB-2
    status: resolved
    summary: "Thumbnail frame selection, dimensions and output format unspecified"
    resolved_by: phase-03-videos/TD-05
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
    status: resolved
    summary: "TD-02/TD-07 send the browser to a non-same-origin host vs strict-BFF"
    resolved_by: phase-03-videos/TD-02, phase-03-videos/TD-07
  - id: OQ-1
    status: resolved
    summary: "TD-11 pending — queue producer/consumer test strategy"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-2
    status: resolved
    summary: "TD-12 pending — upload size and content-type enforcement point"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-3
    status: resolved
    summary: "TD-13 pending — authorization policy for streaming and download"
    resolved_by: phase-03-videos/TD-13
  - id: OQ-4
    status: resolved
    summary: "TD-14 pending — queue broker deployment shape, supersedes TD-01"
    resolved_by: phase-03-videos/TD-14
advisories: []
---

# phase-03-videos — Validation

The slice has 14 TDs: 13 active and decided, plus `TD-01`, which `TD-14` superseded and which therefore drops out of active enumeration (its `<!-- status: superseded-by: ... -->` marker is surfaced in `## Decisions Index` and its block is absent from `## Decisions Detail`). Every capability bullet in `## Capability Coverage` maps to at least one active decided TD — the queue bullet now via `TD-04`, `TD-11` and `TD-14`. No `IC-N` fires from the supersession: exactly one of the two queue-backend TDs is active, so there are no two decided TDs with mutually exclusive runtime behaviour. The three conflicts the earlier rounds surfaced remain adjudicated inside `context.md` rather than left for `/plan-build` to guess at. Check 8 (cross-slice coverage) is suppressed — phase 3 has exactly one phase-scope decisions doc, so `CC-N` / `MC-cross-N` are not meaningful concepts here and the `## Capability Consistency` and `## Cross-slice Advisories` sections are omitted. `UIG-N` is skipped entirely: the phase has no UI capability bullet, so `## UI Inventory` is absent by construction. No custom rules exist in `docs/rules/plan-validate/`, so the custom-findings and suppressions sections are omitted.

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

- **MD-1** _(resolved_by phase-03-videos/TD-11)_ — No TD decided the queue producer/consumer test strategy. `TD-11` now owns it.
- **MD-2** _(resolved_by phase-03-videos/TD-12)_ — No TD decided where the 10GB ceiling and content-type are enforced once TD-02 removed the API from the byte path. `TD-12` now owns it.
- **MD-3** _(resolved_by phase-03-videos/TD-13)_ — No TD decided who may obtain a streaming or download URL while Fase 03 has no visibility field. `TD-13` now owns it.
- **OQ-1** _(resolved_by phase-03-videos/TD-11)_ — TD-11 decided: Option A — real `Worker` in-process driven by `QueueEvents`, with direct processor invocation kept for branch-level unit tests. `bullmq` pinned in `library-refs.md`.
- **OQ-2** _(resolved_by phase-03-videos/TD-12)_ — TD-12 decided: Option A — declare `size` and `contentType` at initiate, verify the real `ContentLength` with `HeadObject` at complete before enqueueing. `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` pinned in `library-refs.md`.
- **OQ-3** _(resolved_by phase-03-videos/TD-13)_ — TD-13 decided: Option A — public for `ready` via the existing `@Public()` decorator, state-gated so every other status returns the same not-found response.
- **IC-1** _(resolved_by phase-03-videos/TD-10)_ — Resolved as a phase-local override rather than a Skill edit: `.claude/skills/` is provided foundation outside this phase's deliverable, so per `CLAUDE.md` § Scope Limits the guide correction is tracked as a separate task. The override is recorded as a `**Revisions:**` entry on TD-10 and as the phase-local override table in `context.md`'s `## Testing Requirements`, which is what `/implement` reads — storage specs run against the real MinIO container.
- **IC-2** _(resolved_by phase-03-videos/TD-01)_ — Same resolution shape as IC-1, for the queue half: the guide's § "Message Queue" placeholder (Redis + `BullModule.forRoot`) and its § 2 `BullModule.registerQueue()` example do not apply. Override recorded as a `**Revisions:**` entry on TD-01 and in `context.md`'s override table — BullMQ 6 on the PostgreSQL backend, no `BullModule`, no Redis service, `Queue` and `Worker` as hand-written providers.
- **AMB-1** _(resolved_by phase-03-videos/TD-05)_ — Persisted metadata set fixed as a hybrid: discrete columns for `duration_seconds`, `width`, `height`, `size_bytes` plus a `jsonb` `metadata` column for the `ffprobe` long tail (container, video codec, audio codec, bitrate, framerate). Recorded as a `**Revisions:**` entry on TD-05 so `/plan-build` derives the Data Model from it.
- **AMB-2** _(resolved_by phase-03-videos/TD-05)_ — Thumbnail parameters fixed: one frame seeked at 10% of the `ffprobe` duration, scaled to 1280x720 preserving aspect ratio, JPEG at fixed quality. A percentage never falls outside the file, unlike a fixed timestamp. Recorded as a `**Revisions:**` entry on TD-05.
- **ICC-1** _(resolved_by phase-03-videos/TD-02, phase-03-videos/TD-07)_ — Resolved by recording a deliberately narrow exception on both cross-layer TDs: the inherited strict-BFF model governs calls to the NestJS API, and presigned storage URLs minted server-side fall outside its scope. Recorded on both TDs rather than one because the two contracts are inherited independently by different frontend phases.
- **OQ-4** _(resolved_by phase-03-videos/TD-14)_ — TD-14 decided: Option A — a dedicated `redis` Compose service with `Queue` and `Worker` as hand-written providers, `ioredis` installed as BullMQ's optional peer, and `appendonly yes` for job durability. Option B (`@nestjs/bullmq@12`) was rejected because the package is `type: module` with its `require` export condition pointing at the ESM build, the same edge `TD-02` and `TD-08` declined in this CJS project. Option C (keep the PostgreSQL backend and document it) is the better choice on engineering merit and is recorded as such in the TD, but it leaves the acceptance criterion resting on the reader. The resolution carried three further edits: the supersede marker on `TD-01`, two `**Revisions:**` entries on `TD-11` (connection target, no `runMigrations()`, plus the re-anchored testing-guide override) with its chosen strategy intact, and the rewritten queue row in `context.md`'s `## Testing Requirements` override table.

## Revisions absorbed after this verdict

- **2026-11-08 — `phase-03-videos/TD-03`** gained a `**Revisions:**` entry scoping the `AbortIncompleteMultipartUpload` lifecycle rule to production S3, after the local MinIO build was verified not to implement it. The `sources_mtime` above was refreshed to match. This opens **no new issue**: the chosen option is unchanged, no capability loses coverage, and the cleanup mechanism moves to `SI-03.12`'s reaper, which the plan already contained. The `clean` verdict therefore still holds — but note that the authority for that verdict is `/plan-validate`, and this entry records a refresh applied during `/implement`, not a fresh run of the checks. Re-run `/plan-validate 03` if an independent reconfirmation is wanted.

- **2026-11-09 — `phase-03-videos/TD-10`** gained a `**Revisions:**` entry splitting the signing endpoint from the server-side endpoint, after client-facing presigned URLs were found to carry the Compose service name (`minio:9000`) and therefore to be unusable outside Docker — SigV4 covers the `Host` header, so the host cannot be rewritten after signing. The `sources_mtime` above was refreshed to match. This opens **no new issue**: the chosen option (single S3 adapter, real MinIO in tests) is unchanged, and the revision makes the implementation *match* obligations already recorded on `TD-02` (the browser `PUT`s parts directly) and `TD-07` (the player consumes the presigned GET as its `src`) rather than altering any decision. No capability loses coverage; the regression guard is a unit test, because the integration suites run inside the container where the public and internal endpoints coincide and so cannot distinguish the two paths. As with the entry above, the authority for the `clean` verdict is `/plan-validate`; this records a refresh applied during implementation, not a fresh run of the checks.

## Deferred follow-up (not an open issue)

~~Correcting `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` is tracked as a **separate task**~~ — **done on 2026-11-09**, after the phase closed. It was tracked as separate work per `CLAUDE.md` § Scope Limits, since `.claude/` is provided foundation outside this phase's deliverable structure, but was carried out because documentation of the AI foundation contradicting the code is an automatic-failure item in the challenge brief. Scope of that task: § "Object Storage" to MinIO, a queue producer/consumer row in the § 3 artifact table, and the § 2 `BullModule.registerQueue()` example. Note that `TD-14` changed what is wrong with § "Message Queue" — the placeholder's assumption of **Redis is now correct**, while its `BullModule.forRoot` setup example and `getQueueToken` usage remain inapplicable, because `TD-14` keeps `Queue` and `Worker` as hand-written providers with no `BullModule`.

None of this gates `/plan-build`: the authoritative instruction for `/implement` is the phase-local override table in `context.md`'s `## Testing Requirements`, backed by the `**Revisions:**` entries on `TD-10` (storage) and `TD-11` (queue).
