import assert from 'node:assert/strict';
import { createMetricsRegistry } from '@shopsage/platform';
import { describe, it } from 'node:test';
import { createInstruments } from '../src/observability/create-instruments.js';
import { instrumentAssistant } from '../src/observability/instrument-assistant.js';
import {
  instrumentCart,
  instrumentCommerce,
  instrumentModel,
  instrumentRetriever,
  instrumentStore,
  observePorts,
} from '../src/observability/instrument-ports.js';

function build() {
  const registry = createMetricsRegistry();

  return { registry, instruments: createInstruments(registry) };
}

/**
 * @param {number} promptTokens
 * @param {number} completionTokens
 */
const usage = (promptTokens, completionTokens) => ({
  promptTokens,
  completionTokens,
  totalTokens: promptTokens + completionTokens,
});

describe('the language model, instrumented', () => {
  it('counts tokens by kind and total per call', async () => {
    const { registry, instruments } = build();
    const model = instrumentModel({
      modelName: 'gpt-4o-mini',
      instruments,
      model: {
        generate: () =>
          Promise.resolve({
            content: 'x',
            toolCalls: [],
            finishReason: /** @type {const} */ ('stop'),
            usage: usage(238, 62),
          }),
        // eslint-disable-next-line require-yield
        async *stream() {
          throw new Error('not used');
        },
      },
    });

    await model.generate([]);

    const rendered = registry.render();

    assert.match(rendered, /llm_tokens_total\{kind="prompt",model="gpt-4o-mini"\} 238/u);
    assert.match(rendered, /llm_tokens_total\{kind="completion",model="gpt-4o-mini"\} 62/u);
    assert.match(rendered, /llm_tokens_per_call_count\{model="gpt-4o-mini"\} 1/u);
  });

  it('counts tokens from a stream, off the terminal end event', async () => {
    const { registry, instruments } = build();
    const model = instrumentModel({
      modelName: 'm',
      instruments,
      model: {
        generate: () => Promise.reject(new Error('not used')),
        async *stream() {
          yield { type: /** @type {const} */ ('delta'), text: 'hi' };
          yield {
            type: /** @type {const} */ ('end'),
            completion: {
              content: 'hi',
              toolCalls: [],
              finishReason: /** @type {const} */ ('stop'),
              usage: usage(10, 5),
            },
          };
        },
      },
    });

    // The `end` event carries the same completion a buffered call returns, which is why one recording
    // function serves both paths (docs/adr/0011).
    for await (const event of model.stream([])) void event;

    assert.match(registry.render(), /llm_tokens_total\{kind="prompt",model="m"\} 10/u);
  });

  it('yields every event through, unchanged', async () => {
    const { instruments } = build();
    const events = [
      { type: /** @type {const} */ ('delta'), text: 'a' },
      { type: /** @type {const} */ ('delta'), text: 'b' },
    ];
    const model = instrumentModel({
      modelName: 'm',
      instruments,
      model: {
        generate: () => Promise.reject(new Error('x')),
        async *stream() {
          yield* events;
        },
      },
    });

    const seen = [];

    for await (const event of model.stream([])) seen.push(event);

    // A decorator that changed what flowed through would be a bug in the value path rather than in the
    // observation, which is why every recording sits outside it.
    assert.deepEqual(seen, events);
  });

  it('re-throws a failure and counts it', async () => {
    const { registry, instruments } = build();
    const model = instrumentModel({
      modelName: 'm',
      instruments,
      model: {
        generate: () => Promise.reject(new Error('gateway down')),
        // eslint-disable-next-line require-yield
        async *stream() {
          throw new Error('gateway down');
        },
      },
    });

    await assert.rejects(model.generate([]), /gateway down/u);
    await assert.rejects(async () => {
      for await (const event of model.stream([])) void event;
    }, /gateway down/u);

    const rendered = registry.render();

    assert.match(
      rendered,
      /dependency_calls_total\{dependency="llm",operation="generate",outcome="error"\} 1/u,
    );
    assert.match(
      rendered,
      /dependency_calls_total\{dependency="llm",operation="stream",outcome="error"\} 1/u,
    );
  });

  it('records no tokens when the gateway reported none', async () => {
    // Not a hypothetical: `LLM_STREAM_INCLUDE_USAGE=false` exists for gateways that reject
    // `stream_options`, and the adapter normalises the missing usage to zeroes.
    const { registry, instruments } = build();
    const model = instrumentModel({
      modelName: 'm',
      instruments,
      model: {
        // Zeroes, which is what the adapter produces when a gateway reports no usage.
        generate: () =>
          Promise.resolve({
            content: 'x',
            toolCalls: [],
            finishReason: /** @type {const} */ ('stop'),
            usage: usage(0, 0),
          }),
        // eslint-disable-next-line require-yield
        async *stream() {
          throw new Error('x');
        },
      },
    });

    await model.generate([]);

    // A gateway that omits usage must not be recorded as zero tokens: zero is a claim about cost, and
    // "we do not know" is a different one.
    assert.ok(!/llm_tokens_total\{[^}]*\} /u.test(registry.render()));
  });
});

