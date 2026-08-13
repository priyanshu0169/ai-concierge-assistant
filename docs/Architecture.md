# Architecture

## Purpose

ShopSage is a reusable AI commerce platform. Its central architectural constraint is that **the same
build must serve any Magento store**. Every design decision below follows from that: anything that
differs between two stores is data, and anything that differs between two vendors is an adapter.

## The shape: ports and adapters

The system is a hexagonal (ports-and-adapters) architecture with one direction of dependency.

```
                    ┌─────────────────────────────────────────┐
 inbound adapters   │             assistant-core              │   ports it declares
                    │                                         │
 rag-backend ──────▶│  conversation manager                   │──▶ LanguageModel
 (HTTP/REST)        │  tool loop  ·  tool registry            │──▶ KnowledgeRetriever
                    │  ranking  ·  context builder            │──▶ ConversationStore
 ingestion CLI      │  prompt builder  ·  answer formatter    │──▶ MagentoClient (Stage 9)
 (does not use it)  └─────────────────────────────────────────┘
                                       ▲
                                       │ depends on nothing but @shopsage/platform

            who satisfies them, in build-application.js:

  LanguageModel        ◀── llm-client
  KnowledgeRetriever   ◀── rag-backend  ◀── embeddings-client + vector-repository
  ConversationStore    ◀── in-memory (assistant-core) │ conversation-store (Redis)
                           chosen by CONVERSATION_STORE, no domain code involved
```

**The dependency rule:** `assistant-core` may not import Express, Qdrant, an LLM SDK, or anything
Magento. It declares what it needs as a port — a JSDoc-typed interface in `src/types.js` — and the
composition root in `rag-backend` supplies a concrete implementation.

Note what is **not** a port. There is no `EmbeddingsClient` port and no `VectorRepository` port, even
though both packages exist and both are used on every grounded answer. They sit _behind_
`KnowledgeRetriever`, one level further out, because a domain that declared them would know retrieval is
vector search — and could then no longer be given a hybrid or reranked retriever without changing the
domain. [ADR 0021](adr/0021-the-domain-declares-its-ports.md) covers why the obvious two-port design was
rejected.

Why this matters concretely: the vision includes swapping vector databases, running behind different
LLM gateways, and serving multiple stores. Each of those is a change of adapter or of data, not a
change of business logic — provided the business logic never learned the adapter's name.

## Layers

| Layer                | Packages                                                                                                        | May depend on         |
| -------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------- |
| Cross-cutting kernel | `platform`                                                                                                      | nothing               |
| Contracts            | `content-model`                                                                                                 | `platform`            |
| Domain               | `assistant-core`                                                                                                | `platform`, contracts |
| Outbound adapters    | `llm-client`, `embeddings-client`, `vector-repository`, `conversation-store`, `session-token`, `magento-client` | `platform`            |
| Content sources      | `scraper`                                                                                                       | `platform`, contracts |
| Inbound adapters     | `rag-backend`, `ingestion`                                                                                      | all of the above      |
| Presentation         | `widget`                                                                                                        | nothing (HTTP only)   |

Three rules make this enforceable by review:

1. **`platform` never learns the domain.** It holds logging, errors, configuration and async
   primitives. If a change to `platform` mentions products, retrieval or prompts, it belongs
   elsewhere. Without this rule a "shared" package becomes the place every coupling hides.
2. **Adapters never call each other.** `llm-client` does not know `vector-repository` exists.
   Composition happens in exactly one file per entry point.
3. **A port shared by a producer and a consumer belongs to neither.** `content-model` holds the
   `ContentSource` contract because both `scraper` and `ingestion` need it: pointing the dependency
   either way would claim the pipeline is downstream of crawling, or that a crawler is downstream of
   the pipeline it feeds. Neither is true, and either would drag one package's dependencies into the
   other. A contracts package stays free of implementation — if one arrives, this rule has been broken.

## Package responsibilities

### `platform` — cross-cutting kernel

Structured logging with guaranteed secret redaction, the error taxonomy every layer throws from,
configuration loading and validation, timeout/cancellation and retry primitives, and the outbound HTTP
mechanics every adapter shares.

