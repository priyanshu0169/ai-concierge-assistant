# ADR 0023: Streaming delivery over SSE, with a lazily-opened stream

Status: Accepted
Date: 2026-07-31
Stage: 7

## Context

A grounded answer takes about five seconds, and the shape of that wait is worse than the
number suggests. Measured against the real gateway: the model spends ~1.8s deciding to
search, retrieval takes ~1.1s, and the first token of the answer arrives at **4.3s**. A
buffered response shows the customer nothing for four and a half seconds and then the whole
answer at once, which reads as a broken page rather than a slow one.

`llm-client.stream()` has existed since Stage 2, tested including tool-call reassembly
across events, precisely so that this stage would be a delivery change rather than a
rewrite ([ADR 0011](0011-normalized-llm-contract.md)). What was deliberately left unmade
was **how streaming interacts with the tool loop**, which is why `stream()` was absent from
the `LanguageModel` port ([ADR 0021](0021-the-domain-declares-its-ports.md)).

That interaction is the real problem. Tokens cannot be streamed until the model has stopped
asking for tools, and whether it will ask is only knowable after the round completes. Three
further questions follow: what HTTP mechanism carries the events, what happens when a
request fails _after_ its status code is already on the wire, and what happens when the
customer closes the tab.

## Decision

**Server-sent events on `POST /v1/chat/stream`**, alongside the unchanged buffered
`POST /v1/chat`.

**The stream opens on its first event, not when the handler starts.** This is the decision
worth the most and the least obvious. Writing the response head commits a 200 and makes
every later failure unreportable as a status code — so it is deferred until there is
something to send. A turn that dies before its first event (a conversation store that is
down, a profile that fails to load) therefore still becomes an ordinary 502 or 503 with the
standard envelope, from the same error middleware as every other route. Only once an event
is out does the fallback below apply.

**A mid-stream failure becomes an `error` event**, carrying the same envelope the error
middleware would have produced, built by the same function. Extracting
`buildErrorEnvelope` was part of this stage for that reason: two implementations of "mask a
5xx message" would eventually stop agreeing, and the one exercised less would be the one
that leaked.

**Four events, with ordering guarantees**: `start` first and always, `tool` bracketing each
tool execution, `delta` for text, `done` exactly once and last.

`tool` events earn their place on the measurements above. They fill the 4.3-second gap
before the first token with something honest — "searching the help centre" — which is both
the correct progress signal and the thing that keeps the connection visibly alive.

**`done.reply` is authoritative; deltas are a progressive preview of it.** When a model
returns no prose at all there are zero deltas and the store's `noAnswerMessage` appears
only in `done`, so a renderer that trusts deltas alone shows an empty bubble in exactly the
case where saying something matters most. In the normal case the two are identical and
reconciling changes nothing.

**`done`'s payload is byte-identical in shape to the buffered response**, produced by one
serializer. A client may ignore `start` entirely and still have everything. `grounded` is
withheld on both paths, for the reason in [ADR 0022](0022-bounded-tool-loop.md).

**One tool loop serves both modes.** The loop is an async generator parameterized by a
_round runner_: the streaming runner is `model.stream()` unchanged, and the buffered runner
is a two-line adapter that wraps `generate()` in a single `end` event. This works because
Stage 2 gave `stream()` a terminal event carrying a finished `LlmCompletion` — so round
bounding, tool withdrawal and tool execution are written once. A test asserts the two modes
produce the same answer and citations for the same scenario.

**The buffered path keeps using `generate()`** rather than draining a stream and discarding
the deltas. It is one request instead of an SSE connection, and it does not require the
gateway to support streaming at all — `LLM_STREAM_INCLUDE_USAGE` exists because some
gateways are particular about streaming options, and `/v1/chat` should not inherit that
risk.

**A disconnect cancels the turn and persists nothing.** The abort signal reaches the LLM
client, which cancels the request rather than ignoring its result — verified: the second
gateway round logs no completion after an abort. Nothing is written to history, because a
stream can be cut anywhere, including mid-sentence or before a single token, and a fragment
replayed to the model on the next question is worse than no record at all.