describe('retrieval, instrumented', () => {
  it('counts an empty result apart from a found one', async () => {
    const { registry, instruments } = build();
    const empty = instrumentRetriever({
      instruments,
      retriever: { retrieve: () => Promise.resolve([]) },
    });
    const found = instrumentRetriever({
      instruments,
      retriever: { retrieve: () => Promise.resolve([/** @type {any} */ ({ id: 'a' })]) },
    });

    await empty.retrieve(/** @type {any} */ ({}));
    await found.retrieve(/** @type {any} */ ({}));

    // An empty retrieval is not an error, but its rate is the leading indicator for the grounded rate
    // falling — and it moves first.
    const rendered = registry.render();

    assert.match(rendered, /dependency="retrieval",operation="retrieve",outcome="empty"\} 1/u);
    assert.match(rendered, /dependency="retrieval",operation="retrieve",outcome="found"\} 1/u);
  });
});

describe('the stores and connectors, instrumented', () => {
  it('labels each operation, passing values through', async () => {
    const { registry, instruments } = build();
    const store = instrumentStore({
      instruments,
      store: {
        history: () => Promise.resolve([/** @type {any} */ ({ role: 'user' })]),
        append: () => Promise.resolve(),
      },
    });

    const history = await store.history(/** @type {any} */ ({}));

    assert.equal(history.length, 1);
    assert.match(
      registry.render(),
      /dependency="conversations",operation="history",outcome="ok"\} 1/u,
    );
  });

  it('counts a cart write apart from a product read', async () => {
    const { registry, instruments } = build();
    const commerce = instrumentCommerce({
      instruments,
      commerce: {
        searchProducts: () => Promise.resolve([]),
        findProduct: () => Promise.resolve(undefined),
        listOrders: () => Promise.resolve([]),
      },
    });
    const cart = instrumentCart({
      instruments,
      cart: {
        addToCart: () => Promise.resolve({ applied: true }),
        applyCoupon: () => Promise.resolve({ applied: true }),
      },
    });

    await commerce.searchProducts({ query: 'x' });
    await cart.addToCart({ lines: [], idempotencyKey: 'k' });

    // A failing cart write is money not taken; a failing product search is an answer not given. They are
    // different alerts, so they are different series.
    const rendered = registry.render();

    assert.match(rendered, /dependency="commerce",operation="searchProducts"/u);
    assert.match(rendered, /dependency="cart",operation="addToCart"/u);
  });
});

