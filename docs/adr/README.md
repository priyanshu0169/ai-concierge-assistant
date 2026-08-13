# Architecture Decision Records

Each ADR captures one decision: the forces at play, what was chosen, what was rejected and why, and
the consequences accepted.

The value is in the rejected alternatives. Code shows what was built; only an ADR shows what was
considered and discarded, which is what stops a future team from re-litigating a settled question — or
from quietly reversing it without knowing what it was protecting.

## Format

```
# ADR NNNN: Title

Status: Proposed | Accepted | Superseded by ADR NNNN
Date: YYYY-MM-DD
Stage: N

## Context      the forces, constraints and requirements
## Decision     what we are doing
## Alternatives what we rejected, and why
## Consequences what this makes easy, what it makes hard, what we accept
```

## Index

| ADR                                                        | Title                                                                    | Status   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ | -------- |
| [0001](0001-monorepo-with-npm-workspaces.md)               | Monorepo with npm workspaces                                             | Accepted |
| [0002](0002-javascript-with-jsdoc-type-checking.md)        | JavaScript with JSDoc, type-checked by TypeScript                        | Accepted |
| [0003](0003-hexagonal-architecture.md)                     | Hexagonal architecture with a framework-free core                        | Accepted |
| [0004](0004-configuration-boundary.md)                     | Configuration boundary: environment versus site profile                  | Accepted |
| [0005](0005-openai-compatible-llm-gateway.md)              | One package owns LLM access, via an OpenAI-compatible gateway            | Accepted |
| [0006](0006-vector-repository-port.md)                     | Qdrant behind a VectorRepository port, payload-based tenancy             | Accepted |
| [0007](0007-dependency-free-structured-logging.md)         | Dependency-free structured logging with enforced redaction               | Accepted |
| [0008](0008-docker-first-environment.md)                   | Docker-first environment; the application owns dependency readiness      | Accepted |
| [0009](0009-platform-package.md)                           | A `platform` package for cross-cutting concerns                          | Accepted |
| [0010](0010-tool-calling-from-the-start.md)                | Tool-calling architecture from the first stage                           | Accepted |
| [0011](0011-normalized-llm-contract.md)                    | The LLM client's normalized contract: tool calls and streaming           | Accepted |
| [0012](0012-llm-retry-and-failure-policy.md)               | Retry, timeout and failure policy for the LLM gateway                    | Accepted |
| [0013](0013-required-config-per-entry-point.md)            | Required configuration enforced per entry point                          | Accepted |
| [0014](0014-clients-own-their-readiness.md)                | Clients own their readiness, and readiness means usable                  | Accepted |
| [0015](0015-caller-owned-point-ids.md)                     | Callers keep their own point ids; the adapter derives the store's        | Accepted |
| [0016](0016-content-source-port-and-canonical-document.md) | A `ContentSource` port and a canonical `Document`                        | Accepted |
| [0017](0017-crawl-behaviour-is-site-profile-data.md)       | Crawl behaviour is site-profile data, not code                           | Accepted |
| [0018](0018-embeddings-backend-is-configuration.md)        | The embeddings backend is a configuration choice                         | Accepted |
| [0019](0019-content-hash-idempotent-ingestion.md)          | Idempotent ingestion via content-hash comparison, guarded prune          | Accepted |
| [0020](0020-structure-aware-chunking.md)                   | Structure-aware chunking in characters, with an evaluation harness       | Accepted |
| [0021](0021-the-domain-declares-its-ports.md)              | The domain declares its ports, including retrieval as one port           | Accepted |
| [0022](0022-bounded-tool-loop.md)                          | A bounded tool loop, with tools withdrawn on the final round             | Accepted |
| [0023](0023-streaming-delivery-over-sse.md)                | Streaming delivery over SSE, with a lazily-opened stream                 | Accepted |
| [0024](0024-durable-conversation-store.md)                 | A durable conversation store, chosen explicitly rather than defaulted    | Accepted |
| [0025](0025-rate-limiting-and-capacity.md)                 | Rate limiting by token bucket, and capacity as a separate ceiling        | Accepted |
| [0026](0026-magento-issued-session-tokens.md)              | Magento-issued session tokens, verified against a cached key set         | Accepted |
| [0027](0027-widget-as-a-custom-element.md)                 | The widget is a custom element that renders untrusted text as DOM        | Accepted |
| [0028](0028-commerce-reads-behind-one-adapter.md)          | Commerce reads behind one adapter; the assistant never computes money    | Accepted |
| [0029](0029-cart-changes-need-a-confirmed-proposal.md)     | A cart changes only through a proposal the customer confirmed            | Accepted |
| [0030](0030-metrics-as-port-decorators.md)                 | Dependency-free Prometheus metrics, instrumented as port decorators      | Accepted |
| [0031](0031-crawler-scoped-header-size.md)                 | The crawler's transport raises Undici's header ceiling, scoped to itself | Accepted |
| [0032](0032-linkedom-instead-of-node-html-parser.md)       | Extract page text with `linkedom`, not `node-html-parser`                | Accepted |
