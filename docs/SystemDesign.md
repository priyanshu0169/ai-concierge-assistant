# System Design

Runtime behaviour of ShopSage: what happens on each request, where state lives, and how the system
behaves when a dependency fails.

## Deployment topology

```
                    ┌──────────────────────────────┐
  Customer browser  │  Magento storefront (PHP)     │
        │           │  + ShopSage widget (JS)       │
        │           └──────────────────────────────┘
        │  cross-origin HTTPS
        ▼
  ┌─────────────────────────────────────────────────┐
  │  shopsage-backend  (Node.js, stateless)          │
  └─────────────────────────────────────────────────┘
        │                  │                  │
        ▼                  ▼                  ▼
  shopsage-qdrant   shopsage-embeddings   LLM gateway
  (vectors)         (TEI, CPU, local)     (OpenAI-compatible, external)
        │
        └─────────────────▶ Magento connector module (HTTP, separate repo)
```

The backend is **stateless** by design. Conversation state is externalised (see below), so instances
scale horizontally and a restart never loses a customer's conversation.

## Request flow

The middleware chain, in registration order — the order is load-bearing:

```
request
  │
  ├─ request-id ......... assign/validate correlation id, build request logger
  ├─ request-logger ..... start timer, register finish listener
  ├─ cors ............... origin allow-list
  ├─ express.json ....... parse body, 64 kB ceiling
  ├─ router
  │    ├─ /health* ...... never rate limited
  │    └─ /v1
  │         ├─ rate-limit ... token bucket per client → 429
  │         └─ chat routes .. /chat, /chat/stream
  ├─ not-found .......... unmatched route → NotFoundError
  └─ error-handler ...... classify, log, set Retry-After, emit the error envelope
```

Why this order:

- **Correlation is first.** Anything that fails later — a CORS rejection, a body-parse failure — is
  still attributable to a request id in the logs. Putting CORS first would leave rejected requests
  untraceable.
- **The body limit precedes routing.** An oversized payload is rejected before any handler allocates
  against it.
- **The error handler is last.** It is the only component that decides what an external caller sees, and
  the only place that sets `Retry-After` — from the error itself, so every error carrying a wait says so
  without each throw site remembering a header.
- **Rate limiting is inside the router, not on the app.** It must cover `/v1` and must not cover
  `/health`: throttling a readiness probe would make an orchestrator pull a healthy instance out of the
  load balancer, turning a protection into the outage it exists to prevent.

## Chat flow

What `POST /v1/chat` does. Every box runs; nothing here is planned.

```
POST /v1/chat  { conversationId?, message }
  │
  ├─ validate body ................. zod, strict; unknown fields rejected
  └─ assistant.answer()  ← assistant-core, no HTTP below this line
       ├─ ids ...................... c_… / m_…, conversationId reused if supplied
       ├─ store.history() .......... last conversation.maxHistoryMessages messages
       ├─ build messages ........... system prompt + history + question
       │                             {{assistantName}} / {{companyName}} resolved
       │                             tools named; NO context yet — it arrives below
       ├─ tool loop (≤ 3 rounds, then tools withdrawn)
       │    ├─ llm.generate(messages, { tools })
       │    │    ├─ build wire request ... OpenAI chat-completions body
       │    │    ├─ withRetry ........... 3 attempts, equal jitter, Retry-After honoured
       │    │    │    └─ withTimeout .... LLM_TIMEOUT_MS per attempt, real cancellation
       │    │    ├─ map errors .......... status → taxonomy, upstream body sanitized
       │    │    ├─ parse completion .... content, tool calls, finish reason, usage
       │    │    └─ log usage ........... model + tokens + duration + correlation ids
       │    ├─ no tool calls? → leave the loop with this completion
       │    ├─ searchKnowledge({ query })
       │    │    ├─ retriever.retrieve()  ← the KnowledgeRetriever port
       │    │    │    ├─ embeddings.embedQuery() ...... one vector
       │    │    │    └─ vectors.search() ............. siteId filter + minScore floor
       │    │    ├─ rank ......... score sort, dedupe, ≤ 2 per source URL
       │    │    ├─ build context  numbered excerpts, cut at a chunk boundary
       │    │    └─ append as a tool result, then loop
       │    └─ a commerce tool ← only those the store enabled AND the session may use
       │         ├─ commerce.searchProducts / findProduct / listOrders
       │         │                          ← the CommerceCatalogue port
       │         │    └─ HTTP GET to the connector, session token forwarded as-is
       │         │         ├─ one retry on 5xx; a 404 means absent, not failed
       │         │         └─ wire → domain shapes, defensively; unknown = absent
       │         ├─ ShopSage's own logic ... comparison axes, shortlist, price ordering
       │         ├─ format for the model ... rules about money restated with the data
       │         └─ append as a tool result, then loop
       ├─ format answer ............ empty → noAnswerMessage; sources only if grounded
       ├─ redact ................... email / card / phone removed from BOTH turns
       ├─ store.append() ........... after success, so a failed turn is not history
       └─ log ...................... grounded, sources, toolRounds, exhausted, historyTurns
  │
  └─ 200 { conversationId, messageId, answer, sources, finishReason }
```

