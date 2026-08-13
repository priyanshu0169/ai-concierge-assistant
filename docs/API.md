# API

Base URL: `http://localhost:3000` in local development, `integrations.backendUrl` from the site
profile otherwise.

Operational endpoints under `/health` are **unversioned** — orchestrators and monitoring should never
have to follow a version bump. Product endpoints live under `/v1`, so the widget can pin an API
version independently of the storefront's deployment cycle.

## Conventions

### Headers

| Header          | Direction | Notes                                                                   |
| --------------- | --------- | ----------------------------------------------------------------------- |
| `authorization` | in        | **`Bearer <session token>`. Required on `/v1`** — see below             |
| `x-request-id`  | in / out  | Accepted from upstream to continue a trace; always present in responses |
| `x-site-id`     | in        | Reserved for multi-store routing (allowed by CORS, not yet consumed)    |
| `content-type`  | in        | `application/json` for request bodies                                   |

### Authentication

Every `/v1` request carries a session token minted by the Magento module. `/health*` never does — an
orchestrator has no token and must never need one.

```
Authorization: Bearer eyJhbGciOiJFUzI1NiIsInR5cCI6ImF0K2p3dCIsImtpZCI6…
```

The widget obtains one from the storefront (`GET /assistant/session`, same-origin, authenticated by the
ordinary Magento session cookie) and refreshes at about 80% of the 15-minute lifetime. There is no
refresh token: the browser already holds the thing that proves who it is.

**ShopSage never learns who the customer is.** The token's subject is a pseudonym, not a customer id or
an email address. It is used as a stable key for conversation ownership and rate limiting; a future tool
needing real identity will forward the token to Magento, which minted it and can resolve it. Full
contract: [Proposal 0001](proposals/0001-assistant-session-token.md).

| Status | Code                  | Meaning                                    | A client should…                    |
| ------ | --------------------- | ------------------------------------------ | ----------------------------------- |
| `401`  | `UNAUTHORIZED`        | Missing, malformed, or invalid token       | Fetch a fresh token, retry **once** |
| `401`  | `TOKEN_EXPIRED`       | Correctly signed, past its expiry          | **Refresh and retry** — routine     |
| `503`  | `SERVICE_UNAVAILABLE` | ShopSage cannot reach the issuer's key set | Retry with backoff                  |

Those two 401s are deliberately distinct. An expiry happens to every customer every fifteen minutes by
design, so treating it as a hard rejection would make a widget give up where it should quietly refresh.

The `503` is the row most often got wrong elsewhere: if ShopSage holds no usable verification keys, the
caller's token may be perfectly valid and we simply cannot check it. Answering `401` there would send
an operator looking in entirely the wrong place.

**No response ever says which check failed.** Signature, audience, issuer and store are all
`UNAUTHORIZED` with the same message — knowing which one failed is what an attacker would use to work
out what to change next. The precise reason is in ShopSage's logs, graded by severity: an expiry is
`info`, a token minted for another store is `error`.

