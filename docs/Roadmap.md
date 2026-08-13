# Roadmap

One stage at a time. Each stage is independently verifiable, updates documentation, and ends with a
review before the next begins. The ordering is driven by dependency, not by visible progress: the
foundation and the vendor boundaries come before the features that rely on them.

## Stages

### ✅ Stage 1 — Foundation and runtime skeleton

Monorepo with npm workspaces, `@shopsage/platform` (structured logging with secret redaction, error
taxonomy, configuration loading and validation, timeout primitives), `@shopsage/rag-backend` HTTP
skeleton (correlation ids, access logging, CORS, error envelope, liveness/readiness/info endpoints,
graceful shutdown), the Docker environment, the quality gates, and this documentation set.

Verified: 94 tests, clean lint, clean typecheck, Compose config valid for both modes, production image
builds, runtime endpoints exercised.

### ✅ Stage 2 — LLM client

`@shopsage/llm-client` against any OpenAI-compatible endpoint. `generate()` and `stream()`, retries
with equal-jitter backoff, per-attempt timeouts, `Retry-After` handling, normalized responses, tool
calls (including reassembly of streamed fragments), and errors mapped into the platform taxonomy.
`withRetry` landed in `@shopsage/platform`. `POST /v1/chat` is wired end to end without retrieval, so
the gateway is proven before anything depends on it.

Token accounting is logged rather than returned, which keeps the model identifier out of the client's
contract entirely. `LLM_*` became mandatory — enforced in the backend's composition root rather than
the shared schema, so entry points that never call a model are not forced to carry credentials
([ADR 0013](adr/0013-required-config-per-entry-point.md)).