A grounded answer therefore costs **two** gateway calls and one embedding call. Measured on the
verification corpus: round 1 returns `tool_calls` from a 238-token prompt, round 2 returns `stop` from
544 tokens once the context is appended, total ~5.3s of which ~4.2s is the first model call.

Note where `grounded` is: in the log line, not the response body. It is an operational signal about how
often answers rest on retrieved content, and publishing it would invite a client to branch on it.

Five properties of this path are worth stating explicitly, because they are the ones easy to
regress:

- **The HTTP layer makes no conversation decisions.** The route validates, calls one method, and
  serializes five fields. Whether a tool was called, how sources were ranked, what an empty answer
  becomes — none of that is visible from `rag-backend`.
- **History is written last.** A turn that failed upstream is not recorded, so a retry sees the same
  history the failed attempt saw rather than a conversation containing a question that was never
  answered.
- **Redaction happens at the write, and nowhere earlier.** The customer read their own message in the
  widget and the model answered the real question; only the copy that outlives the turn is reduced.
  Redacting earlier would degrade an answer in order to protect a record.
- **The customer's session token reaches the connector and nothing else.** It is put on the tool context,
  never into `metadata` — `metadata` is what gets logged — and it is deliberately kept off `req.session`
  at the HTTP layer, because the session is bound into the request logger.

- **The credential appears in exactly one place** — the request headers built inside
  `llm-client/src/transport`. Nothing else reads `LLM_API_KEY`, and an upstream error body is scrubbed
  of it before it reaches a log record.
- **Cost is recorded, not returned.** Every call emits one `llm completion` record carrying the model,
  the three token counts, the duration and the finish reason, correlated by `requestId` and
  `conversationId`. None of that reaches the response body.
- **The gateway is never named to a customer.** Every gateway failure surfaces as a masked 502.

### Retry behaviour

| Failure                               | Retried | Why                                                                                  |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| Upstream 5xx, 408                     | ✅      | Transient by definition                                                              |
| Upstream 429                          | ✅      | Honouring `Retry-After`, clamped to the backoff ceiling                              |
| Network failure (DNS, refused, TLS)   | ✅      | Transient                                                                            |
| Truncated response body               | ✅      | Usually a dropped connection                                                         |
| **Timeout**                           | ❌      | The gateway was still generating; a retry pays twice and triples the customer's wait |
| Other 4xx                             | ❌      | The same request will fail again                                                     |
| 200 with no choices                   | ❌      | A non-standard error envelope; deterministic and billable                            |
| Anything after the first stream event | ❌      | The caller has rendered it; replaying duplicates output                              |

Reasoning in [ADR 0012](adr/0012-llm-retry-and-failure-policy.md).

## Health, liveness and readiness

These answer different questions and are separated deliberately.

| Endpoint            | Question                              | Touches dependencies | Status codes |
| ------------------- | ------------------------------------- | -------------------- | ------------ |
| `GET /health`       | Is this process healthy?              | No                   | 200          |
| `GET /health/ready` | Should this instance receive traffic? | Yes                  | 200 / 503    |
| `GET /health/info`  | Which site profile is loaded?         | No                   | 200          |

