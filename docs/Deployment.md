# Deployment

> As of Stage 7b the assistant answers from store content over two endpoints — one buffered, one
> streamed — with conversation history in a shared store, so it scales past one replica. Production hardening is Stage 10; this document
> records the intended topology and the operational contract the code already honours, so deployment is
> not designed retroactively.
>
> **Authentication, rate limiting and capacity ceilings are all in place as of Stage 7d.** What remains
> before internet exposure is operational rather than architectural: TLS at the proxy, the checklist
> below, and a real corpus with a measured question set.
>
> **The assistant now depends on Magento issuing session tokens.** If the storefront's session endpoint
> is down, nobody can chat — accepted knowingly when the contract was agreed. A Magento outage does _not_
> stop verification while a cached key set is held.
>
> **The reverse proxy needs SSE-specific configuration**, or streaming silently stops streaming. See
> [Streaming through a proxy](#streaming-through-a-proxy).

## Topology

```
                    Internet
                       │  HTTPS
                       ▼
              ┌──────────────────┐
              │  Reverse proxy   │  TLS termination, rate limiting, WAF
              └──────────────────┘
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
  shopsage-backend N=2+      (stateless, horizontally scalable)
          │
    ┌─────┼────────┬──────────────┬──────────────────┐
    ▼     ▼        ▼              ▼                  ▼
 Qdrant  Redis    TEI       LLM gateway      Magento connector
 (stateful) (stateful) (stateless)  (external)   (separate repo)
```

The backend holds no conversation state, which is what lets it scale horizontally. Qdrant and Redis are
the stateful components, and they want different things: Qdrant holds the knowledge base and needs
backed-up persistent storage, while Redis holds conversations that expire on their own and deliberately
runs **without** disk persistence — losing them on restart is the same outcome as their TTL passing.

## Operational contract

The application already behaves the way an orchestrator expects, which is what makes it deployable
without wrappers:

| Concern          | Behaviour                                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration    | Environment plus a site profile file. Validated at boot; invalid config exits non-zero.                                                                                          |
| Required config  | `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, and `CONVERSATION_STORE` in production. Absent → exit non-zero naming all of them. Deliberately **not** a degraded-but-running mode. |
| Shutdown hooks   | The Redis connection is closed after in-flight requests drain, not before.                                                                                                       |
| Liveness probe   | `GET /health` — never touches a dependency, so an outage cannot cause restart loops.                                                                                             |
| Readiness probe  | `GET /health/ready` — 503 until dependencies are up. Bind a load balancer to this.                                                                                               |
| Logs             | One JSON object per line on stdout. The platform owns routing; the app writes no files.                                                                                          |
| Shutdown         | SIGTERM drains in-flight requests within `SHUTDOWN_TIMEOUT_MS`, then exits 0.                                                                                                    |
| Fatal errors     | Uncaught exceptions and unhandled rejections exit non-zero rather than continuing in unknown state.                                                                              |
| Startup ordering | No dependency wait. The service starts and reports readiness honestly.                                                                                                           |

Set `terminationGracePeriodSeconds` (or the platform equivalent) **above** `SHUTDOWN_TIMEOUT_MS`.
If the platform's grace period is shorter, it SIGKILLs mid-drain and every rolling deploy drops
requests.

Streaming makes the drain window matter more than it did: an SSE connection is held open for the whole
answer, so `SHUTDOWN_TIMEOUT_MS` must exceed a realistic worst-case turn (≈`LLM_TIMEOUT_MS` plus
retrieval) or a rolling deploy cuts customers off mid-sentence. The 10s default is **too low** for that;
30s is a defensible starting point once streaming is in use.

## Streaming through a proxy

`POST /v1/chat/stream` works locally and silently stops streaming behind a default-configured proxy.
There is nothing in any log to explain it — events simply all arrive at the end — so this is worth
getting right before anyone reports it as "streaming doesn't work in production".

The backend already sends what it can: `content-type: text/event-stream`,
`cache-control: no-cache, no-transform`, `x-accel-buffering: no`, and a `: keepalive` comment every 15
seconds while idle. The rest is proxy configuration.

| Requirement                | Why                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------ |
| **Response buffering off** | nginx defaults `proxy_buffering on`, which holds every event until the response ends |
| **No gzip on this route**  | Compression buffers to fill a block, which reintroduces the same problem             |
| **Read timeout > a turn**  | Below the worst-case answer time, the proxy cuts the connection mid-answer           |
| **HTTP/1.1 upstream**      | HTTP/1.0 has no chunked transfer encoding, so the response cannot stream at all      |

For nginx:

```nginx
location /v1/chat/stream {
    proxy_pass              http://shopsage-backend;
    proxy_http_version      1.1;
    proxy_buffering         off;
    proxy_cache             off;
    gzip                    off;
    proxy_read_timeout      120s;
    proxy_set_header        Connection '';
}
```

`x-accel-buffering: no` already covers the buffering case for nginx specifically, and is sent for that
reason — the explicit config is belt and braces, and documents the requirement for every other proxy
that does not honour that header.

Cloud load balancers: check the idle timeout (AWS ALB defaults to 60s, which the keepalive covers) and
that HTTP/2 or gRPC-style response buffering is not enabled for the route.

**Verify after any proxy change**, because the failure mode is invisible otherwise:

```bash
curl -N -X POST https://<host>/v1/chat/stream \
  -H 'content-type: application/json' -d '{"message":"How long do I have to return something?"}'
```

Events must appear progressively. If they all land at once, buffering is still on somewhere.

## Production checklist

### Security

- [ ] `CORS_ALLOWED_ORIGINS` set to the exact storefront origins. Never `*`. The backend logs a
      warning at boot if this is left open in production.
- [ ] `QDRANT_API_KEY` set, and Qdrant not reachable from outside the application network.
- [ ] `TRUST_PROXY` set correctly for the topology — **both** settings are now load-bearing. On without
      a trusted proxy lets a caller forge its identity and evade the rate limit; off _behind_ one
      collapses every customer into a single bucket and throttles them all at once. Nothing in the
      application can detect the second case.
- [ ] `RATE_LIMIT_MAX_REQUESTS` divided by the replica count. Limiter state is per process, so a
      configured 30 across three replicas is an effective 90.
- [ ] `MAX_CONCURRENT_STREAMS` sized against what one process can actually carry — it is the closest
      thing to a cost ceiling this system has, and it bounds concurrent spend rather than total spend.
- [ ] Secrets injected by a secret manager, not baked into images or committed to a profile.
- [ ] `NODE_ENV=production` — this is what suppresses stack traces in error responses. It is also what
      makes `AUTH_ENABLED` and `CONVERSATION_STORE` required rather than defaulted.
- [ ] `AUTH_ENABLED=true`, with `AUTH_ISSUER`, `AUTH_AUDIENCE` and `AUTH_JWKS_URL` matching what the
      Magento module mints. The backend refuses to boot in production without an explicit choice, but it
      cannot tell whether the values are the _right_ ones — a mismatch is a 401 on every request.
- [ ] `AUTH_AUDIENCE` is store-specific (`shopsage-<store-id>`), so a token minted for one deployment
      cannot be presented to another.
- [ ] The JWKS URL is reachable from every replica, and `session-keys` reports `up` in `/health/ready`.
- [ ] Alerting on `session token rejected` at **error** level: `alg: none`, a bad signature, and a token
      minted for another store all have a base rate of zero in honest traffic. An expiry is logged at
      `info` and must not be alerted on.
- [ ] TLS terminated at the proxy; the backend never serves plaintext to the internet.
- [ ] Container runs as non-root (already enforced in the image) with a read-only root filesystem.

### Configuration

- [ ] `SITE_PROFILE_PATH` points at the store's profile, mounted read-only.
- [ ] `GET /health/info` confirms the expected `siteId` and `assistantName` after deploy. This is the
      cheapest possible check that the right store's configuration was shipped.
- [ ] The boot log's `llm gateway configured` record shows the expected model and gateway host. This is
      the equivalent check for the gateway, which is deliberately absent from `/health/info`.
- [ ] `EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS` match each other and match the ingested corpus.
- [ ] `LLM_TIMEOUT_MS` and `LLM_MAX_ATTEMPTS` sized against the gateway's measured latency, not the
      defaults. They are per-attempt and total-attempts respectively.
- [ ] `POST /v1/chat` answers a real question after deploy, and the reply's `finishReason` is `stop`
      rather than `length`.

### Cost

The gateway is metered, and this is the first stage where a deployment can spend money.

- [ ] A cost ceiling agreed, and someone accountable for it. Open decision 8 in
      [Roadmap](Roadmap.md).
- [ ] `LLM_MAX_TOKENS` set deliberately. It bounds one answer, not a day's spend.
- [ ] `conversation.maxUserMessageLength` in the site profile set deliberately — every character of a
      question reaches the context window.
- [ ] Spend dashboard built on the `llm completion` log record, which carries the model and the three
      token counts per call, correlated by `requestId` and `conversationId`.
- [ ] **Ingestion spend accounted for separately.** With a hosted embedding backend, embedding is
      metered too, and a full re-ingestion of a large corpus is the single most expensive operation
      this system performs. The `source finished` log record reports `chunksEmbedded` versus
      `chunksSkipped` per run — a healthy scheduled run embeds a handful and skips the rest. A run that
      embeds everything every time means content hashing is not working and the bill scales with corpus
      size rather than with change.
- [ ] `--force` understood as a deliberate, expensive operation, not a default.
- [ ] Understood that the gateway is **not** probed by `/health/ready`. A readiness check that bills per
      call, per instance, every few seconds, is a bill nobody agreed to — so gateway health is visible
      only through real traffic and the `UPSTREAM_FAILURE` rate.

### Reliability

- [ ] **`CONVERSATION_STORE=redis` and `REDIS_URL` set.** The backend refuses to boot in production
      without an explicit choice, so this cannot be forgotten — but it can be answered wrongly. `memory`
      is correct only at exactly one replica; behind two, whichever one the load balancer picks decides
      whether the assistant remembers, and the result reads as an assistant that forgets at random rather
      than as a misconfiguration.
- [ ] At least two backend replicas.
- [ ] Redis reachable from every replica, and **not** shared with another deployment unless
      `REDIS_KEY_PREFIX` differs.
- [ ] `REDIS_TIMEOUT_MS` sized deliberately. A conversation read sits inside a customer's request, so
      this bounds how long a store outage makes them wait before a 502.
- [ ] `conversation.sessionIdleTimeoutMinutes` in the site profile agreed with whoever owns retention —
      it is how long a customer's messages are kept, not merely a cache setting. See open decision 5 in
      [Roadmap](Roadmap.md).
- [ ] Readiness-gated rolling deploys.
- [ ] **Ingestion has run at least once against the configured collection**, or every instance stays
      unready. `/health/ready` checks collection existence as of Stage 6, because a backend with no
      knowledge base cannot answer anything. Order of operations on a fresh environment: start Qdrant,
      run ingestion, then start the backend.
- [ ] A re-ingestion schedule agreed. Content drifts, and a stale knowledge base answers confidently
      from last quarter's policies. Nothing in the system notices this on its own.
- [ ] Qdrant storage on durable volumes, with backups and a **tested** restore. An untested restore is
      not a backup.
- [ ] TEI model cache on a persistent volume so a restart is not a 2.2 GB download.
- [ ] Resource limits set. Budget at least 4 GB for the embeddings container; under-provisioning it
      shows up as the OOM killer restarting the service repeatedly.

### Observability

- [ ] Logs shipped to an aggregator and queryable by `requestId` and `siteId`.
- [ ] Alerts on: readiness failures, 5xx rate, LLM latency and error rate, Qdrant availability.
- [ ] Alert on the `llm request failed, retrying` rate. It is logged at `warn` deliberately: a gateway
      that needs a retry on most requests is a problem worth seeing before it becomes an outage.
- [ ] Alert on `finishReason: "length"` frequency. It means answers are being truncated, which reads to
      a customer as the assistant trailing off mid-sentence.
- [ ] `x-request-id` propagated by the proxy so a trace spans the whole request path.
- [ ] Log retention reviewed against the token counts and correlation ids now being recorded. No
      customer text is logged, and that is worth re-checking rather than assuming.

## Building for production

```bash
docker compose -f docker-compose.yml build shopsage-backend
```

The `production` target carries runtime dependencies only, no dev dependencies and no test code, runs
as the unprivileged `node` user, and includes a `HEALTHCHECK` implemented with Node's own `fetch` so
no extra tooling enters the image. Current size is roughly 240 MB.

## Data operations

| Operation                  | Notes                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial ingestion          | `npm run ingest`. Run as a job, never at application startup — a slow crawl must not block readiness. It creates the collection itself, so no separate provisioning step. Configuration comes from `process.env` exactly as the backend's does; the orchestrator supplies it directly (a Kubernetes Job's own `env`, an ECS task definition) and no `.env` file is needed or present. |
| Re-ingestion               | Idempotent via content hashing; unchanged chunks are skipped and never re-embedded. Safe to schedule.                                                                                                                                                                                                                                                                                 |
| Verifying retrieval        | `npm run evaluate`. Non-zero exit on any failing golden question — usable as a gate.                                                                                                                                                                                                                                                                                                  |
| Deleting removed content   | Automatic, but **guarded**: pruning refuses to run after any crawl failure or below 50% coverage of stored documents. A skipped prune is logged loudly; content removed at the source stays indexed until a clean run.                                                                                                                                                                |
| Changing embedding model   | Breaking. Re-create the collection, re-ingest everything, and **re-tune `minScore`** — score distributions differ per model. Mixing vector spaces silently corrupts similarity.                                                                                                                                                                                                       |
| Changing chunking settings | Re-run with `--force`. A hash covers the chunk's text, so most settings changes are detected automatically, but forcing removes the doubt.                                                                                                                                                                                                                                            |
| Adding a store             | New site profile plus ingestion under a new `siteId`. No code change.                                                                                                                                                                                                                                                                                                                 |

## Known limitations

- No CI/CD pipeline yet; `npm run verify` is the intended gate.
- No Kubernetes manifests or Helm chart. Compose is the only supported deployment today.
- Images are tagged by version, not pinned by digest.
- **Rate limiting keys on the session subject**, which requires a token from Magento — a real
  improvement over an IP address. Keep the proxy's limiter as a second layer anyway: it sees traffic the
  application never receives.
- **Revocation is by expiry.** A token stays valid for up to 15 minutes after a customer logs out.
  Accepted when the contract was agreed; shortening it costs more refreshes.
- **The limiter's state is per process**, so the effective allowance is `limit × replicas`. Divide
  accordingly; nothing checks this for you.
- **The token is not yet forwarded to Magento.** The pseudonymous `sub` design only pays off when a
  commerce tool needs customer identity, which needs `magento-client` — Stage 9.
- **`MAX_CONCURRENT_STREAMS` bounds concurrent spend, not cumulative spend.** It is the closest thing to
  a cost ceiling here, and it will not stop a slow, steady, expensive month. Open decision 8.
- **Streaming depends on proxy configuration that is not verifiable from the application.** A buffering
  proxy turns it into a slow non-stream with nothing logged anywhere. See
  [Streaming through a proxy](#streaming-through-a-proxy), and re-run the `curl -N` check after any proxy
  change.
- An SSE connection is held for the whole answer, so `SHUTDOWN_TIMEOUT_MS=10000` is too low once
  streaming is in use — a rolling deploy will cut answers mid-sentence.
- **Conversation history is not durable across a Redis restart, by design.** Redis runs without
  `appendonly`, so a restart drops in-flight conversations — the same outcome as their TTL passing. If a
  deployment needs transcripts to survive that, it needs a different store with different requirements,
  and it should be driven by the retention decision rather than by this default.
- **`CONVERSATION_STORE=memory` in production is legal and correct only at one replica.** Nothing checks
  the replica count, so a scale-up from one to two silently reintroduces intermittent amnesia. Treat this
  as a scaling checklist item.
- **Grounding is observed, not enforced.** The model is given retrieved content and told to answer only
  from it, and an ungrounded answer is visible (no citations, `grounded: false` in the logs) — but nothing
  structurally prevents the model from answering from its own knowledge anyway. It can still be
  confidently wrong about prices, stock and policies. Products in particular are deliberately **not** in
  the knowledge base, and until the Stage 9 commerce tools exist, product questions have no correct
  source to draw on.
- Answer quality is unmeasured on any real corpus. The golden-question harness proves the mechanism
  against a 7-question fake site; it says nothing about a real store's content. Build a representative
  question set during onboarding, before launch, not after.
- No cap on tool-loop cost per conversation. Each turn is bounded at 4 gateway calls, but a customer can
  send unlimited turns — which is the rate-limiting gap above, seen from the cost side.
- Gateway conformance is verified per endpoint by hand; there is no automated conformance suite.
