---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-08T19:35:53-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-08T19:32:03-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-08T19:31:28-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-20T12:27:44-03:00"
---

# Fase 03 — Upload e Processamento de Vídeos

## Objective

Entregar upload de vídeos de até 10GB sem passar os bytes pela API, processamento automático em segundo plano que extrai duração e metadados e gera o thumbnail, URL única por vídeo, e reprodução via streaming mais download — sustentados por object storage, fila e worker novos subindo no Compose.

---

## Step Implementations

### SI-03.1 — Provisionar object storage e broker no Compose

**Description:** Sobe a infraestrutura nova que toda a fase depende — object storage, broker da fila e os buckets já criados com a lifecycle rule que limpa upload abandonado.

**Technical actions:**

1. Adicionar o serviço `minio` ao `compose.yaml` com healthcheck e volume nomeado (per `phase-03-videos/TD-10`)
2. Adicionar o serviço `minio-init` (one-shot, `depends_on` minio healthy) que cria os buckets `videos` (privado) e `thumbnails` (público e cacheável) e aplica a lifecycle rule `AbortIncompleteMultipartUpload` no bucket de vídeos (per `phase-03-videos/TD-03`)
3. Adicionar o serviço `redis` com `--appendonly yes` e healthcheck `redis-cli ping` (per `phase-03-videos/TD-14`)
4. Declarar as chaves novas em `.env` e `.env.example`, aspeando valores com caractere especial de shell conforme a convenção do subprojeto

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose ps` mostra `nestjs-api`, `db`, `mailpit`, `minio` e `redis` com status `running` — o `video-worker` entra no SI-03.10
- `docker compose exec redis redis-cli ping` responde `PONG`
- Os buckets `videos` e `thumbnails` existem após o `minio-init` completar
- O bucket `videos` tem a lifecycle rule `AbortIncompleteMultipartUpload` configurada
- O volume do Redis persiste o AOF entre `docker compose restart redis`

---

### SI-03.2 — Configurar storage e fila no ConfigModule

**Description:** Expõe as chaves de storage e de fila pelo mesmo padrão de config namespeada das fases anteriores, com validação no startup.

**Technical actions:**

1. Criar `src/config/storage.config.ts` — factory `registerAs('storage', ...)` com endpoint, região, credenciais, nomes dos buckets, TTL da URL pré-assinada e `partSize` (per `## Inherited Conventions`, phase 01)
2. Criar `src/config/queue.config.ts` — factory `registerAs('queue', ...)` com host, porta e nome da fila (per `phase-03-videos/TD-14`)
3. Estender `src/config/env.validation.ts` com o schema Joi das chaves novas, todas obrigatórias (per `## Inherited Conventions`, phase 01)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `storageConfig` / `queueConfig` | Unit: coerção de tipos e defaults | `src/config/storage.config.spec.ts` |
| `env.validation` | Unit: schema rejeita chave ausente e porta não-numérica | `src/config/env.validation.spec.ts` |

**Dependencies:** SI-03.1 — as chaves descrevem serviços que precisam existir no Compose

**Acceptance criteria:**

- `ConfigType<typeof storageConfig>` injeta com `@Inject(storageConfig.KEY)` sem cast
- Remover uma chave obrigatória do `.env` derruba a aplicação no startup com erro do Joi nomeando a chave
- Nenhuma chave de storage ou fila é lida via `process.env` fora das factories

---

### SI-03.3 — Criar a entidade Video e a migration

**Description:** Materializa a tabela de vídeos ligada ao canal, com o ciclo de status técnico e a divisão híbrida de metadados.

**Technical actions:**

1. Criar `src/videos/entities/video-status.enum.ts` — `draft | uploading | processing | ready | failed` (per `phase-03-videos/TD-09`)
2. Criar `src/videos/entities/video.entity.ts` conforme `## Technical Specifications` → `### Data Model` → `Video`, com `@ManyToOne` para `Channel` e índice único em `public_id` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-09`)
3. Criar a migration `CreateVideos` em `src/database/migrations/` — colunas, enum, FK com `ON DELETE CASCADE` e os três índices (per `## Inherited Conventions`, phase 01)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: default `draft`, unique em `public_id`, FK para `channels`, `jsonb` em `metadata`, `bigint` aceita 10GB | `src/videos/entities/video.entity.integration-spec.ts` |

**Dependencies:** none — a tabela `channels` já existe desde a Fase 02

**Acceptance criteria:**

- `npm run migration:run` cria a tabela e `migration:revert` a remove sem resíduo
- Inserir dois vídeos com o mesmo `public_id` viola a constraint única
- `status` default é `draft` quando omitido no insert
- Gravar `10737418240` em `size_bytes` e ler de volta preserva o valor
- Apagar o canal apaga seus vídeos em cascata

---

### SI-03.4 — Implementar o adapter de object storage

