# ADR 0030: Dependency-free Prometheus metrics, instrumented as port decorators

Status: Accepted
Date: 2026-08-04
Stage: 10a

## Context

Nine stages have produced a service that answers questions, and no way to tell whether it is answering
them well. The gap is specific: **an assistant returning the store's no-answer message to every question
is indistinguishable from a healthy one if all you have is HTTP status codes.** Both are `200`.

The logs carry every individual fact — `grounded`, `toolRounds`, `totalTokens`, durations, retry
notices — correlated by `requestId` and `conversationId`. What does not exist is any way to aggregate
them. "What is p95 latency", "what did we spend today", "has the grounded rate fallen" are not questions
`grep` answers, and they are the questions an operator has.

This also blocks [open decision 8](../Roadmap.md#open-decisions): a cost ceiling cannot be set against
data nobody can total.

Stage 10 in the Roadmap bundles nine separate things. This is the first split, and it was ordered first
over CI because the repository has no commits and no remote — a workflow file would be a thing that
cannot run against anything, while this is buildable and verifiable today.

## Decision

**Prometheus text exposition, emitted with no dependency.** The same reasoning as the logger
([ADR 0007](0007-dependency-free-structured-logging.md)): the format is text and a counter is a number.
A client library would bring a dependency tree to do string concatenation and addition, and this
project's one durable advantage is that its production dependencies are `express`, `zod` and a Redis
client.

**Not OpenTelemetry**, which the Roadmap named. OTel is a large dependency tree, needs a collector to be
useful, and is push-based — three things to operate before the first number appears. Its real advantage
is distributed tracing across services, and ShopSage is one service talking to four dependencies whose
own traces it does not own. When there is a second service, tracing goes behind a port and this stays.

**Instrumentation as decorators around ports, applied in the composition root.** This is the hexagonal
arrangement paying a dividend that was not the reason for it. The domain declared `LanguageModel`,
`KnowledgeRetriever`, `CommerceCatalogue`, `CommerceCart` and `ConversationStore`; the composition root
chooses what satisfies them, so it can supply implementations that count. `assistant-core` imports
nothing about metrics, no adapter carries a registry, and **no existing test double had to change.**

**Counters and histograms only.** No gauges: a gauge is a value at scrape time and needs something to
sample it, and everything worth knowing here is cumulative or a distribution. No summaries: quantiles
computed per-process cannot be aggregated across replicas, so they lie exactly when it matters.

**Cardinality is bounded by construction.** Every label value comes from a fixed set. The route label is
an **allow-list** — not `req.path`, which is attacker-controlled, and not `req.route`, which is empty for
exactly the 404s and rejections that matter most. A thousand requests to `/aaa1`…`/aaa1000` produce one
series labelled `other`.

**The endpoint is off by default and guarded when on.** The payload says how many customers asked
questions, what the store spent, and which dependencies are failing: a business intelligence feed for a
competitor and a map of what is broken for anybody probing. `METRICS_ENABLED` with no `METRICS_TOKEN`
is a **boot failure**, not an open endpoint — the same rule as `CONVERSATION_STORE` and the commerce
connector: where a wrong guess is invisible, refuse to guess.

**Mounted outside `/v1` and outside the rate limiter.** A scraper is not a customer: it holds an operator
credential rather than a session token, must not compete with customer traffic for a rate-limit bucket,
and should not break the day `/v1` becomes `/v2`.

**The middleware is mounted first, before anything that can reject.** A request refused by the limiter or
the authenticator is exactly the request worth counting, and middleware mounted after the gate never sees
it.

## Consequences

**The first scrape found two things immediately.** Three chat turns, all `200`, and the metrics said all
three were **ungrounded** and one retrieval had **failed** — because the knowledge collection was not
ingested in that container. Readiness already said `knowledge-collection:down`, but nothing connected
that to the answers customers were getting. That connection is the whole point.

**Time to first token is now a number.** Measured 2.5s to first delta against a 3.6s streamed turn, and
3.7s for a buffered one that shows nothing until it finishes. Stage 7a's entire argument, previously
supported by one hand-timed observation, is now a histogram.

**`usage` needed handling the type said was impossible.** `LlmCompletion.usage` is required, and the
adapter normalises a gateway that omits it to **zeroes** — correct for the adapter, wrong to feed into a
histogram, because a deployment with `LLM_STREAM_INCLUDE_USAGE=false` would show a token distribution
sitting entirely at zero and read as "calls are free". Recording is skipped when `totalTokens` is zero,
and the gap stays detectable without a metric for it: `llm_tokens_per_call_count` diverging from
`dependency_calls_total{dependency="llm"}` _is_ the count of calls with no usage reported.

**Counters are per-process, and that is correct rather than a limitation.** Prometheus scrapes each
replica and sums; this is unlike the rate limiter, whose per-replica state is a real imprecision an
operator has to divide around.

**`site` is a constant label, and it will need revisiting.** One value per process today, which is what
makes a label this useful also safe. Multi-store hosting — a `SiteProfileProvider` resolving per request
— would make it per-request, and the cardinality argument has to be redone then.

**Metrics are not derived from logs, deliberately.** That alternative needs no plumbing at all and was
genuinely tempting. It permanently couples metric names to log message strings, so rewording a log line
silently breaks a dashboard — the same class of failure as the redactor eating its own field name in
Stage 9a. Metrics and logs have different lifetimes and should not be welded together.

**The composition root was split into four files.** It had grown past the 250-line limit again, and the
limit was right: `build-commerce.js`, `build-health.js` and the extracted `buildOutboundClients` /
`buildAssistant` each read as one idea, where the single function had stopped doing so.

**Nothing alerts.** These are metrics, not alerting rules. A falling grounded rate is now visible and
still nobody is told about it, which is decision 8's other half and a Stage 10d task.

## Alternatives considered

**OpenTelemetry.** Covered above: the dependency and the collector buy distributed tracing, which needs
more than one service to be worth anything.

**A `prom-client` dependency.** Would give bucket arithmetic and escaping. Both are short enough to write
with the reasoning visible, and the escaping is four lines. Rejected on the same grounds as a logging
library in Stage 1 — and, unlike then, there is now a nine-stage precedent for the choice paying off.

**Deriving metrics from the log stream.** Rejected above.

**Instrumenting inside each adapter.** Would put a metrics dependency into six packages and make every
one of their test doubles carry it. The decorator approach puts it in one.

**Serving `/metrics` unauthenticated on the main port**, as most exporters do. That convention assumes a
private network where the scrape port is not routable. This service is internet-facing by design, and the
convention's assumption does not hold.

**A separate port for metrics**, which would let a firewall do the guarding. Genuinely better in
Kubernetes and worse everywhere else — a second listener to configure, health-check and shut down
gracefully. A bearer token works in both, and the port split can be added later without changing what is
emitted.