That last item — `sendRequest` and `readJsonBody` — was extracted once there were three callers, not
before. It carries the mechanics all of them need (cancel on timeout, classify a transport failure as a
retryable `UpstreamError`) and **none of the semantics any of them differ on**: it deliberately does not
interpret a status code, because what a 409 or a 422 means is vendor knowledge that belongs in the
adapter. That split is what keeps it legitimate under the rule below.

This package is an addition to the originally specified package list. Rationale in
[ADR 0009](adr/0009-platform-package.md): a logger and an error taxonomy are needed by every other
package, and with no home they accumulate inside `assistant-core`, which is precisely the package
that must stay pure.

### `assistant-core` — the domain ✅

Conversation management, retrieval orchestration, context building, prompt building, tool registry,
source ranking, answer formatting. Contains no HTTP, no framework, no Magento, no vendor SDK, and no
`fetch` — its only runtime dependency is `platform`.

Each responsibility is a separate unit with one job. The reason is testability under a
non-deterministic dependency: an LLM makes end-to-end assertions weak, so the deterministic parts —
what got retrieved, how context was truncated, how the prompt was assembled, how sources were
ranked — must be independently testable without a model in the loop.

**`src/types.js` is the architecturally significant file.** The domain declares the ports it needs and
the outer layers satisfy them, so the dependency arrow points inward at every edge
([ADR 0021](adr/0021-the-domain-declares-its-ports.md)):

| Port                 | Surface                                             | Satisfied by                                        |
| -------------------- | --------------------------------------------------- | --------------------------------------------------- |
| `LanguageModel`      | `generate()`, `stream()`                            | `llm-client`, structurally                          |
| `KnowledgeRetriever` | `retrieve({ text, siteId, … })`                     | `rag-backend`'s `createKnowledgeRetriever`          |
| `ConversationStore`  | `history()`, `append()`                             | in-memory here, **or** `conversation-store` (Redis) |
| `CommerceCatalogue`  | `searchProducts()`, `findProduct()`, `listOrders()` | `magento-client`                                    |
| `CommerceCart`       | `addToCart()`, `applyCoupon()`                      | `magento-client`, a **separate** factory            |
| `CartProposalStore`  | `save()`, `consume()`                               | in-memory here, **or** `conversation-store` (Redis) |
| `ToolContext`        | what a tool executor is handed                      | the conversation manager, per turn                  |

`ConversationStore` is the port that has since gained a **second** implementation, which is the test a
port is really for. Adding Redis in Stage 7b changed no domain code: the conversation manager, the tool
loop and the routes never learn which side of the choice they got, and which one runs is a deployment
decision ([ADR 0024](adr/0024-durable-conversation-store.md)).

`CommerceCatalogue` is the same shape of decision, taken again in Stage 9a. The domain asks for
commerce facts and is never told a Magento module is answering, so every wire field name from
[Proposal 0002](proposals/0002-commerce-connector-contract.md) lives in `magento-client/src/wire/`
and nowhere else. It carries **read methods only**: cart mutation follows a propose → confirm →
execute workflow whose failure policy is genuinely different — a failed read is worth retrying, a
failed "add to basket" is not — so whether it joins this port or gets its own is a live question for
Stage 9b ([ADR 0028](adr/0028-commerce-reads-behind-one-adapter.md)).

Its `credential` parameter is worth noticing: the customer's session token, forwarded and **never
interpreted**. The subject is a pseudonym by agreement, so the connector resolves identity because it
minted the token. The domain does not parse it, branch on it, or log it.

`CommerceCart` is the answer to the question Stage 9a left open, and separation won for a reason that
outlived tidiness: the read adapter wraps every call in a retry and a mutation must never be retried.
Apart, that is structural — `create-magento-cart.js` does not import `withRetry`, and a test asserts it.
Together, one plausible refactor makes the rule false with the whole suite green, because no test can
observe a second charge.

