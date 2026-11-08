# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 7/12 completed

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
- **Status:** completed
- **Tests:** 31 passing no SI (21 unit com mocks nos limites + 10 de integração contra DB e MinIO reais); suíte completa 228 passing / 33 suites, e2e 52 passing / 3 suites, `tsc --noEmit` exit 0, lint exit 0
- **Observations:**
  - **Erro de contrato corrigido nos meus próprios artefatos.** O `DomainExceptionFilter` serializa `{ statusCode, error, message }` — o campo é `error`, não `errorCode`. Meus dois specs de teste e duas ACs do plano asseravam `errorCode: "..."` no corpo. Corrigido nos três arquivos (o cabeçalho da tabela do Error Catalog continua `errorCode`, que é o nome da coluna do catálogo e está certo) e os specs re-estampados.
  - **Teto e allowlist ficam no service, não no DTO.** O Error Catalog pede `413 UPLOAD_SIZE_EXCEEDED` e `415 UNSUPPORTED_MEDIA_TYPE`; um `@Max()` no DTO daria `400`. Como efeito colateral bom, o teto continua sendo valor de config em vez de literal num decorator.
  - **JSDoc dos DTOs encurtado de propósito:** com `introspectComments: true` o JSDoc vira a `description` do OpenAPI, então a justificativa sobre status HTTP foi para comentário comum, fora da doc pública.
  - **`isPgUniqueViolationOnColumn` extraído para `src/common/database/pg-error.util.ts`** e o `channels.service.ts` passou a importá-lo. O helper introspecciona interno de driver (`driverError.code`/`.detail`); duas cópias divergiriam na primeira mudança de formato de mensagem.
  - **`findByUserId` entrou no `ChannelsService`** em vez de o `VideosService` consultar a tabela `channels`. O `CLAUDE.md` é explícito: módulo não deve ser dono de entidade alheia.
  - **Retry do `public_id` fora de transação, de propósito.** O `typeorm-queries.md` avisa que violação de unique dentro de transação a aborta e exige SAVEPOINT; como cada tentativa aqui é um insert avulso, o problema não existe. Divergência consciente do padrão do `channels.service`, que faz o retry dentro de transação.
  - **Compensação no handshake:** se o `CreateMultipartUpload` falha, o rascunho é apagado, para não deixar órfão que o reaper depois teria de interpretar.
  - **Dois tropeços meus nesta rodada:** o `videos.module.spec.ts` da rodada anterior quebrou ao o módulo ganhar imports de Config/Storage/Queue (reescrito com `ConfigModule` global, como a regra de testes manda para `forRootAsync`), e eu relatei "lint em 0" com o exit code mascarado por um `| tail` — o lint tinha 2 erros de `no-unsafe-member-access` em `mock.calls`. Passei a capturar o código antes de pipar.

### SI-03.7 — Implementar a finalização do upload com verificação e enfileiramento
- **Status:** completed
- **Tests:** 19 passing no SI (6 unit de `completeUpload` + 3 de integração contra MinIO e Redis reais + 10 unit do validator); suíte completa 247 passing / 34 suites, e2e 52 passing / 3 suites, `tsc --noEmit` exit 0, lint exit 0
- **Observations:**
  - **Imprecisão real encontrada na TD-12, e contornada sem reabrir a decisão.** A TD diz "verifica com `HeadObject` no complete" e "divergência **aborta o multipart**" — as duas coisas não coexistem: antes do `CompleteMultipartUpload` o objeto não existe (nada a inspecionar), e depois dele o multipart já não existe (nada a abortar). A limpeza equivalente é **apagar o objeto**, que é o que o código faz. O resultado observável que o Error Catalog especifica (`409`, linha `failed` com motivo, nada enfileirado) não muda, então tratei como imprecisão de prosa e corrigi a redação do plano em vez de abrir Revision na TD. Vale a sua chamada se preferir registrar formalmente.
  - **`upload_id` é zerado no complete**, tanto no caminho de sucesso quanto no de falha: depois de completar ou apagar, não existe mais upload endereçável, e deixar o id ali daria ao reaper um alvo inválido.
  - **Dois gatilhos de falha, uma exceção.** Divergência de tamanho e objeto acima do teto levam ambos a `failed` + `UPLOAD_SIZE_MISMATCH`, mas com `processing_error` distinto, para o motivo ficar legível depois.
  - **Regra de partes consecutivas virou validator próprio** (`IsConsecutiveFromOne`), com 10 testes unit. Não é expressável em decorator declarativo sobre o array, e sem ela o cliente receberia o `400 InvalidPartOrder` cru do S3 em vez do erro de validação do projeto. O guia pede Unit para validação customizada.
  - O teste de integração do caminho de falha declara o dobro do que envia, então a divergência é produzida de verdade pelo storage — não simulada.

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