describe('the assistant, instrumented', () => {
  /**
   * @param {any} reply
   * @param {ReturnType<typeof createInstruments>} instruments
   */
  const assistantReturning = (reply, instruments) =>
    instrumentAssistant({
      instruments,
      noAnswerMessage: 'I could not find that.',
      assistant: {
        answer: () => Promise.resolve(reply),
        async *answerStream() {
          yield { type: /** @type {const} */ ('delta'), text: 'hi' };
          yield { type: /** @type {const} */ ('done'), reply };
        },
      },
    });

  it('tells grounded, ungrounded and no-answer apart', async () => {
    const { registry, instruments } = build();
    const base = { conversationId: 'c', messageId: 'm', sources: [], finishReason: 'stop' };

    await assistantReturning(
      { ...base, answer: 'From the docs.', grounded: true },
      instruments,
    ).answer({ message: 'x' });
    await assistantReturning({ ...base, answer: 'Hello.', grounded: false }, instruments).answer({
      message: 'x',
    });
    await assistantReturning(
      { ...base, answer: 'I could not find that.', grounded: false },
      instruments,
    ).answer({ message: 'x' });

    // The number nothing else in the system could give: an assistant returning the store's no-answer copy
    // to every question is indistinguishable from a healthy one if all you have is status codes.
    const rendered = registry.render();

    assert.match(rendered, /assistant_turns_total\{mode="buffered",outcome="grounded"\} 1/u);
    assert.match(rendered, /assistant_turns_total\{mode="buffered",outcome="ungrounded"\} 1/u);
    assert.match(rendered, /assistant_turns_total\{mode="buffered",outcome="no_answer"\} 1/u);
  });

  it('counts a failed turn rather than leaving a hole', async () => {
    const { registry, instruments } = build();
    const assistant = instrumentAssistant({
      instruments,
      noAnswerMessage: 'n',
      assistant: {
        answer: () => Promise.reject(new Error('gateway down')),
        // eslint-disable-next-line require-yield
        async *answerStream() {
          throw new Error('gateway down');
        },
      },
    });

    await assert.rejects(assistant.answer({ message: 'x' }), /gateway down/u);

    // Without this a gateway outage is a hole in the turn count, and a hole is not something an alert can
    // be written against.
    assert.match(registry.render(), /assistant_turns_total\{mode="buffered",outcome="failed"\} 1/u);
  });

  it('times to the first delta, not the first event', async () => {
    const { registry, instruments } = build();
    const reply = {
      conversationId: 'c',
      messageId: 'm',
      answer: 'hi',
      sources: [],
      finishReason: 'stop',
      grounded: false,
    };
    const assistant = assistantReturning(reply, instruments);

    for await (const event of assistant.answerStream({ message: 'x' })) void event;

    // `start` arrives before any model call, so timing to it would measure nothing. The first delta is
    // the moment the customer stops looking at a spinner.
    assert.match(registry.render(), /assistant_time_to_first_token_ms_count 1/u);
    assert.match(
      registry.render(),
      /assistant_turns_total\{mode="streamed",outcome="ungrounded"\} 1/u,
    );
  });

  it('counts an abandoned stream as its own outcome', async () => {
    const { registry, instruments } = build();
    const assistant = instrumentAssistant({
      instruments,
      noAnswerMessage: 'n',
      assistant: {
        answer: () => Promise.reject(new Error('x')),
        async *answerStream() {
          yield { type: /** @type {const} */ ('delta'), text: 'partial' };
          yield { type: /** @type {const} */ ('delta'), text: ' more' };
        },
      },
    });

    // Stop consuming early, which is what a closed tab looks like.
    for await (const event of assistant.answerStream({ message: 'x' })) {
      void event;
      break;
    }

    // Ordinary once, a signal at volume: `abandoned` over `streamed` is the ratio that says whether
    // customers are giving up or a proxy is cutting connections.
    assert.match(
      registry.render(),
      /assistant_turns_total\{mode="streamed",outcome="abandoned"\} 1/u,
    );
  });

  it('counts tool executions by name and phase', async () => {
    const { registry, instruments } = build();
    const assistant = instrumentAssistant({
      instruments,
      noAnswerMessage: 'n',
      assistant: {
        answer: () => Promise.reject(new Error('x')),
        async *answerStream() {
          yield { type: /** @type {const} */ ('tool'), name: 'searchKnowledge', phase: 'started' };
          yield { type: /** @type {const} */ ('tool'), name: 'searchKnowledge', phase: 'finished' };
          yield {
            type: /** @type {const} */ ('done'),
            reply: /** @type {any} */ ({
              conversationId: 'c',
              messageId: 'm',
              answer: 'a',
              sources: [],
              finishReason: 'stop',
              grounded: true,
            }),
          };
        },
      },
    });

    for await (const event of assistant.answerStream({ message: 'x' })) void event;

    assert.match(
      registry.render(),
      /tool_rounds_total\{phase="finished",tool="searchKnowledge"\} 1/u,
    );
  });

  it('counts a prepared cart proposal', async () => {
    const { registry, instruments } = build();
    const reply = /** @type {any} */ ({
      conversationId: 'c',
      messageId: 'm',
      answer: 'prepared',
      sources: [],
      finishReason: 'stop',
      grounded: false,
      proposal: { id: 'cp_x', kind: 'addToCart' },
    });

    await assistantReturning(reply, instruments).answer({ message: 'x' });

    // The proposal's kind, never its id or its contents — a coupon proposal carries a working code.
    assert.match(registry.render(), /cart_proposals_total\{kind="addToCart",stage="prepared"\} 1/u);
    assert.ok(!registry.render().includes('cp_x'));
  });
});

describe('observePorts', () => {
  it('hands back exactly what arrived when metrics are off', () => {
    const model = /** @type {any} */ ({ generate: () => {}, stream: () => {} });
    const retriever = /** @type {any} */ ({ retrieve: () => {} });
    const store = /** @type {any} */ ({ history: () => {}, append: () => {} });

    const observed = observePorts({
      metrics: undefined,
      modelName: 'm',
      model,
      retriever,
      store,
      commerce: undefined,
      cart: undefined,
    });

    // Identity, not equality. A disabled feature that still allocates a wrapper per port is a feature you
    // find out about from a profiler.
    assert.equal(observed.model, model);
    assert.equal(observed.retriever, retriever);
    assert.equal(observed.store, store);
  });

  it('leaves an absent commerce port absent', () => {
    const { instruments } = build();
    const observed = observePorts({
      metrics: { instruments },
      modelName: 'm',
      model: /** @type {any} */ ({}),
      retriever: /** @type {any} */ ({}),
      store: /** @type {any} */ ({}),
      commerce: undefined,
      cart: undefined,
    });

    assert.equal(observed.commerce, undefined);
    assert.equal(observed.cart, undefined);
  });
});