**A valid token with no usable scope is not an error.** The request succeeds, and the capability is
simply absent — the assistant says it cannot look that up. See
[capability gating](#capability-gating).

An inbound `x-request-id` is validated before use: at most 128 characters from `[A-Za-z0-9._:-]`.
Anything else is replaced with a generated UUID. The header is attacker-controlled and lands in log
storage, so accepting it unchecked would be a log injection vector.

### Limits

| Limit                  | Value                                     | Applies to        |
| ---------------------- | ----------------------------------------- | ----------------- |
| JSON body size         | 64 kB                                     | Everything        |
| Request timeout        | `REQUEST_TIMEOUT_MS`, default 30 s        | Everything        |
| Message length         | `conversation.maxUserMessageLength`, 2000 | Chat endpoints    |
| **Request rate**       | `RATE_LIMIT_MAX_REQUESTS`, default 30/min | `/v1/*`           |
| **Concurrent streams** | `MAX_CONCURRENT_STREAMS_PER_CLIENT`, 2    | `/v1/chat/stream` |
| **Service capacity**   | `MAX_CONCURRENT_STREAMS`, default 50      | `/v1/chat/stream` |

**`/health` is never rate limited.** An orchestrator polls readiness on a fixed interval, and throttling
it would make a healthy instance report a false outage.

### Rate limit headers

Every `/v1` response carries the client's standing, whether or not it was refused, so a client can slow
down before it is turned away:

| Header                | Meaning                                                |
| --------------------- | ------------------------------------------------------ |
| `RateLimit-Limit`     | Requests permitted per window                          |
| `RateLimit-Remaining` | Whole requests still available                         |
| `RateLimit-Reset`     | Seconds until the allowance is fully restored          |
| `Retry-After`         | On a refusal only — seconds until **one** is available |

`Retry-After` advises the wait for one request rather than for a full allowance: the allowance refills
continuously, so telling a client to wait 60 s when it could proceed in 20 keeps it idle three times
longer than it needs to be.

**Two different refusals**, and they mean different things:

| Status | Code                  | Meaning                                                                |
| ------ | --------------------- | ---------------------------------------------------------------------- |
| `429`  | `RATE_LIMITED`        | **This client** sent too many requests, or is holding too many streams |
| `503`  | `SERVICE_UNAVAILABLE` | **The service** is at capacity — not this client's fault               |

`details.scope` distinguishes the two concurrency cases: `client` or `service`. A well-behaved customer
must never be told they are being throttled when the service is simply full.

Rate limits key on the client's IP address today. When authentication arrives they will key on the
authenticated subject instead; nothing about the headers or status codes changes.

### CORS

Configured via `CORS_ALLOWED_ORIGINS`. Allowed methods `GET`, `POST`, `OPTIONS`; allowed headers
`Content-Type`, `Authorization`, `X-Request-Id`, `X-Site-Id`; `X-Request-Id` is exposed to the browser.

`Access-Control-Allow-Credentials` is **never** sent. The assistant session is carried in a header,
never a cookie, which keeps the API immune to CSRF and avoids the wildcard-plus-credentials
combination browsers reject.

### Error envelope

Every failure — 4xx and 5xx alike — has exactly one shape, so a client parses one thing:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "message must not be empty",
    "requestId": "4f1c9b2e-1a3d-4f0e-9c1b-7a2f5e8d3c44",
    "details": { "field": "message" }
  }
}
```

| Field       | Notes                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| `code`      | Stable, machine-readable. Safe to branch on. Renaming one is breaking. |
| `message`   | Human-readable. **Generic for 5xx** — see below.                       |
| `requestId` | Always present. The one thing to quote in a bug report.                |
| `details`   | Only on exposed errors                                                 |
| `stack`     | Only when `NODE_ENV !== 'production'`                                  |

**Message exposure.** Errors carry an `expose` flag. Client errors (4xx) return their real message,
because it tells the caller what to fix. Server errors return
`"An unexpected error occurred. Please try again."` and the real message goes to the logs only —
internal messages routinely contain dependency hostnames, ports and query fragments. Anything
unclassified fails closed as a masked 500.

### Error codes

| Code                    | Status   | Meaning                                   |
| ----------------------- | -------- | ----------------------------------------- |
| `VALIDATION_FAILED`     | 400, 413 | Malformed or oversized input              |
| `UNAUTHORIZED`          | 401      | Missing or unusable credentials           |
| `TOKEN_EXPIRED`         | 401      | Valid signature, past expiry — refresh    |
| `FORBIDDEN`             | 403      | Not permitted                             |
| `NOT_FOUND`             | 404      | No such route or resource                 |
| `RATE_LIMITED`          | 429      | Too many requests                         |
| `UPSTREAM_FAILURE`      | 502      | A dependency failed                       |
| `SERVICE_UNAVAILABLE`   | 503      | Reachable but not ready                   |
| `TIMEOUT`               | 504      | Exceeded its time budget                  |
| `CONFIGURATION_INVALID` | 500      | Bad configuration (fatal at boot)         |
| `INTERNAL_ERROR`        | 500      | Unclassified — reaching a client is a bug |

## Endpoints

### `GET /health`

Liveness. Returns 200 whenever the process can serve requests. **Never** consults a dependency — see
[SystemDesign](SystemDesign.md#health-liveness-and-readiness).

```json
{ "status": "ok", "service": "shopsage-backend", "version": "0.1.0", "uptimeSeconds": 42 }
```

Use this for container and orchestrator liveness probes.

### `GET /health/ready`

Readiness. Checks every dependency in parallel and reports each one.

`200` when all dependencies are up, `503` when any is down. Response body is identical in both cases
apart from `status`:

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
    },
    {
      "name": "knowledge-collection",
      "status": "down",
      "error": "Knowledge collection \"shopsage_content\" does not exist (run: npm run ingest -w @shopsage/ingestion)"
    }
  ]
}
```

