# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with two main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express). Contains modules for users, channels, videos, comments, etc.
- `docs/` — Project documentation, architecture diagrams, and planning.
- `next-frontend/` (Next.js) — not yet initialized

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST, streams from Object Storage
- **API** (Nest.js) → business rules, auth, reads/writes DB, uploads to storage, publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → consumes jobs from queue, processes videos, updates DB and storage
- **Database** (PostgreSQL) → users, channels, videos, comments, likes
- **Object Storage** (S3/MinIO) → video files and thumbnails
- **Message Queue** (Redis + BullMQ) → video processing job queue
- **Email Service** (SMTP) → account confirmation and password recovery

## Videos (Fase 03)

Upload, processing and delivery of videos. The bytes never pass through the API.

**Module:** `nestjs-project/src/videos/` — owns the `Video` entity, the upload
handshake, public delivery and the abandoned-upload reaper. The worker side
lives in `src/videos/worker/`.

**Endpoints** (full contract in `nestjs-project/openapi.json`):

| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| `POST` | `/videos` | Bearer | Opens the upload: pre-registers the draft row and the S3 multipart |
| `POST` | `/videos/{id}/parts` | Bearer | Returns presigned `UploadPart` URLs |
| `POST` | `/videos/{id}/complete` | Bearer | Verifies the stored size, then enqueues processing |
| `DELETE` | `/videos/{id}` | Bearer | Aborts the upload and drops the draft |
| `GET` | `/videos/{publicId}` | Public | Metadata of a `ready` video |
| `GET` | `/videos/{publicId}/stream` | Public | Returns `{ url, expiresIn }` — a short-lived presigned GET the player uses as its source; storage answers `Range` on it with `206` |
| `GET` | `/videos/{publicId}/download` | Public | The same mechanism with a `content-disposition: attachment` override, so the browser saves the file |

**Upload path.** The client slices the file and `PUT`s each part straight to
storage with a presigned URL, so a 10GB upload never touches the API process. A
presigned `PUT` cannot constrain size or content type (the SDK signs the payload
as `UNSIGNED-PAYLOAD`), so the ceiling is enforced at initiate from the declared
size and **verified** at complete against `HeadObject.ContentLength`.

**Queue and worker.** The API publishes a `video.process` job to a Redis-backed
BullMQ queue; the `video-worker` container runs the same image with
`npm run start:worker` and consumes it. `Queue` and `Worker` are hand-written
providers — `@nestjs/bullmq` is ESM-only and this project emits CommonJS.
Queue-level retries absorb transient faults; only exhausting the attempts moves
a row to `failed` with a stored `processing_error`.

**Processing.** The worker signs a GET and hands the URL to `ffprobe` and
`ffmpeg` as an HTTP input, so it reads byte ranges from storage instead of
downloading the object — measured at ~1–2% of the file, bounded by the GOP
rather than the file size. It extracts duration, dimensions and the codec tail,
generates a thumbnail from a frame at 10% of the duration fitted into 1280x720,
and moves the row to `ready`. The container stays stateless: nothing is ever
written to its filesystem.

Both delivery routes hand the client a URL rather than proxying bytes: the API
answers `200` with `{ url, expiresIn }` and the player or browser talks to
storage directly, so neither playback nor download passes through the API.

**Storage.** Two buckets with different access policies: `videos` is private and
every read goes through a short-lived presigned URL, while `thumbnails` is
public and served by permanent URL. `STORAGE_PUBLIC_URL` is the one setting that
must *not* be a Compose service name — a browser consumes it.

**Status lifecycle.** `draft → uploading → processing → ready | failed`. This
enum describes *processing* only; publication is editorial state and gets its
own field in Fase 04 rather than new values here.

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.