# Docker

Everything runs in Docker. `docker compose up --build` is the supported way to run ShopSage locally.

## Services

| Service                        | Image                                                   | Host port         | Purpose                                             |
| ------------------------------ | ------------------------------------------------------- | ----------------- | --------------------------------------------------- |
| `shopsage-backend`             | built from `docker/backend.Dockerfile`                  | `3000`            | REST API                                            |
| `shopsage-qdrant`              | `qdrant/qdrant:v1.12.4`                                 | `6333` (loopback) | Vector database                                     |
| `shopsage-redis`               | `redis:7.4-alpine`                                      | `6379` (loopback) | Conversation history                                |
| `shopsage-embeddings`          | `ghcr.io/huggingface/text-embeddings-inference:cpu-1.8` | `8080` (loopback) | **Optional** — self-hosted embeddings               |
| `shopsage-reference-connector` | built from `docker/backend.Dockerfile`                  | `8750` (loopback) | **Development only** — reference commerce connector |

**Three services start by default, not four.** Embeddings default to a hosted OpenAI-compatible endpoint
— usually the same gateway that serves the LLM — so the inference container is behind a Compose profile:

```bash
docker compose up                              # backend + Qdrant + Redis
docker compose --profile selfhosted up         # …and local embeddings
docker compose --profile reference up          # …and the reference commerce connector
```

**The reference connector is a development aid and must stay behind its profile.** It is a runnable form
of [Proposal 0002](proposals/0002-commerce-connector-contract.md) over a fictional eight-product
catalogue, so ShopSage's commerce path can be exercised without a Magento instance. It reads a session
token's subject **without verifying the signature** — correct for a stand-in, since verifying would need
the private key and make it a second issuer, and catastrophic anywhere real. That is why it is profiled
and bound to loopback. Using it needs two settings together:

```bash
docker compose --profile reference up
# .env:
MAGENTO_API_URL=http://shopsage-reference-connector:8750
```

Run **bare** it binds loopback only, and that default is the control rather than a convenience:
`listen(port)` with no host binds every interface, which for this server means publishing a
non-verifying connector to the local network. The Compose service passes `--host 0.0.0.0` because a
container bound to its own loopback is unreachable from the backend — safe because the host mapping is
`127.0.0.1:8750:8750`. It says so on startup when bound wide, stating the fact rather than predicting
a consequence that would be false in the container case.

Redis is **not** behind a profile, unlike the embeddings service: it is a ~15 MB image that starts
instantly, and a durable conversation store should be the easy path rather than the opt-in one. Switching
to it is then one variable (`CONVERSATION_STORE=redis`) with no extra setup.

It runs with **no disk persistence** and `maxmemory-policy volatile-ttl`. Conversations expire on their
own, so paying fsync durability to protect data that deletes itself within the hour is the wrong trade,
and under memory pressure evicting the entries closest to expiring is the least harmful thing to do —
`noeviction` would instead fail every write once memory filled, turning a capacity problem into an
outage. See [ADR 0024](adr/0024-durable-conversation-store.md).

Downloading a 2.2 GB model nobody asked for is a poor first run. Self-hosting stays a first-class
option — it is the answer whenever content may not leave the network — and needs three settings
together: `EMBEDDING_PROVIDER=tei`, `EMBEDDING_BASE_URL=http://shopsage-embeddings:80`, and an
`EMBEDDING_MODEL`/`EMBEDDING_DIMENSIONS` pair matching what the container serves. See
[ADR 0018](adr/0018-embeddings-backend-is-configuration.md).

Service names double as DNS names on the Compose network, which is why the backend reaches Qdrant at
`http://shopsage-qdrant:6333`.

Qdrant, Redis and the embeddings service are all bound to `127.0.0.1` rather than `0.0.0.0`. They are
datastores and inference endpoints with no authentication in the default configuration; publishing them
on the LAN would expose the whole corpus — and every customer's conversation — to anyone on the network.
That loopback binding is also precisely what makes them reachable from the host at all, which the next
section depends on.

### One `.env`, both contexts: why `QDRANT_URL` and `REDIS_URL` say `localhost`

`.env` holds `QDRANT_URL=http://localhost:6333` and `REDIS_URL=redis://localhost:6379` — the host
addresses, not the Docker service names — and that is correct for **both** `docker compose up` and a
bare `node` process (`npm run dev`, `npm run ingest`, `npm run evaluate`, `npm run preview`), with no
editing when switching between them. That is possible only because of an asymmetry worth understanding
rather than taking on faith:

