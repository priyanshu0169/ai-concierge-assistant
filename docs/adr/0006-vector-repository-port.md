# ADR 0006: Qdrant behind a VectorRepository port, with payload-based tenancy

Status: Accepted
Date: 2026-07-30
Stage: 1 (contract), 3 (implementation)

## Context

Retrieval needs a vector store. Qdrant is the choice today, and the requirement is explicit that a
future vector database must be replaceable without changing business logic. Multiple Magento stores are
also on the roadmap, so the store's data model has to accommodate tenancy.

Vector databases leak more aggressively than most dependencies. Their filter languages, id formats,
distance metrics, payload conventions and batching semantics all differ, and those details have a way
of reaching the calling code — a service that builds a Qdrant `Filter` object has embedded Qdrant in
the domain even if it never imports the client.

## Decision

**A `VectorRepository` port with a fixed surface**, and a Qdrant adapter behind it:

```
createCollection()   insert()   search()
delete()             count()    collectionExists()
```

Rules:

- No Qdrant type crosses the boundary. Not a client, not a filter, not a point struct, not a
  `ScoredPoint`. Inputs and outputs are ShopSage's own plain shapes.
- Filtering is expressed declaratively (`{ siteId, contentType }`), and the adapter translates it into
  the store's native filter language.
- Failures surface as `UpstreamError` / `TimeoutError`, never as a Qdrant error class.
- The adapter also provides the health check that the backend's readiness probe uses from Stage 3,
  replacing the generic HTTP probe used in Stage 1.

**Tenancy: one shared collection with a `siteId` payload filter and a payload index** — not a
collection per store. This is Qdrant's own recommended multi-tenancy model. Collection-per-store
multiplies index and memory overhead and turns "onboard a store" into an operational procedure rather
than a configuration change.

Every search is filtered by `siteId`. That is a **correctness** requirement, not an optimisation:
without it, one store's assistant can answer from another store's policies. It belongs in the adapter,
so no caller can forget it.

## Alternatives

**Use the Qdrant client directly in services.** Less code and full access to Qdrant's features.
Rejected because it makes the stated goal — a replaceable vector database — false. It also makes
retrieval logic untestable without a running Qdrant.

**A generic repository exposing raw query objects.** A thin pass-through that still allows anything.
Rejected as abstraction theatre: if the query object is Qdrant's, the coupling is intact and only
harder to see.

**pgvector on PostgreSQL.** One less service, transactional with relational data, familiar operations.
A genuinely reasonable choice, and the port keeps it available. Rejected as the default because Qdrant's
filtered-search performance, payload indexing and named-vector support fit the roadmap better —
specifically hybrid dense/sparse retrieval with BGE-M3, which pgvector does not address as directly.

**Collection per store.** Strong isolation, trivial per-store deletion, no risk of a missing filter.
Rejected for the overhead and operational cost above. Worth revisiting if a store ever needs physical
data isolation for compliance reasons — that is a legitimate reason to change this decision.

## Consequences

Easy: swapping the store is one adapter plus one line in the composition root. Retrieval logic is
testable against an in-memory fake. Adding a store is data, not operations. Tenancy filtering cannot be
forgotten by a caller.

Hard: the port is the lowest common denominator, so Qdrant-specific features — quantization tuning,
snapshots, sparse vectors, multi-vector search — are not reachable without a deliberate extension. Some
of those (sparse vectors for hybrid retrieval) are already on the roadmap, so the port will need to
grow, and it must grow as a ShopSage concept rather than as a Qdrant passthrough.

Accepted: a port designed against a single adapter tends to encode that adapter's assumptions. The
second implementation is where this design is really tested, and some revision then is expected rather
than a failure.