`CartProposalStore` is where a prepared-but-unconfirmed cart change waits. Its one interesting property
is that `consume` is **take-once and atomic** — `GETDEL` in Redis, a single `Map` delete in memory —
which is what makes a double-tapped confirm button safe. A `get` followed by a `delete` is a race with a
basket on the other end of it, and the window is exactly as wide as a customer tapping twice
([ADR 0029](adr/0029-cart-changes-need-a-confirmed-proposal.md)).

`KnowledgeRetriever` being **one** port rather than a `TextEmbedder` plus a `VectorStore` is the
decision that matters. The domain asks for content relevant to a question; it never learns that
answering involves an embedding model, a vector index or a network call. Swapping in hybrid search or a
reranker is an adapter change, not a domain change.

The domain may import **types** from an adapter (`LlmMessage`, `LlmCompletion` from `llm-client`) but
never a factory function. That seam is sanctioned by [ADR 0011](adr/0011-normalized-llm-contract.md):
restating a contract whose entire purpose is to be provider-neutral would create two definitions to
keep in lockstep by hand. JSDoc type imports are erased and create no runtime dependency.

`stream()` joined `LanguageModel` in Stage 7a, having been deliberately absent until something in the
domain needed it. The conversation manager gained a second way out — `answerStream()` — rather than a
second implementation: **one tool loop serves both**, parameterized by how a round is fetched
([ADR 0023](adr/0023-streaming-delivery-over-sse.md)). A test asserts the two modes produce the same
answer and citations for the same scenario, which is what stops two delivery paths becoming two
products.

### `rag-backend` — HTTP delivery

REST endpoints, request validation, sessions, authentication, rate limiting, health, and the
**composition root**. Delegates all decisions to `assistant-core`. A handler should read as: parse
input, call a use case, serialize the result.

`build-application.js` is the only file permitted to read `process.env` or construct dependencies.
Everything else receives what it needs as an argument, which is what makes the tree unit-testable
without global state.

It is also where required configuration is enforced. `composition/llm-options.js` maps the environment
onto the LLM client's options and refuses to produce them if the gateway is not configured, so the
backend cannot boot without a model. The shared environment schema keeps `LLM_*` optional because the
scraper and ingestion CLI never call one — see [ADR 0013](adr/0013-required-config-per-entry-point.md).

**`src/chat/` is gone.** Stage 2 put a labelled transitional slice there — build messages, call the
gateway, shape a reply — on the explicit promise that Stage 6 would delete it once `assistant-core`
existed. That promise was kept: the directory is deleted and the route now delegates to
`assistant.answer()`. The HTTP contract did not change, which was the point of putting the slice
behind a final contract in the first place.

What remains here of the chat path is genuinely delivery-layer: `http/chat-request-schema.js`
(validation) and `retrieval/create-knowledge-retriever.js` (the adapter satisfying the domain's
`KnowledgeRetriever` port by composing `embeddings.embedQuery` with `store.search`, and mapping the
Qdrant payload back through `PAYLOAD_KEYS` from `ingestion` — the one place that knows the storage
shape).

### `llm-client` — the only LLM-aware package ✅

Talks to any OpenAI-compatible endpoint: an internal AI gateway, Azure OpenAI, LiteLLM, OpenRouter,
vLLM, or OpenAI itself. Owns retries, timeouts, rate-limit handling, and response normalization.

Public surface is `generate()` and `stream()`. **No other package knows which provider, model, or
base URL is in use** — not even that a gateway exists. See
[ADR 0005](adr/0005-openai-compatible-llm-gateway.md).

The package is organised so that the wire format is confined to one directory:

| Directory        | Holds                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| `src/*.js`       | The port, its contract (`types.js`), the call paths, the retry predicate |
| `src/wire/`      | Request building, response parsing, SSE decoding, fragment reassembly    |
| `src/transport/` | Authenticated HTTP, error mapping, upstream-body sanitizing              |

Two rules keep the boundary honest. `types.js` mentions no provider, model, endpoint or HTTP concept —
it is the whole surface other packages may depend on. And the completion deliberately carries **no
model identifier**: cost accounting is the only legitimate reason to want one, so this package logs the
model with the token counts and nobody else needs it. See
[ADR 0011](adr/0011-normalized-llm-contract.md).

