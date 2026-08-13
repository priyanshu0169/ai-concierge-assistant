# ADR 0024: A durable conversation store, chosen explicitly rather than defaulted

Status: Accepted
Date: 2026-08-01
Stage: 7b

## Context

[ADR 0021](0021-the-domain-declares-its-ports.md) shipped the `ConversationStore` port with
an in-process implementation and recorded the consequence plainly: two replicas answer the
same conversation with different history, and a deploy erases every in-flight conversation.
`docs/Deployment.md` has carried it since as "the strongest single blocker to a real
deployment". This stage closes it.

The failure it causes is worth naming precisely, because it is not "conversations are
lost". It is **intermittent** amnesia — whichever replica the load balancer picks decides
whether the assistant remembers — and it presents to a customer as an assistant that is
randomly stupid rather than as an outage. Nothing in any log says "this instance had never
seen that conversation".

Three questions had to be answered: what backend, how the choice is made, and what happens
when the backend is unavailable.

## Decision

**Redis, in a new `@shopsage/conversation-store` package.** An outbound adapter with the
same shape as `vector-repository`: it satisfies a port the domain declared and keeps its
backend invisible above that line. Nothing outside the package mentions Redis, a key
format, or a TTL.

The data model is one list per conversation, JSON-encoded turns, keyed
`{prefix}:{siteId}:{conversationId}`. Three properties of that shape are deliberate:

- **`siteId` is in the key**, not in the value. Cross-tenant reads become structurally
  impossible rather than a filter somebody has to remember — the same reasoning as
  [ADR 0006](0006-vector-repository-port.md)'s tenancy, reached independently.
- **`RPUSH` + `LTRIM` + `EXPIRE` in one `MULTI`.** Atomic, one round trip, and the reason
  the port says `append` rather than `set`: two tabs on one conversation would otherwise
  interleave a read-modify-write and lose a turn.
- **A sliding TTL**, refreshed on every write, so the expiry means "idle for this long"
  rather than "created this long ago".

**The TTL comes from `conversation.sessionIdleTimeoutMinutes`** — a site-profile key that
has existed since Stage 1 and until now did nothing. How long a store remembers a customer
is a product decision that differs between stores, so it belongs on the profile side of
[ADR 0004](0004-configuration-boundary.md)'s boundary; the address and the timeout are
infrastructure and stay in the environment. `maxHistoryMessages` doubles as the storage cap,
because keeping more than is ever replayed to the model is paying to store text nothing
reads.

**`CONVERSATION_STORE` has no default in production.** Outside production the backend picks
`memory` for itself, because a developer should not need Redis to ask a question. Inside
production an unset value is a **boot failure** naming both options. This is the same rule
as `LLM_*` ([ADR 0013](0013-required-config-per-entry-point.md)): configuration with no
defensible default is required rather than assumed. Only the operator knows the replica
count, and `memory` is correct at one and silently wrong at two.

Choosing `memory` in production is still allowed. One replica is a real deployment, and
banning it would block a legitimate configuration to protect against a different one.

**The in-memory store gained the same idle expiry**, lazily on read against an injectable
clock. Two implementations of one port that expire differently are two products, and the
difference would surface as behaviour a developer cannot reproduce against production.

**A failed read fails the turn; a failed write does not.** This asymmetry only became a
real decision once the store was a network dependency rather than a `Map`:

- Answering a follow-up with no memory produces a reply that reads as the assistant being
  stupid, and a customer cannot distinguish that from a broken dependency. A 502 is honest
  and retryable.
- By the time the write happens the answer exists and, on the streaming path, has already
  been rendered. Turning that into an error throws away work the customer can see, to
  report a problem they cannot act on. The turn is logged with `persisted: false`.

**Every operation carries its own deadline.** See the consequence below — this was a defect,
not foresight.

## Alternatives

