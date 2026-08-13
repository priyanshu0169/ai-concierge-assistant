# Configuration

ShopSage has two configuration sources with a hard boundary between them. Getting this boundary right
is what makes one build serve any store.

| Source                     | Holds                                           | Secret? | Differs per store? |
| -------------------------- | ----------------------------------------------- | ------- | ------------------ |
| Environment variables      | Infrastructure addresses, credentials, timeouts | **Yes** | Rarely             |
| `config/site-profile.json` | Behaviour, copy, branding, feature flags        | **No**  | Always             |

**The rule:** a secret must never appear in a site profile, and customer-facing copy must never
appear in the environment.

Why it matters: parts of a site profile are served to browsers (branding, welcome message, quick
replies), profiles are checked into deployment repositories and edited by non-engineers, and profiles
will eventually be resolved per request for multi-store hosting. Any of those makes a secret in a
profile a leak. Conversely, putting the system prompt in an environment variable makes prompt changes
a redeployment and makes multi-line copy unreadable.

Both sources are validated with zod at boot, and validation failure is fatal. See
[ADR 0004](adr/0004-configuration-boundary.md).

## Environment variables

> **`.env.example` is committed; `.env` is not.** `.gitignore` excludes `.env` and explicitly
> un-excludes `.env.example` (`!.env.example`), which is what makes the template shareable. A real
> credential written into the template is therefore a credential staged for commit. Secrets go in
> `.env`, always — and if one does reach `.env.example`, rotate it rather than just deleting the line.

Copy `.env.example` to `.env`. Every variable has a working default **except `LLM_API_KEY`,
`LLM_BASE_URL` and `LLM_MODEL`**, which the backend requires to start. A blank value (`FOO=`) is treated
as **absent** and falls back to the default — operators routinely leave placeholders in env files, and
treating those as the empty string would defeat every default. That also means `LLM_API_KEY=` is a
missing credential, not an empty one, and is reported as such.

### Runtime

| Variable            | Default                      | Notes                                     |
| ------------------- | ---------------------------- | ----------------------------------------- |
| `NODE_ENV`          | `development`                | `development` \| `test` \| `production`   |
| `PORT`              | `3000`                       |                                           |
| `SERVICE_NAME`      | `shopsage-backend`           | Appears as `name` in every log record     |
| `LOG_LEVEL`         | `info`                       | `trace`…`fatal`                           |
| `LOG_FORMAT`        | `json`                       | `pretty` for local dev only — it is lossy |
| `SITE_PROFILE_PATH` | `./config/site-profile.json` | Relative to the working directory         |

### HTTP

| Variable               | Default | Notes                                                          |
| ---------------------- | ------- | -------------------------------------------------------------- |
| `CORS_ALLOWED_ORIGINS` | `*`     | Comma-separated storefront origins. `*` is dev-only.           |
| `REQUEST_TIMEOUT_MS`   | `30000` | Ceiling on how long a client may take to send a request        |
| `SHUTDOWN_TIMEOUT_MS`  | `10000` | Grace period for in-flight requests on SIGTERM                 |
| `TRUST_PROXY`          | `false` | Enable **only** behind a trusted proxy — see the warning below |

`TRUST_PROXY` makes Express believe `X-Forwarded-For`. With no trusted proxy in front, any caller can
forge the client IP that rate limiting and audit logs depend on. Defaults to off for that reason.

