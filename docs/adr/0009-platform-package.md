# ADR 0009: A `platform` package for cross-cutting concerns

Status: Accepted
Date: 2026-07-30
Stage: 1

## Context

The specified package list is `assistant-core`, `llm-client`, `embeddings-client`,
`vector-repository`, `ingestion`, `scraper`, `rag-backend`, `widget`.

Several things are needed by nearly all of them and belong to none:

- Structured logging with correlation ids and secret redaction.
- The error taxonomy that every layer throws and the HTTP boundary translates.
- Configuration loading and validation.
- Timeout and cancellation primitives, used by every outbound client.

Given no home, these land in one of two places. Either they go into `assistant-core`, which every
package then depends on — making the domain a utility library and forcing `llm-client` to import the
business core to get a logger. Or they get duplicated, and the redaction rules drift until one copy
lacks the key pattern that mattered.

Both outcomes damage the property the architecture exists to protect: `assistant-core` must stay pure,
and adapters must not depend on the domain.

## Decision

Add `@shopsage/platform` as the **single permitted location for cross-cutting concerns**, and constrain
it explicitly:

- It depends on nothing but zod.
- **It must never learn the domain.** No products, retrieval, prompts, conversations or commerce. If a
  change to `platform` mentions any of those, it belongs in the package that owns that concept.
- Its contents are limited to logging, errors, configuration and async primitives. It is not a
  `utils` package, and "shared helper with no obvious home" is not an admission criterion.

This is a deliberate deviation from the specified package list, recorded here so it is a decision rather
than drift.

## Alternatives

**Put it in `assistant-core`.** No new package, and matches the specification literally. Rejected
because it inverts the dependency direction: outbound adapters would import the domain to obtain a
logger, and `assistant-core` would accumulate infrastructure until it was no longer framework-free —
losing exactly the property that makes it testable and portable.

**Duplicate per package.** No shared dependency, maximum independence. Rejected because the duplicated
code includes a **security control**. Six copies of a redaction pattern means the one that misses
`sessionId` is a leak nobody notices, and the error taxonomy has to be identical for the HTTP boundary
to translate errors uniformly.

**Publish separate micro-packages (`@shopsage/logger`, `@shopsage/errors`, …).** Cleanest boundaries and
independently versionable. Rejected as premature: four packages of a few hundred lines each, always
released together, with cross-dependencies between them — errors need the log level names, logging needs
error serialization. The split can happen later if any of them gains an independent consumer.

**Name it `shared` or `common`.** Rejected on naming grounds, which matters more than it sounds. A
package called `shared` invites anything; `platform` describes a role — infrastructure the application
runs on — and makes "does this belong here?" answerable.

## Consequences

Easy: one implementation of redaction, one error taxonomy, one configuration loader. Adapters depend on
`platform` and never on the domain. The dependency graph stays acyclic and the direction stays obvious.

Hard: one more package than specified, and a package every other one depends on — so a breaking change
there ripples everywhere, and it needs a higher standard of care and test coverage than average. There is
also permanent pressure to widen it: `platform` is the path of least resistance for any code whose home
is unclear.

Accepted: the constraint is only real if enforced in review. The test is not "is this reusable?" but
"is this free of domain knowledge?" A retry helper qualifies; a helper that knows what a product is does
not, however generic it looks.