**PostgreSQL.** Durable, transactional, and a dependency many deployments already have.
Rejected: conversation history is bounded-lifetime, write-heavy, read-by-key state with no
relational queries over it, and it should delete itself. That is a TTL-shaped problem, and
a database without native expiry needs a sweeper job somebody has to remember to run and
monitor. If retention policy later demands durable transcripts for audit, that is a
_different_ store with different requirements, not this one grown.

**Qdrant, to avoid adding a service.** Rejected in ADR 0021 and still rejected: a vector
database is not a transcript store, and modelling turns as points with a fake vector is an
abuse visible in every future query.

**The `redis` meta-package.** The obvious client. Rejected after looking at what it pulls
in: `@redis/bloom`, `@redis/json`, `@redis/search` and `@redis/time-series`, none of which
this uses. `@redis/client` is the same code from the same maintainers with one transitive
dependency.

**Hand-rolled RESP over a socket.** Consistent with the project's dependency-light stance —
there is no vendor SDK anywhere else, and `fetch` covers every other client. Rejected:
reconnection, pipelining and error recovery are the hard parts, and getting them subtly
wrong produces data loss under exactly the conditions nobody tests. The dependency-light
stance exists to avoid _vendor lock-in and hidden behaviour_, and a protocol client for a
protocol we chose is neither.

**Defaulting `CONVERSATION_STORE` to `redis`.** Safe-by-default, and it would make the
right choice the easy one. Rejected: it makes `npm start` fail for a developer who has not
started Redis, and the failure would be a connection error rather than a message explaining
what to set.

**Failing the turn when the write fails, for symmetry.** Simpler to explain. Rejected for
the reason above: it discards a delivered answer to report an unactionable problem.

**`--appendonly yes` on the Redis container.** Rejected: paying fsync durability to protect
data that deletes itself within the hour is the wrong trade, and a restart losing in-flight
conversations is the same outcome as their TTL passing.

## Consequences

Two replicas now share conversations. Verified live with a question asked on one process
and recalled on another: _"Please remember this for later: my reference code is
TANGERINE-42"_ → _"You provided the reference code TANGERINE-42."_ The same test against
the in-memory store on two replicas answers _"I could not find the answer to that"_.

A production deployment can no longer boot without deciding how it stores conversations,
and the message names both options and the consequence of each.

`sessionIdleTimeoutMinutes` finally does something, in both implementations.

**A real defect, found by testing rather than reasoning.** Stopping Redis made
`/health/ready` hang **indefinitely** instead of reporting `down`. The client retries
connecting forever by design, and nothing above it had a deadline —
`platform`'s `withTimeout` is a _cancellation_ primitive that hands the operation an
`AbortSignal`, which is the right shape for `fetch` and the wrong shape for a Redis command
that cannot be cancelled. Every other client in the codebase bounds its own I/O
(`QDRANT_TIMEOUT_MS`, `EMBEDDING_TIMEOUT_MS`); this one did not, and the omission was
invisible until the dependency actually went away. Now every operation races a
`REDIS_TIMEOUT_MS` deadline, the socket has a connect timeout, and a test pins that a
client which never answers still fails fast.

With that fixed, a store outage behaves correctly: readiness reports `conversations: down`
in ~5s, liveness stays 200 so no orchestrator restarts a working process, `/v1/chat`
returns a masked 502, and the instance recovers on its own when Redis returns — no restart
needed.

`POST /v1/chat/stream` returns a **502 with a JSON envelope** rather than an SSE `error`
event when the store is down, because the history read happens before the first event. That
is [ADR 0023](0023-streaming-delivery-over-sse.md)'s lazily-opened stream paying off in
exactly the case it was designed for.

The stack gains a service and the repository gains its first runtime dependency that is not
`express` or `zod`. Both are accepted; the alternative was worse in each case.

Two things this does **not** deliver, and they remain the reason a deployment is not
internet-facing: there is still no authentication and no rate limiting. Authentication is
blocked on open decision 2, which needs the Magento module's author, and rate limiting
without it keys on a forgeable IP or a trivially-rotated conversation id.