`docker-compose.yml` hardcodes both variables directly in the backend service's own `environment:`
block (`QDRANT_URL: http://shopsage-qdrant:6333`, similarly for Redis), and a Compose `environment:`
entry always wins over the same key arriving from `env_file:` (i.e. `.env`) — that precedence is
Compose's, not something this project arranges. So **inside the container, `.env`'s value for these two
variables is never even read** — whatever `.env` says, the backend running in Docker always gets the
Docker-internal hostname. `.env`'s `localhost` values are consulted only by something running outside
Docker, and Qdrant's and Redis's container ports are published to the host (`127.0.0.1:6333`,
`127.0.0.1:6379`) for exactly that reason — a bare `node` process reaches the same containers Docker
Compose itself uses, just from the other side of the published port.

Before this, `.env`'s default for `QDRANT_URL` was the Docker hostname, which is precisely backwards:
it happened to be harmless inside Docker (Compose overrides it there regardless) and silently broke
every local, non-Docker invocation — `ENOTFOUND shopsage-qdrant`, since that name resolves only inside
the Compose network. The ingestion CLI was the first to surface it, because it is the entry point most
often run outside Docker while Qdrant runs inside it.

**This is not true of every service address**, and knowing which category a variable falls into matters
before assuming the same trick applies. `MAGENTO_API_URL`, and `EMBEDDING_BASE_URL` when self-hosting
via the `tei` provider, are **not** overridden by Compose — they are forwarded from `.env` into the
container unchanged, deliberately, so that a real deployment can never silently default to the
fictional reference connector by omission. For those two, `.env`'s value has to actually match where
the backend or CLI is running: the Docker hostname if it runs inside Docker too (the normal way to use
the reference connector or a self-hosted embeddings container), or `http://localhost:<published-port>`
if it runs bare against a container Docker is still hosting. See the comments beside each variable in
`.env.example` for the specific ports.

### Qdrant authentication: presence, not value

Qdrant enables API-key authentication whenever `QDRANT__SERVICE__API_KEY` is **present**, whatever it
contains. The compose file therefore declares it in the bare list form:

```yaml
environment:
  - QDRANT__SERVICE__API_KEY
```

not as `QDRANT__SERVICE__API_KEY: ${QDRANT_API_KEY:-}`. The mapping form always sets the variable, so a
blank value switched authentication **on** with a key nothing could present. `/readyz` kept answering
200 — it is exempt from auth — so the stack looked healthy while every read and write returned 401. The
bare form resolves from `.env` when set and omits the variable entirely when it is not, so there is no
broken state in between.

Enabling authentication means setting **both** variables to the same value: `QDRANT__SERVICE__API_KEY`
for the server that requires the key, and `QDRANT_API_KEY` for the backend that presents it. Setting
only the first locks the backend out of its own store.

## Running

```bash
cp .env.example .env        # then set the LLM_* and EMBEDDING_* values
docker compose up --build
```

**A `.env` with gateway credentials is now required.** The backend refuses to start without
`LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `EMBEDDING_BASE_URL` and — for the default hosted provider —
`EMBEDDING_API_KEY`. With `restart: unless-stopped` an unconfigured backend presents as a **restart
loop**.

The embedding values are usually the same gateway and credential as the LLM ones, because most
OpenAI-compatible gateways serve `/embeddings` alongside `/chat/completions`. That is the intended, visible outcome for configuration a human
has to supply — the log line before each exit names exactly what is missing:

```bash
docker compose logs shopsage-backend | grep 'bootstrap failed'
```

Qdrant and the embeddings service still start and run normally, so the rest of the stack can be brought
up and inspected while the gateway is being sorted out.

If the gateway runs on the Docker host rather than in the network, address it as
`http://host.docker.internal:PORT` — `localhost` inside the container is the container.

`docker compose up` automatically applies `docker-compose.override.yml`, which switches the backend
into **development** mode: source bind-mounted, `node --watch`, `LOG_FORMAT=pretty`, debug logging.

For a production-shaped run, bypass the override explicitly:

```bash
docker compose -f docker-compose.yml up --build
```

| Command                  | Effect                                               |
| ------------------------ | ---------------------------------------------------- |
| `npm run docker:up`      | Development stack                                    |
| `npm run docker:up:prod` | Production-shaped stack                              |
| `npm run docker:logs`    | Follow backend logs                                  |
| `npm run docker:down`    | Stop, keep volumes                                   |
| `npm run docker:reset`   | Stop and **delete volumes** (re-downloads the model) |

## Verification