### `embeddings-client` — embedding generation ✅

`embedQuery()` and `embedDocuments()` against **either** an OpenAI-compatible endpoint (typically the
same gateway that serves the LLM, with the same credential) **or** a self-hosted HuggingFace TEI
service. Chosen by `EMBEDDING_PROVIDER`; the port is identical either way and nothing above the package
can tell which answered. See [ADR 0018](adr/0018-embeddings-backend-is-configuration.md).

A provider supplies only the four things that genuinely differ — request shape, response extraction,
status semantics, health probe. Batching, ordering, validation, the dimension guard, retries and
logging sit above the seam and are shared, so a new backend inherits them rather than reimplementing
them slightly differently.

The asymmetry between the two methods is deliberate: query embedding is latency critical and
single-item, document embedding is throughput critical and batched. Batches run **sequentially**
whichever backend is configured — a self-hosted service runs one model on CPU and parallel requests just
queue inside it, while a gateway is rate-limited per key and a burst is the fastest way to find that
limit.

Two correctness guards, both cheap and both catching failures that are otherwise silent:

- **Every response is checked against the configured dimension count.** A vector of the wrong width
  belongs to a different model, and mixed vector spaces produce similarity scores that look plausible
  and mean nothing.
- **`health()` fails if the service reports a different model than configured.** See
  [ADR 0014](adr/0014-clients-own-their-readiness.md).

### `vector-repository` — vector storage behind a port ✅

`createCollection()`, `insert()`, `search()`, `list()`, `delete()`, `collectionExists()`, `count()`,
plus `health()`. Qdrant is an implementation detail that must not leak: no caller sees a Qdrant filter
object, point struct, id format or client instance. See
[ADR 0006](adr/0006-vector-repository-port.md).

`list()` was added in Stage 5, for `ingestion` to ask "what do I already hold for this document?"
without a query vector — the question idempotent re-ingestion is built on. It never returns vectors:
callers enumerating state do not need them, and a page of them at real embedding widths would dominate
the response for no benefit.

Two rules are enforced in code rather than documented, because both are correctness:

- **`siteId` is a required top-level field** on `search()` and on every stored payload — not an
  optional filter entry. Tenancy cannot be forgotten if it cannot be omitted, and a missing tenant
  filter is one store's assistant answering from another store's content.
- **A filtered delete requires `siteId`**, so one omitted field cannot turn "remove this store's stale
  content" into "remove everything". A vector store has no undo.

Callers use any string as a point id — a content hash is the expected choice — and the adapter derives
the UUID Qdrant demands, deterministically. See [ADR 0015](adr/0015-caller-owned-point-ids.md).

### `conversation-store` — durable history behind a port ✅

Redis behind the domain's `ConversationStore`. The same shape as `vector-repository`: it satisfies a port
the domain declared, and nothing above it mentions Redis, a key format or a TTL. It adds `health()` and
`close()` beyond the port — readiness and shutdown are the composition root's business, and it knows the
concrete type, so the port stays as narrow as the domain needs.

The one non-obvious property is that **`siteId` is in the Redis key**, not in the stored value. Two
stores cannot read each other's conversations because there is no key that would let them, rather than
because a filter was applied — arrived at independently, and the same reasoning as
[ADR 0006](adr/0006-vector-repository-port.md)'s tenancy.

Reads are defensive: an entry that does not decode is skipped and counted, not thrown. A shared datastore
outlives any one release, so a running instance reads what a previous version wrote, and one malformed
entry must not break a conversation permanently.

Every operation carries its own deadline. That is not decoration — see
[ADR 0024](adr/0024-durable-conversation-store.md) for the outage it was written after.

### `session-token` — verifies, never issues ✅

Verification of the Magento-issued session token. **Holds public keys only**: Magento is the sole
issuer and sole holder of a private key, so a compromise of this process yields nothing that could
mint a token for a customer. That asymmetry is why `HS256` is absent from the implementation rather
than merely discouraged — a symmetric key would make ShopSage an identity provider by accident.

