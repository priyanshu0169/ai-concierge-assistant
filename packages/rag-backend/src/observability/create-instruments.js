import { LATENCY_BUCKETS_MS, TOKEN_BUCKETS } from '@shopsage/platform';

/**
 * Every metric this service emits, declared in one place.
 *
 * One file rather than a declaration next to each call site, and the reason is that the **set** is the
 * interesting thing. A reader asking "what can I actually see about this service?" gets an answer here,
 * and a reviewer asking "does anything here have unbounded cardinality?" can check it in one pass.
 *
 * Six questions an operator has, and the metrics that answer them:
 *
 * 1. **Is it up and serving?** `http_requests_total` by route and status.
 * 2. **Is it answering *well*?** `assistant_turns_total` by outcome — grounded, ungrounded, no-answer.
 *    This is the one nothing else could tell you: an assistant returning the fallback message for
 *    every question looks perfectly healthy from an HTTP status code.
 * 3. **Is it fast?** `http_request_duration_ms`, and `assistant_time_to_first_token_ms` for streams,
 *    which is the number a customer actually experiences.
 * 4. **What does it cost?** `llm_tokens_total` by model and kind, plus a distribution.
 * 5. **Is a dependency struggling?** `dependency_calls_total` by dependency and outcome.
 * 6. **Is anyone abusing it?** `requests_rejected_total` by reason.
 *
 * **Every label value comes from a fixed set.** No conversation id, no subject, no query text, no sku, no
 * error message. That is not caution about privacy alone - one series per conversation would put the
 * monitoring system down before it put anything else down.
 *
 * @param {import('@shopsage/platform').MetricsRegistry} registry
 */
export function createInstruments(registry) {
  return {
    httpRequests: registry.counter({
      name: 'http_requests_total',
      help: 'HTTP requests, by matched route and status code.',
    }),
    httpDuration: registry.histogram({
      name: 'http_request_duration_ms',
      help: 'Time to serve an HTTP request, in milliseconds.',
      buckets: LATENCY_BUCKETS_MS,
    }),

    /**
     * The quality signal, and the reason this stage exists.
     *
     * `grounded` is deliberately **not** in the API response (it would become a contract a client
     * branched on) and has only ever been in a log line. As an aggregate it is the single most useful
     * number about this service: a falling grounded rate means retrieval is degrading, and nothing else
     * in the system would say so.
     */
    assistantTurns: registry.counter({
      name: 'assistant_turns_total',
      help: 'Completed assistant turns, by delivery mode and outcome.',
    }),
    assistantDuration: registry.histogram({
      name: 'assistant_turn_duration_ms',
      help: 'Time to complete an assistant turn, in milliseconds.',
      buckets: LATENCY_BUCKETS_MS,
    }),
    /**
     * What the customer experiences, as distinct from what the server does.
     *
     * A streamed turn takes the same total time as a buffered one; the difference is that the buffered
     * endpoint spends four of those seconds showing nothing. This is the number that difference lives
     * in, so a regression in it is a regression nobody would see in total latency.
     */
    timeToFirstToken: registry.histogram({
      name: 'assistant_time_to_first_token_ms',
      help: 'Time from a streamed request arriving to its first delta, in milliseconds.',
      buckets: LATENCY_BUCKETS_MS,
    }),
    toolRounds: registry.counter({
      name: 'assistant_tool_rounds_total',
      help: 'Tool executions, by tool name and outcome.',
    }),
    cartProposals: registry.counter({
      name: 'cart_proposals_total',
      help: 'Cart changes, by kind and stage: prepared, applied, rejected or gone.',
    }),

    llmTokens: registry.counter({
      name: 'llm_tokens_total',
      help: 'Tokens billed, by model and kind (prompt or completion).',
    }),
    llmTokensPerCall: registry.histogram({
      name: 'llm_tokens_per_call',
      help: 'Total tokens per gateway call, by model.',
      buckets: TOKEN_BUCKETS,
    }),

    /**
     * Dependencies, as one family with a `dependency` label rather than one metric each.
     *
     * A dashboard wants "which dependency is failing", which is a query over one family. Separate
     * metrics per dependency would need the panel rewritten every time one is added.
     */
    dependencyCalls: registry.counter({
      name: 'dependency_calls_total',
      help: 'Outbound calls, by dependency, operation and outcome.',
    }),
    dependencyDuration: registry.histogram({
      name: 'dependency_call_duration_ms',
      help: 'Time for an outbound call, in milliseconds.',
      buckets: LATENCY_BUCKETS_MS,
    }),

    rejected: registry.counter({
      name: 'requests_rejected_total',
      help: 'Requests refused before doing work, by reason.',
    }),
  };
}

/** @typedef {ReturnType<typeof createInstruments>} Instruments */