Three checks as of Stage 6: `qdrant`, `embeddings`, and `knowledge-collection`. The last one was
deliberately absent before — a missing collection is the correct state before the first ingestion run,
and failing on it would have meant a fresh deployment could never become ready enough to be ingested
into. Now that every question retrieves, a backend with no collection cannot answer anything.

Use this for load-balancer and orchestrator readiness probes. Expect 503 on a fresh deployment until
ingestion has run once, and on first start of a self-hosted embeddings service while its model
downloads.

### `GET /health/info`

The effective, non-secret configuration. Exists so the configuration-driven design is verifiable at
runtime: it proves which site profile an instance actually loaded.

```json
{
  "service": "shopsage-backend",
  "environment": "production",
  "site": { "siteId": "demo-store", "companyName": "Demo Store", "assistantName": "Sage" },
  "localization": { "locale": "en-US", "currency": "USD", "timezone": "UTC" },
  "enabledFeatures": ["knowledgeSearch", "streaming"]
}
```

Secrets, dependency URLs and the system prompt are excluded, and a test asserts they stay excluded.

All three endpoints send `Cache-Control: no-store`; a cached health response would make an
orchestrator act on stale state.

**The LLM gateway is not in `/health/ready`.** It is a metered, rate-limited third party, and a
readiness check that bills per call — once per instance, every few seconds, forever — is a bill nobody
agreed to. Gateway misconfiguration is caught at boot instead: the backend refuses to start without
`LLM_API_KEY`, `LLM_BASE_URL` and `LLM_MODEL`. Everything else shows up as `UPSTREAM_FAILURE` on a
real request, with a remediation hint in the log.

### `POST /v1/chat`

Ask the assistant a question.

**Request**

```json
{ "conversationId": "c_4f1c9b2e1a3d4f0e9c1b7a2f5e8d3c44", "message": "What is your return policy?" }
```

| Field            | Required | Rules                                                                          |
| ---------------- | -------- | ------------------------------------------------------------------------------ |
| `message`        | ✅       | Trimmed, non-empty, at most `conversation.maxUserMessageLength` (default 2000) |
| `conversationId` |          | Opaque token, `[A-Za-z0-9_-]{1,64}`. Omit to start a conversation              |

Unknown fields are **rejected** with a 400. A field the API does not understand is either a client bug
or an attempt to smuggle a parameter into the model call.

**Response**

```json
{
  "conversationId": "c_a1fecd4e898b41f98e3a8f2076b5cbf1",
  "messageId": "m_3e4fc705f94f4f4c9febf2b44b52c602",
  "answer": "You have thirty days from the delivery date to return unopened items for a full refund, provided the original packaging is intact and undamaged. Please note that return shipping is the customer's responsibility.",
  "sources": [
    { "title": "Returns policy", "url": "https://example.com/help/returns" },
    { "title": "Help Centre", "url": "https://example.com/help" }
  ],
  "finishReason": "stop"
}
```

| Field            | Notes                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| `conversationId` | Echoed if supplied, generated otherwise. Always the id to use next        |
| `messageId`      | Identifies this assistant turn                                            |
| `answer`         | The store's `noAnswerMessage` if the model returned nothing at all        |
| `sources`        | Citations behind this answer, at most `retrieval.maxCitations`. See below |
| `finishReason`   | `stop` \| `length` \| `tool_calls` \| `content_filter` \| `unknown`       |

**`sources` is populated as of Stage 6, and the response shape did not change to make that possible.**
The field shipped in the first release as a permanently empty array precisely so that clients written
against Stage 2 need no change now. Same for `conversationId`: it was in the contract three stages
before there was any memory behind it, so memory arrived with **no API change**.