**Readiness asks whether a dependency is _usable_, not whether it is reachable.** Each client answers
for itself rather than the backend probing a URL it guessed at:

| Dependency           | What is checked                                                                       |
| -------------------- | ------------------------------------------------------------------------------------- |
| Qdrant               | `/readyz` — **shard** readiness, not merely that the process is listening             |
| Embeddings           | `/info` (or `/models`), **and that the reported model is the configured one**         |
| Knowledge collection | `QDRANT_COLLECTION` exists — added in Stage 6, see below                              |
| Conversations        | `PING`, **only when the store is Redis**. Added in Stage 7b                           |
| LLM gateway          | Nothing. It is metered; a probe that bills per call, per instance, forever, is not it |

The conversation probe is registered only for the Redis store. An in-memory store cannot be down, and a
probe that always passes teaches an operator to stop reading it.

The model check earns its place by catching a failure nothing else would. Change `EMBEDDING_MODEL`,
redeploy the backend, leave the embeddings container serving the old weights: both services are up,
every URL probe passes, and ingestion writes vectors from one model into a collection built for
another. Retrieval then returns scores that are plausible, ranked and meaningless, and nothing ever
errors.

Observed live, with the configuration deliberately mismatched:

```json
{
  "status": "degraded",
  "checks": [
    { "name": "qdrant", "status": "up", "latencyMs": 50 },
    {
      "name": "embeddings",
      "status": "down",
      "latencyMs": 25,
      "error": "Embeddings service is running an unexpected model (align EMBEDDING_MODEL with the running service, then re-create the collection and re-ingest - vectors from two models are not comparable)"
    }
  ]
}
```

The remediation sits in the response body on purpose: an operator should not have to go log-diving to
learn which variable is wrong. Liveness stayed 200 throughout, so the orchestrator did not restart a
process that was working correctly. See [ADR 0014](adr/0014-clients-own-their-readiness.md).

**Collection existence joined readiness in Stage 6**, as the roadmap said it would. Until Stage 5 a
missing collection was the correct state before the first ingestion run, and failing on it would have
meant a fresh deployment could never become ready enough to be ingested into. Now that `/v1/chat`
retrieves on every question, a backend with no collection cannot answer anything — it is unready by
definition, and the probe names the fix:

```json
{
  "name": "knowledge-collection",
  "status": "down",
  "error": "Knowledge collection \"shopsage_content\" does not exist (run: npm run ingest -w @shopsage/ingestion)"
}
```

Ingestion is unaffected: it does not serve traffic and creates the collection itself, so
[ADR 0013](adr/0013-required-config-per-entry-point.md)'s per-entry-point rule keeps the probe on the
backend only. Observed live with all three passing:

```json
{
  "status": "ok",
  "service": "shopsage-backend",
  "checks": [
    { "name": "qdrant", "status": "up", "latencyMs": 206 },
    { "name": "embeddings", "status": "up", "latencyMs": 834 },
    { "name": "knowledge-collection", "status": "up", "latencyMs": 74 }
  ]
}
```

**Liveness must never check a dependency.** If it did, a Qdrant outage would fail the liveness probe,
the orchestrator would restart a perfectly healthy container, and a dependency outage would escalate
into a crash loop across every instance simultaneously. This is a common and expensive mistake, so it
is enforced by a test asserting that `liveness()` invokes no probe.

Readiness checks dependencies in parallel and reports each individually, so an operator can see
_which_ dependency is down without reading logs:

```json
{
  "status": "degraded",
  "service": "shopsage-backend",
  "checks": [
    { "name": "qdrant", "status": "up", "latencyMs": 3 },
    {
      "name": "embeddings",
      "status": "down",
      "latencyMs": 2001,
      "error": "health probe embeddings timed out after 2000ms"
    }
  ]
}
```

A probe never throws — an unreachable dependency is a _value_, not an exception. If probes threw, one
dead dependency would break reporting for all the others.

## Startup sequence

