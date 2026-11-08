---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-08T18:57:34-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-08T18:51:31-03:00"
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
advisories: []
---

# phase-03-videos — Validation

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
