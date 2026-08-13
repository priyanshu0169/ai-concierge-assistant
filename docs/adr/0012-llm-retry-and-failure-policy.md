# ADR 0012: Retry, timeout and failure policy for the LLM gateway

Status: Accepted
Date: 2026-07-30
Stage: 2

## Context

The LLM gateway is the slowest, most expensive and least reliable dependency in the system, and it
sits directly in a customer's request path. Every retry decision is simultaneously a decision about
latency, about money, and about whether a customer sees an answer.

Three properties make the usual "retry anything that looks transient" advice wrong here:

- **Requests are metered.** A retried request is charged again, including the tokens the first
  attempt already generated.
- **Requests are slow.** The default per-attempt budget is 60 seconds. Three attempts is a
  three-minute silence in a chat window.
- **Streamed responses are not idempotent from the caller's point of view.** Once a delta has been
  rendered, replaying the call appends a second copy rather than repairing the first.

Timeouts are the interesting case. `TimeoutError` is marked retryable in the platform's taxonomy,
which is correct in general and wrong here.

## Decision

**Retry:** upstream 5xx, upstream 408, upstream 429, and network-level failures (DNS, refused
connection, TLS, socket reset). Plus a body that fails to parse as JSON, which is usually a truncated
response on a dropped connection.

**Do not retry:** timeouts, any other 4xx, a 200 carrying no choices, unparsable tool-call arguments,
and any failure after the first stream event has been yielded.

- `LLM_TIMEOUT_MS` is a **per-attempt** budget. With timeouts excluded from retry, a slow gateway
  fails once at the budget rather than three times.
- Backoff is exponential with **equal jitter** — half the window fixed, half random.
- An upstream `Retry-After` wins over the computed delay, clamped to the backoff ceiling.
- An upstream 429 becomes a masked `UpstreamError` (502), not a `RateLimitError` (429).
- `stream()` retries only up to accepting the response; body consumption is never retried.
- The LLM gateway is **not** included in the readiness probe.

## Alternatives

**Retry timeouts, as the taxonomy's default suggests.** Consistent with every other client, and a
timeout during connection setup genuinely is transient. Rejected because the _common_ cause is a
gateway still generating a long answer: the retry pays for the abandoned generation, and the customer
waits `maxAttempts × timeoutMs`. Distinguishing "timed out before first byte" from "timed out while
generating" would need machinery we would rather not have; lowering `LLM_TIMEOUT_MS` is the correct
lever for a gateway that is slow to respond at all.

**A single overall deadline across all attempts.** Bounds worst-case latency directly, which is
attractive for a customer-facing path. Rejected for now: a global deadline that cancels an attempt
mid-flight produces failures nobody can attribute to a cause, and with timeouts excluded from retry
the worst case is already bounded in practice. Revisit when streaming lands on the HTTP surface in
Stage 7.

**Surface an upstream 429 as a customer 429.** Lets a client back off intelligently, and HTTP already
has the semantics. Rejected on two counts. It tells a customer _they_ are being throttled when they
are not — ShopSage's own rate limiting arrives in Stage 7 and will legitimately produce 429s, and the
two must be distinguishable. And `RateLimitError` is an exposed error, so its `details` are serialized
to the caller: the gateway's status and error body would be published to a browser.

**Probe the gateway in `/health/ready`.** Would surface a bad credential before a customer finds it.
Rejected because a completions call costs money and consumes rate limit, once per instance every few
seconds forever. Boot-time validation catches the misconfiguration cases that matter (missing or
malformed settings), and a real request surfaces the rest as `UPSTREAM_FAILURE` with a remediation
hint in the log.

**Full jitter instead of equal jitter.** The AWS-recommended default. Rejected narrowly: full jitter
can produce a near-zero delay, which retries a struggling gateway immediately. Equal jitter keeps the
decorrelation while guaranteeing the wait is at least half the window.

## Consequences

Easy: failure behaviour is one predicate in one file (`retry-policy.js`), so "what does ShopSage do
when the gateway 500s?" has a single answer. Cost cannot silently triple on a slow model. A partially
streamed answer never duplicates itself.

Hard: a genuine connection-setup timeout is not retried, so an occasional request fails that a retry
would have saved. A gateway that returns 200 with an error envelope fails on the first attempt with a
generic "no choices" message rather than the gateway's own wording. Gateway health is invisible until
a customer asks something.

Accepted: the worst case is still `maxAttempts × timeoutMs` plus backoff for the retryable classes.
The mitigation is documentation and an operator-tunable `LLM_MAX_ATTEMPTS`, not a hidden deadline.
