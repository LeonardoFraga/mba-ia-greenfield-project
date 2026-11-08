---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: nestjs-project/test/videos-upload.e2e-spec.ts
---

# Endpoint Test Plan — Upload handshake de vídeos

## Application Overview

As quatro rotas autenticadas que orquestram o upload multipart de um vídeo de até 10GB sem que os bytes passem pela API. `POST /videos` pré-cadastra o rascunho e abre o multipart no object storage; `POST /videos/:id/parts` assina lotes de URLs de parte que o cliente usa para enviar direto ao storage; `POST /videos/:id/complete` finaliza, confere o objeto que chegou contra o que foi declarado e enfileira o processamento; `DELETE /videos/:id` aborta um upload em andamento. Todas exigem autenticação e posse do canal.

## Test Scenarios

### 1. Initiate — POST /videos

**Setup:** `beforeEach` trunca `videos`, `channels`, `users` em ordem reversa de FK; bootstrap do módulo de teste com `Test.createTestingModule({ imports: [AppModule] })` reproduzindo os globals do `main.ts` (ValidationPipe, filtro de exceções de domínio, guard JWT global); um usuário com canal é semeado e seu access token obtido via `POST /auth/login`.

#### 1.1. rejects-anonymous-initiate

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-08T22:50:14Z

**Steps:**
  1. POST /videos sem header `Authorization`, com body válido
    - expect: status `401`
    - expect: nenhuma linha criada em `videos`

#### 1.2. creates-draft-and-opens-multipart

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-08T22:50:14Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <token>` e body `{ title, size: 104857600, contentType: 'video/mp4' }`
    - expect: status `201`
    - expect: body contém `id`, `publicId`, `uploadId`, `partSize`, `partCount` e `status: 'uploading'`
    - expect: `publicId` tem 11 caracteres e casa `^[A-Za-z0-9_-]{11}$`
    - expect: `partCount` é `ceil(size / partSize)`
    - expect: a linha em `videos` tem `status = 'uploading'`, `upload_id` não nulo e `declared_size_bytes = 104857600`

#### 1.3. rejects-size-above-ceiling

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-08T22:50:14Z

**Steps:**
  1. POST /videos com `size: 10737418241` (um byte acima de 10GB)
    - expect: status `413`
    - expect: body com `errorCode: "UPLOAD_SIZE_EXCEEDED"`
    - expect: nenhuma linha criada em `videos` — a rejeição acontece antes do pré-cadastro
    - expect: nenhum multipart aberto no bucket de vídeos

#### 1.4. rejects-content-type-outside-allowlist

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-08T22:50:14Z

**Steps:**
  1. POST /videos com `contentType: 'application/zip'`
    - expect: status `415`
    - expect: body com `errorCode: "UNSUPPORTED_MEDIA_TYPE"`
    - expect: nenhuma linha criada em `videos`

---

### 2. Sign parts — POST /videos/:id/parts

**Setup:** o mesmo da seção 1, mais um segundo usuário com canal próprio e token próprio, e um rascunho em `uploading` criado pelo primeiro usuário.

#### 2.1. signs-requested-part-urls

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-08T22:50:14Z

**Steps:**
  1. POST /videos/:id/parts com body `{ partNumbers: [1, 2] }` e o token do dono
    - expect: status `200`
    - expect: `parts` tem dois itens, cada um com `partNumber`, `url` e `expiresIn`
    - expect: cada `url` aponta para o host do object storage, não para a API

#### 2.2. denies-non-owner

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-08T22:50:14Z

**Steps:**
  1. POST /videos/:id/parts no rascunho do primeiro usuário usando o token do segundo
    - expect: status `403`
    - expect: body com `errorCode: "VIDEO_NOT_OWNED"`
    - expect: nenhuma URL devolvida no corpo

#### 2.3. rejects-part-numbers-out-of-range

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-08T22:50:14Z

**Steps:**
  1. POST /videos/:id/parts com `{ partNumbers: [0] }`
    - expect: status `400`
  2. POST /videos/:id/parts com `{ partNumbers: [10001] }`
    - expect: status `400`
  3. POST /videos/:id/parts com `{ partNumbers: [] }`
    - expect: status `400`

---

### 3. Complete — POST /videos/:id/complete

**Setup:** o mesmo da seção 1, mais um rascunho em `uploading` cujas partes foram efetivamente enviadas ao storage pelas URLs pré-assinadas, de modo que as ETags do corpo sejam reais.

#### 3.1. completes-and-enqueues-processing

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-08T22:50:14Z

**Steps:**
  1. POST /videos/:id/complete com `{ parts: [{ partNumber: 1, etag }, { partNumber: 2, etag }] }`
    - expect: status `200`
    - expect: body com `status: 'processing'`
    - expect: a linha tem `storage_key` e `size_bytes` preenchidos, e `size_bytes` igual ao tamanho real do objeto
    - expect: um job aparece na fila com payload contendo o `videoId` da linha

#### 3.2. rejects-size-mismatch-and-aborts-upload

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-08T22:50:14Z

**Steps:**
  1. Criar um rascunho declarando `size` maior do que os bytes efetivamente enviados nas partes
  2. POST /videos/:id/complete com as ETags reais
    - expect: status `409`
    - expect: body com `errorCode: "UPLOAD_SIZE_MISMATCH"`
    - expect: a linha termina com `status = 'failed'` e `processing_error` não vazio
    - expect: nenhum job enfileirado
    - expect: o multipart deixa de constar como pendente no bucket

#### 3.3. rejects-complete-on-wrong-status

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-08T22:50:14Z

**Steps:**
  1. Completar um upload com sucesso, levando a linha a `processing`
  2. POST /videos/:id/complete novamente no mesmo vídeo
    - expect: status `409`
    - expect: body com `errorCode: "UPLOAD_NOT_IN_PROGRESS"`

---

### 4. Abort — DELETE /videos/:id

**Setup:** o mesmo da seção 2.

#### 4.1. aborts-and-discards-draft

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-08T22:50:14Z

**Steps:**
  1. DELETE /videos/:id no rascunho em `uploading`, com o token do dono
    - expect: status `204` sem corpo
    - expect: a linha deixa de existir em `videos`
    - expect: o multipart deixa de constar como pendente no bucket
  2. DELETE /videos/:id no mesmo id novamente
    - expect: status `404` com `errorCode: "VIDEO_NOT_FOUND"`

#### 4.2. denies-abort-by-non-owner

**Covers AC:** #4, #5
**Source:** auto
**Last sync:** 2026-11-08T22:50:14Z

**Steps:**
  1. DELETE /videos/:id no rascunho do primeiro usuário usando o token do segundo
    - expect: status `403` com `errorCode: "VIDEO_NOT_OWNED"`
    - expect: a linha continua existindo

---

## Coverage note

AC #6 do SI-03.8 ("as quatro rotas aparecem no `openapi.json` exportado") **não é coberta por cenário E2E** — é verificável rodando `npm run openapi:export` e inspecionando o artefato, não por uma chamada HTTP de runtime. Fica registrada aqui como lacuna deliberada, a ser conferida no fechamento da fase junto com os Deliverables de documentação.