**A disconnect is logged at `info`, not `warn` or `error`.** Found by testing: cancelling
the turn makes the gateway call reject, and the first implementation filed that rejection as
a stream failure — an `error` record with a stack trace **every time a customer closed a
tab**. Normal behaviour must not look like a fault, or real faults drown in it. A test now
pins that an abandoned turn produces no record above `info`.

## Alternatives

**WebSockets.** Bidirectional, and the obvious choice if the widget ever needed to push
something mid-answer. Rejected: the traffic is strictly one-way after the request, and a
WebSocket costs a connection upgrade, a subprotocol to design, its own reconnect and
heartbeat handling, and proxy configuration that many corporate networks get wrong. SSE is
plain HTTP with `EventSource` built into every browser.

**Chunked JSON lines (`application/x-ndjson`).** Simpler to produce than SSE and trivially
parseable. Rejected: no browser primitive consumes it, so the widget would hand-roll
incremental parsing over `ReadableStream`, and `EventSource`'s named events and automatic
reconnection would have to be reimplemented.

**Buffer every tool round and stream only the final one.** Would guarantee that streamed
text never contains a model's pre-tool narration. Rejected because it cannot be done
without giving up streaming: whether a round is final is only known once it has ended, so
"stream only the final round" means buffering the whole answer and emitting it at once.
Streaming optimistically is the only version that streams, and narration reaching the
customer reads naturally — "let me check that" followed by the answer.

**Stream from `generate()` by chunking the finished answer client-side.** A fake stream.
Rejected: it delivers nothing until the answer is complete, which is the entire problem.

**Write the response head immediately.** One less branch, and what nearly every SSE example
does. Rejected once it was clear how much it gives up: a conversation-store outage, a
config failure, or any pre-first-event error would arrive as a 200 with an error event —
invisible to load balancers, monitoring, and every client that branches on status.

**Keep one endpoint and switch on `Accept: text/event-stream`.** Fewer routes, and arguably
more RESTful. Rejected: the two have genuinely different failure semantics — one can return
502, the other mostly cannot — and hiding that behind a header makes the contract depend on
something easy to set by accident. A separate path is also independently
feature-flaggable and independently rate-limitable.

**Retry a failed stream.** Rejected in Stage 2 and unchanged
([ADR 0012](0012-llm-retry-and-failure-policy.md)): once a delta has been rendered,
replaying duplicates text rather than repairing it.

## Consequences

Perceived latency changes completely while total latency does not. Measured on the same
question: `start` at 70ms, `tool started` at 1.8s, `tool finished` at 2.9s, first token at
4.3s, complete at 4.8s across 48 delta events — against 4.9s of silence for the buffered
path.

Every hop between the handler and the browser must not buffer. `x-accel-buffering: no` and
`cache-control: no-transform` are sent for this reason, and nginx's default
`proxy_buffering on` will otherwise hold every event until the response ends — turning a
stream into a slow non-stream with nothing in any log to explain it.
`docs/Deployment.md` carries the proxy requirements.

A 15-second keepalive comment is sent while idle, because the pre-first-token gap plus a
stalled model can exceed a proxy's idle timeout, and to a proxy an idle stream is
indistinguishable from a dead one. It is unit-tested with mocked timers rather than left to
be discovered behind a real load balancer.

Clients now have two error shapes to handle for one logical failure: a JSON envelope with a
status code, or an `error` event inside a 200. That is inherent to streaming, not a design
choice, and it is why `POST /v1/chat` remains a supported endpoint rather than a legacy
one — anything that would rather have a status code should use it.

The streamed and buffered answers to the same question can differ slightly in text: the
streamed answer includes any narration the model emitted before calling a tool, because
those tokens were rendered and are what the customer saw. Both are internally consistent —
each persists exactly what it delivered — and LLM output is not reproducible between two
calls anyway.

Two things this stage does **not** do, and they are the reason Stage 7 was split rather
than delivered whole: there is still no authentication and no rate limiting.
`POST /v1/chat/stream` holds a connection open for seconds per request, so it is a cheaper
target for connection exhaustion than the buffered endpoint. Neither may be exposed to the
internet until 7b.