```
1. loadConfig()          validate environment, then load and validate the site profile
2. createLogger()        bound to siteId, service name, version, environment
3. createHealthService() with a probe per dependency
4. createLlmClient()     require and validate the gateway settings  ← fails here if unconfigured
5. createChatService()   bind the site profile to the client
6. createApp()           wire middleware and routes
7. server.listen()
8. registerGracefulShutdown()
```

**Configuration is validated eagerly and failure is fatal.** A store running with a half-valid
profile gives customers wrong answers, and wrong answers about price, stock or policy are worse than
downtime. On failure the process writes one JSON line to stderr and exits non-zero, so the
orchestrator never routes traffic to it.

The backend **does not wait for its dependencies**. It binds the port immediately and reports 503 on
`/health/ready` until Qdrant and the embeddings service are up. On first run TEI downloads model
weights for several minutes; a backend that blocked on that would look like a failed deployment.

Note the asymmetry between steps 1–5 and that paragraph. **Missing configuration is fatal; an
unavailable dependency is not.** A dependency comes back on its own; a missing credential does not, and
an instance that starts without one answers every customer question with a 502 while looking healthy.
So the LLM client is constructed eagerly — it validates its own settings, and the backend exits
non-zero naming the missing variables. Under Compose with `restart: unless-stopped` that presents as a
restart loop, which is the correct and visible outcome for configuration a human has to fix.

## Shutdown sequence

```
SIGTERM
  → stop accepting new connections
  → let in-flight requests finish (SHUTDOWN_TIMEOUT_MS, default 10s)
  → run teardown hooks
  → exit 0
  ─ budget exceeded → log and exit 1
```

`init: true` in Compose gives the container a PID 1 that forwards signals, so SIGTERM actually
reaches Node. Without it the signal is swallowed, the orchestrator escalates to SIGKILL, and every
rolling deploy shows up as a crash.

Uncaught exceptions and unhandled rejections are treated as **fatal**, not logged and ignored. After
either, the process is in unknown state, and serving customers from unknown state is worse than a
restart.

## Failure modes

| Failure                                      | Behaviour                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| Site profile missing / invalid               | Process exits at boot with the offending path and reason                |
| Environment variable invalid                 | Same, before the profile is even read                                   |
| LLM gateway not configured                   | Process exits at boot naming every missing variable                     |
| Embeddings service serving the wrong model   | `/health/ready` → 503 naming the variable to align                      |
| Embeddings returns a wrong-width vector      | Non-retryable `UPSTREAM_FAILURE`; nothing is stored                     |
| Vector store missing the collection          | `UPSTREAM_FAILURE` with a remediation naming `QDRANT_COLLECTION`        |
| A caller omits `siteId`                      | `VALIDATION_FAILED` before any request is sent                          |
| Qdrant down                                  | Process healthy, `/health/ready` → 503 naming `qdrant`                  |
| Embeddings down                              | Process healthy, `/health/ready` → 503 naming `embeddings`              |
| Dependency hangs                             | Probe aborts at 2 s and reports `down` with the timeout message         |
| Malformed JSON body                          | 400 `VALIDATION_FAILED` — a client error, not a 500                     |
| Body over 64 kB                              | 413                                                                     |
| Unknown route                                | 404 `NOT_FOUND` in the standard envelope                                |
| Unclassified throw                           | 500 `INTERNAL_ERROR`, message masked, real cause in logs                |
| LLM gateway 5xx or unreachable               | Retried, then 502 masked; status and body in the logs                   |
| LLM gateway 401 / 404                        | 502 masked immediately, log carries a remediation hint                  |
| LLM gateway throttles us                     | Retried after `Retry-After`, then 502 masked — never a 429              |
| LLM gateway exceeds its budget               | 504 `TIMEOUT`, not retried                                              |
| Model returns an empty answer                | 200 carrying the profile's `noAnswerMessage`                            |
| Model's answer hits `maxTokens`              | 200 with `finishReason: "length"`, reported honestly                    |
| Commerce connector down or slow              | **200** with an honest "I could not look that up"; readiness unaffected |
| Commerce connector 5xx                       | One retry, then the tool fails and the model writes around it           |
| Commerce connector 404 on one product        | Not a failure — "we do not sell that" is an answer                      |
| Commerce feature on, `MAGENTO_API_URL` unset | Process exits at boot naming the offending features                     |
| Guest session asks about an order            | 200; `trackOrder` is absent, so the assistant says it cannot look it up |
| Proposal store unreachable                   | `/health/ready` → 503; a prepared change is withheld from the reply     |
| Cart confirmation, connector fails           | **502**, not degraded — the write may have partly happened              |
| Cart confirmation, proposal already used     | 200 `gone`. Consumed on the first attempt, successful or not            |
| Cart confirmation from the wrong session     | 200 `gone`, **and the proposal survives** for its owner                 |