```bash
# 1. Configuration is valid in both modes
docker compose config --quiet
docker compose -f docker-compose.yml config --quiet

# 2. Build
docker compose -f docker-compose.yml build shopsage-backend

# 3. Start
docker compose -f docker-compose.yml up -d

# 4. Backend is alive
curl -fsS http://localhost:3000/health

# 5. The site profile really was loaded from config/
curl -fsS http://localhost:3000/health/info

# 5a. The gateway was configured, and the credential is not in the logs
docker compose -f docker-compose.yml logs shopsage-backend | grep 'llm gateway configured'
docker compose -f docker-compose.yml logs shopsage-backend | grep -c "$LLM_API_KEY"   # expect 0

# 5b. A real question, end to end
curl -fsS -XPOST http://localhost:3000/v1/chat \
  -H 'content-type: application/json' \
  -d '{"message":"What is your return policy?"}'

# 6. Dependencies (503 until TEI finishes downloading the model)
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/health/ready
curl -fsS http://localhost:3000/health/ready

# 7. Dependencies directly
curl -fsS http://localhost:6333/readyz
curl -fsS http://localhost:8080/health

# 8. Container-level health as Docker sees it
docker inspect --format '{{.State.Health.Status}}' shopsage-backend

# 9. Graceful shutdown - expect "shutdown started" then "shutdown complete"
docker compose -f docker-compose.yml stop shopsage-backend
docker compose -f docker-compose.yml logs --tail 20 shopsage-backend
```

Expected results are listed in [Testing](Testing.md).

## First run takes a while

On first start, the embeddings service downloads `BAAI/bge-m3` — roughly **2.2 GB**. Until it
finishes, `/health/ready` returns 503 with `embeddings: down`. This is correct behaviour, not a
failure: the backend starts regardless of dependency state and reports readiness honestly.

Weights are cached in the `embeddings-cache` volume, so subsequent starts are fast. `docker compose
down -v` deletes that cache and forces a re-download.

### Resource requirements

BGE-M3 is an XLM-RoBERTa-large model (~560 M parameters) running on CPU. Budget **at least 4 GB of
memory for the embeddings container alone**, and expect single-digit embeddings per second on a
laptop. On a memory-constrained machine the container will be killed by the OOM killer, which appears
as the service restarting repeatedly.

**`bge-m3` is the production model** and the shipped default. On a constrained development machine — and
only there — swap in the smaller English-only model:

```bash
# .env  — LOCAL DEVELOPMENT ONLY. Never ship this.
EMBEDDING_MODEL=BAAI/bge-small-en-v1.5
EMBEDDING_DIMENSIONS=384
EMBEDDING_QUERY_PREFIX=Represent this sentence for searching relevant passages:
```