| File                       | Responsibility                                                       |
| -------------------------- | -------------------------------------------------------------------- |
| `decode.js`                | Splits the token, and **cannot inspect a claim** — so it cannot peek |
| `verify-signature.js`      | Performs the **configured** algorithm, never the token's             |
| `verify-token.js`          | The contract's ordered checks; returns a session                     |
| `jwks/create-key-store.js` | The only part doing I/O: cache, bounded refetch, serve stale         |

The pinning in `verify-signature.js` is the single most important line in the package. Choosing a
verification method from a value the attacker supplies is the classic JWT break, so the module exposes
an allow-list of _implementations_ and the header is only ever compared against the configured value.

No JWT dependency: Node's `crypto` verifies both algorithms natively, and `ieee-p1363` is exactly the
raw signature encoding JWS specifies. See
[ADR 0026](adr/0026-magento-issued-session-tokens.md), and
[Proposal 0001](proposals/0001-assistant-session-token.md) for the agreed contract.

### `rag-backend`'s `observability/` — counting without touching the domain ✅

Metrics are **decorators around the ports the domain declared**, applied in the composition root. That is
this arrangement paying a dividend which was not the reason for it: `assistant-core` imports nothing about
metrics, no adapter carries a registry, and no existing test double had to change.

| File                      | Responsibility                                                             |
| ------------------------- | -------------------------------------------------------------------------- |
| `create-instruments.js`   | Every metric this service emits, declared in one place                     |
| `instrument-ports.js`     | Decorators for the model, retrieval, the stores and the connectors         |
| `instrument-assistant.js` | The **quality** signal: grounded, ungrounded, no-answer, failed, abandoned |

`create-instruments.js` is one file on purpose. A reader asking "what can I see about this service?" gets
an answer in one place, and a reviewer asking "does anything here have unbounded cardinality?" can check it
in one pass.

Two alternatives were rejected and both are worth knowing about. Instrumenting **inside each adapter**
would put a metrics dependency into six packages and make every one of their test doubles carry it.
Deriving metrics **from the log stream** needs no plumbing at all and permanently couples metric names to
log message strings, so rewording a log line silently breaks a dashboard. See
[ADR 0030](adr/0030-metrics-as-port-decorators.md).

### `magento-client` — the commerce connector ✅

Reads from the store's commerce connector, behind the domain's `CommerceCatalogue` port. **HTTP only,
never a Magento library**: the module lives in a separate repository and this consumes the contract in
[Proposal 0002](proposals/0002-commerce-connector-contract.md).

| File                       | Responsibility                                                |
| -------------------------- | ------------------------------------------------------------- |
| `wire/to-product.js`       | The **only** file that knows the contract's field names       |
| `wire/to-cart-outcome.js`  | The cart's reply. `applied` defaults to **false**, never true |
| `create-magento-client.js` | Reads. Transport: headers, retry, 404-means-absent            |
| `create-magento-cart.js`   | Writes. **Imports no retry helper**, and that is the point    |
| `reference/server.js`      | A runnable specification of the contract. Development only    |
| `reference/catalogue.json` | Eight fictional products, three categories, two orders        |

`wire/to-product.js` is the file that makes the arrangement worth having: replacing the reference
connector with the real Magento module should touch this directory and the configuration, and nothing
above them. Its mapping is **defensive rather than trusting** — an unrecognised field, a null where the
contract said optional, an availability value nobody agreed on, all become absent rather than throwing.
A connector that adds a field must not take the assistant down.

Three transport decisions are contract terms rather than preferences. **Only reads exist**, so "writes
never retry" is enforced by there being no write method. **The status is judged inside the retry**,
because `sendRequest` resolves for a 503 rather than throwing — a retry wrapped around the request
alone would retry a dropped connection and not a connector asking to be tried again. And **a 404 on a
single product returns `undefined`**, because "we do not sell that" is an answer rather than a failure.

The reference connector reads a token's subject **without verifying the signature**. Correct for a
stand-in — verifying would need the private key, which would make it a second issuer — and
catastrophic anywhere real, which is why it sits behind a Compose profile bound to loopback. See
[ADR 0028](adr/0028-commerce-reads-behind-one-adapter.md).

