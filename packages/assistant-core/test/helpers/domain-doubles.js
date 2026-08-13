import { createLogger, parseSiteProfile } from '@shopsage/platform';

/**
 * The **real** logger, writing to memory.
 *
 * A hand-written fake would have to reimplement levels, child bindings and redaction, and
 * would then be asserted against instead of the thing that ships. The sink receives a
 * serialized line - which is the point, since it means an assertion runs against the
 * record that would actually be shipped, redaction included.
 *
 * @returns {{ logger: import('@shopsage/platform').Logger, records: any[] }}
 */
export function createRecordingLogger() {
  /** @type {any[]} */
  const records = [];

  return {
    records,
    logger: createLogger({
      level: 'trace',
      sink: { write: (line) => records.push(JSON.parse(line)) },
    }),
  };
}

/**
 * A site profile through the **real** parser.
 *
 * A hand-written object would drift from the schema and skip the defaults, and the
 * defaults are where most of the assistant's behaviour comes from.
 *
 * @param {Record<string, unknown>} [overrides]
 * @returns {import('@shopsage/platform').SiteProfile}
 */
export function testProfile(overrides = {}) {
  return parseSiteProfile({
    identity: { siteId: 'demo-store', companyName: 'Demo Store', assistantName: 'Sage' },
    prompts: {
      systemPrompt: 'You are {{assistantName}} for {{companyName}}. Answer only from context.',
      welcomeMessage: 'Hi.',
      fallbackMessage: 'Something went wrong.',
      noAnswerMessage: 'I could not find that in our store information.',
    },
    integrations: { backendUrl: 'https://assistant.example.com' },
    ...overrides,
  });
}

/**
 * @param {Partial<import('../../src/types.js').RetrievedChunk>} [overrides]
 * @returns {import('../../src/types.js').RetrievedChunk}
 */
export function testChunk(overrides = {}) {
  return {
    id: 'doc_a#0',
    score: 0.8,
    text: 'Unopened items may be returned within thirty days of delivery.',
    title: 'Returns policy',
    url: 'https://example.com/help/returns',
    ...overrides,
  };
}

/**
 * A retriever returning a fixed result, recording what it was asked.
 *
 * `failWith` covers the vector-store-is-down case through the same double, so a test that
 * asserts a failure can still inspect what was asked before it failed.
 *
 * @param {import('../../src/types.js').RetrievedChunk[]} [chunks]
 * @param {{ failWith?: Error }} [options]
 * @returns {import('../../src/types.js').KnowledgeRetriever & { queries: any[] }}
 */
export function createFakeRetriever(chunks = [testChunk()], options = {}) {
  /** @type {any[]} */
  const queries = [];

  return {
    queries,
    retrieve(query) {
      queries.push(query);

      return options.failWith === undefined
        ? Promise.resolve(chunks)
        : Promise.reject(options.failWith);
    },
  };
}

/**
 * One scripted round. `deltas` overrides how `stream()` fragments the content, which is
 * how a test pins behaviour that only appears when text arrives in pieces.
 *
 * @typedef {Partial<import('@shopsage/llm-client').LlmCompletion> & { deltas?: string[] }} ScriptedRound
 */

/**
 * A language model driven by a script of completions, recording every call.
 *
 * Each entry is one turn's response. A `toolCalls` entry drives the loop round again,
 * which is how multi-round behaviour is asserted without a real model.
 *
 * `generate` and `stream` answer from the **same** script on purpose: a test can assert
 * the two delivery modes agree on a given scenario, which is the property that stops them
 * drifting into two products.
 *
 * @param {ScriptedRound[]} script
 * @returns {import('../../src/types.js').LanguageModel & {
 *   calls: { messages: any[], options: any }[],
 * }}
 */
export function createFakeModel(script) {
  /** @type {{ messages: any[], options: any }[]} */
  const calls = [];

  // The last entry repeats if the loop asks for more turns than the script covers.
  const record = (/** @type {any} */ messages, /** @type {any} */ options) => {
    calls.push({ messages, options });
    return script[Math.min(calls.length - 1, script.length - 1)] ?? {};
  };

  return {
    calls,

    generate(messages, options = {}) {
      return Promise.resolve(toCompletion(record(messages, options)));
    },

    async *stream(messages, options = {}) {
      const step = record(messages, options);

      for (const text of step.deltas ?? asWords(step.content ?? '')) {
        yield { type: 'delta', text };
      }

      yield { type: 'end', completion: toCompletion(step) };
    },
  };
}