The third line is not optional with this model: the smaller BGE models are trained with an asymmetric
query instruction, and omitting it degrades retrieval silently. See
[Configuration](Configuration.md#which-embedding-model).

**Both variables must change together.** `bge-small-en-v1.5` produces 384-dimensional vectors, not 1024. Switching models also invalidates any existing collection: vectors from two different models in
one collection produce silently meaningless similarity scores. Re-create the collection and re-ingest.

Two guards now make that mistake loud rather than silent: every embedding response is checked against
`EMBEDDING_DIMENSIONS`, and `/health/ready` fails if the container is serving a model other than
`EMBEDDING_MODEL`.

### When "out of memory" leaves no OOM evidence

Observed on a machine with 8 GB allocated to Docker: `bge-m3` reached `Warming up model` and the
container exited with status **0** — then restarted, eighteen times, never becoming ready.

```bash
docker inspect shopsage-embeddings --format \
  'restarts={{.RestartCount}} oomkilled={{.State.OOMKilled}} exit={{.State.ExitCode}}'
# restarts=18 oomkilled=false exit=0
```

`OOMKilled` is **false** and the exit code is **0**, so nothing in Docker's own reporting says "out of
memory". The signature to recognise is the loop itself: repeated `Warming up model` with no `Ready`
line, and a rising `RestartCount`.

```bash
docker compose logs shopsage-embeddings | grep -c 'Warming up model'   # more than 1 is the tell
```

The fix is the smaller model above, or more memory for Docker. Warm-up is the peak: TEI allocates for
its maximum batch, so a model that serves fine can still fail to start.

## Why there are no Compose healthchecks on Qdrant and TEI

Neither image ships a shell, `curl` or `wget`, so a Compose healthcheck would require either adding
tooling to someone else's image or writing a command that depends on its internals. Both are brittle.

Instead the **application owns dependency readiness**: the backend probes both services and reports
them on `/health/ready`. This is also the correct twelve-factor behaviour — the service starts
regardless of dependency state — and it means `depends_on` controls start order only, never blocking
startup on a dependency that may take minutes to warm up. See
[ADR 0008](adr/0008-docker-first-environment.md).

The backend itself does have a `HEALTHCHECK`, implemented with `node -e` and `fetch` so no extra
tooling enters the image.

## Image design

`docker/backend.Dockerfile` is a multi-stage build:

| Stage          | Purpose                                                  |
| -------------- | -------------------------------------------------------- |
| `base`         | `node:22-alpine`, workdir, npm quietened                 |
| `manifests`    | every workspace `package.json` — the cacheable layer key |
| `dependencies` | `npm ci --omit=dev --ignore-scripts`                     |
| `development`  | full install, source copied, `node --watch`              |
| `production`   | runtime dependencies + source, non-root, healthcheck     |

Decisions worth knowing:

- **Manifests are copied before source, by wildcard.** Editing a source file does not invalidate the
  install layer, so an incremental rebuild is seconds rather than a minute. `COPY --parents
packages/*/package.json ./` brings in every workspace manifest, and `--parents` is what preserves the
  directory structure — without it every manifest would land on the same path.

  This was a hand-maintained list of three until Stage 9a, and it had been silently wrong since Stage 7b.
  The failure mode is worth knowing because it is not the one this document previously predicted: `npm ci`
  does **not** fail on a missing manifest. It can only resolve a workspace whose `package.json` it can
  read, so a package added later was simply absent from `node_modules`, and the image failed much later
  at _import_ time with `ERR_MODULE_NOT_FOUND` — which reads as a code bug, not a build one. Local
  development hid it completely, because a root `npm install` links every workspace regardless of what
  any single package declares. A wildcard cannot fall behind; a list can, and did.

  The other half of that fix was in `packages/rag-backend/package.json`, which imported
  `@shopsage/conversation-store` and `@shopsage/session-token` without declaring either. **Declare what
  you import**, even inside a workspace — npm's hoisting will forgive it locally and Docker will not.

- **`--ignore-scripts`.** No package in this tree needs a lifecycle script, and refusing to run them
  removes an arbitrary-code-execution path from the build.
- **`USER node`.** Never run as root. The official image ships an unprivileged user.
- **Tests are excluded** via `.dockerignore`, so no test code ships in an image. In development the
  source is bind-mounted, so tests are still available inside the container:
  `docker compose exec shopsage-backend npm test`.
- **`init: true`.** Gives the container a PID 1 that forwards signals, so SIGTERM reaches Node and
  graceful shutdown actually runs. Without it, every rolling deploy looks like a crash.

Only `./packages` and `./config` are bind-mounted in development. Mounting the repository root would
shadow `/app/node_modules` and break the npm workspace symlinks.

## Troubleshooting

| Symptom                                             | Cause and fix                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `/health/ready` stuck at 503, `embeddings: down`    | Model still downloading. `docker compose logs -f shopsage-embeddings`.                |
| Embeddings container restarts repeatedly            | Almost always memory — but see below, **it may not look like an OOM**.                |
| `embeddings: down`, error says `unexpected model`   | `EMBEDDING_MODEL` disagrees with the running container. Align them, then re-ingest.   |
| Backend exits immediately with `bootstrap failed`   | Invalid config. The stderr line names the file and the offending key.                 |
| Backend restarts in a loop from the first start     | `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` missing from `.env`. The log names them. |
| `/v1/chat` returns 502 for every question           | Gateway unreachable or rejecting us. `grep remediation` in the logs.                  |
| `/v1/chat` 502s but the gateway works from the host | `localhost` in `LLM_BASE_URL` is the container. Use `host.docker.internal`.           |
| `/v1/chat` 400s with `stream_options`-style errors  | A strict gateway. Set `LLM_STREAM_INCLUDE_USAGE=false`.                               |
| `qdrant: down` but Qdrant is running                | `QDRANT_API_KEY` set for Qdrant but not for the backend, or vice versa.               |
| Qdrant data operations 401 while `/readyz` is 200   | Auth is on with a key nothing can present. See the Qdrant note below.                 |
| `Vector store returned 404`                         | The collection does not exist yet — expected before the first ingestion run.          |
| Port 3000 already in use                            | Set `BACKEND_PORT` in `.env`.                                                         |
| Code changes not picked up                          | You are on the production target. Drop `-f docker-compose.yml`.                       |
| `failed to connect to the docker API`               | Docker Desktop's engine is not running.                                               |

## Known limitations

- Image tags are pinned by version, not by digest. Digest pinning is the stricter choice and is
  tracked in [Roadmap](Roadmap.md).
- Qdrant runs without an API key by default in local development. Set `QDRANT_API_KEY` for any
  shared or production deployment.
- CPU-only inference. GPU support for TEI is a separate image and compose profile, deferred until
  ingestion volume justifies it.