Both settings of it are now load-bearing, because rate limiting keys on `req.ip`: **on** without a
trusted proxy lets a caller forge its identity and evade the limit; **off** behind one collapses every
customer into a single bucket. See [Rate limiting and capacity](#rate-limiting-and-capacity).

The backend logs a warning at boot if `NODE_ENV=production` and CORS is open to every origin.

### LLM gateway — **required**

| Variable                   | Default  | Notes                                                     |
| -------------------------- | -------- | --------------------------------------------------------- |
| `LLM_API_KEY`              | —        | **Secret. Required.**                                     |
| `LLM_BASE_URL`             | —        | **Required.** API base, or a full completions URL         |
| `LLM_MODEL`                | —        | **Required.** Provider's model identifier                 |
| `LLM_TEMPERATURE`          | `0.2`    | Low by default: a commerce assistant should not improvise |
| `LLM_MAX_TOKENS`           | `1024`   | Ceiling on the answer length                              |
| `LLM_TIMEOUT_MS`           | `60000`  | **Per attempt**, not a total                              |
| `LLM_MAX_ATTEMPTS`         | `3`      | Including the first. `1` disables retrying                |
| `LLM_AUTH_STYLE`           | `bearer` | `api-key` for Azure OpenAI                                |
| `LLM_STREAM_INCLUDE_USAGE` | `true`   | `false` for gateways that reject `stream_options`         |

These are consumed **only** by `@shopsage/llm-client`. No other package learns which provider, model
or base URL is in use. Works with an internal AI gateway, Azure OpenAI, LiteLLM, OpenRouter, vLLM, or
OpenAI.

**The backend will not start without the first three.** It exits non-zero at boot with one JSON line
naming every variable that is missing. An assistant with no model cannot answer anything, and an
instance that looks healthy while returning 502 to every customer is worse than one that visibly failed
to start. The scraper and ingestion CLI never call a model, which is why the requirement lives in the
backend's composition root rather than in the shared schema — see
[ADR 0013](adr/0013-required-config-per-entry-point.md).

**`LLM_BASE_URL`.** Give the API base and `/chat/completions` is appended:

| Set this                                                   | Requests go to                               |
| ---------------------------------------------------------- | -------------------------------------------- |
| `https://api.openai.com/v1`                                | `https://api.openai.com/v1/chat/completions` |
| `http://localhost:8000`                                    | `http://localhost:8000/chat/completions`     |
| `https://…/deployments/gpt/chat/completions?api-version=…` | unchanged, query preserved                   |

No `/v1` is ever inferred. Silently inventing a path segment turns a wrong base URL into a 404 that
looks like a missing model — and Azure's path embeds a deployment name that no amount of guessing would
reconstruct, which is why a complete URL is accepted as-is.

**A 401 does not always mean the credential.** Gateways that do per-team model access control answer
**401** — not 403 or 404 — for a model the key is not entitled to use. Check `LLM_MODEL` against the
gateway's allowed list before rotating anything; the log's `upstreamBody` usually names the model it
refused. The remediation hint says as much for this reason.

**Timeouts and attempts interact.** `LLM_TIMEOUT_MS` bounds one attempt, so the theoretical worst case
is `LLM_TIMEOUT_MS × LLM_MAX_ATTEMPTS` plus backoff. In practice timeouts are **not** retried — a
timeout means the gateway was still generating, so retrying pays for the abandoned work and multiplies
the customer's wait — so a slow gateway fails once at the budget. If a gateway is slow to respond at
all, lower `LLM_TIMEOUT_MS`; do not lower `LLM_MAX_ATTEMPTS` expecting it to help. See
[ADR 0012](adr/0012-llm-retry-and-failure-policy.md).

### Embeddings

| Variable                 | Default                  | Notes                                                      |
| ------------------------ | ------------------------ | ---------------------------------------------------------- |
| `EMBEDDING_PROVIDER`     | `openai`                 | `openai` (any compatible endpoint) or `tei` (self-hosted)  |
| `EMBEDDING_BASE_URL`     | —                        | **Required.** API base; the route is appended              |
| `EMBEDDING_API_KEY`      | —                        | **Secret. Required for `openai`**, unused for `tei`        |
| `EMBEDDING_AUTH_STYLE`   | `bearer`                 | `api-key` for Azure OpenAI                                 |
| `EMBEDDING_MODEL`        | `text-embedding-3-small` | 1536-dimensional dense vectors                             |
| `EMBEDDING_DIMENSIONS`   | `1536`                   | Must match the model's native width                        |
| `EMBEDDING_BATCH_SIZE`   | `16`                     | Documents per request; both backends reject oversized ones |
| `EMBEDDING_TIMEOUT_MS`   | `30000`                  | Per attempt                                                |
| `EMBEDDING_QUERY_PREFIX` | _(empty)_                | Instruction prepended to **queries only**                  |

**The gateway usually serves both.** Most OpenAI-compatible gateways expose `/embeddings` alongside
`/chat/completions`, so `EMBEDDING_BASE_URL` and `EMBEDDING_API_KEY` are typically the same values as
`LLM_BASE_URL` and `LLM_API_KEY`. They are separate variables rather than a fallback so that pointing
embeddings at a different endpoint — a self-hosted service, a different tenant — never requires touching
the LLM configuration, and so changing one cannot silently move the other.

The backend refuses to start without `EMBEDDING_BASE_URL`, and without `EMBEDDING_API_KEY` when the
provider is `openai`. A self-hosted service on a private network legitimately has no credential, and
demanding one there would mean inventing a dummy value.

Changing `EMBEDDING_MODEL` changes the vector space: the existing collection must be re-created and all
content re-ingested, `EMBEDDING_DIMENSIONS` must be updated to match, and `minScore` re-tuned. Mixing
vectors from two models in one collection produces silently meaningless similarity scores.

**Two guards make that mistake loud.** Every embedding response is checked against
`EMBEDDING_DIMENSIONS`, and `/health/ready` fails if the running service reports a different model than
`EMBEDDING_MODEL` — the case where someone changes the variable and the container keeps serving the old
weights, which nothing else in the system would notice.

### Choosing a backend and a model

The backend is a deployment decision. The client's behaviour is identical either way, and no
application code knows which is configured — see
[ADR 0018](adr/0018-embeddings-backend-is-configuration.md).

|                            | Hosted gateway _(default)_ | Self-hosted, full | Self-hosted, constrained                                   |
| -------------------------- | -------------------------- | ----------------- | ---------------------------------------------------------- |
| `EMBEDDING_PROVIDER`       | `openai`                   | `tei`             | `tei`                                                      |
| `EMBEDDING_MODEL`          | `text-embedding-3-small`   | `BAAI/bge-m3`     | `BAAI/bge-small-en-v1.5`                                   |
| `EMBEDDING_DIMENSIONS`     | `1536`                     | `1024`            | `384`                                                      |
| `EMBEDDING_QUERY_PREFIX`   | _(empty)_                  | _(empty)_         | `Represent this sentence for searching relevant passages:` |
| `EMBEDDING_API_KEY`        | required                   | not used          | not used                                                   |
| Max input                  | not published              | 8192 tokens       | 512 tokens                                                 |
| Languages                  | Multilingual               | Multilingual      | English                                                    |
| Content leaves the network | **yes**                    | no                | no                                                         |

**Every row changes together.** The dimensions must match the model's native output or every response
is rejected. The query prefix exists because the smaller BGE models are trained _asymmetrically_ — a
query gets an instruction that documents do not, and omitting it degrades retrieval without producing
any error. It is applied in `embedQuery` and never in `embedDocuments`.

**Hosted (`openai`) is the default** because it needs no extra service, no 2.2 GB download and no
memory budget, and because the gateway that already serves the LLM usually serves embeddings on the
same base URL with the same credential. It also measurably out-ranked the small local model on the
smoke corpus (see [RAG](RAG.md#retrieval-and-tenancy)).

**Self-hosted (`tei`) is the answer when content may not leave the network**, for an air-gapped
install, or when per-token cost matters more than operating a service. `bge-m3` is the model to use
there: multilingual, an 8192-token limit that comfortably fits a structure-aware chunk, and sparse and
multi-vector representations that leave hybrid retrieval open without a migration. It needs real
memory and will **fail to start rather than run slowly** if it is short
(see [Docker](Docker.md#when-out-of-memory-leaves-no-oom-evidence)).

**`bge-small-en-v1.5` is a constrained-laptop fallback only.** English-only, a 512-token limit, and
weaker separation between right and nearly-right answers. Never ship it.

Switching invalidates the corpus: re-create the collection and re-ingest. Re-tune `minScore` too —
score distributions differ per model, so a threshold carried across is either useless or mutes the
assistant entirely.

### Vector database

| Variable            | Default                 | Notes                                         |
| ------------------- | ----------------------- | --------------------------------------------- |
| `QDRANT_URL`        | `http://localhost:6333` |                                               |
| `QDRANT_API_KEY`    | —                       | **Secret.** Presented by the backend          |
| `QDRANT_COLLECTION` | `shopsage_knowledge`    | Letters, digits, hyphens and underscores only |
| `QDRANT_TIMEOUT_MS` | `10000`                 | Per attempt                                   |

`EMBEDDING_DIMENSIONS` is also the collection's vector size — the same value is handed to both clients
deliberately, because a collection built for one width and fed vectors of another is exactly the failure
this pairing exists to prevent.

**The default and `.env`'s value are both `localhost`, not the Docker service name — and that is
correct running either through Docker or bare.** `docker-compose.yml` hardcodes `QDRANT_URL` for the
backend container's own environment, which always wins over `.env`, so this value is only ever actually
read by something running outside Docker (`npm run ingest`, `npm run evaluate`, `npm run dev`), where
`localhost` is the address Qdrant's published container port answers to. See
[Docker: one `.env`, both contexts](Docker.md#one-env-both-contexts-why-qdrant_url-and-redis_url-say-localhost).

**Enabling authentication takes two variables, not one.** Qdrant requires the key; the backend presents
it:

```ini
QDRANT__SERVICE__API_KEY=change-me   # read by the Qdrant container
QDRANT_API_KEY=change-me             # read by the backend
```

They must match. Setting only the first locks the backend out of its own store, and — because Qdrant
enables authentication on the _presence_ of its variable rather than on its value — a **blank**
`QDRANT__SERVICE__API_KEY` switches auth on with a key nothing can satisfy, while `/readyz` keeps
answering 200. See [Docker](Docker.md#qdrant-authentication-presence-not-value).

### Authentication

| Variable                  | Default  | Notes                                                      |
| ------------------------- | -------- | ---------------------------------------------------------- |
| `AUTH_ENABLED`            | —        | `true` \| `false`. **Required in production**              |
| `AUTH_ISSUER`             | —        | Expected `iss`; the Magento instance minting tokens        |
| `AUTH_AUDIENCE`           | —        | Expected `aud`. Store-specific: `shopsage-<store-id>`      |
| `AUTH_JWKS_URL`           | —        | Where the issuer publishes its public keys                 |
| `AUTH_ALGORITHM`          | `ES256`  | `ES256` \| `RS256`. **Pinned** — never read from the token |
| `AUTH_CLOCK_SKEW_SECONDS` | `60`     | Two servers, two clocks                                    |
| `AUTH_JWKS_CACHE_TTL_MS`  | `600000` | How long a fetched key set is trusted                      |

The first four have no defaults and cannot be guessed. Getting `AUTH_ISSUER` or `AUTH_AUDIENCE` wrong
produces a 401 on every request rather than a message saying what to set, so all three are named at once
in a boot failure.

**`AUTH_ENABLED` has no default in production**, following `CONVERSATION_STORE` and `LLM_*`. Serving an
unauthenticated assistant is a legitimate choice behind a VPN whose proxy already authenticates, and a
catastrophic accident anywhere else — so the decision is required rather than assumed. Outside production
it defaults to off, and every request gets a synthetic **guest** session with `chat` and nothing else.
That keeps the capability-gating path exercised locally instead of bypassed.

**`AUTH_ALGORITHM` is what this deployment will perform.** The token's own `alg` header is only compared
against it, never used to choose a method — doing so is the classic JWT break. `HS256` is not offered at
any setting: a symmetric key would let ShopSage mint tokens for customers, so a compromise here would
become an identity compromise for the store.

`AUTH_AUDIENCE` is store-specific by agreement, so a token minted for one deployment cannot be presented
to another. Full contract: [Proposal 0001](proposals/0001-assistant-session-token.md).

### Rate limiting and capacity

| Variable                            | Default | Notes                                               |
| ----------------------------------- | ------- | --------------------------------------------------- |
| `RATE_LIMIT_ENABLED`                | `true`  | `true` \| `false`. Off must be a deliberate choice  |
| `RATE_LIMIT_WINDOW_MS`              | `60000` | The window the allowance refills over               |
| `RATE_LIMIT_MAX_REQUESTS`           | `30`    | Requests per window, per client, applied to `/v1/*` |
| `MAX_CONCURRENT_STREAMS_PER_CLIENT` | `2`     | Streams one client may hold open at once → `429`    |
| `MAX_CONCURRENT_STREAMS`            | `50`    | Streams the whole process will run at once → `503`  |

Two ceilings because they measure different things: a request is **spent**, a stream is **held**. A
client well inside its request rate can still keep several LLM generations running, each costing tokens
and a socket for its whole life. A single number cannot express "thirty questions a minute but only two
answers in flight", which is the shape of legitimate use.

`/health` is never rate limited — throttling a readiness probe would make an orchestrator pull a healthy
instance out of the load balancer.

**Divide the request limit by your replica count.** Limiter state is per process, so with three replicas
a configured 30 becomes an effective 90. This is deliberate rather than overlooked: it keeps a Redis
round trip and a fail-open policy off every request, and unlike per-replica conversation history it is a
precision problem an operator can correct rather than a correctness bug. See
[ADR 0025](adr/0025-rate-limiting-and-capacity.md).

> **`TRUST_PROXY` and rate limiting interact, and getting it wrong is loud.** Limits key on `req.ip`.
> With `TRUST_PROXY=false` **behind** a proxy, every request appears to come from the proxy's address —
> so all customers share one bucket and the limiter throttles everybody at once. Nothing in the
> application can detect this; it looks exactly like genuine traffic from one address.

**Rate limiting keys on the session's pseudonymous subject**, not an IP address, because authentication
runs first. That is a real improvement over keying on an address: a shared corporate NAT no longer looks
like one abusive client, and an attacker rotating addresses no longer looks like many innocent ones.
Obtaining a subject requires a token from Magento, which Magento can throttle against its own session.

With `AUTH_ENABLED=false` the synthetic session's subject is derived from the address, so local
development still separates callers.

### Conversation history

| Variable             | Default         | Notes                                                         |
| -------------------- | --------------- | ------------------------------------------------------------- |
| `CONVERSATION_STORE` | —               | `memory` \| `redis`. **Required in production**               |
| `REDIS_URL`          | —               | Required when the store is `redis`. `redis://` or `rediss://` |
| `REDIS_KEY_PREFIX`   | `shopsage:conv` | Lets one Redis host two deployments                           |
| `REDIS_TIMEOUT_MS`   | `5000`          | Per-operation budget, like `QDRANT_TIMEOUT_MS`                |

**When set, `REDIS_URL` should be `redis://localhost:6379`, not the Docker service name — the same
reasoning as `QDRANT_URL` above.** Compose hardcodes `REDIS_URL` for the backend container regardless
of `.env`, so `.env`'s value is only ever read outside Docker, where `localhost` is what Redis's
published container port answers to. See
[Docker: one `.env`, both contexts](Docker.md#one-env-both-contexts-why-qdrant_url-and-redis_url-say-localhost).

**`CONVERSATION_STORE` deliberately has no default in production.** Outside production the backend
picks `memory` for itself, so a developer needs no Redis to ask a question. In production an unset value
is a boot failure naming both options:

```json
{
  "msg": "bootstrap failed",
  "err": {
    "message": "Conversation store is not configured",
    "details": {
      "missing": ["CONVERSATION_STORE"],
      "remediation": "set CONVERSATION_STORE=redis (with REDIS_URL) for more than one replica, or CONVERSATION_STORE=memory to accept per-process history"
    }
  }
}
```

The reason is that neither value is safe to assume. `memory` is correct at one replica and silently
wrong at two — some requests remember a conversation and some do not, which reads as an assistant that
is randomly forgetful rather than as a misconfiguration — and only an operator knows the replica count.
Same rule as `LLM_*` ([ADR 0013](adr/0013-required-config-per-entry-point.md)).

Choosing `memory` in production is allowed and is correct for a single replica.

`REDIS_TIMEOUT_MS` bounds each operation. It exists because a conversation read sits directly in a
customer's request, and an unbounded one is a hung page — which is precisely what happened before it was
added; see [ADR 0024](adr/0024-durable-conversation-store.md).

### Metrics

| Variable          | Default | Notes                                                        |
| ----------------- | ------- | ------------------------------------------------------------ |
| `METRICS_ENABLED` | `false` | Publish `GET /metrics` in the Prometheus exposition format   |
| `METRICS_TOKEN`   | —       | **Secret.** Required whenever enabled. Minimum 16 characters |

**Off by default, which is the opposite of the usual advice and right here.** The payload says how many
customers asked questions, how many tokens the store paid for, and which dependencies are failing — a
business intelligence feed for a competitor and a map of what is broken for anybody probing. It exists
when an operator asks for it.

**Enabled with no token is a boot failure**, not an open endpoint. The same rule as `CONVERSATION_STORE`
and `MAGENTO_API_URL`: where a wrong guess is invisible, the backend refuses to guess.

A bearer token rather than an IP allow-list, because the deployment topology is not knowable from here —
in Kubernetes the scraper's address is whatever the pod got today. A separate metrics **port** would let a
firewall do the guarding and is genuinely better there and worse everywhere else; it can be added later
without changing what is emitted ([ADR 0030](adr/0030-metrics-as-port-decorators.md)).

### Commerce connector

| Variable               | Default | Notes                                                           |
| ---------------------- | ------- | --------------------------------------------------------------- |
| `MAGENTO_API_URL`      | —       | Base URL of the connector, ending **before** `/assistant/v1`    |
| `MAGENTO_API_TOKEN`    | —       | **Secret.** ShopSage's own credential, not the customer's token |
| `MAGENTO_TIMEOUT_MS`   | `5000`  | Per-call budget                                                 |
| `MAGENTO_MAX_ATTEMPTS` | `2`     | Attempts for a **read**. Writes never retry, at any setting     |

**`MAGENTO_API_URL` is required as soon as any commerce feature is enabled** in the site profile —
`productSearch`, `productComparison`, `recommendations`, `orderTracking`, `cart` or `coupons`. The
backend refuses to boot without it and names the offending features.

That refusal is the deliberate counterpart to a design choice. A connector failure is degraded into
an ordinary assistant response ("I could not look that up") rather than an HTTP error, which is right
for an outage and would be terrible for a misconfiguration: a missing URL would look like a model
that had gone vague, quietly, for every commerce question. Boot is the only place the mistake cannot
be missed. See [ADR 0028](adr/0028-commerce-reads-behind-one-adapter.md).

**The two credentials are different things.** `MAGENTO_API_TOKEN` says "the caller is ShopSage" and
is sent in `x-shopsage-service-token`. The customer's session token arrives per request, is forwarded
verbatim as the `authorization` bearer, and is never stored, parsed or logged. Collapsing them would
make a stolen customer token sufficient to impersonate the service.

**The cart needs a proposal store, and it follows `CONVERSATION_STORE`.** A prepared change waits in
Redis (or in memory outside production) until the customer confirms it, sharing the conversation store's
connection. There is deliberately no separate variable: an operator who has said "this deployment has
more than one replica" has already answered this question, and a deployment where conversations are
shared but proposals are not would produce a confirmation button that works four times in five — the
worst possible way to discover the mistake.

**Running without a Magento instance.** The repository ships a reference connector — a runnable form
of [Proposal 0002](proposals/0002-commerce-connector-contract.md) over a fictional eight-product
catalogue:

```sh
docker compose --profile reference up
# then, in .env:
MAGENTO_API_URL=http://shopsage-reference-connector:8750
```

It does **not** verify token signatures — it reads the subject and trusts it — which is correct for a
stand-in and catastrophic anywhere real. It is behind a Compose profile and bound to loopback for
exactly that reason. Never point a real deployment at it.

`MAGENTO_API_URL` also exists as `integrations.magentoApiUrl` in the site profile. **Precedence: the
site profile wins when set; the environment variable is the fallback.** The reasoning: the connector
address is store-identifying, non-secret data, so it belongs with the store in multi-store hosting;
the environment variable is a convenience for single-store deployments. The token is a secret and
lives only in the environment, which is why it is not overridable from the profile.

## Site profile

`config/site-profile.json` is validated against a strict schema — **unknown keys are rejected**, so a
typo fails at boot instead of silently reverting to a default. The shipped profile is intentionally
generic ("Demo Store" / "Sage"); no real company name exists anywhere in this repository. A store's
own profile is deployment data, supplied via `SITE_PROFILE_PATH`.

Sections rather than a flat object: a flat 30-key profile stops being navigable, and grouping makes
it obvious who owns which keys (marketing owns `prompts`, design owns `branding`, engineering owns
`retrieval`).

### `identity` — required

| Key             | Required | Notes                                                                    |
| --------------- | -------- | ------------------------------------------------------------------------ |
| `siteId`        | ✅       | Lowercase slug. Bound into every log record and used for vector tenancy. |
| `companyName`   | ✅       |                                                                          |
| `assistantName` | ✅       | The customer-facing name                                                 |
| `websiteUrl`    |          |                                                                          |
| `supportEmail`  |          | Used for human escalation                                                |
| `supportUrl`    |          |                                                                          |

### `prompts` — required

| Key               | Required | Notes                                                |
| ----------------- | -------- | ---------------------------------------------------- |
| `systemPrompt`    | ✅       | 20–8000 characters                                   |
| `welcomeMessage`  | ✅       | First message the widget shows                       |
| `fallbackMessage` | ✅       | Shown on a technical failure                         |
| `noAnswerMessage` | ✅       | Shown when retrieval finds nothing — **not** a guess |
| `quickReplies`    |          | Up to 8 suggested prompts                            |

**Placeholders.** Copy may contain `{{assistantName}}` and `{{companyName}}`, resolved from `identity`.
They exist so a store states its own name once instead of repeating it through the system prompt and the
welcome message where the two can drift apart. Whitespace inside the braces is tolerated
(`{{ companyName }}`).

An **unknown** placeholder is left exactly as written rather than deleted: removing it would silently
change a prompt's meaning, while leaving `{{assistantNmae}}` visible makes the typo obvious the first
time anyone reads the output. A substituted value is not re-scanned, so a store's copy cannot expand
into another placeholder.

Currently applied to `systemPrompt`. `welcomeMessage`, `fallbackMessage` and `noAnswerMessage` are
served to the widget in Stage 8 and are resolved there.

The default `systemPrompt` is deliberately strict about grounding — answer only from context, decline
rather than guess, never invent prices, stock or policies. For a commerce assistant, a confident
wrong answer about a price or return window is the most damaging output the system can produce.

### `localization`

| Key        | Default | Notes                 |
| ---------- | ------- | --------------------- |
| `locale`   | `en-US` |                       |
| `currency` | `USD`   | ISO 4217, upper-cased |
| `timezone` | `UTC`   | IANA zone             |

### `branding`

| Key             | Default        | Notes            |
| --------------- | -------------- | ---------------- |
| `primaryColor`  | `#111827`      | Hex only         |
| `accentColor`   | `#2563eb`      |                  |
| `surfaceColor`  | `#ffffff`      |                  |
| `position`      | `bottom-right` | or `bottom-left` |
| `launcherLabel` | `Ask us`       |                  |
| `avatarUrl`     | —              |                  |

### `retrieval`

| Key                    | Default | Notes                                                                  |
| ---------------------- | ------- | ---------------------------------------------------------------------- |
| `topK`                 | `6`     | Chunks retrieved per query                                             |
| `minScore`             | `0.35`  | Similarity floor, applied by the store; nothing below it is ever shown |
| `maxContextCharacters` | `8000`  | Context budget handed to the model                                     |
| `maxCitations`         | `3`     | Sources shown to the customer, after dedupe by URL                     |

Exposed as configuration because the right values depend on corpus size and writing style, which
differ per store. `minScore` is the main lever for the accuracy/coverage trade-off: raising it makes
the assistant decline more often and hallucinate less.

**`minScore` does not transfer between embedding models.** The same corpus and question scored 0.42 on
`text-embedding-3-small` and 0.54 on `bge-small-en-v1.5`, with completely different separation between
the right chunk and a plausible wrong one. Changing `EMBEDDING_MODEL` means re-tuning this value in the
same breath as re-creating the collection — measurements and reasoning in
[RAG](RAG.md#retrieval-and-tenancy).

Two ceilings that are **not** configuration, deliberately:

| Constant                      | Value | Why it is not a profile key                                                                       |
| ----------------------------- | ----- | ------------------------------------------------------------------------------------------------- |
| Chunks per source URL         | 2     | Guards against a model reading five excerpts from one page as five sources agreeing. Not a taste. |
| Tool rounds before withdrawal | 3     | A cost and liveness guard. A store cannot be trusted to raise it safely.                          |

The rule applied throughout: a store configures what differs legitimately between stores. A guard
against a failure mode is not one of those things.

### `conversation`

| Key                         | Default | Notes                                                            |
| --------------------------- | ------- | ---------------------------------------------------------------- |
| `maxHistoryMessages`        | `12`    | Messages (not turns) replayed to the model; also the storage cap |
| `maxUserMessageLength`      | `2000`  | Input validation ceiling, enforced at the HTTP boundary          |
| `sessionIdleTimeoutMinutes` | `60`    | How long an idle conversation is remembered                      |

`maxHistoryMessages` counts **messages**, so the default of 12 is six question-and-answer exchanges. It
trims from the front, keeping the most recent, because a follow-up depends on what was just said. It
doubles as the store's cap: keeping more than is ever replayed to the model is paying to store text
nothing reads.

`sessionIdleTimeoutMinutes` is **sliding** — refreshed on every turn, so it means "idle for this long"
rather than "created this long ago". Both store implementations honour it, so a conversation expires
after the same period whichever one is running.

It sits on the profile side of the boundary because how long a store remembers a customer is a product
decision that differs between stores. Where the store _is_, and how long one operation may take, are
infrastructure — `CONVERSATION_STORE`, `REDIS_URL` and `REDIS_TIMEOUT_MS` above. See
[SystemDesign](SystemDesign.md#conversation-state).

### `features`

Every capability except `knowledgeSearch` and `streaming` defaults to **off**:

`knowledgeSearch`, `streaming`, `productSearch`, `productComparison`, `recommendations`, `cart`,
`coupons`, `orderTracking`, `recipes`, `winePairings`

Defaulting to off means adding a tool to the platform cannot change an existing store's behaviour
until that store's profile opts in. A shared platform where a new release silently changes what a
customer's assistant does is not safely upgradable.

Two of these already do something:

| Flag              | Effect when off                                                                       |
| ----------------- | ------------------------------------------------------------------------------------- |
| `knowledgeSearch` | No `searchKnowledge` tool is offered, and it is not named in the system prompt either |
| `streaming`       | `POST /v1/chat/stream` returns **404**; `POST /v1/chat` is unaffected                 |

A 404 rather than a 403 for streaming: a capability a store has not enabled does not exist for that
store, and the alternative advertises a feature the caller cannot use. `GET /health/info` lists the
enabled set, so what a deployment actually has on is checkable at runtime.

Turning `streaming` off is a reasonable choice for a store behind infrastructure that cannot carry an SSE
connection cleanly — see [Deployment](Deployment.md#streaming-through-a-proxy) — rather than shipping a
stream that silently arrives all at once.

### `integrations` — required

| Key             | Required | Notes                                |
| --------------- | -------- | ------------------------------------ |
| `backendUrl`    | ✅       | Where the widget reaches ShopSage    |
| `magentoApiUrl` |          | Overrides `MAGENTO_API_URL` when set |

### `content` — what to ingest

Where a store says what its assistant should know. Every crawl decision lives here, so
`@shopsage/scraper` contains no path, host or store name — the same build serves two stores with
completely different URL layouts. See [ADR 0017](adr/0017-crawl-behaviour-is-site-profile-data.md).

```json
"content": {
  "sources": [
    {
      "type": "website",
      "id": "help-centre",
      "enabled": true,
      "contentType": "page",
      "startUrls": ["https://example.com/help"],
      "sitemaps": ["https://example.com/sitemap.xml"],
      "include": ["^https://example\\.com/(help|guides|policies|blog)(/|$)"],
      "exclude": ["/cart", "/checkout", "\\?(p|page|sort)=", "\\.(pdf|zip|jpe?g|png)$"],
      "classify": [
        { "pattern": "/policies/", "contentType": "policy" },
        { "pattern": "/(faq|help)/", "contentType": "faq" }
      ],
      "maxDepth": 3,
      "maxPages": 500,
      "requestsPerSecond": 1,
      "respectRobotsTxt": true
    }
  ]
}
```

| Key                     | Default    | Notes                                                              |
| ----------------------- | ---------- | ------------------------------------------------------------------ |
| `type`                  | —          | `website` today. Unknown types fail at boot, by name               |
| `id`                    | —          | Lowercase slug, unique. Scopes every document id this source emits |
| `enabled`               | `true`     | Park a source without deleting configuration                       |
| `contentType`           | `page`     | `page` \| `faq` \| `guide` \| `policy` \| `blog` \| `other`        |
| `classify`              | `[]`       | Per-path overrides, **first match wins**                           |
| `startUrls`             | `[]`       | At least one of `startUrls` or `sitemaps` is required              |
| `sitemaps`              | `[]`       | Index files are followed one level deep                            |
| `include`               | `[]`       | Empty means **no opinion**, not "nothing"                          |
| `exclude`               | `[]`       | Evaluated **before** include, so exclude always wins               |
| `allowedHosts`          | seed hosts | Subdomains included. The safety net against crawling the internet  |
| `maxDepth`              | `3`        | Link hops from a seed. Sitemap entries are all depth 0             |
| `maxPages`              | `500`      | A ceiling on cost and blast radius, not a target                   |
| `requestsPerSecond`     | `1`        | Capped at 50. A site's own `Crawl-delay` can lower it further      |
| `respectRobotsTxt`      | `true`     | Only ever `false` for a site you own                               |
| `maxDocumentCharacters` | `200000`   | Long pages are cut at a paragraph boundary                         |

**Patterns are regular expressions, tested against the normalized absolute URL.** That means they can
match on host as well as path, and a pattern behaves the same whether the link was written relative or
absolute. They are compiled at boot, so a malformed one is a configuration error naming the offending
source index rather than an exception three hundred pages into a crawl.

**Getting `include` and `exclude` right is the hard part of onboarding a store**, which is why there is
a dry run that embeds and stores nothing:

```bash
node packages/scraper/src/cli/preview.js --source help-centre --limit 5
node packages/scraper/src/cli/preview.js --full          # whole extracted text
```

It prints each document's classification, title, URL, id, content hash and extracted text, then the
run's counters. Tune patterns against that before spending an ingestion run.

**Two things this section is not.** It is not served to browsers — `GET /v1/config` publishes
only the branding and copy subset, and a crawl plan is operational detail whose exclude patterns can
name paths a store would rather not advertise. And it is not where products come from: products are
deliberately out of scope for retrieval, because an embedded catalogue is wrong the moment a price
changes. They arrive live from the Magento API in Stage 9.

The example shipped in `config/site-profile.json` is `enabled: false`. An example must never crawl a
website because somebody ran the default stack.

### `ingestion` — how content is chunked

| Key                   | Default | Notes                                                                          |
| --------------------- | ------- | ------------------------------------------------------------------------------ |
| `maxChunkCharacters`  | `2400`  | Hard ceiling. Oversized sections split at sentence, then character, boundaries |
| `minChunkCharacters`  | `300`   | A shorter trailing chunk merges into its predecessor                           |
| `overlapCharacters`   | `200`   | Carried from one chunk's end into the next chunk's start                       |
| `splitOnHeadingLevel` | `3`     | Headings at or above this level force a new chunk                              |
| `includeHeadingPath`  | `true`  | Prepend "Title > Heading > Subheading" to the **embedded** text                |

**Measured in characters, not tokens.** A token count needs a tokenizer specific to one model family,
and the default embedding backend (an OpenAI-compatible gateway, Stage 4) publishes no token limit to
size against — self-hosted TEI does, via `health().maxInputTokens`, but chunking cannot depend on a
number one backend may not have. Roughly four characters per token for English prose, so the defaults
above sit around 500–700 tokens; re-tune for other scripts or a very different writing style.

Cutting is structure-aware, in a fixed order of preference: heading first, paragraph second, sentence
third, and only then an arbitrary character offset. Each step down that list is a worse seam. See
[ADR 0020](adr/0020-structure-aware-chunking.md).

`includeHeadingPath` affects only what gets **embedded**, never what gets **displayed**. A chunk's
citation shows its own text; the breadcrumb exists purely to give an isolated chunk the context a
reader gets from the page around it.

**Changing these settings does not retroactively re-chunk anything.** A content hash covers the
_embedded_ text, so a settings change that produces different chunk text is caught automatically on the
next run — but one that happens not to change the text (an edge case) will not be. Re-run with
`--force` after a settings change if in doubt.

## Running ingestion

```bash
npm run ingest -- [--source <id>] [--force] [--no-prune] [--verbose]
```

Run as a scheduled job, never at application startup — a crawl takes minutes, and a backend that
blocked on one would never become ready. `--force` re-embeds everything, ignoring content hashes;
reach for it after a chunking-settings or embedding-model change that might not otherwise be detected.
`--no-prune` disables deletion of documents the source no longer produces, for a cautious first run
against a store you do not yet trust.

The `npm run` wrapper is `node --env-file-if-exists=.env packages/ingestion/src/cli/ingest.js` — Node's
own env-file flag, not a `dotenv` dependency. The CLI's composition root (`build-pipeline.js`) reads
`process.env` exactly like the backend's does, and neither file loads `.env` itself; that stays a
property of how the process was started, which is what keeps the composition root identical whether it
is invoked locally or by Docker, where Compose injects the variables directly and no `.env` file is
present in the image at all. Calling `node packages/ingestion/src/cli/ingest.js` directly, without the
`npm run` wrapper, needs the same flag added by hand or it fails with `EMBEDDING_BASE_URL is required` —
that is a missing flag, not a missing feature.

Re-running against an unchanged corpus embeds nothing — verified in this stage's own testing at
seconds down to a fraction of a second, `chunksEmbedded: 0` on the second pass.

### Evaluating retrieval

```bash
npm run evaluate -- [--questions <path>]
```

Reads a golden question set (default `config/golden-questions.json`) and reports recall at
`retrieval.topK` and refusal accuracy — whether questions the corpus genuinely cannot answer correctly
retrieve nothing above `retrieval.minScore`. Exits non-zero on any failing question, so it can gate a
change to chunking, `minScore`, or the embedding model. No LLM is called; this measures retrieval only.

A golden question is:

```json
{ "question": "How long do I have to return something?", "expectedText": ["thirty days"] }
{ "question": "Who is the CEO?", "unanswerable": true }
```

`expectedUrls` or `expectedText` name what counts as a hit; `unanswerable: true` marks a question the
corpus should refuse rather than guess at — the harness fails that question if _anything_ is retrieved
above the score floor, because that is the model's opportunity to be confidently wrong.

## Verifying the active configuration

```bash
curl http://localhost:3000/health/info
```

Returns the loaded `siteId`, company and assistant names, localization, and the enabled feature list.
It deliberately excludes secrets, dependency URLs and the system prompt — a test asserts that none of
those appear in the response.

The gateway in use is not on that endpoint, deliberately. It appears once in the logs at boot:

```json
{
  "msg": "llm gateway configured",
  "model": "…",
  "gatewayHost": "…",
  "timeoutMs": 60000,
  "maxAttempts": 3
}
```

Host rather than full endpoint, because some gateways carry a credential in the URL.

## Onboarding a new store

1. Copy `config/site-profile.json`, set `identity`, `prompts` and `integrations.backendUrl`.
2. Deploy it and point `SITE_PROFILE_PATH` at it.
3. Set `CORS_ALLOWED_ORIGINS` to the storefront origins.
4. Set `LLM_API_KEY`, `LLM_BASE_URL` and `LLM_MODEL`; the backend will not start without them.
5. Confirm with `GET /health/info`, then ask a real question with `POST /v1/chat`.

No code change, no rebuild.
