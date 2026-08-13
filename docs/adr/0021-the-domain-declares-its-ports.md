# ADR 0021: The domain declares its ports, including retrieval as one port

Status: Accepted
Date: 2026-07-31
Stage: 6

## Context

Stage 6 is where the assistant becomes real: a question arrives, content is retrieved,
the model answers from it. Every prior stage built a piece of that — an LLM client, an
embeddings client, a vector repository, an ingestion pipeline — and each one is a
concrete adapter with a concrete dependency. Assembling them naively means
`assistant-core` importing `@shopsage/llm-client`, `@shopsage/embeddings-client` and
`@shopsage/vector-repository`, at which point the domain package that
[ADR 0003](0003-hexagonal-architecture.md) promised would be framework-free instead
depends on three network clients and cannot be exercised without any of them.

The pressing question was not _whether_ to invert those dependencies — the hexagonal
mandate settles that — but **how many ports retrieval should be**, and the shape is
not obvious. Retrieval is physically two calls: embed the question, then search the
vector store. Both clients already exist as packages. The path of least resistance is
for the domain to declare two ports it already has adapters for, `TextEmbedder` and
`VectorStore`, and orchestrate them itself.

A second question: the brief requires that "future memory must require zero API
changes", and Stage 6 has no persistent store. Conversation history has to exist in
the contract now while being backed by nothing durable.

## Decision

**`packages/assistant-core/src/types.js` declares the ports, and no adapter package
declares them.** The domain states what it needs; the outer layers satisfy it. The
dependency arrow points inward at every edge, and `assistant-core` has one runtime
dependency: `@shopsage/platform`, for errors, logging and the site-profile type.

**Retrieval is exactly one port, `KnowledgeRetriever`, with one method:**

```js
retrieve({ text, siteId, topK, minScore }) -> RetrievedChunk[]
```

The domain asks for content relevant to a question. It does not know that answering
that involves an embedding model, a vector index, a similarity metric, or a network
call at all. `createKnowledgeRetriever` in `rag-backend` composes
`embeddings.embedQuery` and `store.search` behind it.

This is the important half of the decision. Two ports would have leaked the retrieval
_mechanism_ into the domain — `assistant-core` would know that a question becomes a
vector, that a vector is searched, that a `minScore` is a cosine threshold. Replacing
vector search with a hybrid BM25 + vector retriever, adding a reranker, or putting a
cache in front would then all be domain changes. Behind one port they are adapter
changes and the domain does not move.

**Three further ports**, each for the same reason:

- `LanguageModel` — `generate(messages, options)`. Structurally the subset of
  `LlmClient` the domain uses. `stream()` is deliberately **absent**: nothing in the
  domain streams yet, and a port should describe what is needed, not what an adapter
  happens to offer.
- `ConversationStore` — `history()` and `append()`.
- `ToolContext` — what a tool executor is handed: `siteId`, `siteProfile`,
  `retriever`, an optional `logger` and `signal`.

**`assistant-core` may import _types_ from an adapter package, never a factory.**
`RetrievedChunk` is domain-owned, but `LlmMessage`, `LlmCompletion` and
`LlmToolDefinition` are imported from `@shopsage/llm-client`. This is the seam
[ADR 0011](0011-normalized-llm-contract.md) already sanctioned: that package's whole
purpose is to own one _normalized_, provider-neutral message contract, so restating it
in the domain would create two definitions of the same thing that must be kept in
lockstep by hand. JSDoc type imports are erased — they create no runtime dependency,
and `import type` of a factory function would still be a violation.

**`ConversationStore` ships with an in-memory implementation**, capped at 1000
conversations with LRU-style eviction, which warns at construction when
`NODE_ENV=production`. History exists in the contract from the first stage that has a
conversation; where it is _stored_ is an adapter swap. A Redis or Postgres store is a
new file satisfying the same two methods.

## Alternatives

**Two ports, `TextEmbedder` + `VectorStore`, orchestrated in the domain.** Rejected
above: it makes the domain know retrieval is vector-based. It also reads as the
_simpler_ option — each port maps 1:1 to a package that already exists — which is
exactly why it needed an explicit decision rather than a default. The test for a port
is not "does an adapter exist with this shape" but "is this the vocabulary of the
domain". "Retrieve knowledge for a question" is; "embed this text to 1536 floats" is
not.

**Ports declared in `platform`.** `platform` is the dependency everything already
shares, so interfaces there are visible everywhere. Rejected: it would make the ports
a _platform_ concern rather than a _domain_ one, and any package could then satisfy or
consume them. A port belongs to the layer that needs it, which is the whole point of
dependency inversion. `platform` holds things with no owner — errors, logging,
config; `KnowledgeRetriever` has an owner.

**`assistant-core` depends on the adapters directly, with interfaces later.** The
common "extract the interface when you need a second implementation" position. Rejected
because the second implementation arrives immediately and unavoidably: tests. A domain
that imports `@shopsage/llm-client` cannot have its tool loop tested without a gateway
or a mocking framework. `assistant-core`'s tests pass plain object literals and run in
milliseconds with no network and no `mock.module`.

**A `RetrievalService` port returning built context instead of chunks.** Would move
ranking and context assembly out of the domain. Rejected: how many excerpts to show,
how to diversify across sources, and how to cite are _product_ decisions about answer
quality, and they belong next to the prompt that consumes them, not in an adapter.

**Persist conversations in Qdrant to avoid the in-memory store.** Rejected: a vector
database is not a transcript store, and modelling turns as points with a fake vector
would be an abuse visible in every future query. The in-memory store is honest about
being temporary; a wrong-shaped persistent one would not be.

## Consequences

`assistant-core` has no `express`, no `fetch`, no Qdrant, no SDK, and its full test
suite runs offline against object literals. A test for "the model asked for a tool that
does not exist" is four lines.

The domain cannot be run by itself — something must supply four ports — which is
`build-application.js`'s job, and that file is now the single place where the shape of
the system is visible. That is intentional: composition being explicit and located in
one file is what lets the readiness probes, the tool registry and the store all be
wired consistently.

`minScore` crosses the port as a number the domain chooses, and
[ADR 0018](0018-embeddings-backend-is-configuration.md) established that similarity
scores do **not** transfer between embedding models. The port therefore carries a value
whose meaning depends on which adapter is behind it. This is a genuine leak and it is
accepted for now because the alternative — a normalized `relevance` the adapter
calibrates per model — needs per-model calibration data the project does not yet have.
`RETRIEVAL_MIN_SCORE` is environment configuration for precisely this reason, and the
constraint is documented in `docs/RAG.md`.

The in-memory store means two backend replicas answer the same conversation with
different history, and a deploy erases every in-flight conversation. Acceptable at one
replica; the production warning fires so this cannot be shipped by accident, and
`docs/Roadmap.md` carries it as the Stage 8 obligation.
