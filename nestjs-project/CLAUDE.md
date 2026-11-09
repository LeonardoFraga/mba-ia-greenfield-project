# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **MinIO:** `docker compose exec minio curl -fsS http://localhost:9000/minio/health/live` — exit code `0`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **Video worker:** `docker compose logs video-worker | grep "worker listening"` — the line naming the queue and the Redis host is what proves the consumer is attached. A `video-worker` that keeps restarting means it crashed on boot; read its logs before anything else.

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`. Data lives in the `db-data` volume, so it survives `docker compose down` and any recreation of the container
- `mailpit` — SMTP sink, SMTP on `1025`, web UI on `8025`
- `minio` — S3-compatible object storage, API on `9000`, console on `9001`, key/secret `streamtube`
- `minio-init` — one-shot: creates the `videos` and `thumbnails` buckets and makes `thumbnails` publicly readable, then exits `0`. An exited `minio-init` is the expected steady state, not a failure.
- `redis` — BullMQ broker, port `6379`, started with `--appendonly yes` so an enqueued job survives a restart
- `video-worker` — the **same image** as `nestjs-api`, started with `npm run start:worker`. No ports: it has no HTTP surface, it consumes the queue.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment (named volumes are kept, so the database,
# MinIO objects and queued jobs survive)
docker compose down

# Tear down AND discard all persisted data — migrations and seeds must be re-run
docker compose down -v
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Environment Variables (Fase 03)

Storage and queue keys. `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY`,
`STORAGE_SECRET_KEY`, `STORAGE_BUCKET_VIDEOS`, `STORAGE_BUCKET_THUMBNAILS` and
`STORAGE_PUBLIC_URL` are **required** — the app refuses to boot without them,
by `src/config/env.validation.ts`. The rest have defaults.

| Key | Default | Notes |
|-----|---------|-------|
| `STORAGE_ENDPOINT` | — | S3 API endpoint. `http://minio:9000` in Compose |
| `STORAGE_REGION` | `us-east-1` | |
| `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` | — | |
| `STORAGE_BUCKET_VIDEOS` | — | Private bucket; every read is a presigned GET |
| `STORAGE_BUCKET_THUMBNAILS` | — | Public, cacheable bucket |
| `STORAGE_PUBLIC_URL` | — | **The one host that must not be a Compose service name** — it is handed to a browser, so `http://localhost:9000` locally |
| `STORAGE_PRESIGN_TTL_SECONDS` | `900` | Presigned URL lifetime |
| `STORAGE_UPLOAD_PART_SIZE_BYTES` | `52428800` | 50MB: a 10GB file is 200 parts, well under the 10,000 cap |
| `STORAGE_MAX_UPLOAD_BYTES` | `10737418240` | 10GB ceiling, enforced at initiate and verified at complete |
| `STORAGE_ABANDONED_UPLOAD_CUTOFF_HOURS` | `24` | How long a row may sit at `uploading` before the reaper collects it |
| `REDIS_HOST` / `REDIS_PORT` | `redis` / `6379` | |
| `QUEUE_VIDEO_PROCESSING_NAME` | `video-processing` | Jest rewrites this to `…-test` (see below) |
| `QUEUE_JOB_ATTEMPTS` | `3` | Exhausting it is what lets a row reach `failed` |
| `QUEUE_JOB_BACKOFF_DELAY_MS` | `1000` | Exponential |

`FFMPEG_VERSION` is a Docker build `ARG` in `Dockerfile.dev` (not an env var),
pinned to the exact apt candidate so an image rebuild cannot silently change
the FFmpeg the worker runs.

## Test Queue Namespace

`src/test/jest-queue-namespace.ts` runs after `dotenv/config` in both Jest
configs and rewrites `QUEUE_VIDEO_PROCESSING_NAME` to `<name>-test`.

This is not cosmetic: the `video-worker` container drains the real queue, so
without it a producer spec asserting `getJobs(['waiting'])` races a live
consumer and fails for a reason that has nothing to do with the code. Do not
remove it, and when adding a queue-touching spec do not hardcode a queue name —
read it from `src/config/queue.config.ts` so it follows the namespace.

Note the path difference: `package.json`'s jest config has `rootDir: "src"`, so
the entry is `<rootDir>/test/...`, while `test/jest-e2e.json` resolves
`<rootDir>` to its **own directory**, so the entry is `<rootDir>/../src/test/...`.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
