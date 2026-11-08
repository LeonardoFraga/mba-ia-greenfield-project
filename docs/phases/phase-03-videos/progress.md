# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/12 completed

### SI-03.1 — Provisionar object storage e broker no Compose
- **Status:** completed
- **Tests:** no tests (Infra SI — verificado pelas acceptance criteria)
- **Observations:**
  - **Registry:** o `minio/minio` oficial **não é mais puxável do Docker Hub** (a API do registry responde 401 mesmo com token anônimo) e `quay.io/minio/minio` responde 401. `bitnami/minio` também migrou. A imagem que funciona é `bitnamilegacy/minio` — é o mesmo servidor MinIO (verificado: `DEVELOPMENT.2025-05-24`, `/minio/health/live` → 200, arm64 nativo), então a decisão da TD-10 segue de pé e só o canal de distribuição mudou. Risco a acompanhar: `bitnamilegacy` é um registry que a Bitnami congelou.
  - **Bootstrap:** o `minio/mc` sumiu junto com a imagem do servidor, então o init container usa `amazon/aws-cli` — ativamente mantido e falando a mesma API S3 que a aplicação, em vez de `bitnamilegacy/minio-client`.
  - **Lifecycle rule não aplicada (AC não cumprida).** A TD-03 pede `AbortIncompleteMultipartUpload` no bucket de vídeos. Este build do MinIO não implementa, verificado por três caminhos: (1) a API S3 rejeita regra cuja única ação é `AbortIncompleteMultipartUpload` com `InvalidArgument` / "XML did not validate against our published schema"; (2) combinada com uma ação de expiração a requisição é aceita mas o MinIO **descarta silenciosamente** o elemento de abort — o read-back devolve só `ExpiredObjectDeleteMarker`; (3) `mc ilm rule add --help` não expõe flag alguma de multipart/incomplete e a listagem não tem coluna para isso. A regra continua correta para o S3 de produção. Localmente, quem recolhe upload abandonado é o reaper da aplicação (SI-03.12), que aborta o multipart pelo SDK para toda linha presa em `uploading` além do corte. **Pendente de decisão:** registrar isso como Revision na TD-03.
  - **Env:** `STORAGE_PUBLIC_URL=http://localhost:9000` é a única chave que aponta para host em vez de nome de serviço do Compose, e de propósito — o valor é entregue a um browser para montar a URL pública do thumbnail, não usado em tráfego container-a-container.
  - **Fora de escopo, observado:** `.env.example` tem `MAIL_FROM="StreamTube" <noreply@streamtube.com>` com os angle brackets fora das aspas, exatamente o problema de parsing que `nestjs-project/CLAUDE.md` § Environment File Conventions documenta. Não corrigido por ser de outra fase.

### SI-03.2 — Configurar storage e fila no ConfigModule
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.3 — Criar a entidade Video e a migration
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Implementar o adapter de object storage
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Montar o QueueModule e o contrato do job
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Implementar o handshake de upload no VideosService
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Implementar a finalização do upload com verificação e enfileiramento
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Expor as rotas autenticadas de upload
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — Expor as rotas públicas de entrega
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — Montar o container do video worker
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Implementar o processor: metadados e thumbnail
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Implementar o reaper de uploads abandonados
- **Status:** pending
- **Tests:** —
- **Observations:** none
