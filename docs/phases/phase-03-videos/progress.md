# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 3/12 completed

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
- **Status:** completed
- **Tests:** 31 passing no diretório de config (4 suites); suíte completa 168 passing / 25 suites, `tsc --noEmit` exit 0, lint exit 0
- **Observations:**
  - **Desvio do plano (arquivo de teste):** o plano previa `src/config/env.validation.spec.ts`, mas o projeto já tem `src/config/env.validation.integration-spec.ts` como casa dos testes do schema. Estendi o arquivo existente em vez de criar um paralelo. De passagem: esse arquivo testa só Joi puro, sem I/O, então pelo critério do `CLAUDE.md` § Test Type Selection ele deveria ser `*.spec.ts` — nomenclatura herdada da Fase 01, não mexi.
  - **Teste da Fase 01 ajustado por necessidade:** as chaves novas de credencial, endpoint e bucket são `required()`, e o `env.validation.integration-spec.ts` tem um fixture `requiredEnv` com `validate({})` esperando sucesso. Sem acrescentar as novas ao fixture, um teste da Fase 01 quebraria. O fixture é exatamente a costura prevista para isso.
  - **AC de startup verificada contra o app buildado**, não via `ts-node src/main.ts`: o `main.ts` importa `./metadata.js`, gerado pelo plugin CLI do swagger, que só existe depois do `nest build`. Resultado real: sem `STORAGE_ACCESS_KEY` o boot morre com `Config validation error: "STORAGE_ACCESS_KEY" is required`; com a chave de volta, `Nest application successfully started`.
  - **`||` em vez de `??`** nas leituras de env, para casar com `database.config.ts` e os outros vizinhos — e porque env var vazia deve cair no default, o que `??` não faz. A regra `typescript-strict.md` usa `??` no exemplo; a divergência é deliberada e local ao diretório de config.
  - Duas chaves a mais do que o plano listava: `QUEUE_JOB_ATTEMPTS` e `QUEUE_JOB_BACKOFF_DELAY_MS`, para que a política de retry que a TD-09 depende seja configuração e não número solto no código do produtor.

### SI-03.3 — Criar a entidade Video e a migration
- **Status:** completed
- **Tests:** 12 passing nos testes do SI (entidade + migrations); suíte completa 179 passing / 27 suites, e2e 52 passing / 3 suites, `tsc --noEmit` exit 0, lint exit 0
- **Observations:**
  - **Enum no arquivo da entidade**, não em `video-status.enum.ts` como o plano previa: o precedente do projeto é `verification-token.entity.ts`, que exporta seu enum do próprio arquivo da entidade.
  - **O lado inverso da relação custou mais do que parecia.** A regra `nestjs-entities.md` manda definir os dois lados, então `Channel` ganhou `@OneToMany(() => Video)`. Consequência em cascata: (1) todo DataSource de teste que registra `Channel` passou a precisar de `Video` no array de entidades, sob pena de `Entity metadata for Channel#videos was not found` — 10 arquivos de spec das Fases 01/02 ajustados; (2) o `VideosModule` com `forFeature([Video])` teve de ser criado **aqui** e não no SI-03.8, porque sem ele o `AppModule` real não resolve o lado inverso e o `openapi-export.integration-spec.ts` falha no bootstrap. O plano do SI-03.8 foi ajustado de "criar" para "estender".
  - **`cleanAllTables` ganhou `DELETE FROM "videos"`** em ordem reversa de FK. O `ON DELETE CASCADE` de `channels` cobriria, mas limpeza de teste por cascade implícito é frágil.
  - **`migrations.integration-spec.ts` reescrito em quatro pontos:** cadeia de 3 migrations, 5 tabelas, e o teste de revert agora assere que `videos` cai — porque a minha migration passou a ser a cabeça da cadeia, e não mais as de token. Acrescentei um teste novo garantindo que reverter a cabeça não leva as tabelas de token, que era a garantia que a asserção antiga dava de graça.
  - **Para tarefa separada:** `const ALL_ENTITIES = [...]` está duplicado em 10 arquivos de spec. Exportar a lista de `src/test/create-test-data-source.ts` tornaria a próxima entidade uma mudança de uma linha em vez de dez. Não fiz aqui para não misturar refactor de 10 arquivos num SI funcional.
  - **Fora de escopo, observado:** `create-test-data-source.ts` lê `process.env.DB_DATABASE`, mas o `.env` define `DB_NAME` — funciona só porque o fallback `'streamtube'` coincide com o nome real do banco. Herdado da Fase 01.

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
