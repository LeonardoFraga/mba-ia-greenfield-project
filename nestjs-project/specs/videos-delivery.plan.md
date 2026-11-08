---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: nestjs-project/test/videos-delivery.e2e-spec.ts
---

# Endpoint Test Plan — Entrega de vídeo (metadata, streaming, download)

## Application Overview

As três rotas públicas que entregam um vídeo pronto. `GET /videos/:publicId` devolve a metadata pública; `GET /videos/:publicId/stream` emite uma URL pré-assinada de curta duração que o player usa como `src`, deixando o object storage responder às range requests nativamente; `GET /videos/:publicId/download` reusa o mesmo mecanismo com override de content-disposition. Todas são `@Public()` e autorizam pelo **estado** do vídeo, não pela identidade de quem chama: a URL só é emitida com `status = ready`, e qualquer outro estado responde o mesmo `VIDEO_NOT_FOUND` que um id inexistente.

## Test Scenarios

### 1. Metadata pública — GET /videos/:publicId

**Setup:** `beforeEach` trunca `videos`, `channels`, `users` em ordem reversa de FK; bootstrap do módulo de teste com `Test.createTestingModule({ imports: [AppModule] })` reproduzindo os globals do `main.ts`; um canal semeado e vídeos semeados diretamente no repositório em cada status necessário, com um objeto real no bucket de vídeos para os casos `ready`.

#### 1.1. returns-metadata-for-ready-video

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-08T23:30:39Z

**Steps:**
  1. GET /videos/:publicId de um vídeo `ready`, sem header `Authorization`
    - expect: status `200`
    - expect: body com `publicId`, `title`, `durationSeconds`, `width`, `height`, `thumbnailUrl` e `createdAt`
    - expect: o corpo não expõe `storageKey`, `uploadId`, `channelId` nem `processingError`

#### 1.2. hides-every-non-ready-status

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-08T23:30:39Z

**Steps:**
  1. GET /videos/:publicId de um vídeo `draft`
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/:publicId de um vídeo `uploading`
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  3. GET /videos/:publicId de um vídeo `processing`
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  4. GET /videos/:publicId de um vídeo `failed`
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  5. GET /videos/:publicId de um `publicId` que nunca existiu
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
    - expect: corpo byte-idêntico ao dos quatro casos anteriores — a existência de um rascunho não vaza

#### 1.3. stays-public-for-authenticated-callers

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-08T23:30:39Z

**Steps:**
  1. GET /videos/:publicId de um vídeo `ready` com `Authorization: Bearer <token>` de um usuário que não é o dono
    - expect: status `200` com o mesmo corpo do caso anônimo — a identidade não altera a resposta

---

### 2. Streaming — GET /videos/:publicId/stream

**Setup:** o mesmo da seção 1, com um objeto real de tamanho conhecido no bucket de vídeos para o vídeo `ready`.

#### 2.1. issues-short-lived-presigned-url

**Covers AC:** #1, #5
**Source:** auto
**Last sync:** 2026-11-08T23:30:39Z

**Steps:**
  1. GET /videos/:publicId/stream de um vídeo `ready`, sem header `Authorization`
    - expect: status `200`
    - expect: body com `url` e `expiresIn`
    - expect: `url` aponta para o host do object storage, não para a API
    - expect: `expiresIn` é menor ou igual a `3600` — minutos, não horas

#### 2.2. url-serves-byte-ranges

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-08T23:30:39Z

**Steps:**
  1. GET /videos/:publicId/stream e capturar `url`
  2. GET na `url` capturada com header `Range: bytes=0-1023`
    - expect: status `206`
    - expect: header `Content-Range` presente, com o tamanho total do objeto
    - expect: o corpo tem exatamente 1024 bytes — a reprodução não exige download completo
  3. GET na `url` capturada sem header `Range`
    - expect: status `200` com o objeto inteiro

#### 2.3. refuses-stream-for-non-ready

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-08T23:30:39Z

**Steps:**
  1. GET /videos/:publicId/stream de um vídeo `processing`
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
    - expect: nenhuma `url` no corpo — nada é assinado para vídeo que não está pronto

---

### 3. Download — GET /videos/:publicId/download

**Setup:** o mesmo da seção 2.

#### 3.1. issues-url-with-attachment-disposition

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-08T23:30:39Z

**Steps:**
  1. GET /videos/:publicId/download de um vídeo `ready`, sem header `Authorization`
    - expect: status `200` com `url` e `expiresIn`
    - expect: a query string da `url` carrega `response-content-disposition` com `attachment`

#### 3.2. url-delivers-the-whole-object

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-08T23:30:39Z

**Steps:**
  1. GET /videos/:publicId/download e capturar `url`
  2. GET na `url` capturada
    - expect: status `200`
    - expect: header `Content-Disposition` começando com `attachment`
    - expect: o tamanho do corpo é igual ao `size_bytes` da linha

#### 3.3. refuses-download-for-non-ready

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-08T23:30:39Z

**Steps:**
  1. GET /videos/:publicId/download de um vídeo `failed`
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
    - expect: nenhuma `url` no corpo