Verified: 257 tests, clean lint, clean typecheck, Compose config valid for both modes, the full path
exercised against a stub gateway (retry on 503, no retry on 401 or timeout, prompt assembled from the
site profile, credential absent from every log record), **and a real internal LiteLLM gateway** — where
tool calling, the tool-result round trip, streaming and streamed fragment reassembly all pass. See
[Testing](Testing.md#2a-bis-verified-gateways).

Carried into Stage 6: `packages/rag-backend/src/chat/` is a **transitional** vertical slice, labelled as
such in the code, and is deleted when `assistant-core` lands. The HTTP contract it serves is already
final. See [Architecture](Architecture.md#rag-backend--http-delivery).

Also found and fixed here: the Stage 1 redaction pattern matched `token` in any position, so every
token count was logged as `[redacted]` — the exact data this stage set out to make visible. See the
postscript to [ADR 0011](adr/0011-normalized-llm-contract.md).

### ✅ Stage 3 — Embeddings client and vector repository

`@shopsage/embeddings-client` (`embedQuery`, `embedDocuments`, sequential batching, truncation, explicit
normalization) and `@shopsage/vector-repository` (`createCollection`, `insert`, `search`, `delete`,
`collectionExists`, `count`) with a Qdrant adapter behind the port. Readiness moved from generic HTTP
checks to the clients' own `health()` methods, and the backend no longer holds a dependency URL.

Readiness now means **usable**, not reachable: the embeddings check fails if the service is serving a
model other than the configured one, which is the silent-corruption case nothing else would catch
([ADR 0014](adr/0014-clients-own-their-readiness.md)). Callers keep their own point ids and the adapter
derives the UUID Qdrant demands, deterministically, so re-ingestion stays idempotent without leaking an
id format ([ADR 0015](adr/0015-caller-owned-point-ids.md)). `sendRequest`/`readJsonBody` moved into
`platform` once there was a third caller.

Verified: 329 tests, clean lint, clean typecheck, the production image built (244 MB) and the full stack
run production-shaped, **and both clients exercised against real Qdrant and real TEI** — normalized
vectors, ordered batching, idempotent upsert, filtered search, and two stores in one collection unable
to see each other. See [Testing](Testing.md).

Three real defects surfaced, all in earlier stages' work:

- **Qdrant authentication was silently on and unsatisfiable.** `QDRANT__SERVICE__API_KEY: ${QDRANT_API_KEY:-}`
  always sets the variable, and Qdrant enables auth on its presence — so a blank key 401'd every data
  operation while `/readyz` stayed 200. Stage 3 is the first stage to perform a data operation. Fixed
  with Compose's bare-name form.
- **`bge-m3` cannot warm up on 8 GB of Docker memory**, and leaves no OOM evidence: exit 0,
  `OOMKilled=false`, eighteen restarts. The troubleshooting guidance now describes the real signature.
- **A promise-returning method that threw synchronously** on validation failure, forcing callers to
  handle two error channels. Caught by its own test.

### ✅ Stage 4 — Content sources

Two packages. `@shopsage/content-model` holds the `ContentSource` port and the canonical `Document`
every source emits — a contract with no implementation, so neither the scraper nor the ingestion
pipeline has to depend on the other ([ADR 0016](adr/0016-content-source-port-and-canonical-document.md)).
`@shopsage/scraper` is one implementation of that port: robots-aware, rate-limited, sitemap-seeded,
breadth-first, streaming documents as it finds them.

All crawl behaviour moved into `config/site-profile.json` under `content.sources[]` — seeds, sitemaps,
include and exclude patterns, depth, page ceiling, rate, per-path classification. No path, host or
store name appears in the scraper ([ADR 0017](adr/0017-crawl-behaviour-is-site-profile-data.md)). A
preview CLI dry-runs a source without embedding or storing anything, because include/exclude patterns
are the hard part of onboarding a store.

Products remain explicitly out of scope: an embedded catalogue is wrong the moment a price changes.

**Verification was interrupted and then completed.** Node.js was removed from the development machine
partway through this stage — `C:\Program Files\nodejs` left holding only `node_modules` — so the stage
shipped with lint and typecheck clean but its tests never executed. Once Node returned (early in
Stage 5's work), the full suite ran and found two real defects: inline HTML markup extracted with a
missing word boundary (`Returnunopened items`), and a `z.discriminatedUnion` member that could not be
wrapped in `.refine()`. Both fixed; see [Testing](Testing.md#current-results).

### ✅ Stage 5 — Ingestion pipeline

`@shopsage/ingestion`: structure-aware chunking (heading → paragraph → sentence → character, in that
order of preference), embedding, upsert, idempotent re-ingestion via content-hash comparison, a guarded
prune for documents removed at the source, a CLI, and the first golden-question evaluation harness.

Chunking is measured in **characters, not tokens** — a token-based design needs a tokenizer specific to
one model family, and the default embedding backend (Stage 4's hosted gateway) publishes no token limit
to size against. `EMBEDDING_QUERY_PREFIX`-style per-backend tuning was the alternative considered and
rejected; see [ADR 0020](adr/0020-structure-aware-chunking.md).

`VectorRepository` gained `list()` — cursor-paginated enumeration with no query vector — because cheap
re-ingestion needs to ask "what do I already hold for this document?" before deciding what to re-embed.
Whole-document deletion is a separate, guarded operation that refuses to run after any crawl failure or
when coverage of what is already stored falls below 50%, so a partial crawl degrades to stale content
rather than to an emptied knowledge base. See
[ADR 0019](adr/0019-content-hash-idempotent-ingestion.md).

Verified: 533 tests (up from 329 pre-Stage-4), clean lint, clean typecheck, and a full real-service
pass — a four-page fake site crawled end to end into real Qdrant using the real embedding gateway,
first run embedding 7 chunks in 4.5s, second run confirming all 7 unchanged in 0.3s, a deliberately
narrowed re-crawl correctly refusing to prune (25% coverage against a 50% threshold, verified by
counting points in Qdrant directly), and the evaluation CLI reporting 7/7 golden questions passed,
recall@6 = 1, refusal accuracy = 1. See [Testing](Testing.md#2a-quater-verify-ingestion-end-to-end-against-real-services).

Nothing here is wired into a customer-facing request yet — ingestion is a batch process run by hand or
by schedule, and `/v1/chat` still answers from the model's own knowledge until Stage 6.

### ✅ Stage 6 — Assistant core

`@shopsage/assistant-core`: conversation manager, bounded tool loop, context builder, prompt builder
(taking over `{{assistantName}}` / `{{companyName}}` interpolation), tool registry with
`searchKnowledge`, source ranking, answer formatter, and an in-memory `ConversationStore`.
Framework-free: no Express, no `fetch`, no Qdrant, no SDK, one runtime dependency (`platform`), and a
full test suite that runs offline against object literals.

**The domain declares its ports** and the outer layers satisfy them —
[ADR 0021](adr/0021-the-domain-declares-its-ports.md). The decision that mattered was making retrieval
**one** port (`KnowledgeRetriever`) rather than the obvious two (`TextEmbedder` + `VectorStore`): the
domain asks for content relevant to a question and never learns that answering involves an embedding
model or a vector index, so a reranker or hybrid retriever is an adapter change. `stream()` was
deliberately absent from `LanguageModel` at this point, because how streaming interacts with the tool
loop was unsettled and a port method would have guessed at the answer — settled in 7a.

**The tool loop is bounded at three rounds, then withdraws the tools** to force prose —
[ADR 0022](adr/0022-bounded-tool-loop.md). A tool that throws becomes a tool result rather than a 502;
an invented tool name is answered by naming what exists. Retrieved context arrives as a tool result, not
in a pre-built system prompt, which is what lets the model search again when the first query misses.

**`packages/rag-backend/src/chat/` is deleted**, as Stage 2 promised when it put the transitional slice
there. `/v1/chat` now returns populated `sources` and the HTTP contract did not change — which is the
whole reason the contract was finalised three stages before the implementation behind it existed.

Collection existence joined `/health/ready`, as this stage said it would.

Verified: 586 tests (up from 533), clean lint, clean typecheck, and a real end-to-end pass against the
real LLM gateway, real embedding gateway and real Qdrant — a grounded answer with three citations, a
correct refusal with none, and a follow-up question (_"And internationally?"_) resolved from history.
See [Testing](Testing.md#2a-quinquies-verify-a-grounded-answer-end-to-end).

**Carried forward as a known gap at the time:** the `ConversationStore` implementation was in-process
memory, correct at one replica and wrong at two. Closed in Stage 7b.

### ✅ Stage 7 — Full API surface, delivered as 7a–7d

As originally scoped this stage bundled five unrelated concerns — streaming, conversation persistence,
authentication, rate limiting and abuse protection — which breaks the one-stage-at-a-time rule the
project runs on. It is split by what each one touches:

- **7a (done): streaming.** The only item that changes the **domain**. It required a new port method and
  a decision about how streaming interacts with the tool loop, and it is the item that would have been
  most expensive to retrofit.
- **7b (done): the durable conversation store.** An adapter swap that touches no domain code, and the
  one remaining item that was neither blocked nor waiting on anything else.
- **7c (done): rate limiting and capacity.** Middleware. Not blocked on anything — see the correction
  below.
- **7d (done): authentication.** The only piece that was ever genuinely blocked, on open decision 2 — resolved by writing the contract, having it reviewed, and implementing what was agreed.

Doing 7a first also mattered for Stage 8: the widget needs streaming, and does not need auth.

### ✅ Stage 7a — SSE streaming

`POST /v1/chat/stream` delivering the same turn as `POST /v1/chat`, as it happens. Four events —
`start`, `tool`, `delta`, `done` — with `done` carrying the buffered response byte-identical in shape,
from one serializer. `stream()` joined the `LanguageModel` port, and the conversation manager gained
`answerStream()`. See [ADR 0023](adr/0023-streaming-delivery-over-sse.md).

**One tool loop serves both modes**, parameterized by a round runner: the streaming runner is
`model.stream()` unchanged, the buffered one wraps `generate()` in a single terminal event. That works
only because Stage 2 gave `stream()` a terminal event carrying a finished completion — so round
bounding, tool withdrawal and tool execution were not written twice, and a test asserts both modes agree
on the same scenario.

**The stream opens on its first event, not when the handler starts.** Deferring the response head keeps
a pre-first-event failure reportable as a real 5xx with the standard envelope; only once an event is out
does a failure have to become an `error` event. `http/error-envelope.js` was extracted so both paths mask
5xx messages through the same code.

Verified end to end against the real gateway: `start` at 70ms, `tool started` at 1.8s, `tool finished` at
2.9s, first token at 4.3s, complete at 4.8s over 48 deltas — versus 4.9s of silence buffered. Deltas
reassemble exactly to `done.answer`; the streamed and buffered answers and citations match; a disconnect
cancels the gateway call and persists nothing.

**One real defect found by testing rather than by reasoning:** the abort path filed an `error` record
with a stack trace every time a customer closed a tab. Normal behaviour must not look like a fault, or
real faults drown in it. Now `info`, with a test pinning it.

Also worth deciding in 7b: whether the LLM path needs an overall latency budget across attempts rather
than the current per-attempt one ([ADR 0012](adr/0012-llm-retry-and-failure-policy.md)). Streaming makes
that latency visible to a customer in real time, which was the trigger condition recorded for it.

### ✅ Stage 7b — Durable conversation store

`@shopsage/conversation-store`: Redis behind the `ConversationStore` port, closing the gap
`docs/Deployment.md` has carried since Stage 6 as "the strongest single blocker to a real deployment".
Adding it changed **no domain code** — which is the test a port is really for. See
[ADR 0024](adr/0024-durable-conversation-store.md).

**Authentication and rate limiting were deliberately not attempted.** Authentication is blocked on open
decision 2, which needs the Magento module's author, and inventing that contract unilaterally would be
worse than not having it. Rate limiting without authentication keys on a forgeable IP or a trivially
rotated conversation id, so it is weak until auth exists. Both move to 7c.

`CONVERSATION_STORE` has **no default in production**: `memory` is correct at one replica and silently
wrong at two, and only an operator knows which. An unset value is a boot failure naming both options —
the same rule as `LLM_*` ([ADR 0013](adr/0013-required-config-per-entry-point.md)).

`conversation.sessionIdleTimeoutMinutes` finally does something, in **both** implementations: the
in-memory store gained the same lazy idle expiry, because two implementations of one port that expire
differently are two products.

A failed read fails the turn; a failed write does not. The answer already exists by then — and on the
streaming path has already been rendered — so failing would discard work the customer can see to report
something they cannot act on. The turn is logged with `persisted: false`.

Verified live with **two replicas against one Redis**: a reference code given to one process and recalled
from the other comes back correctly, while the same test on the in-memory store answers "I could not find
the answer to that". Also verified: boot refusal in production, expiry, recovery after a Redis restart
without restarting the backend, and `502` rather than an SSE `error` event when the store is down — which
is [ADR 0023](adr/0023-streaming-delivery-over-sse.md)'s lazy stream paying off.

**One real defect, found by testing rather than reasoning.** Stopping Redis made `/health/ready` hang
**indefinitely** instead of reporting `down`. Every other client bounds its own I/O; this one did not,
and `platform`'s `withTimeout` could not help because it is a cancellation primitive and a Redis command
cannot be cancelled. Now every operation races `REDIS_TIMEOUT_MS`, with a test that pins it.

`registerGracefulShutdown`'s teardown hooks — written in Stage 1, unused until now — got their first
implementation and their first tests.

### ✅ Stage 7c — Rate limiting and capacity

A token bucket per client on `/v1`, and a separate concurrency ceiling on streams. See
[ADR 0025](adr/0025-rate-limiting-and-capacity.md).

**A Stage 7b position corrected.** I argued there that rate limiting should wait for authentication
because IP-keyed limiting is weak. That overstated it: it is bypassable by an attacker who rotates
addresses, but the realistic threat is a runaway script or one abusive caller, both of which come from
one place. Every public API limits before it authenticates, and "nothing" is worse than "bypassable with
effort".

**Two controls, because a request is spent and a stream is held.** A client well inside its request rate
can still keep several generations running. Per-client excess is `429`; the process-wide ceiling is
`503`, because a service being full is not any one customer's fault and the two must stay separable in a
dashboard.

**A token bucket, not a fixed window** — a window permits a double-rate burst across its edge. State is
per process, and the resulting `limit × replicas` imprecision is accepted rather than fixed with Redis:
unlike per-replica conversation history it is a precision problem an operator corrects by dividing, and
the alternative puts a round trip and a fail-open policy on every request.

`Retry-After` is now set by the error handler from `retryAfterSeconds` — a field `RateLimitError` has
carried since Stage 1 with nothing ever using it. `ServiceUnavailableError` gained the same field, since
"come back later" is exactly what a 503 means.

Verified live: four requests against a limit of three → `200, 200, 200, 429` with `Retry-After: 10` and
`RateLimit-*` on every response; health polled five times unthrottled; a second concurrent stream refused
`429 scope: client`; and with the process ceiling at one, refused `503 scope: service`. A refusal costs
2–7ms and no gateway call.

### ✅ Stage 7d — Authentication

`@shopsage/session-token`: Magento mints a short-lived ES256 JWT, the widget carries it, and
ShopSage verifies it against a cached JWKS without calling Magento per request. The contract was
written, reviewed and **accepted** before any code
([Proposal 0001](proposals/0001-assistant-session-token.md)); the decision is recorded in
[ADR 0026](adr/0026-magento-issued-session-tokens.md).

**No JWT dependency.** Node's `crypto` verifies both supported algorithms natively — `ieee-p1363`
is exactly the raw signature encoding JWS specifies — and the security-critical part of a verifier is
algorithm pinning, which is worth owning in readable code. `jose` was the closest call in the stage
and is the right answer the moment JWE or a third algorithm is needed.

**The algorithm is pinned by configuration and never read from the token.** Choosing a verification
method from an attacker-supplied value is the classic JWT break. `HS256` is absent from the
implementation permanently: a symmetric key would let ShopSage mint tokens for customers.

**`sub` is a pseudonym.** ShopSage stores no customer identifier next to conversation history; a tool
needing identity will forward the token to Magento, which minted it. Verified: subjects appear in logs
as `ps_…` and no email address appears anywhere.

**Two key-store rules are security controls.** A refetch on an unknown `kid` is limited to one a
minute, or forged `kid`s make ShopSage a denial-of-service amplifier against the storefront; and a
failed refresh serves the **stale** set rather than discarding keys that still verify.

**Insufficient scope withholds a capability, it does not refuse a request** — the tool is absent and
the model says it cannot look that up. Rate limiting re-keyed from IP to the pseudonymous subject,
which cost one line because Stage 7c designed for it.

Verified against a stand-in issuer minting real ES256 tokens: valid → 200 with citations; expired →
`401 TOKEN_EXPIRED`; another store's `sid`, wrong audience and `alg: none` → 401 with graded log
severities; a guest → full answer; **no usable scope → 200 with `toolRounds: 0`** and an honest "I
cannot look that up". JWKS fetched twice across ten requests.

**One real leak, found by a test written for it:** the precise rejection reason was reaching the
client, because a 401 is an exposed error and the envelope publishes `details`. Now logged and
stripped, pinned by a test asserting the guarantee under `NODE_ENV=production`.

**Not done, and Stage 9's job:** nothing forwards the token to Magento yet, so the pseudonym design
does not pay off until a commerce tool needs identity.

### ✅ Stage 8 — Widget

`@shopsage/widget`: a native custom element in a shadow root, bundled by esbuild to **23 kB
minified with zero dependencies**, embeddable with one `<script>` tag. Plus `GET /v1/config`, the
browser-safe subset of a site profile and the only unauthenticated route under `/v1`. See
[ADR 0027](adr/0027-widget-as-a-custom-element.md).

**Untrusted text is rendered as DOM nodes, never through `innerHTML`.** The text comes from a
language model, so it is untrusted input in the same sense a form field is — and building nodes
makes injection structurally impossible rather than a sanitiser away. Link targets are checked
against an `http`/`https` allow-list; HTML inside a code fence is shown, not run. The test DOM
cannot parse HTML, deliberately, so reaching for `innerHTML` fails the suite rather than passing
against an implementation that ignores it.

**No markdown library and no framework.** `marked` plus `DOMPurify` would be two dependencies to
reach a subset of what is here, with the security property delegated rather than structural. Lit
would have saved perhaps a hundred lines and imposed a runtime on every host page.

**Markdown is re-rendered whole on every delta**, because markdown is not incrementally
parseable: `**bol` is literal asterisks until the closing pair arrives.

**Platform-independent by construction.** Nothing names Magento; everything store-specific
arrives from `GET /v1/config` at run time, and the only host-specific value is `token-url`.

Verified in a **real browser** over the DevTools protocol: element registered, shadow root
attached, config applied, a grounded answer streamed in with three citations, both status phases
shown, the conversation continued across a page reload, full-screen at 375px and back at desktop
width, host CSS overriding the store brand, and zero console errors.

**Three real defects, each found by looking at output rather than code:**

1. `GET /v1/config` published **unresolved placeholders** — a store writing
   `"Hi! I'm {{assistantName}}."` would have greeted customers with the braces.
2. **Theming precedence was inverted.** Brand colours were inline styles on the element, which
   beat any stylesheet, so the store's brand was unoverridable — the opposite of what the code
   claimed. Only visible in a browser.
3. **Closing the panel could lose focus entirely**, returning it to `document.body` when the
   panel had been opened programmatically.

Also fixed: the markdown link pattern stopped at the first `)`, breaking every Wikipedia-style
URL.

The widget has its own `tsconfig.json` and lint block, because adding the DOM library to the root
config would make `window` and `document` valid names in every backend package.

### Stage 9a — Commerce reads ✅

`@shopsage/magento-client` consuming the connector's `/assistant/v1` APIs, and four read tools:
`searchProducts`, `compareProducts`, `recommendProducts`, `trackOrder`.
[Proposal 0002](proposals/0002-commerce-connector-contract.md) is **accepted**, with the decisions in
its §0. Recorded as [ADR 0028](adr/0028-commerce-reads-behind-one-adapter.md). Resolves open decisions
4 and 5.

**Stage 9 was split**, and the reason is worth stating: the accepted propose → confirm → execute
workflow for cart mutations is not another tool. It needs a stored proposal, a confirmation endpoint,
an addition to the SSE event set and a widget affordance — a stage of its own rather than half of this
one. Reads are complete, including the personal-data redaction, which applies to every conversation
whether commerce is enabled or not.

**One port, reads only.** `CommerceCatalogue` with `searchProducts`, `findProduct` and `listOrders`.
Every wire field name lives in `magento-client/src/wire/` and nowhere else, so replacing the reference
connector with the real module is a configuration change and, at most, a change to that directory.

**The four tools arrived as four entries in `TOOL_FACTORIES` with no change to the conversation loop**,
which is the first real evidence for what [ADR 0022](adr/0022-bounded-tool-loop.md) claimed. What the
stage actually needed beyond them was the two things a table cannot express: the arithmetic rule and
the redaction.

**Comparison and recommendation logic lives in ShopSage** (decision 8). Magento exposes product data;
which three of ten products to offer is assistant behaviour, and "never recommend something they cannot
buy" is now a function with a test.

**Verified against a running reference connector**, not a mock — the real client, over real HTTP, with
a real model answering. Which is how the stage's most important finding surfaced.

**Four defects found by verification rather than by tests:**

1. `recommendProducts` **repeated the whole rules block once per product** — a third of the tool result
   restating itself. Only visible by reading a real result.
2. Term matching used substrings, so **"for" matched "reinforced"**: it inflated the ranking and told
   the customer a product matched "for". Now matched at word starts.
3. A reason read **"Chosen because it listed in stock"** — the fallback phrasing did not fit the
   sentence it was placed in.
4. The production Docker image had been **missing two workspace packages since Stage 7b**. The
   Dockerfile listed three manifests by hand and npm can only resolve a workspace whose `package.json`
   it can read, so `conversation-store` and `session-token` were simply absent — and `rag-backend` had
   never declared them as dependencies either, which npm's root hoisting hid completely in local
   development. Fixed in both places: the dependencies are declared, and the Dockerfile now copies
   every manifest by wildcard so the list cannot fall behind again.

**And the finding that matters most.** Asked _"which is cheaper and by how much"_, a real model
answered **"cheaper by £31.00"** with the no-arithmetic rule already in the system prompt and in the
tool result. Naming that exact phrasing fixed the three cases tested — a total, a difference, a
percentage — but the rule is a **mitigation, not a guarantee**, and the honest position is in
[ADR 0028](adr/0028-commerce-reads-behind-one-adapter.md). Closing it structurally means checking an
answer's monetary figures against what the tools returned, and on the streaming path the tokens are
delivered before such a check could run. That is a design problem, not a tightening.

### Stage 9b — Cart mutation, behind confirmation ✅

`addToCart` and `applyCoupon`, under the propose → confirm → execute workflow of decision 4. Recorded as
[ADR 0029](adr/0029-cart-changes-need-a-confirmed-proposal.md).

**The assistant cannot change a basket.** A tool prepares a `CartProposal`; `POST /v1/cart/confirm`
executes one. The model is out of the commit path as a property of **what it can reach** — `ToolContext`
carries the read port and nothing else, so there is no path from a tool to the write client. There is
deliberately no `POST /v1/cart/items` either: a client cannot ask for a basket change, only agree to one.

The pieces, and why this was its own stage rather than two more table entries:

- **A stored proposal**, with an owner, a ten-minute expiry and a summary **ShopSage** wrote from
  connector data. Consent to a sentence a model composed is not consent to what the button does.
- **A confirmation endpoint**, so the commit is an act by a customer rather than a side effect of prose.
- **A fourth SSE event**, plus `reply.proposal` for the buffered path.
- **The widget's first real affordance** — a card that disarms on the first click, re-checks expiry on
  click rather than trusting a timer, and renders the summary as text rather than markdown.
- **A separate write port and adapter** that does not import `withRetry`. The question Stage 9a left open,
  answered: apart, "a write is never retried" is structural; together, one plausible refactor makes it
  false with the whole suite green, because no test can observe a second charge.
- **Take-once consumption** — `GETDEL` in Redis — which is what makes a double-tapped button safe.

**Two defects that only a live stack could find:**

1. **Every prepared change was unconfirmable.** The chat routes never sent the session `subject`, so the
   domain fell back to the conversation id and the confirmation endpoint — which compares against
   `req.session.subject` — refused everything. 1049 tests green.
2. **A stranger holding a proposal id could destroy it.** Consumption precedes the ownership check, so a
   wrong-session attempt burned the proposal and left its owner unable to confirm. Found by running two
   sessions side by side; fixed by restoring the proposal on a subject mismatch, and only on that.

**`DEV_SESSION_SCOPES` arrived out of necessity.** With authentication off the synthetic session held
`chat` alone, so nobody could reach the cart or order paths without a real issuer. It is honoured only
where authentication is disabled, warns at boot when widened, and stays at the default in the committed
`.env.example`.

The shared JWT vectors gained `valid-cart`, which also caught a test asserting the vector set _exactly_
where the contract specifies a minimum.

### Stage 10 — Hardening and operations

The Roadmap had this as one stage covering nine separate things: CI, coverage gates, tracing, metrics,
retrieval evaluation, load testing, digest-pinned images, deployment manifests and a security review. It is
not one stage, and the ordering below is by what can be built and verified rather than by convention.

### Stage 10a — Metrics ✅

The gap that mattered most, stated precisely: **an assistant returning the store's no-answer message to
every question is indistinguishable from a healthy one if all you have is HTTP status codes.** Both are
`200`. Recorded as [ADR 0030](adr/0030-metrics-as-port-decorators.md).

`GET /metrics` in the Prometheus exposition format, emitted with **no dependency** — the same reasoning as
the logger, and the ninth stage running in which that choice has paid off. Not OpenTelemetry, which the
Roadmap named: its real advantage is distributed tracing across services, and this is one service.

**Instrumentation is decorators around the ports the domain declared**, applied in the composition root.
`assistant-core` imports nothing about metrics, no adapter carries a registry, and no existing test double
had to change. Two alternatives were considered and rejected in the ADR — instrumenting inside each adapter,
and deriving metrics from the log stream.

**Ordered before CI deliberately.** This repository has no commits and no remote, so a workflow file would
be a thing that cannot run against anything. Metrics could be built and verified today.

**The first live scrape found two things.** Three chat turns, every one a `200`, and the metrics said all
three were **ungrounded** with one retrieval **failure** behind them — the knowledge collection was not
ingested in that container. Readiness already said `knowledge-collection:down`; nothing had connected that
to the answers customers were getting.

It also turned Stage 7a's argument into a number: **2.5s to first token** on a 3.6s streamed turn, against
3.7s of a buffered turn showing nothing.

One design defect found while writing it: `LlmCompletion.usage` is required and the adapter normalises a
gateway that omits it to **zeroes**, so feeding it straight into a histogram would show a token
distribution sitting entirely at zero and read as "calls are free". Recording is skipped when the total is
zero, and the gap stays derivable from two metrics that then diverge.

Resolves the _measurement_ half of open decision 8. The alerting half is still open.

### Stage 10b — CI and coverage gating (next)

`npm run verify` is the intended gate and nothing runs it. Every defect in Stages 9a and 9b was found by
hand.

- A workflow running format, lint, typecheck and tests on every change.
- **Coverage measured and gated.** `npm run test:coverage` works and nothing enforces a threshold, so
  nobody knows where the suite is thin. Measuring it first, then choosing a floor from what it says — a
  number picked before measuring is a number that gets lowered.
- Dependency and image pinning: `npm ci` from the committed lockfile, and digest-pinned base images so a
  rebuild cannot silently change the runtime.

Needs a repository first, which is why it is second rather than first.

### Stage 10c — Retrieval evaluation

Deferred since Stage 5 and still the most valuable _product_ item. The scores in [RAG](RAG.md) come from
one hand-built five-sentence corpus: enough to show the ranking works and that intuition about thresholds
is wrong, nowhere near enough to tune anything.

A golden question set with expected sources, so prompt, chunking and threshold changes can be **measured**
rather than argued about. Stage 10a made the aggregate visible in production; this makes it measurable
before a deploy.

### Stage 10d — Deployment hardening and alerting

- **Alerting rules.** Metrics exist and nobody is told when they move. A falling grounded rate is now
  visible and still needs somebody to see it — this is the other half of open decision 8, along with a
  spend ceiling.
- Deployment manifests, load testing, and a security review pass.
- Contract tests against the real Magento module, once that repository exists.

## Beyond

Multi-store hosting (`SiteProfileProvider` resolving per request), recipe and wine-pairing tools,
analytics, reranking, hybrid dense/sparse retrieval, semantic caching, additional vector-store
adapters.

## Open decisions

These need a human answer. Several become expensive to change after the stage that depends on them.

| #   | Decision                                                                                         | Needed by           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Licence.** Currently `UNLICENSED` / `private`.                                                 | Before publishing   | The stated goal is a leading open-source Magento assistant, which implies Apache-2.0 or MIT. Apache-2.0 adds an explicit patent grant, which matters for corporate adoption. A business decision, so it is not being made in code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | ~~**Widget authentication.**~~ Resolved.                                                         | Stage 7d ✅         | Contract written, reviewed and accepted: [Proposal 0001](proposals/0001-assistant-session-token.md). Magento mints a short-lived ES256 JWT with a **pseudonymous** `sub`; ShopSage verifies against a cached JWKS, pins the algorithm, and never calls Magento per request. Guests get tokens too, which is what lets rate limiting key on a subject. Implemented in [ADR 0026](adr/0026-magento-issued-session-tokens.md).                                                                                                                                                                                                                                                                                                                                                                                                              |
| 3   | ~~**Conversation store.**~~ Resolved.                                                            | Stage 7b ✅         | Redis, behind the port the domain already declared. `CONVERSATION_STORE` must be set explicitly in production because neither value is safe to assume. Verified across two replicas. See [ADR 0024](adr/0024-durable-conversation-store.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 4   | **Magento connector repository.** Owner, name, API contract versioning.                          | Stage 9             | **Resolved for the contract, open for the repository.** [Proposal 0002](proposals/0002-commerce-connector-contract.md) is accepted and implemented on ShopSage's side (Stage 9a); its §0 records every decision. Two questions still need the module's author: the latency the module can commit to (question 6) and who owns the repository and cuts a contract version (question 7). Neither blocks ShopSage — the reference connector stands in — but both block real integration.                                                                                                                                                                                                                                                                                                                                                    |
| 5   | **PII and data retention.** Are customer messages stored, and for how long?                      | **Before Stage 9**  | **Resolved.** Conversation history must not persist addresses, payment details, email addresses or phone numbers. Implemented in `assistant-core/src/privacy/`: emails, Luhn-valid card numbers and structured phone numbers are removed from **both** sides of a turn at the moment of writing, and the response to the customer is untouched. `trackOrder` fetches only status, reference, delivery and tracking, and the `Order` type has no field for anything else — so the address problem is answered structurally rather than by detection, which is just as well, because free-text addresses are **not** reliably detectable and [ADR 0028](adr/0028-commerce-reads-behind-one-adapter.md) says so rather than implying otherwise. Retention period is unchanged: the Redis TTL from `conversation.sessionIdleTimeoutMinutes`. |
| 6   | ~~**LLM gateway details.**~~ Largely answered.                                                   | Stage 2 ✅ (partly) | An internal LiteLLM proxy serving `gpt-4o-mini` is verified end to end — tool calls, tool-result round trip, streaming, streamed tool-call reassembly, error mapping, credential containment. Bearer auth; `stream_options` accepted; `/v1` and bare paths both resolve. Measured 1.1–1.5 s for short answers, so `LLM_TIMEOUT_MS=60000` is headroom for a long answer rather than a typical wait — 30000 is defensible and left to an operator. Details in [Testing](Testing.md). **Still open:** the gateway's rate limits, and the cost ceiling (decision 8).                                                                                                                                                                                                                                                                         |
| 7   | ~~**Content sources per store.**~~ Mechanism built; per-store answers still needed.              | Stage 4 ✅ (partly) | `content.sources[]` in the site profile is the mechanism — seeds, sitemaps, include/exclude, classification, rate — and it is verified end to end against a real crawl. **Still open:** the actual URLs, sitemaps and refresh cadence for any real store, which are deployment data no amount of code answers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 8   | **Cost ceiling and alerting.** What is an acceptable spend, and who is told when it is exceeded? | **Half resolved**   | **Measurement exists** as of Stage 10a: `llm_tokens_total` by model and kind, `llm_tokens_per_call` as a distribution, and `dependency_calls_total` for every outbound call — so "what did we spend today" is now a query rather than a grep. **Still open:** the budget itself, the alert, and any per-conversation or per-ingestion cap. Nothing is told when a number moves, which is Stage 10d. Cheaper to decide before traffic than after an invoice.                                                                                                                                                                                                                                                                                                                                                                              |

## Deliberate deferrals

Not oversights — recorded so they are not re-litigated:

| Deferred                        | Until      | Why                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~Retry helper (`withRetry`)~~  | ✅ Stage 2 | Shipped, with the LLM client as its first caller — which is what let the retry predicate be written against real failure modes rather than guessed at.                                                                                                                                                                                                            |
| Overall LLM latency budget      | Stage 7d+  | **Trigger condition now met**: SSE makes latency visible to a customer in real time, and a streamed turn is up to four gateway rounds. Per-attempt timeouts plus no-retry-on-timeout still bound the realistic worst case, and a global deadline that cancels mid-flight produces failures nobody can attribute — so it is a 7b decision rather than an omission. |
| Semantic caching of completions | Stage 7c+  | Now worth doing — retrieval exists, and Stage 6 made a grounded answer cost two gateway calls instead of one, which doubles what a cache hit saves. Must be keyed by `siteId`. Deferred over streaming and rate limiting because it is an optimisation, not a gap.                                                                                                |
| Overall grounding enforcement   | Post-10    | Grounding is currently **observed** (a `grounded` flag, citations only when chunks were retrieved), not enforced. Enforcing it needs claim-level attribution of each sentence to a chunk — expensive, imperfect, and a research problem more than an engineering one. See [RAG](RAG.md#what-grounding-does-not-guarantee).                                        |
| Multi-store profile resolution  | Post-10    | The seams exist (`siteId` everywhere, single-function config load, `X-Site-Id` allowed by CORS). The machinery would be unused code today.                                                                                                                                                                                                                        |
| Reranking, hybrid retrieval     | Post-6     | Both are quality optimisations, and the golden-question harness that would prove they help now exists (Stage 5). Deferred until there is a real corpus and real questions to measure them against — a 7-question fake-site set is not that corpus.                                                                                                                |
| ~~Rate limiting~~ ✅ Stage 7c   | —          | Now overdue rather than premature: two LLM-backed endpoints exist and one holds a connection open per request, so 7b needs a concurrent-connection limit as well as a request-rate one. The proxy must provide both in the meantime.                                                                                                                              |
| GPU embeddings                  | Post-5     | CPU inference is adequate until ingestion volume proves otherwise. Now directly measurable: a real ingestion run's `durationMs` per source is in the CLI's own report.                                                                                                                                                                                            |