/**
 * A model that fails the same way whichever delivery mode asks it.
 *
 * @param {Error} error
 * @returns {import('../../src/types.js').LanguageModel}
 */
export function createFailingModel(error) {
  return {
    generate: () => Promise.reject(error),

    // eslint-disable-next-line require-yield
    async *stream() {
      throw error;
    },
  };
}

/**
 * @param {ScriptedRound} step
 * @returns {import('@shopsage/llm-client').LlmCompletion}
 */
function toCompletion(step) {
  return {
    content: step.content ?? '',
    toolCalls: step.toolCalls ?? [],
    finishReason: step.finishReason ?? 'stop',
    usage: step.usage ?? { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  };
}

/**
 * Fragment text the way a gateway does - many small pieces, whitespace attached - so a
 * consumer that assumes one delta per response fails here rather than in production.
 *
 * @param {string} content
 * @returns {string[]}
 */
function asWords(content) {
  return content.length === 0 ? [] : content.split(/(?<=\s)/u);
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {import('@shopsage/llm-client').LlmToolCall}
 */
export function toolCall(name, args) {
  return { id: `call_${name}`, name, arguments: args };
}

/**
 * Drain an async generator, keeping both what it yielded and what it returned.
 *
 * `for await` discards a generator's return value, and the tool loop's return value is
 * the result every caller needs - so tests drive it by hand, exactly as the conversation
 * manager does.
 *
 * @template Y, R
 * @param {AsyncGenerator<Y, R>} generator
 * @returns {Promise<{ events: Y[], result: R }>}
 */
export async function collect(generator) {
  /** @type {Y[]} */
  const events = [];
  let step = await generator.next();

  while (!step.done) {
    events.push(step.value);
    step = await generator.next();
  }

  return { events, result: step.value };
}

/**
 * @param {Partial<import('../../src/types.js').Product>} [overrides]
 * @returns {import('../../src/types.js').Product}
 */
export function testProduct(overrides = {}) {
  return {
    sku: 'HD-MRN-NVY-L',
    name: 'Merino wool hoodie, navy, large',
    url: 'https://example.com/p/merino-hoodie',
    summary: 'Mid-weight merino, machine washable.',
    price: { formatted: '£120.00', amount: '120.00', currency: 'GBP', taxIncluded: true },
    availability: 'in_stock',
    ...overrides,
  };
}

/**
 * @param {Partial<import('../../src/types.js').Order>} [overrides]
 * @returns {import('../../src/types.js').Order}
 */
export function testOrder(overrides = {}) {
  return {
    reference: 'ORD-100482',
    status: 'shipped',
    statusLabel: 'Shipped',
    placedAt: '2026-07-14',
    estimatedDelivery: '2026-07-31',
    trackingUrl: 'https://example.com/track/ORD-100482',
    items: [{ name: 'Merino wool hoodie, navy, large', quantity: 1, sku: 'HD-MRN-NVY-L' }],
    ...overrides,
  };
}

/**
 * A commerce connector returning fixed results, recording every call.
 *
 * Records `credential` alongside each call, because "the session token was forwarded and nothing
 * else was done with it" is a property worth asserting rather than assuming.
 *
 * @param {{
 *   products?: import('../../src/types.js').Product[],
 *   orders?: import('../../src/types.js').Order[],
 *   failWith?: Error,
 * }} [options]
 * @returns {import('../../src/types.js').CommerceCatalogue & { calls: any[] }}
 */
export function createFakeCommerce(options = {}) {
  /** @type {any[]} */
  const calls = [];
  const products = options.products ?? [testProduct()];

  /** @type {<T>(value: T) => Promise<T>} */
  const answer = (value) =>
    options.failWith === undefined ? Promise.resolve(value) : Promise.reject(options.failWith);

  return {
    calls,

    searchProducts(query) {
      calls.push({ method: 'searchProducts', ...query });

      return answer(products.slice(0, query.limit ?? products.length));
    },

    findProduct(query) {
      calls.push({ method: 'findProduct', ...query });

      return answer(products.find((product) => product.sku === query.sku));
    },

    listOrders(query) {
      calls.push({ method: 'listOrders', ...query });

      return answer(options.orders ?? [testOrder()]);
    },
  };
}
