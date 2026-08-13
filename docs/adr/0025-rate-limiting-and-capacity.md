# ADR 0025: Rate limiting by token bucket, and capacity as a separate ceiling

Status: Accepted
Date: 2026-08-03
Stage: 7c

## Context

Two chat endpoints are unauthenticated, cost money per request, and hold a connection open
for seconds at a time. `docs/Deployment.md` has said since Stage 6 that the proxy must
supply throttling; that is a reasonable interim position and a poor permanent one, because
a protection that lives only in infrastructure is a protection somebody eventually
forgets to configure.

**A position from Stage 7b needs correcting.** I argued there that rate limiting should
wait for authentication, on the grounds that IP-keyed limiting is weak. That overstated
the case. It is bypassable by an attacker who rotates addresses, but the realistic threat
to this endpoint is a runaway script or one abusive caller, and both come from one place.
Every public API limits before it authenticates, and "nothing" is strictly worse than
"bypassable with effort". Authentication remains blocked on open decision 2; limiting does
not have to wait for it.

Three questions: what algorithm, where the state lives, and whether one ceiling is enough.

## Decision

**A token bucket per client, in process memory, mounted on `/v1` only.**

**Token bucket over a fixed window.** A fixed window permits a double-rate burst across
its boundary — a full allowance at 11:59:59 and another at 12:00:00 is two windows' worth
in a second, from a limiter configured for one. A bucket refills continuously, so the rate
holds everywhere, and it still permits a legitimate burst up to capacity.

**Token bucket over a sliding-window log.** A log costs memory proportional to traffic,
which is precisely the wrong shape for a mechanism whose job is to survive a flood. A
bucket is two numbers per client.

**Health endpoints are exempt**, which is why the limiter is mounted on the router rather
than the app. An orchestrator polls readiness on a fixed interval; throttling it would
make a healthy instance report a false outage and be pulled from the load balancer,
turning a protection into the outage it exists to prevent.

**State is per process, and the imprecision is accepted.** With N replicas the effective
allowance is N times the configured one. Redis is already in the stack and would make it
exact — and it was rejected, because it adds a round trip to every request, a failure
mode, and a fail-open policy, to fix something an operator corrects by dividing the limit
by the replica count. This is explicitly _not_ the same judgement as Stage 7b's: per-replica
conversation history was a **correctness** bug, and per-replica rate limiting is a
**precision** one. The store sits behind a seam, so exactness is a later addition rather
than a rewrite.

**Concurrency is a second, separate ceiling.** A rate limit counts requests _spent_; a
stream is _held_. A client well inside its rate can keep twenty generations running, each
costing tokens and a socket for its whole life. So streams are counted in flight, with two
limits that answer different questions:

| Ceiling    | Exceeded means        | Status | Reasoning                              |
| ---------- | --------------------- | ------ | -------------------------------------- |
| Per client | This client is greedy | `429`  | The client's fault; it should back off |
| Global     | The service is full   | `503`  | Not any one client's fault             |

Telling a well-behaved customer they are being throttled when the service is simply at
capacity would be a lie, and the two need to stay distinguishable in a dashboard — the same
reasoning that made an upstream 429 surface as a masked 502 in
[ADR 0012](0012-llm-retry-and-failure-policy.md).

Concurrency counting per process is _not_ an approximation, unlike the rate limiter's: a
connection is held by one process, so a per-process ceiling is exactly what bounds that
process's sockets and memory.

**`Retry-After` is set by the error handler**, from `retryAfterSeconds` on the error,
rather than by each throw site. It is the one part of an error that belongs in a header:
clients, proxies and browsers act on it automatically. `RateLimitError` has carried that
field since Stage 1 and nothing had ever used it.

**A refused request advises the wait for _one_ token, not for a full bucket.** Telling a
client to wait 60s when it could proceed in 20 keeps it idle three times longer than
necessary.

**Rate limiting defaults to on.** An operator who wants the proxy to own throttling can
turn it off deliberately; nobody should arrive there by forgetting.

## Alternatives

**`express-rate-limit`.** Mature, widely used, and it would have been perhaps thirty lines
of configuration. Rejected on the same grounds as every other dependency here: the whole
mechanism is ~80 lines, the eviction bound and the two-ceiling split are decisions this
system needs to make explicitly, and a library's defaults would have to be audited to know
what they are. That reasoning would flip if this needed a distributed store, cluster
support, or a dozen strategies.

**Redis-backed limiting for exactness across replicas.** Covered above: a round trip per
request and a new failure mode, to fix an imprecision division already solves.

**Keying on `conversationId` as well as address.** Rejected — it is client-supplied, so
rotating it would hand an attacker unlimited buckets. It would make the limiter _weaker_
while looking more precise.

**One ceiling covering both requests and streams.** Simpler configuration. Rejected: they
measure different things, and a single number cannot express "thirty questions a minute
but only two answers in flight" — which is exactly the shape of legitimate use.

**Failing closed when the client map is full.** Rejected: refusing new clients once the
map fills turns a flood into a total outage. Evicting the least-recently-seen slightly
favours an attacker — a flood can push out a legitimate client's bucket and hand it a
fresh allowance — and that is the right way round.

**Per-store limits in the site profile.** Rejected: throttling protects the _deployment_,
not the store's brand or behaviour. It is infrastructure, so it lives in the environment
per [ADR 0004](0004-configuration-boundary.md).

## Consequences

A refusal costs 2–7ms and no gateway call, measured — the point being that a limited
request must be cheap to refuse or the limiter becomes the attack.

`RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` go out on **every** `/v1`
response, so a client can slow down before it is refused rather than discovering the limit
by hitting it.

**A misconfiguration worth knowing about:** `TRUST_PROXY=false` behind a proxy makes every
request appear to come from the proxy's address, so all customers share one bucket and the
limiter throttles everybody at once. Nothing in the application can detect this — it looks
identical to genuine traffic from one address — so it is documented next to the setting
and next to the limits.

Rate limiting is now the application's job as well as the proxy's. That duplication is
deliberate: the proxy can be more aggressive and can see traffic the application never
receives, while the application's copy cannot be forgotten during a deployment.

Two things this stage does **not** change. Authentication is still absent, so the key is
still an address and a determined attacker with many addresses is still unthrottled — a
real limit on how much this buys, and the reason 7d exists. And the global stream ceiling
is a capacity control, not a **spend** control: it bounds concurrent cost, not cumulative
cost, so open decision 8 remains open and a budget alarm remains the operator's to build.