Body-parser failures are mapped explicitly because, left unmapped, they surface as 500s and pollute
error-rate alerting with what is really a malformed request.

The cart rows are where that pattern **stops**. A confirmation is the one request that spends money, so
a connector failure there is a real `502`: the write may have partially happened, and answering "we could
not apply it" would be a claim nobody can support. The proposal store, unlike the connector, _is_ a
readiness dependency — an unreachable one means every confirmation button in flight is dead while the
assistant keeps preparing more ([ADR 0029](adr/0029-cart-changes-need-a-confirmed-proposal.md)).

**The commerce rows are the first in this table where a dependency failure is not an error.** A connector
outage degrades commerce answers while every knowledge answer keeps working, so a `502` would report a
partial failure as a total one, and readiness would pull instances that can still do half the job. The
cost of that choice is that a _misconfiguration_ would also be silent — which is exactly why a commerce
feature with no connector URL is a boot failure instead. See
[ADR 0028](adr/0028-commerce-reads-behind-one-adapter.md).

## Observability

Every log record is one line of JSON with `time`, `level`, `name`, `msg`, plus bindings
(`siteId`, `env`, `version`, `requestId`). Two rules are enforced in code:

- **Secrets are redacted structurally.** Any key matching a credential-shaped pattern (`*_KEY`,
  `token`, `secret`, `authorization`, `cookie`, …) is replaced with `[redacted]` at any depth, so a
  secret that rides along inside a logged config object never reaches storage. The `token` clause is
  singular-only (`token(?!s)`): credentials are singular, token _counts_ are plural, and matching the
  plural silently redacted every cost measurement in the system.
- **Upstream error bodies are scrubbed before logging.** Providers quote the credential back —
  OpenAI's 401 body reads `Incorrect API key provided: sk-...`. The client removes the configured key,
  masks credential-shaped tokens it was not given, collapses whitespace so a body cannot forge a
  second log record, and truncates to 500 characters.
- **Customer text never enters access logs.** The logged path is derived from `req.originalUrl` with
  the query string stripped, and request bodies are never logged. Malformed tool-call arguments are
  reported by tool name only, for the same reason.

### Cost and gateway records

| Record                         | Level | Carries                                                                         |
| ------------------------------ | ----- | ------------------------------------------------------------------------------- |
| `llm gateway configured`       | info  | Model, gateway **host** only, timeout, attempt count — at boot                  |
| `llm completion`               | info  | Model, prompt/completion/total tokens, duration, finish reason, tool-call count |
| `llm request failed, retrying` | warn  | Attempt, delay, classified error                                                |

`warn` for a retry is deliberate: a retry is a symptom, and a gateway that needs one on most requests
is worth noticing before it becomes an outage. The boot record logs the host rather than the full
endpoint because some gateways embed a credential in the URL.

`x-request-id` is accepted from upstream so a trace started by the storefront continues through
ShopSage — after validation, because that header is attacker-controlled and would otherwise be a log
injection vector.

### Metrics, and what logs could not do

Logs answer questions about **one** request. Metrics answer questions about **all** of them, and until
Stage 10a there was no way to ask the second kind — "what is p95 latency", "what did we spend today", "has
the grounded rate fallen" are not questions `grep` answers.

