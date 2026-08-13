# ADR 0014: Clients own their readiness, and readiness means usable

Status: Accepted
Date: 2026-07-30
Stage: 3

## Context

Stage 1 probed dependencies with generic HTTP GETs. The backend held each
dependency's URL, appended whichever path happened to be its health endpoint, and
called a 2xx "up". It was explicitly a stopgap, and [ADR 0006](0006-vector-repository-port.md)
committed to replacing it once the clients existed.

The stopgap has a deeper problem than duplicated URLs. A 200 from
`GET /health` proves a service is _listening_. It does not prove the service is
the one this deployment needs. The specific failure that matters here:

Someone changes `EMBEDDING_MODEL` from `BAAI/bge-m3` to something else and
redeploys the backend, but the embeddings container is still serving the old
weights. Both services are up. Every probe passes. Ingestion writes vectors from
one model into a collection built for another, and retrieval returns similarity
scores that are plausible, ranked, and meaningless. Nothing errors — ever.

There is a converse question too: which dependencies should be probed at all?

## Decision

**Each client answers for its own readiness**, through a `health()` method on its
port. The backend composes probes from those methods and holds no dependency URL
of its own.

**Readiness means usable, not reachable.** Concretely:

- `embeddings-client.health()` reads TEI's `/info` and **fails if the reported
  model is not the configured one**, with a remediation string saying to
  re-create the collection and re-ingest. It reports the model and the input-token
  limit on success.
- `vectorRepository.health()` uses Qdrant's `/readyz`, which reports _shard_
  readiness — a node that is up but still loading shards would answer real
  requests with errors.
- Every embedding response is checked against the configured dimension count, on
  every call, not only at startup.

Two things are deliberately **not** checked:

- **Collection existence.** A missing collection is the correct state before the
  first ingestion run. Failing readiness on it would mean a fresh deployment could
  never become ready enough to be ingested into. It joins readiness in Stage 6,
  when retrieval actually depends on it.
- **The LLM gateway.** It is metered and rate-limited. A check that bills per
  call, once per instance, every few seconds, forever, is a bill nobody agreed
  to. Gateway misconfiguration is caught at boot instead, and gateway failure
  surfaces as `UPSTREAM_FAILURE` on a real request.

A probe still never throws — an unreachable dependency is a _value_ — and the
probe surfaces the client's `remediation` in the `/health/ready` body, so an
operator does not have to go log-diving to learn which variable is wrong.

## Alternatives

**Keep generic HTTP probes.** Simple, uniform, and no client needs a `health()`
method. Rejected because it cannot express usability. It also duplicates
addressing knowledge the client already has, which is how a probe ends up passing
against a URL the client is not actually using.

**Probe by doing real work** — embed a canary string and check the vector width.
Strictly stronger: it verifies the whole path rather than a self-report, and local
inference is free. Rejected as the default because it makes readiness cost real
CPU on a service whose throughput is the pipeline's bottleneck, once per instance
every few seconds. The per-response dimension check gets most of the benefit on
traffic that was happening anyway. Worth revisiting if a service is ever found
misreporting its own model.

**Compose-level healthchecks.** Rejected in [ADR 0008](0008-docker-first-environment.md)
already: neither image ships a shell or curl.

**Fail readiness on a missing collection.** Tempting, because retrieval cannot
work without one. Rejected for the bootstrap deadlock above, and because it
conflates "not configured yet" with "broken".

## Consequences

Easy: the backend no longer knows how to reach anything — it asks. Adding a
dependency means writing a client with a `health()` method, not teaching the
backend another URL. A model mismatch, previously undetectable, now shows up as a
503 naming the fix.

Hard: `health()` is now part of every outbound client's port, including future
ones. A client that cannot cheaply distinguish usable from reachable will have to
pick one and document which.

Accepted: model comparison is skipped when the service reports no model id, which
a locally mounted model does. That is a deliberate false-negative — refusing to
start because a path is not a repository name would be worse than the gap.

## Postscript: two findings from running this for real

**Qdrant authentication was silently broken by the Stage 1 compose file.** It read
`QDRANT__SERVICE__API_KEY: ${QDRANT_API_KEY:-}`, which always _sets_ the variable.
Qdrant enables API-key authentication on the variable's presence, whatever its
value — so a blank `QDRANT_API_KEY` turned authentication on with a key nothing
could present. `/readyz` kept answering 200, so the old probe was green, while
every data operation returned 401. Stage 3 is the first stage to perform a data
operation, which is why it went unnoticed. Fixed by using Compose's bare-name
environment form, which omits the variable entirely when it is unset.

That is also an argument for this ADR: a readiness check that only proves
reachability was green throughout.

**`bge-m3` could not complete warm-up on an 8 GB Docker allocation.** TEI reached
`Warming up model` and exited **0** — not a crash, not `OOMKilled` — then restarted,
eighteen times. `docs/Docker.md` already recommended a smaller model for
development, but told operators to look for the OOM killer, and this leaves no OOM
evidence at all. The troubleshooting entry now describes the real signature.
