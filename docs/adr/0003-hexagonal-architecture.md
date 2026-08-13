# ADR 0003: Hexagonal architecture with a framework-free core

Status: Accepted
Date: 2026-07-30
Stage: 1

## Context

The roadmap promises several substitutions: replaceable vector databases, any OpenAI-compatible LLM
gateway, multiple content sources, multiple Magento stores, and a conversation store that starts simple
and becomes durable. It also promises a long life — this is meant to become a leading open-source
Magento assistant, which means outliving several vendor choices.

Each of those substitutions is cheap or ruinous depending on one thing: whether the business logic
learned the vendor's name.

There is also a testing problem. The centre of this system calls an LLM, and an LLM is
non-deterministic. If retrieval, context assembly, prompt construction and ranking are only reachable
through an HTTP handler that ends at a model, none of them can be tested precisely.

## Decision

Ports and adapters, with one direction of dependency.

- `assistant-core` holds the domain and imports nothing but `@shopsage/platform`. No Express, no
  Qdrant, no LLM SDK, nothing Magento.
- It declares what it needs as **ports** — JSDoc-typed interfaces.
- Adapters implement the ports: `rag-backend` inbound; `llm-client`, `embeddings-client`,
  `vector-repository`, `magento-client` outbound.
- Each entry point has exactly one **composition root** that constructs concrete implementations and
  injects them. In the backend that is `src/composition/build-application.js`, the only file permitted
  to read `process.env`.

Every collaborator arrives as an argument. No module reaches for a singleton, a global, or a
module-level client.

## Alternatives

**Layered architecture with direct dependencies.** Familiar, and fewer files. Rejected because a
service that imports a Qdrant client has hard-coded the vector store into the business logic; swapping
it becomes a search-and-replace across the layer that should have been indifferent.

**A framework's DI container.** Decorators, automatic resolution, less wiring code. Rejected as
disproportionate: with a handful of dependencies, explicit construction in one file is shorter than the
configuration a container needs, and it is greppable — you can read the entire dependency graph top to
bottom without knowing a framework's resolution rules.

**Service locator.** A registry any module can query. Rejected because it hides dependencies: a
module's real requirements no longer appear in its signature, which is exactly the property that makes
unit tests easy to write and coupling easy to spot.

## Consequences

Easy: substituting an adapter is a one-file change in the composition root. Domain logic is testable
without HTTP, network, or a model. Dependencies are visible in signatures. Tests need no global reset,
because there is no global state.

Hard: more indirection, and more files than a direct-call design. A newcomer tracing a call has to look
up which implementation was injected. Ports must be defined before they are needed, which occasionally
means designing an interface with one implementation in hand — and a port designed against a single
adapter tends to leak that adapter's assumptions, so the second implementation is where the design is
really tested.

Accepted: the discipline is worth nothing if it is partially applied. One direct `import` of a vendor
SDK into `assistant-core` reintroduces the coupling the whole structure exists to prevent, so that is a
review blocker rather than a style note.