The gap that mattered most was specific: **an assistant returning the store's no-answer message to every
question is indistinguishable from a healthy one if all you have is HTTP status codes.** Both are `200`.
`assistant_turns_total{outcome=...}` is that distinction, and the first live scrape found it — three chat
turns, all `200`, all **ungrounded**, with one retrieval failure behind them.

`GET /metrics` is off by default and guarded when on; the full list is in [API](API.md). Two properties are
worth knowing here:

- **The route label is an allow-list, not `req.path`.** A metric labelled with a caller-supplied string
  lets anybody who can send a request create unbounded series that never expire, and the monitoring system
  falls over before the service does. Unrecognised paths collapse to `route="other"`.
- **Counters are per-process, and that is correct.** Prometheus scrapes each replica and sums — unlike the
  rate limiter, whose per-replica state is a real imprecision an operator has to divide around.

Metrics are **not** derived from the log stream, which would need no plumbing and would permanently couple
metric names to log message strings. See
[ADR 0030](adr/0030-metrics-as-port-decorators.md).

## Rate limiting and capacity

Two controls, because they measure different things. A request is **spent**; a stream is **held**.

```
POST /v1/*                          POST /v1/chat/stream
  │                                   │  (after the rate limit, the flag and the body)
  ├─ token bucket, per client         ├─ per-client streams in flight?  → 429  scope: client
  │    tokens left?  → next()         ├─ process streams in flight?     → 503  scope: service
  │    empty?        → 429            └─ acquire a slot, released in `finally`
  └─ RateLimit-* headers either way
```

A refusal costs **2–7ms and no gateway call** — measured. That is the property that matters: a limiter
whose rejections are expensive is itself the attack.

| Control             | Bound         | Exceeded → | Why that status                               |
| ------------------- | ------------- | ---------- | --------------------------------------------- |
| Requests per window | per client    | `429`      | This client is sending too much               |
| Streams in flight   | per client    | `429`      | This client is holding too much               |
| Streams in flight   | whole process | `503`      | Not this client's fault — the service is full |

The last row is the distinction worth keeping. Telling a well-behaved customer they are being throttled
when the service is simply at capacity would be a lie, and the two must stay separable in a dashboard —
the same reasoning that makes an upstream 429 surface as a masked 502
([ADR 0012](adr/0012-llm-retry-and-failure-policy.md)).

**A token bucket, not a fixed window.** A fixed window permits a double-rate burst across its edge: a
full allowance at 11:59:59 and another at 12:00:00. A bucket refills continuously, so the rate holds
everywhere and a refused client is told how long until _one_ request is available rather than until the
whole allowance returns.

**State is per process**, and the effective allowance is therefore `limit × replicas`. Deliberate: it
keeps a Redis round trip and a fail-open policy off every request, and unlike per-replica conversation
history it is a precision problem an operator corrects by dividing rather than a correctness bug.
Concurrency counting is _not_ approximate in the same way — a connection is held by one process, so a
per-process ceiling is exactly what bounds that process's sockets.

Both maps are bounded and evict the least recently seen. The key derives from a client address, so an
unbounded map would be a memory-exhaustion hole inside the middleware meant to prevent one. Eviction
slightly favours an attacker — a flood can push out a legitimate client's bucket and grant it a fresh
allowance — and that is the right way round: refusing new clients once full would turn a flood into a
total outage. See [ADR 0025](adr/0025-rate-limiting-and-capacity.md).

## Conversation state

Every chat carries a `conversationId` from Stage 1 of the API contract onward, which is what let memory
arrive in Stage 6 with **no API change** — verified: a follow-up of _"And internationally?"_ on an
existing `conversationId` resolved correctly to a delivery question, logging `historyTurns: 2`.

State sits behind a `ConversationStore` port with two methods, `history()` and `append()`.
`conversation.maxHistoryMessages` from the site profile bounds how much is replayed, because unbounded
history grows the prompt without bound and the oldest turns rarely help.

**Two implementations, chosen by configuration.** The domain sees one port either way.

| `CONVERSATION_STORE` | Implementation                   | Correct for                    |
| -------------------- | -------------------------------- | ------------------------------ |
| `memory`             | `assistant-core`, in-process Map | Development, and one replica   |
| `redis`              | `@shopsage/conversation-store`   | Anything with a second replica |

