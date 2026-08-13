# ADR 0007: Dependency-free structured logging with enforced redaction

Status: Accepted
Date: 2026-07-30
Stage: 1

## Context

This system handles two categories of data that must never reach log storage: credentials (LLM,
Qdrant and Magento keys) and customer text (questions, order numbers, addresses). It also needs
correlation — a customer report has to be traceable to the exact request that produced it, across
several services.

Logging is also the one subsystem where a failure is silent. A leaked secret does not throw; it sits in
an aggregator, indexed and searchable, until someone notices. So the guarantee cannot be "developers
remember not to log secrets".

## Decision

A small structured logger owned by `@shopsage/platform`, with no logging dependency.

- One JSON object per line on stdout. The process never writes files or manages rotation — the platform
  owns routing.
- `child(bindings)` derives a logger carrying extra fields, which is how `requestId` reaches every
  record in a request without being threaded through every function signature.
- **Redaction is structural.** Every field bag passes through a recursive redactor that replaces values
  under credential-shaped keys (`*_KEY`, `token`, `secret`, `password`, `authorization`, `cookie`,
  `sessionId`, `signature`, …) with `[redacted]`, at any nesting depth. It handles arrays, breaks
  reference cycles, and truncates beyond a depth limit — a logger must never be the reason a request
  fails.
- `Error` values are serialized properly. Node's default JSON encoding of an `Error` is `{}`, which
  silently destroys diagnostics; the serializer preserves name, message, stack, our error code and the
  `cause` chain.
- The clock and the output sink are injected, so logging is deterministically testable.
- A `pretty` format exists for local development, documented as lossy and never for production.

Two conventions are enforced by tests rather than by review: secrets are redacted at any depth, and
access logs contain the request path with the **query string stripped**, because an assistant API can
carry customer text there.

## Alternatives

**Pino.** The obvious choice — fast, mature, well designed, with redaction support. Rejected reluctantly.
Its redaction is path-based (`redact: ['a.b.c']`), which requires enumerating in advance every place a
secret might appear. That is precisely the assumption that fails: the leak comes from the object nobody
predicted would be logged. A key-pattern redactor applied to everything is the weaker-looking mechanism
that actually holds. Pino also brings transports, worker threads and a plugin surface we would not use.

**Winston.** More features, notably transports. Rejected: heavier, slower, and the transport model
contradicts logging to stdout.

**`console.log` with JSON.** Zero code. Rejected because it provides no redaction, no level filtering,
no child bindings and no error serialization — every one of which would then be reimplemented ad hoc at
call sites.

**OpenTelemetry logging.** Where this should end up for traces and metrics. Rejected for now as
substantial setup for a service with no distributed tracing yet; planned for Stage 10, and the logger's
interface is small enough to bridge.

## Consequences

Easy: no logging dependency to track or upgrade. Redaction covers unanticipated shapes by default.
Correlation ids propagate automatically through child loggers. Logs are directly queryable in any
aggregator. The whole thing is about 150 lines and fully tested.

Hard: we own it. No community-tested transports, no ecosystem, no sampling, no async destination.
Performance is `JSON.stringify` plus a synchronous write — fine at expected volume, but Pino would win
under heavy load, and if logging ever appears in a profile this decision should be revisited. The
redaction pattern is also a heuristic: a secret stored under a key like `magentoCredentials` is caught,
one under `value` is not. Redaction is defence in depth, not a licence to pass secrets to the logger.

Accepted: the key-pattern list will need extending as new integrations arrive, and it should be
reviewed whenever a new credential type enters the system.