**Description:** Um único adapter falando a API do S3, que é o que torna upload pré-assinado e entrega por range testáveis de verdade.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` (per `library-refs.md`)
2. Criar `src/storage/storage.service.ts` com `createMultipartUpload`, `signUploadPart`, `completeMultipartUpload`, `abortMultipartUpload`, `headObject`, `signGetObject` e `putObject`, cliente configurado com `forcePathStyle: true` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-07`, `phase-03-videos/TD-12`)
3. Criar `src/storage/storage.module.ts` exportando o service, importando `ConfigModule` (per `phase-03-videos/TD-10`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration contra o MinIO real: multipart de 2 partes via URL pré-assinada, `HeadObject.ContentLength`, `Range` devolvendo `206`, abort removendo as partes | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilation test | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 (MinIO no ar), SI-03.2 (config de storage)

**Acceptance criteria:**

- Um multipart de duas partes enviadas por URL pré-assinada completa e o objeto resultante tem o tamanho somado
- `headObject` devolve `ContentLength` sem baixar o corpo
- Um `GET` com header `Range: bytes=0-99` na URL pré-assinada responde `206` com 100 bytes
- `abortMultipartUpload` deixa o bucket sem partes pendentes
- Os testes rodam contra o MinIO do Compose, sem adapter de filesystem e sem mock de presigning (per `## Technical Specifications` → phase-local override)

---

### SI-03.5 — Montar o QueueModule e o contrato do job

**Description:** Fia a fila à mão — sem `BullModule` — e fixa o payload e a política de retry de que o ciclo de status depende.

**Technical actions:**

1. Instalar `bullmq` e `ioredis` (per `library-refs.md`)
2. Criar `src/queue/queue.module.ts` com `Queue` e `QueueEvents` como providers explícitos construídos a partir de `queueConfig`, sem `createPostgresBackend` e sem `runMigrations()` (per `phase-03-videos/TD-14`, `phase-03-videos/TD-11`)
3. Criar `src/queue/video-processing.job.ts` — tipo do payload `{ videoId, storageKey }` e as opções `attempts: 3` com `backoff` exponencial de 1000ms (per `## Technical Specifications` → `### Events/Messages`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilation test com config de teste | `src/queue/queue.module.spec.ts` |
| `Queue` provider | Integration contra o Redis real: `add` enfileira com o payload e as opções de retry esperadas | `src/queue/queue.module.integration-spec.ts` |

**Dependencies:** SI-03.1 (Redis no ar), SI-03.2 (config de fila)

**Acceptance criteria:**

- `Queue` e `QueueEvents` injetam por token sem `@nestjs/bullmq` no `package.json`
- Um job enfileirado aparece em `getJobs(['waiting'])` com `{ videoId, storageKey }`
- O job carrega `attempts: 3` e `backoff.type: 'exponential'`
- Fechar o módulo fecha `Queue` e `QueueEvents` sem deixar handle aberto no Jest

---

### SI-03.6 — Implementar o handshake de upload no VideosService

**Description:** O pré-cadastro do rascunho e a emissão das URLs de parte — onde o teto de 10GB é imposto antes de qualquer coisa ser criada.

**Technical actions:**

1. Criar `src/videos/videos.service.ts` com `initiateUpload` — valida `size` contra o teto e `contentType` contra a allowlist, resolve o canal do usuário, gera `public_id` com retry em conflito, cria o rascunho e abre o multipart (per `phase-03-videos/TD-08`, `phase-03-videos/TD-12`, `phase-03-videos/TD-02`)
2. Implementar `signParts` — valida faixa e lote de `partNumbers`, confere posse e `status = uploading`, devolve as URLs (per `phase-03-videos/TD-02`)
3. Implementar `abortUpload` — aborta o multipart e remove o rascunho (per `phase-03-videos/TD-02`)
4. Criar os DTOs `InitiateUploadDto` e `SignPartsDto` conforme `### API Contracts` → `#### Validation Rules — videos`
5. Criar as exceções de domínio novas em `src/common/exceptions/` conforme `### Error Catalog` (per `phase-02-auth/TD-07`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: branches de validação, posse e retry de `public_id` com repo mockado | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: contrato de DB do rascunho + multipart real no MinIO | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.3 (entidade), SI-03.4 (adapter de storage)

**Acceptance criteria:**

- `initiateUpload` com `size` acima de 10GB lança `UPLOAD_SIZE_EXCEEDED` e **não** cria linha nem multipart
- `initiateUpload` com `contentType` fora da allowlist lança `UNSUPPORTED_MEDIA_TYPE` e não cria nada
- O rascunho nasce com `status = uploading`, `upload_id` preenchido e `declared_size_bytes` igual ao declarado
- `public_id` tem 11 caracteres URL-safe e um conflito simulado na inserção é reemitido com novo valor
- `signParts` num vídeo de outro usuário lança `VIDEO_NOT_OWNED`
- `signParts` num vídeo com `status != uploading` lança `UPLOAD_NOT_IN_PROGRESS`

---

### SI-03.7 — Implementar a finalização do upload com verificação e enfileiramento

**Description:** Fecha o multipart conferindo os bytes que chegaram contra os prometidos, e só então enfileira o processamento.

**Technical actions:**

1. Implementar `completeUpload` em `VideosService` — confere posse e `status`, chama `CompleteMultipartUpload` com as partes ordenadas (per `phase-03-videos/TD-02`)
2. Verificar `HeadObject.ContentLength` contra `declared_size_bytes`; divergência **apaga o objeto**, move para `failed` com `processing_error` e lança `UPLOAD_SIZE_MISMATCH` (per `phase-03-videos/TD-12`). A TD-12 escreve "aborta o multipart", o que não é possível nesse ponto — o tamanho só é legível depois de o `CompleteMultipartUpload` montar as partes, e aí o multipart já não existe. A limpeza equivalente é apagar o objeto; o resultado observável que o Error Catalog especifica não muda.
3. Persistir `storage_key` e `size_bytes` reais, mover para `processing` e enfileirar `video.process` na mesma transação lógica (per `phase-03-videos/TD-09`, `### Events/Messages`)
4. Criar o DTO `CompleteUploadDto` com a regra de partes consecutivas a partir de 1

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: branches de posse, status e divergência de tamanho com repo e storage mockados | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: multipart real no MinIO, verificação por `HeadObject` e job enfileirado no Redis real | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.6 (handshake), SI-03.5 (fila)

**Acceptance criteria:**

- Um upload consistente termina com `status = processing`, `storage_key` e `size_bytes` preenchidos e um job em `waiting`
- Um objeto cujo `ContentLength` difere do declarado lança `UPLOAD_SIZE_MISMATCH`, deixa `status = failed` com `processing_error` e **não** enfileira job
- Partes fora de ordem ou começando fora de 1 são rejeitadas na validação do DTO
- Chamar complete num vídeo já `processing` lança `UPLOAD_NOT_IN_PROGRESS`

---

### SI-03.8 — Expor as rotas autenticadas de upload

**Description:** Publica o handshake como HTTP sob o guard global, documentado no OpenAPI.

**Route:** POST /videos, POST /videos/:id/parts, POST /videos/:id/complete, DELETE /videos/:id
**Test Specs:** see `nestjs-project/specs/videos-upload.plan.md`
**Authorization:** Owner (per `### Authorization Matrix`)

**Technical actions:**

1. Criar `src/videos/videos.controller.ts` com as quatro rotas conforme `### API Contracts`, delegando ao service sem lógica própria (per `.claude/rules/nestjs-controllers.md`)
2. Decorar com `@nestjs/swagger` — bodies, respostas e os códigos de erro do `### Error Catalog` (per `openapi-docs-nestjs/TD-01`)
3. Estender `src/videos/videos.module.ts` (criado no SI-03.3, onde o `forFeature([Video])` passou a ser pré-requisito de boot) com `StorageModule`, `QueueModule`, o controller e os providers do service

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosModule` | Unit: compilation test | `src/videos/videos.module.spec.ts` |

As linhas de E2E ficam de fora desta tabela de propósito: os cenários HTTP são autorados externamente pelo `/plan-test-specs` no spec referenciado em `**Test Specs:**`.

**Dependencies:** SI-03.6 (handshake), SI-03.7 (finalização)

**Acceptance criteria:**

- `POST /videos` sem `Authorization` retorna `401`
- `POST /videos` com body válido retorna `201` com `publicId`, `uploadId`, `partSize` e `partCount`
- `POST /videos` com `size` acima do teto retorna `413` com `error: "UPLOAD_SIZE_EXCEEDED"`
- `POST /videos/:id/parts` num vídeo de outro usuário retorna `403` com `error: "VIDEO_NOT_OWNED"`
- `DELETE /videos/:id` retorna `204` e o rascunho deixa de existir
- As quatro rotas aparecem no `openapi.json` exportado

---

### SI-03.9 — Expor as rotas públicas de entrega

**Description:** Metadata, streaming e download abertos, com o estado do vídeo — e não a identidade de quem chama — como porta.

**Route:** GET /videos/:publicId, GET /videos/:publicId/stream, GET /videos/:publicId/download
**Test Specs:** see `nestjs-project/specs/videos-delivery.plan.md`
**Authorization:** Anonymous (per `### Authorization Matrix`)

**Technical actions:**

1. Implementar `findPublicByPublicId`, `getStreamUrl` e `getDownloadUrl` em `VideosService`, concentrando a decisão de autorização num único ponto do caminho de assinatura (per `phase-03-videos/TD-13`)
2. Adicionar as três rotas ao `VideosController` com `@Public()`, devolvendo `VIDEO_NOT_FOUND` para qualquer status diferente de `ready` (per `phase-03-videos/TD-13`)
3. Montar a URL pública permanente do thumbnail a partir do bucket público (per `phase-03-videos/TD-03`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` rotas de entrega | Unit: cada status não-`ready` resulta em `VIDEO_NOT_FOUND`, e `ready` emite URL | `src/videos/videos.service.spec.ts` |
| `VideosService.getStreamUrl` | Integration: a URL emitida responde `206` a um `Range` no MinIO real | `src/videos/videos.service.integration-spec.ts` |

As linhas de E2E ficam de fora desta tabela de propósito — ver `**Test Specs:**`.

**Dependencies:** SI-03.3 (entidade), SI-03.4 (adapter de storage)

**Acceptance criteria:**

- `GET /videos/:publicId/stream` sem token retorna `200` com `url` e `expiresIn` para vídeo `ready`
- `GET /videos/:publicId` de vídeo `draft`, `uploading`, `processing` ou `failed` retorna `404` `VIDEO_NOT_FOUND`, indistinguível de id inexistente
- A `url` de stream responde `206 Partial Content` a `Range: bytes=0-1023`
- A `url` de download carrega `response-content-disposition=attachment`
- `expiresIn` está na ordem de minutos, não de horas

---

### SI-03.10 — Montar o container do video worker

**Description:** O processo separado que a arquitetura pede — mesma imagem, mesmo código, comando diferente, com FFmpeg dentro.

**Technical actions:**

1. Acrescentar FFmpeg ao `Dockerfile.dev` com versão pinada explicitamente, em vez de herdar o que a base flutuar (per `phase-03-videos/TD-05`)
2. Criar `src/worker.ts` — bootstrap de app Nest standalone (`NestFactory.createApplicationContext`) carregando `WorkerModule` (per `phase-03-videos/TD-04`)
3. Adicionar o serviço `video-worker` ao `compose.yaml` — mesma imagem do `nestjs-api`, `command` apontando para o worker, `depends_on` db/redis/minio healthy (per `phase-03-videos/TD-04`)
4. Criar `src/videos/worker/worker.module.ts` importando config, TypeORM, `StorageModule` e o processor

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilation test | `src/videos/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.1 (Compose), SI-03.5 (fila)

**Acceptance criteria:**

- `ffmpeg -version` e `ffprobe -version` na imagem respondem com a versão pinada
- `docker compose logs video-worker` mostra o contexto Nest subindo até `Video worker context started`, e o container encerra com exit 0 — sem o `Worker` do BullMQ nada segura o event loop, então **manter o processo vivo e conectado ao Redis é AC do SI-03.11**, não deste
- `video-worker` e `nestjs-api` rodam a partir da mesma imagem construída uma vez
- O worker não expõe porta HTTP

---

### SI-03.11 — Implementar o processor: metadados e thumbnail

**Description:** O coração da fase — lê cabeçalho e um frame por range sobre URL pré-assinada, sem nunca baixar o arquivo inteiro.

**Technical actions:**

1. Criar `src/videos/worker/video-processing.processor.ts` — handler do job que assina um GET para `storage_key` e passa como input HTTP ao `ffprobe` via `spawn` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`)
2. Extrair duração, dimensões e a cauda longa para `metadata`, persistindo nas colunas discretas e no `jsonb` (per `phase-03-videos/TD-05` Revisions)
3. Gerar o thumbnail — um frame em 10% da duração, escalado para 1280x720 preservando aspect ratio, JPEG — e subir no bucket público em chave determinística (per `phase-03-videos/TD-05` Revisions, `phase-03-videos/TD-03`)
4. Mover para `ready`; falha irrecuperável após as tentativas esgotadas move para `failed` com `processing_error` (per `phase-03-videos/TD-09`)
5. Registrar o `Worker` real como provider ligado ao processor, com `worker.close()` no shutdown (per `phase-03-videos/TD-14`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProcessor` | Unit: branches de sucesso, arquivo inprocessável e idempotência com storage e repo mockados | `src/videos/worker/video-processing.processor.spec.ts` |
| Job completo | Integration: enfileira pelo produtor real, sobe `Worker` real, espera `completed` no `QueueEvents`, assere linha e objetos no MinIO; isolamento com `obliterate()` (per `phase-03-videos/TD-11`) | `src/videos/worker/video-processing.integration-spec.ts` |
| Caminho de falha | Integration: arquivo inválido esgota as tentativas e a linha termina `failed` com `processing_error` (per `phase-03-videos/TD-09`) | `src/videos/worker/video-processing.integration-spec.ts` |

**Dependencies:** SI-03.10 (container e módulo do worker), SI-03.4 (adapter de storage), SI-03.3 (entidade)

**Acceptance criteria:**

- Um vídeo fixture processa e termina `ready` com `duration_seconds`, `width`, `height` e `metadata` preenchidos
- `thumbnail_key` aponta para um JPEG existente no bucket público, de 1280 de largura
- O `ffprobe` é invocado com input HTTP e o volume baixado é uma fração do arquivo, não o arquivo inteiro
- Um arquivo não-vídeo esgota as 3 tentativas e a linha termina `failed` com `processing_error` não vazio
- Rodar o mesmo job duas vezes converge para a mesma linha, sem duplicar thumbnail
- `worker.close()` no `afterEach` não deixa handle aberto no Jest
- `docker compose ps` mostra `video-worker` com status `running` de forma sustentada, e seus logs mostram o `Worker` conectado ao Redis (AC herdada do SI-03.10, que não podia cumpri-la antes de o `Worker` existir)

---

### SI-03.12 — Implementar o reaper de uploads abandonados

**Description:** Fecha o ciclo que a TD-09 abriu ao justificar o estado `uploading` — distinguir handshake abandonado de upload em andamento só serve se alguém limpar.

**Technical actions:**

1. Criar `src/videos/upload-reaper.service.ts` — varre vídeos em `uploading` mais antigos que um corte configurável (per `phase-03-videos/TD-02`, `phase-03-videos/TD-09`)
2. Abortar o multipart correspondente e remover a linha, deixando a lifecycle rule do bucket cuidar de parte órfã remanescente (per `phase-03-videos/TD-03`)
3. Registrar o corte como chave de config em `storage.config.ts`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `UploadReaperService` | Unit: seleciona só `uploading` acima do corte, ignora `processing` e `ready` | `src/videos/upload-reaper.service.spec.ts` |
| `UploadReaperService` | Integration: rascunho antigo é removido e seu multipart abortado no MinIO real | `src/videos/upload-reaper.service.integration-spec.ts` |

**Dependencies:** SI-03.6 (handshake cria os rascunhos), SI-03.4 (adapter de storage)

**Acceptance criteria:**

- Um vídeo `uploading` mais antigo que o corte é removido e seu multipart deixa de constar no bucket
- Um vídeo `uploading` dentro do corte permanece intocado
- Vídeos `processing`, `ready` e `failed` nunca são tocados pelo reaper

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| channel_id | uuid | FK → `channels.id`, not null, on delete cascade |
| title | varchar(255) | not null |
| public_id | varchar(16) | unique, not null — 11 URL-safe chars from `crypto.randomBytes(8)` base64url *(per `phase-03-videos/TD-08`)* |
| status | enum | not null, default `draft` — `draft` \| `uploading` \| `processing` \| `ready` \| `failed` *(per `phase-03-videos/TD-09`)* |
| processing_error | text | nullable — reason stored when `status = failed` *(per `phase-03-videos/TD-09`)* |
| storage_key | varchar(512) | nullable — object key in the videos bucket *(per `phase-03-videos/TD-03`)* |
| thumbnail_key | varchar(512) | nullable — object key in the thumbnails bucket *(per `phase-03-videos/TD-03`)* |
| upload_id | varchar(255) | nullable — S3 `UploadId` from `CreateMultipartUpload`, retained for complete/abort *(per `phase-03-videos/TD-02`)* |
| declared_size_bytes | bigint | nullable — size the client declared at initiate *(per `phase-03-videos/TD-12`)* |
| declared_content_type | varchar(127) | nullable — content type the client declared at initiate *(per `phase-03-videos/TD-12`)* |
| size_bytes | bigint | nullable — real size from `HeadObject.ContentLength` at complete *(per `phase-03-videos/TD-12`)* |
| duration_seconds | numeric(10,3) | nullable — from `ffprobe` *(per `phase-03-videos/TD-05`)* |
| width | integer | nullable — from `ffprobe` *(per `phase-03-videos/TD-05`)* |
| height | integer | nullable — from `ffprobe` *(per `phase-03-videos/TD-05`)* |
| metadata | jsonb | nullable — `ffprobe` long tail: container, video codec, audio codec, bitrate, framerate *(per `phase-03-videos/TD-05`)* |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), updated on save |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to one `Channel` via `channel_id`. The owning user is reached through the channel's existing `user_id` (1:1 `User` ↔ `Channel` from Fase 02) — `Video` carries no direct user FK.

**Indexes:**
- unique on `public_id` — the uniqueness guarantee that actually holds; the insert retries on conflict *(per `phase-03-videos/TD-08`)*
- index on `channel_id` — channel listing
- index on `status` — the orphan-draft reaper scans `uploading` rows older than a cutoff *(per `phase-03-videos/TD-02`, `phase-03-videos/TD-09`)*

**Column naming:** snake_case, matching the existing `channels` / `users` tables from Fases 01–02.

**Size types:** `declared_size_bytes` and `size_bytes` are `bigint` because 10GB (10,737,418,240) overflows `integer`. TypeORM maps `bigint` to `string` in JS — the service converts at the boundary and never does arithmetic on the raw column value.

**The hybrid metadata split** *(per `phase-03-videos/TD-05` Revisions)*: `duration_seconds`, `width`, `height` and `size_bytes` are discrete columns because Fases 04 and 05 query and display them; everything else `ffprobe` returns lands in `metadata` so a new field does not force a migration.

---

### API Contracts

All endpoints are under the global `JwtAuthGuard` inherited from `phase-02-auth/TD-02` unless marked `@Public()`. The error envelope is the inherited `{ statusCode, error, message }` with domain codes *(per `phase-02-auth/TD-07`)* — this phase adds codes, not a new shape. Endpoints are documented with `@nestjs/swagger` decorators *(per `openapi-docs-nestjs/TD-01`)*.

#### POST /videos (SI-03.4)

Initiate an upload: pre-register the draft and open the S3 multipart upload *(per `phase-03-videos/TD-02`, `phase-03-videos/TD-12`)*.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {accessToken}

**Request body:**
- title: string, required — min 1, max 255 characters
- size: integer, required — declared byte size; min 1, max 10737418240 (10GB) *(per `phase-03-videos/TD-12`)*
- contentType: string, required — must be in the allowed container allowlist *(per `phase-03-videos/TD-12`)*

**Response 201:**
- id: string (uuid)
- publicId: string — the 11-char unique identifier
- uploadId: string — S3 multipart UploadId
- partSize: integer — bytes per part (plan-level parameter, 50MB)
- partCount: integer — `ceil(size / partSize)`
- status: string — `uploading`

**Error responses:**
- 400 validation error: when the request body fails schema validation
- 413 UPLOAD_SIZE_EXCEEDED: when `size` is above the 10GB ceiling
- 415 UNSUPPORTED_MEDIA_TYPE: when `contentType` is outside the allowlist
- 404 CHANNEL_NOT_FOUND: when the authenticated user has no channel

---

#### POST /videos/:id/parts (SI-03.4)

Sign a batch of `UploadPart` URLs. Called once after initiate and again whenever the client needs more URLs (a presigned URL expires, or the client uploads in waves) *(per `phase-03-videos/TD-02`)*.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {accessToken}

**Request body:**
- partNumbers: integer[], required — 1..10000, max 100 entries per request

**Response 200:**
- parts: array of `{ partNumber: integer, url: string, expiresIn: integer }`

**Error responses:**
- 400 validation error: when `partNumbers` is empty, out of the 1..10000 range, or over the batch cap
- 403 VIDEO_NOT_OWNED: when the video's channel does not belong to the authenticated user
- 404 VIDEO_NOT_FOUND: when no video matches the id
- 409 UPLOAD_NOT_IN_PROGRESS: when `status` is not `uploading`

---

#### POST /videos/:id/complete (SI-03.5)

Finalize the multipart upload, verify the stored object against what was declared, and enqueue processing *(per `phase-03-videos/TD-02`, `phase-03-videos/TD-12`, `phase-03-videos/TD-14`)*.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {accessToken}

**Request body:**
- parts: array of `{ partNumber: integer, etag: string }`, required — part numbers must start at 1 and be consecutive

**Response 200:**
- id: string (uuid)
- publicId: string
- status: string — `processing`

**Error responses:**
- 400 validation error: when `parts` is empty or part numbers are not consecutive from 1
- 403 VIDEO_NOT_OWNED: when the video's channel does not belong to the authenticated user
- 404 VIDEO_NOT_FOUND: when no video matches the id
- 409 UPLOAD_NOT_IN_PROGRESS: when `status` is not `uploading`
- 409 UPLOAD_SIZE_MISMATCH: when `HeadObject.ContentLength` does not match `declared_size_bytes`; the multipart upload is aborted and the row moves to `failed` with `processing_error` set *(per `phase-03-videos/TD-12`)*

---

#### DELETE /videos/:id (SI-03.4)

Abort an in-flight upload and discard the draft *(per `phase-03-videos/TD-02`)*.

**Request headers:**
- Authorization: Bearer {accessToken}

**Response 204:** No content.

**Error responses:**
- 403 VIDEO_NOT_OWNED: when the video's channel does not belong to the authenticated user
- 404 VIDEO_NOT_FOUND: when no video matches the id

---

#### GET /videos/:publicId (SI-03.7)

Public metadata for a ready video. `@Public()` *(per `phase-03-videos/TD-13`)*.

**Response 200:**
- publicId: string
- title: string
- durationSeconds: number \| null
- width: integer \| null
- height: integer \| null
- thumbnailUrl: string \| null — permanent public URL from the thumbnails bucket *(per `phase-03-videos/TD-03`)*
- createdAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video matches `publicId` **or** its `status` is not `ready` — the two cases are deliberately indistinguishable so a draft's existence does not leak *(per `phase-03-videos/TD-13`)*

---

#### GET /videos/:publicId/stream (SI-03.7)

Mint a short-lived presigned GET so the player can request byte ranges directly from storage. `@Public()` *(per `phase-03-videos/TD-07`, `phase-03-videos/TD-13`)*.

**Response 200:**
- url: string — presigned GET; storage answers `Range` requests with `206 Partial Content` natively
- expiresIn: integer — seconds; minutes, not hours *(per `phase-03-videos/TD-07`)*

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video matches `publicId` or its `status` is not `ready`

---

#### GET /videos/:publicId/download (SI-03.7)

The same mechanism with a content-disposition override, so the two capabilities cost one implementation *(per `phase-03-videos/TD-07`)*. `@Public()` *(per `phase-03-videos/TD-13`)*.

**Response 200:**
- url: string — presigned GET carrying `response-content-disposition=attachment; filename="..."`
- expiresIn: integer — seconds

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video matches `publicId` or its `status` is not `ready`

---

#### Validation Rules — videos

- `title`: required, string, min 1, max 255 characters
- `size`: required, integer, min 1, max 10737418240 — the 10GB ceiling enforced before the draft row or the multipart upload is created *(per `phase-03-videos/TD-12`)*
- `contentType`: required, string, must be in the allowed container allowlist; the real container is only confirmed later by `ffprobe` in the worker *(per `phase-03-videos/TD-12`)*
- `partNumbers`: required, non-empty integer array, each 1..10000, at most 100 per request
- `parts`: required, non-empty array of `{ partNumber, etag }`; part numbers start at 1 and are consecutive — S3 returns `400 InvalidPartOrder` otherwise

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ | ✓ |
| POST /videos/:id/parts | ✗ | ✗ | ✓ |
| POST /videos/:id/complete | ✗ | ✗ | ✓ |
| DELETE /videos/:id | ✗ | ✗ | ✓ |
| GET /videos/:publicId | ✓ | ✓ | ✓ |
| GET /videos/:publicId/stream | ✓ | ✓ | ✓ |
| GET /videos/:publicId/download | ✓ | ✓ | ✓ |

**Owner** means the video's `channel_id` resolves to the channel whose `user_id` is the authenticated subject. `POST /videos` has no owner column yet — it creates the row against the caller's own channel, so authenticated and owner coincide.

The three `GET` routes are `@Public()` and gated on **state, not identity**: a URL is issued only when `status = ready`, and every other status returns the same `VIDEO_NOT_FOUND` *(per `phase-03-videos/TD-13`)*. The authorization decision lives in one place in the signing path rather than inlined at each call site, because Fase 04 will tighten this route when it introduces visibility.

---

### Error Catalog

Codes added by this phase. The envelope `{ statusCode, error, message }` is inherited *(per `phase-02-auth/TD-07`)* and not redefined here.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| UPLOAD_SIZE_EXCEEDED | 413 | `size` declarado no initiate acima do teto de 10GB |
| UNSUPPORTED_MEDIA_TYPE | 415 | `contentType` fora da allowlist de containers |
| CHANNEL_NOT_FOUND | 404 | Usuário autenticado sem canal associado |
| VIDEO_NOT_FOUND | 404 | Nenhum vídeo com o id/publicId, ou o vídeo não está `ready` numa rota pública |
| VIDEO_NOT_OWNED | 403 | O canal do vídeo não pertence ao usuário autenticado |
| UPLOAD_NOT_IN_PROGRESS | 409 | Operação de upload num vídeo cujo `status` não é `uploading` |
| UPLOAD_SIZE_MISMATCH | 409 | `HeadObject.ContentLength` divergente do `declared_size_bytes` no complete |

**Not an HTTP error:** a processing failure in the worker never surfaces as a response code — it lands in the row as `status = failed` plus `processing_error`, and the user reads it through `GET /videos/:publicId` once Fase 04 exposes the management panel *(per `phase-03-videos/TD-09`)*.

---

### Events/Messages

Queue `video-processing` on BullMQ 6 against the `redis` Compose service, with `Queue` and `Worker` as hand-written providers — no `BullModule` *(per `phase-03-videos/TD-14`)*.

#### video.process

**Payload:**

```json
{ "videoId": "uuid", "storageKey": "string" }
```

**Producer:** `VideosService.completeUpload` — enqueued only after `HeadObject` verification passes and the row moves to `processing` *(per `phase-03-videos/TD-12`, `phase-03-videos/TD-14`)*
**Consumer:** `VideoProcessingWorker` in the `video-worker` Compose service — a standalone Nest app from the same image, started with a different command *(per `phase-03-videos/TD-04`)*
**Trigger:** the client finalizes the multipart upload via `POST /videos/:id/complete`
**Delivery semantics:** at-least-once — `attempts: 3` with `backoff: { type: 'exponential', delay: 1000 }`; queue-level retries absorb transient faults invisibly, and only exhausted attempts move the row to `failed` with a stored reason *(per `phase-03-videos/TD-09`, `phase-03-videos/TD-14`)*

**Idempotency:** at-least-once means the job can run twice for the same `videoId`. The processor is written to be idempotent — it overwrites `thumbnail_key` at a deterministic key, re-reads metadata from the source, and sets `status = ready` unconditionally on success, so a replay converges to the same row rather than duplicating work *(per `phase-03-videos/TD-09`)*.

**Job work** *(per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`)*: mint a presigned GET for `storageKey` and hand it to `ffprobe` as an HTTP input with range seeking — never download the 10GB object; read duration, dimensions and the container/codec long tail; then `ffmpeg` seeks one frame at 10% of the reported duration, scales to 1280x720 preserving aspect ratio and encodes JPEG; upload the thumbnail to the thumbnails bucket; persist the discrete columns plus `metadata` and flip `status` to `ready`.

**Durability:** the `redis` service carries `appendonly yes` so an enqueued job survives a broker restart — the property the PostgreSQL backend provided for free and that `TD-14` accepted as the cost of a visible broker *(per `phase-03-videos/TD-14`)*.

**No `runMigrations()`:** that bootstrap step exists only for BullMQ's PostgreSQL backend, which `TD-14` superseded *(per `phase-03-videos/TD-11` Revisions)*.

<!-- phase-a-complete -->

---

## Dependency Map

```
SI-03.1 (root — infra no Compose)
├── SI-03.2 — depends on SI-03.1 (as chaves descrevem serviços que precisam existir)
│   ├── SI-03.4 — depends on SI-03.1 + SI-03.2 (MinIO no ar + config de storage)
│   │   ├── SI-03.6 — depends on SI-03.3 + SI-03.4 (entidade + adapter)
│   │   │   ├── SI-03.7 — depends on SI-03.6 + SI-03.5 (handshake + fila)
│   │   │   │   └── SI-03.8 — depends on SI-03.6 + SI-03.7 (rotas de upload)
│   │   │   └── SI-03.12 — depends on SI-03.6 + SI-03.4 (reaper)
│   │   └── SI-03.9 — depends on SI-03.3 + SI-03.4 (rotas de entrega)
│   └── SI-03.5 — depends on SI-03.1 + SI-03.2 (Redis no ar + config de fila)
│       └── SI-03.10 — depends on SI-03.1 + SI-03.5 (container do worker)
│           └── SI-03.11 — depends on SI-03.10 + SI-03.4 + SI-03.3 (processor)
SI-03.3 (root — entidade e migration; a tabela channels já existe da Fase 02)
```

**Caminho crítico:** `SI-03.1 → SI-03.2 → SI-03.5 → SI-03.10 → SI-03.11`. É o ramo do worker, e é o mais longo porque o processor depende de infra, config, fila e container, nessa ordem.

**Ramos independentes:** `SI-03.3` não depende de nada e pode ser feito em paralelo com `SI-03.1`/`SI-03.2`. Depois de `SI-03.4`, os ramos de entrega (`SI-03.9`) e de upload (`SI-03.6 → SI-03.7 → SI-03.8`) são independentes entre si.

---

## Deliverables

- [x] SI-03.1 — Provisionar object storage e broker no Compose
- [x] SI-03.2 — Configurar storage e fila no ConfigModule
- [x] SI-03.3 — Criar a entidade Video e a migration
- [x] SI-03.4 — Implementar o adapter de object storage
- [x] SI-03.5 — Montar o QueueModule e o contrato do job
- [x] SI-03.6 — Implementar o handshake de upload no VideosService
- [x] SI-03.7 — Implementar a finalização do upload com verificação e enfileiramento
- [x] SI-03.8 — Expor as rotas autenticadas de upload
- [x] SI-03.9 — Expor as rotas públicas de entrega
- [x] SI-03.10 — Montar o container do video worker
- [x] SI-03.11 — Implementar o processor: metadados e thumbnail
- [x] SI-03.12 — Implementar o reaper de uploads abandonados

**Capacidades da fase** (de `docs/project-plan.md`, Fase 03):

- [x] Object storage para vídeos e thumbnails, com buckets separados por política de acesso
- [x] Fila de processamento em segundo plano com worker consumindo em container próprio
- [x] Upload de até 10GB sem passar os bytes pela API, com o teto imposto no initiate e verificado no complete
- [x] Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- [x] Processamento automático após o upload, extraindo duração e metadados
- [x] Thumbnail gerado automaticamente a partir de um frame do vídeo
- [x] URL única por vídeo, sem conflito, com índice único garantindo-a
- [x] Reprodução via streaming, com a storage respondendo `206` a range requests
- [x] Download do vídeo pelo usuário

**Infraestrutura:**

- [x] `docker compose up -d` sobe `nestjs-api`, `db`, `mailpit`, `minio`, `redis` e `video-worker`
- [x] Os buckets `videos` e `thumbnails` existem, e o de thumbnails é publicamente legível (`s3:GetObject` para `*`). A lifecycle rule de upload incompleto **não** é aplicada localmente: este build do MinIO não implementa `AbortIncompleteMultipartUpload` — verificado de três formas, e escopado para o S3 de produção pela revisão da `TD-03`. O reaper do SI-03.12 é o que recolhe os multiparts abandonados no ambiente local.
- [x] O Redis persiste com `appendonly yes`
- [x] A migration cria a tabela `videos` ligada a `channels`

**Full test suites** _(todo comando `npm`/`npx` roda dentro do container, por `nestjs-project/CLAUDE.md`)_:

- [x] Suíte de unit + integração passa (`docker compose exec nestjs-api npm test -- --runInBand`)
- [x] Suíte E2E passa (`docker compose exec nestjs-api npm run test:e2e`)
- [x] Type-check limpo (`docker compose exec nestjs-api npx tsc --noEmit`) — exit code 0
- [x] Lint passa (`docker compose exec nestjs-api npm run lint`)

**Documentação:**

- [x] `openapi.json` reexportado com as sete rotas novas (`docker compose exec nestjs-api npm run openapi:export`)
- [x] `CLAUDE.md` da raiz com a seção de vídeos (módulo, endpoints, fila/worker, storage)
- [x] `nestjs-project/CLAUDE.md` com os três serviços novos no bloco Services e as chaves de env novas
- [x] `progress.md` da fase com status e testes por SI