Two things to know about `sources`:

- It is **empty when the answer was not grounded in retrieved content** — either nothing cleared the
  relevance floor, or the model chose not to search. An answer with no sources is one a customer should
  be more sceptical of, and the emptiness is the signal.
- It is deduplicated by URL and capped, so it is a citation list for a human, not a retrieval log. Which
  chunks were retrieved, and how many, is in the logs.

Not in the response, deliberately:

| Withheld      | Why                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Token usage   | A cost signal for operators, not data for a browser. Recorded in the `llm completion` log record                                            |
| `grounded`    | An operational metric — how often answers rest on retrieved content. Publishing it invites a client to branch on it and makes it a contract |
| Tool activity | Whether a tool ran, how many rounds, what the query was. Internal mechanics; `toolRounds` is logged                                         |

A test asserts none of these appear in the serialized body.

**Errors**

| Status | Code                | Cause                                                      |
| ------ | ------------------- | ---------------------------------------------------------- |
| 400    | `VALIDATION_FAILED` | Missing, empty, oversized or unknown field                 |
| 502    | `UPSTREAM_FAILURE`  | The LLM gateway failed, was throttled, or is misconfigured |
| 504    | `TIMEOUT`           | The gateway exceeded `LLM_TIMEOUT_MS`                      |

### `POST /v1/cart/confirm`

Executes a prepared cart change. **The only endpoint that changes a basket**, and it takes no cart
contents — only the id of something ShopSage already prepared and stored:

```json
{ "proposalId": "cp_0123456789abcdef0123456789abcdef" }
```

There is no `POST /v1/cart/items` and no `POST /v1/cart/coupon`. A client cannot _ask_ for a basket
change, only agree to one. That is the whole design: a cart change must be an act by a customer, and a
distinct request made by a click is what makes it one — folding it into `/v1/chat` would put "did the
customer agree?" back into text a model wrote.

**Mounted only when the store has `cart` or `coupons` enabled.** Otherwise the route does not exist, and
a `404` is honest where a `403` would advertise a capability nobody configured.

**Response**

| Field     | Notes                                                                       |
| --------- | --------------------------------------------------------------------------- |
| `status`  | `applied` \| `rejected` \| `gone`                                           |
| `message` | Shown to the customer. The store's own wording where the connector gave one |
| `cart`    | Present when the connector answered: `itemCount`, `total`, `cartUrl`        |

`cart.total` is the connector's **formatted string**, repeated and never recomputed. A client rendering a
total it derived from line prices is the same failure as a model doing the arithmetic, one layer out
([ADR 0028](adr/0028-commerce-reads-behind-one-adapter.md)).

**All three statuses are `200`**, and that is deliberate. "Applied", "the store declined it" and "that
has expired" are all _answers_ to a question the customer asked by clicking; none is an error to retry.
A `404` for a consumed proposal would also confirm to a stranger that the id was once real.

| Status | Code                | Cause                                                             |
| ------ | ------------------- | ----------------------------------------------------------------- |
| 400    | `VALIDATION_FAILED` | Malformed `proposalId`, or an unknown field — including `subject` |
| 403    | `FORBIDDEN`         | The session lacks the `cart` scope                                |
| 404    | `NOT_FOUND`         | No cart feature is enabled for this store                         |
| 502    | `UPSTREAM_FAILURE`  | The connector failed. **Not** degraded into a friendly answer     |

That last row is the one exception to how commerce failures are handled. A chat turn degrades a
connector outage into "I could not look that up"; a confirmation does not, because a write may have
partially happened and "we could not apply it" would be a claim nobody can support. The client tells the
customer to check their basket.

**A proposal is consumed on the first attempt, successful or not.** A second confirmation is `gone`, and
so is a retry after a failure — the customer asks again rather than re-clicking. A confirmation from the
_wrong_ session is refused **and the proposal survives**, so a leaked id cannot be used to destroy
somebody else's prepared change.

### `GET /metrics`

The Prometheus text exposition format. **Off by default**, and guarded with a bearer token whenever it is
on — `METRICS_ENABLED=true` with no `METRICS_TOKEN` is a boot failure rather than an open endpoint.

