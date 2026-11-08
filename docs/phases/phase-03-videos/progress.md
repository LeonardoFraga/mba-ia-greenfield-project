# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 5/12 completed

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
- **Status:** completed
- **Tests:** 11 passing em `src/storage/` (10 de integração contra o MinIO real + 1 compilation test); suíte completa 190 passing / 29 suites, e2e 52 passing / 3 suites, `tsc --noEmit` exit 0, lint exit 0
- **Observations:**
  - **Os dois mecanismos centrais da fase estão verificados de verdade, não contra mock:** multipart de duas partes enviadas por URL pré-assinada completando com o tamanho somado; `Range: bytes=0-99` na URL pré-assinada respondendo `206` com `Content-Range: bytes 0-99/4096` e exatamente 100 bytes no corpo; `abortMultipartUpload` deixando o upload inexistente (o `ListParts` subsequente falha); e o override de content-disposition no download.
  - **Dois métodos além da lista do plano.** `countUploadedParts` porque a AC do abort exige *observar* que as partes sumiram, e `deleteObject` porque a regra de testes manda limpar o dado criado — sem ele os objetos de teste acumulariam no MinIO de desenvolvimento. Nenhum dos dois é especulativo: cada um existe porque um teste precisa dele.
  - **Partes de 5MB no teste por limite de plataforma**, não por escolha: o S3 rejeita parte não-final abaixo de 5MB, então o caso de duas partes é 5MB + 1KB.
  - **`fetch` não aceita `Buffer` nos tipos.** Node aceita em runtime, mas o `BodyInit` do DOM não inclui `Buffer`; o teste usa `new Uint8Array(body)`, que é o equivalente type-correto. Peguei isso com o `tsc` — e só depois de ter relatado "tsc limpo" por engano, porque meu `echo` de confirmação rodava incondicionalmente depois do pipe. Relato corrigido na hora.
  - **`npm audit` é ruído herdado:** 39 vulnerabilidades (2 low, 13 moderate, 21 high, 3 critical), e **nenhuma** menciona `aws-sdk` — os caminhos apontam para o stack NestJS e para `preview-email`/`uuid` sob o `@nestjs-modules/mailer` da Fase 02. Fora do escopo desta fase; `npm audit fix --force` traz breaking changes.

### SI-03.5 — Montar o QueueModule e o contrato do job
- **Status:** completed
- **Tests:** 7 passing em `src/queue/` (5 de integração contra o Redis real + 2 de módulo); suíte completa 197 passing / 31 suites, e2e 52 passing / 3 suites, `tsc --noEmit` exit 0, lint exit 0
- **Observations:**
  - **Erro meu no `library-refs.md`, corrigido:** eu havia fixado `ioredis: ^6.0.0` lendo o `npm view ioredis version` sem checar peers. O `typeorm@0.3.28` declara `peerOptional ioredis@^5.0.4`, então o install falha com `ERESOLVE` nomeando o TypeORM. A versão que satisfaz os dois ranges (BullMQ pede `>=5.0.0`) é `5.11.1`. Pin corrigido no `library-refs.md` com a razão registrada, para quem reler o artefato não repetir o caminho.
  - **Confirmado em runtime que o `bullmq@6` exporta `createPostgresBackend` e `runMigrations`** — a descrição do backend Postgres no `library-refs.md` estava correta. Simplesmente não os usamos, por TD-14; o módulo documenta isso no comentário para ninguém "consertar" depois achando que faltou.
  - **Teste de regressão para a decisão da TD-14:** um caso assere que `@nestjs/bullmq` não está no manifest, com uma asserção de sanidade (`bullmq` presente) para não passar sobre objeto vazio. Tive de ler o `package.json` via `fs` em vez de importar: `resolveJsonModule` está desligado no tsconfig e `require()` é proibido pelo ESLint — o lint pegou na primeira tentativa.
  - **`onModuleDestroy` fecha a `Queue`** e a conexão ioredis. Sem isso o Jest vaza handle, e o `--forceExit` que a suíte usa esconderia o vazamento em vez de reportá-lo.
  - Payload do job deliberadamente mínimo (`videoId` + `storageKey`): o worker relê a linha, então não carrega snapshot que pode envelhecer entre enfileirar e executar.

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