**There is no default in production.** Outside production the backend picks `memory` for itself, so a
developer needs no Redis to ask a question. Inside production an unset `CONVERSATION_STORE` is a boot
failure naming both options — the same rule as `LLM_*`
([ADR 0013](adr/0013-required-config-per-entry-point.md)), because only an operator knows the replica
count and `memory` is correct at one and silently wrong at two. Choosing `memory` in production is still
allowed; one replica is a real deployment.

The failure the Redis store exists to prevent is worth naming precisely. It is not "conversations are
lost" — it is **intermittent** amnesia, where whichever replica the load balancer picks decides whether
the assistant remembers. That presents as an assistant which is randomly stupid rather than as an outage,
and nothing in any log says "this instance had never seen that conversation". Verified both ways: a
reference code given to one replica and recalled from another comes back correctly under `redis`, and
produces "I could not find the answer to that" under `memory`.

### The Redis data model

One list per conversation, JSON turns, keyed `{prefix}:{siteId}:{conversationId}`.

| Choice                                | Reason                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `siteId` in the **key**               | Cross-tenant reads become impossible rather than a filter to remember  |
| `RPUSH`+`LTRIM`+`EXPIRE` in a `MULTI` | Atomic; two tabs on one conversation cannot interleave and lose a turn |
| Sliding TTL, refreshed on every write | The timeout means "idle this long", not "created this long ago"        |
| `LTRIM` to `maxHistoryMessages`       | Storing more than is ever replayed keeps text nothing reads            |
| Unreadable entries skipped, not fatal | A shared store outlives a release; one bad entry must not break a chat |

The TTL is `conversation.sessionIdleTimeoutMinutes` from the **site profile** — a key that has existed
since Stage 1 doing nothing. How long a store remembers a customer is a product decision that differs per
store; the address and the per-operation timeout are infrastructure and stay in the environment. The
in-memory store applies the same idle expiry, so the two implementations cannot drift into different
behaviour.

### When the store is unavailable

| Event             | Behaviour                                                         |
| ----------------- | ----------------------------------------------------------------- |
| `history()` fails | The turn fails — a masked 502                                     |
| `append()` fails  | The answer is **still delivered**; logged with `persisted: false` |
| Readiness         | `conversations: down` within `REDIS_TIMEOUT_MS`                   |
| Liveness          | Stays 200 — no orchestrator restarts a working process            |
| Redis returns     | Recovers on its own; no backend restart                           |

The read/write asymmetry is deliberate. Answering a follow-up with no memory reads as the assistant being
stupid, and a customer cannot tell that apart from a broken dependency — so a read failure is honest as
an error, and it is retryable. A write failure arrives _after_ the answer exists, and on the streaming
path after it has been rendered, so failing then would discard work the customer can see in order to
report something they cannot act on.

`POST /v1/chat/stream` returns a **502 with a JSON envelope** rather than an `error` event when the store
is down, because the history read happens before the first event. That is
[ADR 0023](adr/0023-streaming-delivery-over-sse.md)'s lazily-opened stream paying off in exactly the case
it was designed for.

**Every store operation carries a deadline**, and that was a defect before it was a design. Stopping
Redis originally made `/health/ready` hang **indefinitely** instead of reporting `down`: the client
retries connecting forever by design, and nothing above it bounded the wait. `platform`'s `withTimeout`
did not help — it is a _cancellation_ primitive that hands the operation an `AbortSignal`, which fits
`fetch` and does not fit a Redis command. Every other client bounds its own I/O
(`QDRANT_TIMEOUT_MS`, `EMBEDDING_TIMEOUT_MS`); this one now does too, via `REDIS_TIMEOUT_MS`. See
[ADR 0024](adr/0024-durable-conversation-store.md).

## Streaming

`POST /v1/chat/stream` delivers the same turn as `POST /v1/chat`, as it happens. Building
`llm-client.stream()` back in Stage 2 is what made this a delivery change rather than a rewrite:
retrofitting streaming into a client whose error handling, retry policy and usage accounting were
designed only for a single JSON response means revisiting all three.