```
Authorization: Bearer <METRICS_TOKEN>
→ 200  text/plain; version=0.0.4
→ 401  when the credential is missing or wrong, with no detail about which
→ 404  when metrics are disabled — the route is not mounted
```

The guard is not caution for its own sake: the payload says how many customers asked questions today, how
many tokens the store paid for, which dependencies are failing and how often the assistant cannot answer.
For a competitor that is a free business intelligence feed.

Mounted **outside `/v1`** and outside the rate limiter. A scraper is not a customer: it holds an operator
credential rather than a session token, must not compete with customer traffic for a rate-limit bucket,
and should not break the day `/v1` becomes `/v2` — the same reasoning that keeps `/health` unversioned.

**What it publishes**, and the operator question each answers:

| Metric                             | Answers                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `http_requests_total`              | Is it up and serving? By route and status                                        |
| `http_request_duration_ms`         | Is it fast? By route and method                                                  |
| `assistant_turns_total`            | **Is it answering well?** grounded / ungrounded / no_answer / failed / abandoned |
| `assistant_turn_duration_ms`       | How long a turn takes, buffered versus streamed                                  |
| `assistant_time_to_first_token_ms` | What a customer actually waits for on a stream                                   |
| `assistant_tool_rounds_total`      | Which tools run, and which fail                                                  |
| `cart_proposals_total`             | Cart changes prepared, applied, rejected, gone                                   |
| `llm_tokens_total`                 | What it costs, by model and prompt/completion                                    |
| `llm_tokens_per_call`              | Whether a conversation's prompt is growing out of hand                           |
| `dependency_calls_total`           | Which dependency is failing, by operation and outcome                            |
| `dependency_call_duration_ms`      | Which dependency is slow                                                         |
| `requests_rejected_total`          | Is anyone abusing it? rate_limited / at_capacity / unauthenticated / forbidden   |

`assistant_turns_total` is the one nothing else could give. `grounded` is deliberately **absent** from the
chat response — publishing it would invite a client to branch on it — and has only ever existed in a log
line. As an aggregate it is the single most useful number about this service.

**No label carries customer data.** No conversation id, no session subject, no query text, no sku, no
order reference, no error message. That is not only about privacy: the route label is an allow-list rather
than `req.path`, because a metric labelled with a caller-supplied string lets anybody who can send a
request create unbounded series that never expire. An unrecognised path is `route="other"`.

A gateway failure is always a **masked 502**, never a 429 — including when the gateway itself
rate-limited us. Telling a customer they are being throttled when they are not would be wrong, and
ShopSage's own rate limiting (Stage 7c) must stay distinguishable. The gateway's status, its error body
and a remediation hint go to the logs. See [ADR 0012](adr/0012-llm-retry-and-failure-policy.md).

**A commerce connector failure is not in that table**, and its absence is a decision. It produces a
`200` with an ordinary answer — "I could not look that up just now" — because a commerce outage should
not take down the knowledge answers that still work, and a customer cannot act on a `502` anyway. The
operator sees `tool execution failed` in the log. The connector is not a readiness probe for the same
reason ([ADR 0028](adr/0028-commerce-reads-behind-one-adapter.md)).

