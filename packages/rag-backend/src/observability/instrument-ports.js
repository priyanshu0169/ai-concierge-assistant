/**
 * Instrumentation as **decorators around ports**, applied in the composition root.
 *
 * This is the hexagonal arrangement paying a dividend that was not the reason for it. The domain
 * declared `LanguageModel`, `KnowledgeRetriever`, `CommerceCatalogue` and `ConversationStore`; the
 * composition root chooses what satisfies them. So it can supply an implementation that counts, and
 * `assistant-core` never learns that metrics exist — no metrics import, no registry threaded through a
 * tool context, no test double that has to know about counters.
 *
 * The alternative was instrumenting inside each adapter, which would put a metrics dependency into six
 * packages and make every one of their test doubles carry it. The alternative *after that* was deriving
 * metrics from the log stream, which needs no plumbing at all and permanently couples metric names to
 * log message strings — so a reworded log line silently breaks a dashboard. Metrics and logs have
 * different lifetimes and should not be welded together.
 *
 * A decorator that throws must not change behaviour, so every recording sits outside the value path: the
 * wrapped call's result and its exceptions pass through untouched.
 */

/**
 * @param {number} startedAt
 * @returns {number}
 */
function since(startedAt) {
  return Date.now() - startedAt;
}

/**
 * Record a call's outcome without changing it.
 *
 * `outcome` is `ok` or `error` and never the error's message or class. An error message is
 * attacker-influenced in the general case and unbounded in every case, and "which dependency is
 * failing" is answered by the dependency label.
 *
 * @template T
 * @param {{
 *   instruments: import('./create-instruments.js').Instruments,
 *   dependency: string,
 *   operation: string,
 * }} context
 * @param {() => Promise<T>} call
 * @returns {Promise<T>}
 */
async function timed(context, call) {
  const startedAt = Date.now();
  const labels = { dependency: context.dependency, operation: context.operation };

  try {
    const result = await call();

    context.instruments.dependencyCalls.add({ ...labels, outcome: 'ok' });
    context.instruments.dependencyDuration.observe(since(startedAt), labels);

    return result;
  } catch (error) {
    context.instruments.dependencyCalls.add({ ...labels, outcome: 'error' });
    context.instruments.dependencyDuration.observe(since(startedAt), labels);

    throw error;
  }
}

/**
 * The language model, counting tokens and rounds.
 *
 * `stream()` is wrapped as a generator that yields through. The `end` event carries the same
 * `LlmCompletion` a buffered call returns (docs/adr/0011), which is why one recording function serves
 * both paths — the same property that let the tool loop serve both.
 *
 * @param {{
 *   model: import('@shopsage/assistant-core').LanguageModel,
 *   instruments: import('./create-instruments.js').Instruments,
 *   modelName: string,
 * }} input
 * @returns {import('@shopsage/assistant-core').LanguageModel}
 */
export function instrumentModel(input) {
  const { model, instruments, modelName } = input;

  /**
   * Tokens, recorded only when the gateway actually reported them.
   *
   * `usage` is never absent — the adapter normalises a missing one to zeroes so callers never branch on
   * presence (see `parse-usage.js`). That is right for the adapter and wrong to feed straight into a
   * histogram: a gateway with usage reporting off would produce a token distribution sitting entirely at
   * zero, which reads as "calls are free" rather than "we do not know". Zero total tokens on a call that
   * returned content is not a measurement.
   *
   * The gap stays detectable without a metric for it: `llm_tokens_per_call_count` diverging from
   * `dependency_calls_total{dependency="llm"}` is exactly the count of calls with no usage reported.
   *
   * @param {import('@shopsage/llm-client').LlmCompletion} completion
   */
  const recordTokens = (completion) => {
    const usage = completion.usage;

    if (usage.totalTokens === 0) return;

    instruments.llmTokens.add({ model: modelName, kind: 'prompt' }, usage.promptTokens);
    instruments.llmTokens.add({ model: modelName, kind: 'completion' }, usage.completionTokens);
    instruments.llmTokensPerCall.observe(usage.totalTokens, { model: modelName });
  };

  return {
    async generate(messages, options) {
      const completion = await timed(
        { instruments, dependency: 'llm', operation: 'generate' },
        () => model.generate(messages, options),
      );

      recordTokens(completion);

      return completion;
    },

    async *stream(messages, options) {
      const startedAt = Date.now();
      const labels = { dependency: 'llm', operation: 'stream' };

      try {
        for await (const event of model.stream(messages, options)) {
          if (event.type === 'end') recordTokens(event.completion);

          yield event;
        }

        instruments.dependencyCalls.add({ ...labels, outcome: 'ok' });
      } catch (error) {
        // Counted separately from a completed stream, because a stream that failed **after** yielding
        // text is a different operational event from one that never started - the customer saw a partial
        // answer either way, and the retry policy differs (docs/adr/0012).
        instruments.dependencyCalls.add({ ...labels, outcome: 'error' });

        throw error;
      } finally {
        instruments.dependencyDuration.observe(since(startedAt), labels);
      }
    },
  };
}