**Total latency is unchanged; the shape of the wait is not.** Measured against the real gateway on the
same question:

| Moment                | Buffered    | Streamed                            |
| --------------------- | ----------- | ----------------------------------- |
| First byte of meaning | 4.9s (all)  | **70ms** (`start`)                  |
| "Searching…"          | never shown | 1.8s (`tool started`)               |
| Retrieval done        | never shown | 2.9s (`tool finished`)              |
| First token           | 4.9s        | **4.3s** then 48 deltas over ~500ms |
| Complete              | 4.9s        | 4.8s                                |

The `tool` events are the point of that table. Without them a customer stares at nothing for 4.3
seconds; with them something honest happens three times before the first word of the answer.

```
POST /v1/chat/stream
  │
  ├─ features.streaming? ....... 404 if the store has not enabled it
  ├─ validate body ............. 400 — the same schema as the buffered route
  ├─ wire res.on('close') ...... an AbortSignal for the whole turn
  └─ assistant.answerStream()   ← same conversation manager, same tool loop
       │
       ├─ event: start .......... ids, before any model call
       ├─ event: tool ........... started / finished / failed, per tool
       ├─ event: delta .......... text, as the gateway produces it
       └─ event: done ........... the buffered response body, byte-identical in shape
```

### One loop, two delivery modes

The tool loop is **not** written twice. It is an async generator parameterized by a _round runner_:

| Mode     | Round runner                                 | Used by           |
| -------- | -------------------------------------------- | ----------------- |
| Streamed | `model.stream()`, unchanged                  | `/v1/chat/stream` |
| Buffered | `generate()` wrapped in a single `end` event | `/v1/chat`        |

This works because Stage 2 gave `stream()` a terminal event carrying a finished `LlmCompletion`
([ADR 0011](adr/0011-normalized-llm-contract.md)) — so round bounding, tool withdrawal, tool execution
and citation collection are written once and a test asserts both modes produce the same answer and
sources for the same scenario. The buffered path keeps using `generate()` rather than draining a stream
and discarding deltas: one request instead of an SSE connection, and no dependency on the gateway
supporting streaming at all.

### The stream opens late, on purpose

Writing the response head commits a 200 and makes every later failure unreportable as a status code. So
it is deferred until the first event exists:

| Failure                        | Result                                                     |
| ------------------------------ | ---------------------------------------------------------- |
| Validation, streaming disabled | Normal 4xx, JSON envelope                                  |
| Before the first event         | Normal 5xx, JSON envelope, standard error middleware       |
| After the first event          | 200 already sent → an `error` event carrying that envelope |

Both envelopes come from **one** builder (`http/error-envelope.js`, extracted this stage). Two
implementations of "mask a 5xx message" would eventually stop agreeing, and the one exercised less would
be the one that leaked. See [ADR 0023](adr/0023-streaming-delivery-over-sse.md).

### Disconnects

`res.on('close')` aborts the turn. The signal reaches the LLM client, which **cancels** the request
rather than ignoring its result — verified: after an abort the second gateway round logs no completion
at all, so its tokens were never billed.

An abandoned turn is not persisted. A stream can be cut anywhere, including before a single token, and a
fragment replayed to the model on the next question is worse than no record.

Both facts are logged at `info`, deliberately. The first implementation filed the abort's rejection as a
stream failure, which produced an **`error` record with a stack trace every time a customer closed a
tab**. Normal behaviour must not look like a fault, or real faults drown in it; a test now pins that an
abandoned turn logs nothing above `info`. Alert on the _rate_ instead.

### What every hop in the path must not do

A proxy that buffers turns a stream into a slow non-stream, and nothing in any log explains it. The
response therefore carries `x-accel-buffering: no` and `cache-control: no-cache, no-transform`, and a
`: keepalive` comment goes out every 15 seconds while idle — because the pre-first-token gap plus a
stalled model can exceed a proxy's idle timeout, and an idle stream is indistinguishable from a dead
one. See [Deployment](Deployment.md) for the proxy configuration this requires.