**What this endpoint does.** Loads the last `conversation.maxHistoryMessages` messages, builds a prompt from
the site profile's system prompt (with `{{assistantName}}` and `{{companyName}}` resolved), offers the
model the store's enabled tools, and runs a bounded tool loop until the model answers in prose. Retrieval
happens inside the `searchKnowledge` tool, so the model decides whether to search — see
[RAG](RAG.md#grounding) for what that guarantees and what it does not.

**Which tools this request gets** depends on the store's feature flags **and** the session's scopes. A
guest session never sees `trackOrder`: the tool is **absent** from the prompt rather than present and
refusing, so the model says it cannot look an order up instead of promising a lookup that will never
happen ([ADR 0026](adr/0026-magento-issued-session-tokens.md)).

**A prepared cart change rides on the reply.** When a turn prepares one, the response carries a
`proposal`: `id`, `kind`, `summary`, `expiresAt` and `lines`. It is an allow-list, and three fields are
withheld deliberately — `subject` (the session pseudonym, which the client already knows and which gates
confirmation), `siteId` (internal), and `code` (the customer typed it and it is already in `summary`; a
working discount code duplicated into JSON ends up in browser history for no gain). `id` **is** published,
because it is the confirmation token.

`summary` is the sentence the customer consents to, and it is built by ShopSage from connector data
rather than by the model. A client must render it as **text**: passing it through a markdown renderer
could emphasise a price, insert a link, or swallow a line as syntax
([ADR 0029](adr/0029-cart-changes-need-a-confirmed-proposal.md)).

**What is persisted is not what was sent.** Before a turn is written to conversation history, email
addresses, Luhn-valid card numbers and structured phone numbers are replaced with `[removed]` — in both
the customer's message and the assistant's reply. The response body is untouched: the customer sees what
they typed, and only the copy that outlives the turn is reduced. Free-text addresses are **not**
detectable this way and the redactor does not claim to catch them; the defence there is that no tool
fetches an address and `trackOrder` tells the model never to ask
([ADR 0028](adr/0028-commerce-reads-behind-one-adapter.md)).

**Latency to expect.** A grounded answer is two gateway calls plus one embedding call, not one call.
Measured against the real gateway: ~5.3s end to end, dominated by the first model call. A question the
model answers without searching is one call and correspondingly faster. Streaming (Stage 7a) is what makes
this feel fast rather than making it fast.

**What is still missing.** No authentication — Stage 7d. And conversation history
is held **in process memory**, so it does not survive a restart and is not shared between replicas; the
backend logs a warning about this at boot when `NODE_ENV=production`. Treat the memory guarantee as
best-effort until a durable store lands ([Roadmap](Roadmap.md)).

### `POST /v1/chat/stream`

The same turn as `POST /v1/chat`, delivered as it happens. Same request body, same validation, same
limits. Gated by the `streaming` feature flag, which defaults to on.

Use this one for anything a person is watching. Total latency is the same — about five seconds for a
grounded answer — but the buffered endpoint shows nothing for four of them, which reads as a broken page
rather than a slow one.

**Response**: `200` with `content-type: text/event-stream`, then four kinds of event.

| Event      | Payload                                           | When                                      |
| ---------- | ------------------------------------------------- | ----------------------------------------- |
| `start`    | `{ conversationId, messageId }`                   | **First, always** — before any model call |
| `tool`     | `{ name, phase }` — `started`/`finished`/`failed` | Around each tool execution                |
| `delta`    | `{ text }`                                        | Text to append, as it is produced         |
| `proposal` | A prepared cart change                            | Before `done`, when the turn prepared one |
| `done`     | The full `POST /v1/chat` response body            | **Last, exactly once**                    |
| `error`    | The standard error envelope                       | Instead of `done`, if the turn failed     |

**`proposal` is the one event a client may not merely display.** Every other event is safe to skip. A
proposal a renderer drops leaves an assistant claiming to have prepared something the customer cannot
accept — so `done.proposal` repeats it, and a client should render the repeat only if the separate event
never arrived, which is what a proxy buffering an unknown event type looks like. It is emitted as it
happens rather than only inside `done`, so the confirmation can be shown while the model is still writing
the sentence that explains it.

```
event: start
data: {"conversationId":"c_0e05d1cd…","messageId":"m_a6eddc27…"}

event: tool
data: {"name":"searchKnowledge","phase":"started"}

event: tool
data: {"name":"searchKnowledge","phase":"finished"}

event: delta
data: {"text":"You"}

event: delta
data: {"text":" have thirty days"}

event: done
data: {"conversationId":"c_0e05d1cd…","messageId":"m_a6eddc27…","answer":"You have thirty days…",
       "sources":[{"title":"Returns policy","url":"https://example.com/help/returns"}],
       "finishReason":"stop"}
```

Comment lines (`: keepalive`) arrive every 15 seconds while the stream is idle. Ignore them — that is
what SSE comments are for.

**Four rules a client must follow.**

1. **`done.answer` is authoritative; deltas are a preview of it.** They are identical in the normal
   case. But when the model returns no prose at all there are **zero** deltas and the store's no-answer
   message appears only in `done` — so a renderer that trusts deltas alone shows an empty bubble in
   exactly the case where saying something matters most. Reconcile at the end.
2. **`done` is self-sufficient.** Its payload is the same shape `POST /v1/chat` returns, from the same
   serializer, so a simple client may ignore `start` and still have every field.
3. **Handle `error` as well as a failed status code.** See below.
4. **Expect the first `delta` several seconds in.** The `tool` events exist to fill that gap; render
   them as a status line ("Searching…") rather than as content.

**Two error shapes, and which one you get depends on timing.** This is inherent to streaming, not a
design choice:

| Failure                         | Delivered as                                        |
| ------------------------------- | --------------------------------------------------- |
| Validation, feature disabled    | A normal `4xx` with the JSON error envelope         |
| Anything before the first event | A normal `5xx` with the JSON error envelope         |
| Anything after the first event  | `200`, then an `error` event carrying that envelope |

The stream deliberately opens on its first event rather than when the request arrives, which is what
keeps the middle row possible — a dependency outage stays a real status code that load balancers and
monitoring understand. Once one event is out, a 200 is committed and only the last row is available.
Anything that would rather have a status code than an event should use `POST /v1/chat`.
See [ADR 0023](adr/0023-streaming-delivery-over-sse.md).

| Status | Code                  | Cause                                                              |
| ------ | --------------------- | ------------------------------------------------------------------ |
| 400    | `VALIDATION_FAILED`   | Same rules as `POST /v1/chat`                                      |
| 404    | `NOT_FOUND`           | `features.streaming` is off for this store                         |
| 429    | `RATE_LIMITED`        | Too many requests, or too many streams already open by this client |
| 502    | `UPSTREAM_FAILURE`    | The turn failed before it produced anything                        |
| 503    | `SERVICE_UNAVAILABLE` | The service is at its concurrent-stream capacity                   |

All of these arrive **before** the stream opens, so they are ordinary JSON responses rather than `error`
events. Capacity is checked last, after the feature flag and the request body — there is no point
reserving a slot for a request that was never going to be served.

**Disconnecting is supported and cheap.** Closing the connection cancels the gateway call rather than
letting it finish unread, so an abandoned answer stops being billed. The turn is **not** written to
conversation history — a stream can be cut mid-sentence, and a fragment replayed to the model on the
next question is worse than no record. Practically: if a customer abandons an answer, the next question
will not know it was asked.

## Capability gating

A session's token carries scopes, and they decide which tools the assistant is offered:

| Scope    | Grants                                | Issued to                        |
| -------- | ------------------------------------- | -------------------------------- |
| `chat`   | Knowledge-base Q&A                    | Everyone, including guests       |
| `cart`   | `addToCart`, `applyCoupon` (Stage 9)  | Sessions with a cart             |
| `orders` | `trackOrder`, order history (Stage 9) | **Authenticated customers only** |

**A scope the session lacks makes the tool absent, not the request refused.** A guest asking "where is
my order?" gets a `200` and an honest "I cannot look that up" — the request was legitimate and correctly
authenticated, and there is nothing for the caller to fix. Offering the tool and then refusing the call
would have the assistant promise something it cannot deliver, leaving a customer waiting for an answer
that never comes.

Verified: a valid token with no usable scope answers `200` with no retrieval attempted at all.

This is the same mechanism as the site profile's feature flags, and the two compose: the flag asks what
the **store** has enabled, the scope asks what this **customer** may do.

## Planned endpoints

Contracts are listed so the Magento connector and widget can be built against them.

_None. Every endpoint the widget needs now exists._

## Consumed APIs: the Magento connector

ShopSage **consumes** these; it does not implement them. They live in a separate Magento module
repository and no Magento business logic exists in ShopSage.

| Endpoint                    | Used from |
| --------------------------- | --------- |
| `GET /assistant/products`   | Stage 9   |
| `GET /assistant/categories` | Stage 9   |
| `GET /assistant/orders`     | Stage 9   |
| `POST /assistant/cart`      | Stage 9   |
| `POST /assistant/coupon`    | Stage 9   |