/**
 * Retrieval, counting empty results separately.
 *
 * An empty retrieval is not an error and must not be counted as one — but its **rate** is the leading
 * indicator for the grounded rate falling, and it moves first. A rising `empty` count with a flat error
 * count means the corpus has drifted away from what customers are asking, which is an ingestion problem
 * wearing a retrieval costume.
 *
 * @param {{
 *   retriever: import('@shopsage/assistant-core').KnowledgeRetriever,
 *   instruments: import('./create-instruments.js').Instruments,
 * }} input
 * @returns {import('@shopsage/assistant-core').KnowledgeRetriever}
 */
export function instrumentRetriever(input) {
  return {
    async retrieve(query) {
      const chunks = await timed(
        { instruments: input.instruments, dependency: 'retrieval', operation: 'retrieve' },
        () => input.retriever.retrieve(query),
      );

      input.instruments.dependencyCalls.add({
        dependency: 'retrieval',
        operation: 'retrieve',
        outcome: chunks.length === 0 ? 'empty' : 'found',
      });

      return chunks;
    },
  };
}

/**
 * @param {{
 *   store: import('@shopsage/assistant-core').ConversationStore,
 *   instruments: import('./create-instruments.js').Instruments,
 * }} input
 * @returns {import('@shopsage/assistant-core').ConversationStore}
 */
export function instrumentStore(input) {
  const { store, instruments } = input;

  return {
    history: (query) =>
      timed({ instruments, dependency: 'conversations', operation: 'history' }, () =>
        store.history(query),
      ),
    append: (input_) =>
      timed({ instruments, dependency: 'conversations', operation: 'append' }, () =>
        store.append(input_),
      ),
  };
}

/**
 * @param {{
 *   commerce: import('@shopsage/assistant-core').CommerceCatalogue,
 *   instruments: import('./create-instruments.js').Instruments,
 * }} input
 * @returns {import('@shopsage/assistant-core').CommerceCatalogue}
 */
export function instrumentCommerce(input) {
  const { commerce, instruments } = input;
  /** @param {string} operation */
  const context = (operation) => ({ instruments, dependency: 'commerce', operation });

  return {
    searchProducts: (query) =>
      timed(context('searchProducts'), () => commerce.searchProducts(query)),
    findProduct: (query) => timed(context('findProduct'), () => commerce.findProduct(query)),
    listOrders: (query) => timed(context('listOrders'), () => commerce.listOrders(query)),
  };
}

/**
 * The cart, kept as its own decorator for the same reason the port is its own port.
 *
 * A write's outcome is worth counting separately from a read's: `dependency="cart"` is the series an
 * alert should watch, because a failing cart write is money not taken while a failing product search is
 * an answer not given.
 *
 * @param {{
 *   cart: import('@shopsage/assistant-core').CommerceCart,
 *   instruments: import('./create-instruments.js').Instruments,
 * }} input
 * @returns {import('@shopsage/assistant-core').CommerceCart}
 */
export function instrumentCart(input) {
  const { cart, instruments } = input;

  return {
    addToCart: (query) =>
      timed({ instruments, dependency: 'cart', operation: 'addToCart' }, () =>
        cart.addToCart(query),
      ),
    applyCoupon: (query) =>
      timed({ instruments, dependency: 'cart', operation: 'applyCoupon' }, () =>
        cart.applyCoupon(query),
      ),
  };
}

/**
 * Wrap every port, or hand back exactly what arrived.
 *
 * One function rather than five ternaries in the composition root, and it earns its place by making the
 * off case obvious: with metrics disabled this returns its input unchanged, so there is no registry, no
 * counter and no wrapper object on the request path. A disabled feature that still does its work is a
 * feature you discover from a profiler.
 *
 * @param {{
 *   metrics: { instruments: import('./create-instruments.js').Instruments } | undefined,
 *   modelName: string,
 *   model: import('@shopsage/assistant-core').LanguageModel,
 *   retriever: import('@shopsage/assistant-core').KnowledgeRetriever,
 *   store: import('@shopsage/assistant-core').ConversationStore,
 *   commerce: import('@shopsage/assistant-core').CommerceCatalogue | undefined,
 *   cart: import('@shopsage/assistant-core').CommerceCart | undefined,
 * }} input
 */
export function observePorts(input) {
  const { metrics, model, retriever, store, commerce, cart } = input;

  if (metrics === undefined) return { model, retriever, store, commerce, cart };

  const instruments = metrics.instruments;

  return {
    model: instrumentModel({ model, instruments, modelName: input.modelName }),
    retriever: instrumentRetriever({ retriever, instruments }),
    store: instrumentStore({ store, instruments }),
    commerce: commerce === undefined ? undefined : instrumentCommerce({ commerce, instruments }),
    cart: cart === undefined ? undefined : instrumentCart({ cart, instruments }),
  };
}