### `content-model` — the acquisition contract ✅

The `ContentSource` port and the canonical `Document`. **No implementation**, and that is the point:
the scraper produces documents and `ingestion` consumes them, so if the contract lived in either, the
other would have to depend on it — and a pipeline that needs an HTML parser to define its input type is
already coupled to crawling.

Every source builds its output through `createDocument()`, which derives a stable id, hashes the
content, and normalizes the text. A source assembling that object itself would eventually differ in
whitespace handling or id scheme, and each difference surfaces later as duplicate vector points or as
content that re-embeds on every run. See [ADR 0016](adr/0016-content-source-port-and-canonical-document.md).

### `scraper` — content acquisition ✅

CMS pages, buying guides, FAQs, blog posts, policies. **Not products.** Products come from the
Magento API, which is authoritative for price and stock; scraping them would produce a cache that is
silently wrong the moment a price changes — and wrong prices are the most damaging error this system
can make.

One implementation of `ContentSource`, not a special case. Every behavioural decision — seeds, sitemaps,
include and exclude patterns, depth, page ceiling, rate, per-path classification — comes from a site
profile, so **no path, host or store name appears in this package**. Robots-aware by default, and a
site's own `Crawl-delay` overrides the configured rate when it asks for less.
See [ADR 0017](adr/0017-crawl-behaviour-is-site-profile-data.md).

It carries two dependencies the rest of the backend does not, each behind one file and each earning
its place for the same reason: nobody should hand-roll either. An HTML parser (`linkedom`, chosen over
a smaller one for its browser-grade error recovery on real, often malformed, production markup —
extracting text with regular expressions means shipping navigation and footer copy into every chunk,
which degrades retrieval with no error and no obvious cause; see
[ADR 0032](adr/0032-linkedom-instead-of-node-html-parser.md)). And `undici` — the crawler's default
transport raises Undici's response-header ceiling above the 16 KiB a real production storefront's
session, consent and tracking cookies routinely exceed, scoped to the crawler's own requests and
nothing else in the process. See [ADR 0031](adr/0031-crawler-scoped-header-size.md).

### `ingestion` — the pipeline ✅

Chunk → embed → store, plus idempotent re-ingestion and a golden-question evaluation harness.
Consumes any `ContentSource`; knows nothing about how its documents were acquired.

Chunking is **structure-aware**, cutting at headings first, paragraphs second, sentences third, and
only then at an arbitrary character offset — each step down that list is a worse seam, reached as
rarely as possible. It is measured in **characters, not tokens**, deliberately: the default embedding
backend (Stage 4) is a hosted gateway that publishes no token limit to size against, and a
token-based design would need a tokenizer dependency specific to one model family. See
[ADR 0020](adr/0020-structure-aware-chunking.md).

Re-ingestion is cheap because it asks the store what it already holds — via `VectorRepository.list()`,
added this stage — and embeds only chunks whose content hash changed. Whole-document deletion is a
separate, guarded step: it refuses to run at all when the crawl had failures or covered too little of
what is already stored, because "documents not seen this run" and "documents that no longer exist" are
only the same thing when the run was complete. See
[ADR 0019](adr/0019-content-hash-idempotent-ingestion.md).

The evaluation harness (`ingestion/src/cli/evaluate.js`) measures retrieval against a golden question
set with **no LLM in the loop** — a non-deterministic step in the loop would make a regression
impossible to attribute. Two metrics: recall at K, and refusal accuracy on questions the corpus
genuinely cannot answer, which is the direct measure of hallucination resistance.

### `widget` — presentation ✅

A native custom element in a shadow root, bundled to **23 kB minified with zero dependencies** and
embeddable with one `<script>` tag. The shadow boundary is the requirement: a storefront's CSS
cannot reach in, the widget's cannot leak out, and no framework runtime is imposed on a page that
already has one.

It is the only package that does not depend on `platform`, and it depends on nothing at all — the
layering table above says "HTTP only" and means it literally. It consumes three public endpoints
and contains **no business logic**: no prompt, no retrieval, no judgement about whether an answer
was grounded.

The decision the rest of it is arranged around: **a model's answer is rendered as DOM nodes, never
through `innerHTML`**. That text is untrusted input in the same sense a form field is, and building
nodes makes injection structurally impossible rather than a sanitiser away. Even the static shell
uses `createElement`, so the safe habit has no exception for somebody to widen later. See
[ADR 0027](adr/0027-widget-as-a-custom-element.md) and [Widget](Widget.md).

## Magento boundary

Magento business logic lives in a **separate repository** as a Magento 2 module. ShopSage consumes
HTTP only:

```
GET  /assistant/products      POST /assistant/cart
GET  /assistant/categories    POST /assistant/coupon
GET  /assistant/orders
```

This boundary is not stylistic. Magento upgrades, PHP versions and store customisations move on a
completely different cycle from an AI assistant; coupling the two would mean a Magento patch release
can break the assistant, and an assistant deployment needs a Magento maintenance window. Keeping the
contract to HTTP also means one ShopSage deployment can serve several Magento versions at once.

**The widget never holds a Magento API token**, and as of Stage 7d it does not hold a customer's
identity either. The Magento module issues a short-lived signed token to the storefront; the widget
carries it; ShopSage verifies it against a cached key set. Its subject is a **pseudonym**, so when a
Stage 9 tool needs to know who the customer is, ShopSage forwards the token back to Magento — which
minted it and can resolve it — rather than storing an identifier itself. Contract in
[Proposal 0001](proposals/0001-assistant-session-token.md), decision in
[ADR 0026](adr/0026-magento-issued-session-tokens.md).

## Configuration-driven behaviour

| Concern                                        | Lives in                   |
| ---------------------------------------------- | -------------------------- |
| Company name, assistant name, support contacts | site profile               |
| System prompt, welcome/fallback copy           | site profile               |
| Branding colours, launcher position            | site profile               |
| Which capabilities are enabled                 | site profile feature flags |
| Retrieval tuning (`topK`, `minScore`)          | site profile               |
| Service addresses, credentials, timeouts       | environment                |

Every capability ships behind a flag that defaults to **off**, so adding a tool to the platform
cannot change an existing store's behaviour until its profile opts in.

## Multi-store readiness

Multiple Magento stores are on the roadmap, and retrofitting tenancy is expensive. Stage 1 therefore
establishes the seams now, without building the machinery:

- Every site profile carries a `siteId`, and it is bound into every log record.
- `loadConfig()` resolves one profile today; the call site is a single function that a
  `SiteProfileProvider` port can replace with per-request resolution.
- The CORS allow-list already accepts an `X-Site-Id` request header.
- Vector tenancy is decided in advance: a shared collection with a `siteId` payload filter, not a
  collection per store. See [ADR 0006](adr/0006-vector-repository-port.md).

## Tooling architecture

The system is built around tool calling from Stage 1, even though the first tool is the only tool.

```
user message → assistant-core → tool registry → searchKnowledge() → retrieval → LLM
```

Retrofitting tool calling later would mean rewriting the conversation loop, because a tool-calling
loop is multi-turn by nature — the model may request a tool, receive a result, and continue. Systems
that start with a single-shot "retrieve then answer" flow get rebuilt when the second capability
arrives. Planned tools: `searchProducts`, `compareProducts`, `recommendProducts`, `trackOrder`,
`addToCart`, `applyCoupon`, `recommendRecipes`, `recommendWine`.

## Enforced coding standard

The standard is machine-checked, not aspirational — see `eslint.config.js`:

| Rule                     | Limit | Intent                               |
| ------------------------ | ----- | ------------------------------------ |
| `max-lines`              | 250   | Files stay readable in one sitting   |
| `max-lines-per-function` | 60    | Functions do one thing               |
| `complexity`             | 10    | Branching stays testable             |
| `max-depth`              | 3     | No deeply nested control flow        |
| `max-params`             | 3     | Options objects over positional args |

Express middleware has a scoped exception for the framework's 4-parameter error handlers and its
`req`-decoration idiom; the exception is confined to one directory.
