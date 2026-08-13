import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createConversationManager } from '../src/conversation/create-conversation-manager.js';
import { createMemoryConversationStore } from '../src/conversation/memory-conversation-store.js';
import { bufferedRounds, streamedRounds } from '../src/conversation/model-rounds.js';
import { runToolLoop } from '../src/conversation/run-tool-loop.js';
import { createToolRegistry } from '../src/tools/tool-registry.js';
import {
  collect,
  createFakeModel,
  createFailingModel,
  createFakeRetriever,
  createRecordingLogger,
  testChunk,
  testProfile,
  toolCall,
} from './helpers/domain-doubles.js';

/**
 * @param {{
 *   script?: import('./helpers/domain-doubles.js').ScriptedRound[],
 *   chunks?: import('../src/types.js').RetrievedChunk[],
 *   profile?: Record<string, unknown>,
 *   logger?: import('@shopsage/platform').Logger,
 * }} [options]
 */
function buildAssistant(options = {}) {
  const siteProfile = testProfile(options.profile);
  const model = createFakeModel(options.script ?? [{ content: 'An answer.' }]);
  const retriever = createFakeRetriever(options.chunks);
  const store = createMemoryConversationStore();

  return {
    model,
    retriever,
    store,
    siteProfile,
    assistant: createConversationManager({
      model,
      retriever,
      store,
      siteProfile,
      logger: options.logger,
    }),
  };
}

describe('createConversationManager', () => {
  it('answers and returns the published reply shape', async () => {
    const { assistant } = buildAssistant();

    const reply = await assistant.answer({ message: 'Hello?' });

    assert.match(reply.conversationId, /^c_[0-9a-f]{32}$/);
    assert.match(reply.messageId, /^m_[0-9a-f]{32}$/);
    assert.equal(reply.answer, 'An answer.');
    assert.equal(reply.finishReason, 'stop');
  });

  it('continues the conversation the caller named', async () => {
    const { assistant } = buildAssistant();

    const reply = await assistant.answer({ conversationId: 'c_existing', message: 'Hi.' });

    assert.equal(reply.conversationId, 'c_existing');
  });

  it('issues a distinct message id per turn', async () => {
    const { assistant } = buildAssistant();

    const first = await assistant.answer({ message: 'One.' });
    const second = await assistant.answer({ message: 'Two.' });

    assert.notEqual(first.messageId, second.messageId);
  });

  describe('the prompt it builds', () => {
    it('resolves identity placeholders, so no store name is hard-coded', async () => {
      const { assistant, model } = buildAssistant();

      await assistant.answer({ message: 'Who are you?' });

      const system = model.calls[0].messages[0];
      assert.equal(system.role, 'system');
      assert.match(system.content, /You are Sage for Demo Store/);
    });

    it('describes the tool protocol without duplicating the store grounding rules', async () => {
      // A store owns its voice through prompts.systemPrompt; no store should have to
      // discover by trial that it must describe its own tool-calling protocol.
      const { assistant, model } = buildAssistant();

      await assistant.answer({ message: 'Hi.' });

      assert.match(model.calls[0].messages[0].content, /searchKnowledge/);
    });

    it('puts the customer question last, where a model attends most reliably', async () => {
      const { assistant, model } = buildAssistant();

      await assistant.answer({ message: 'The actual question.' });

      const messages = model.calls[0].messages;
      assert.deepEqual(messages.at(-1), { role: 'user', content: 'The actual question.' });
    });

    it('offers the enabled tools to the model', async () => {
      const { assistant, model } = buildAssistant();

      await assistant.answer({ message: 'Hi.' });

      assert.deepEqual(
        model.calls[0].options.tools.map((/** @type {any} */ tool) => tool.name),
        ['searchKnowledge'],
      );
    });

    it('offers no tools when the store has disabled knowledge search', async () => {
      const { assistant, model } = buildAssistant({
        profile: { features: { knowledgeSearch: false } },
      });

      await assistant.answer({ message: 'Hi.' });

      assert.equal(model.calls[0].options.tools, undefined);
      assert.ok(!model.calls[0].messages[0].content.includes('searchKnowledge'));
    });
  });

  describe('history', () => {
    it('sends earlier turns on a follow-up question', async () => {
      const { assistant, model } = buildAssistant();

      const first = await assistant.answer({ message: 'What is your return window?' });
      await assistant.answer({
        conversationId: first.conversationId,
        message: 'And for sale items?',
      });

      const messages = model.calls.at(-1)?.messages ?? [];
      const roles = messages.map((/** @type {any} */ entry) => entry.role);

      assert.deepEqual(roles, ['system', 'user', 'assistant', 'user']);
      assert.equal(messages[1].content, 'What is your return window?');
    });

    it('keeps conversations separate', async () => {
      const { assistant, model } = buildAssistant();

      await assistant.answer({ conversationId: 'c_one', message: 'First conversation.' });
      await assistant.answer({ conversationId: 'c_two', message: 'Second conversation.' });

      const messages = model.calls.at(-1)?.messages ?? [];
      assert.equal(messages.length, 2, 'a different conversation must start clean');
    });

    it('bounds history by the profile setting, which bounds prompt cost', async () => {
      const { assistant, model } = buildAssistant({
        profile: { conversation: { maxHistoryMessages: 2 } },
      });

      for (const message of ['one', 'two', 'three']) {
        await assistant.answer({ conversationId: 'c_long', message });
      }

      const messages = model.calls.at(-1)?.messages ?? [];
      // system + 2 history turns + the new question.
      assert.equal(messages.length, 4);
    });

    it('does not persist a turn whose answer failed', async () => {
      // A question the assistant never addressed is not history, and the next turn
      // would be built on that gap.
      // The model itself fails, not a tool: a tool failure is deliberately survivable.
      const { store, siteProfile, retriever } = buildAssistant();
      const assistant = createConversationManager({
        model: createFailingModel(new Error('gateway down')),
        retriever,
        store,
        siteProfile,
      });

      await assert.rejects(() => assistant.answer({ conversationId: 'c_x', message: 'Hi.' }));

      const history = await store.history({
        siteId: 'demo-store',
        conversationId: 'c_x',
        limit: 10,
      });
      assert.deepEqual(history, []);
    });

    it('fails the turn when history cannot be read', async () => {
      // Answering a follow-up with no memory reads as the assistant being stupid rather
      // than as a broken dependency, and a customer cannot tell the difference. An error
      // is honest, and it is retryable.
      const { model, retriever, siteProfile } = buildAssistant();
      const assistant = createConversationManager({
        model,
        retriever,
        siteProfile,
        store: {
          history: () => Promise.reject(new Error('conversation store down')),
          append: () => Promise.resolve(),
        },
      });

      await assert.rejects(() => assistant.answer({ message: 'And internationally?' }));
      assert.equal(model.calls.length, 0, 'the gateway must not be paid for a doomed turn');
    });

    it('still answers when the turn cannot be recorded', async () => {
      // The opposite trade, for the opposite reason: by this point the answer exists and
      // on the streaming path has already been rendered. Turning that into a 502 throws
      // away work the customer can see, to report a problem they cannot act on.
      const { logger, records } = createRecordingLogger();
      const { model, retriever, siteProfile } = buildAssistant({
        script: [{ content: 'Thirty days.' }],
      });
      const assistant = createConversationManager({
        model,
        retriever,
        siteProfile,
        logger,
        store: {
          history: () => Promise.resolve([]),
          append: () => Promise.reject(new Error('conversation store down')),
        },
      });

      const reply = await assistant.answer({ message: 'How long for returns?' });

      assert.equal(reply.answer, 'Thirty days.');
      assert.equal(
        records.find((record) => record.msg === 'conversation turn was not recorded')?.level,
        'error',
      );
      assert.equal(records.at(-1)?.persisted, false);
    });

    it('reports a recorded turn as recorded', async () => {
      const { logger, records } = createRecordingLogger();
      const { assistant } = buildAssistant({ logger });

      await assistant.answer({ message: 'Hi.' });

      assert.equal(records.at(-1)?.persisted, true);
    });
  });

  describe('grounding', () => {
    it('cites sources when the answer came from retrieved content', async () => {
      const { assistant } = buildAssistant({
        script: [
          { toolCalls: [toolCall('searchKnowledge', { query: 'returns' })] },
          { content: 'Thirty days, unopened.' },
        ],
      });

      const reply = await assistant.answer({ message: 'How long for returns?' });

      assert.equal(reply.grounded, true);
      assert.deepEqual(reply.sources, [
        { title: 'Returns policy', url: 'https://example.com/help/returns' },
      ]);
    });

    it('cites nothing when the model answered without searching', async () => {
      // Citing a page the model did not use lends borrowed authority to an answer that
      // came from its own knowledge - the exact failure retrieval exists to prevent.
      const { assistant } = buildAssistant({ script: [{ content: 'Probably thirty days.' }] });

      const reply = await assistant.answer({ message: 'How long for returns?' });

      assert.equal(reply.grounded, false);
      assert.deepEqual(reply.sources, []);
    });

    it('substitutes the store no-answer copy for an empty answer', async () => {
      const { assistant } = buildAssistant({ script: [{ content: '   ' }] });

      const reply = await assistant.answer({ message: 'Hi.' });

      assert.equal(reply.answer, 'I could not find that in our store information.');
    });

    it('reports a truncated answer honestly', async () => {
      const { assistant } = buildAssistant({
        script: [{ content: 'A long answer that ran', finishReason: 'length' }],
      });

      assert.equal((await assistant.answer({ message: 'Explain.' })).finishReason, 'length');
    });
  });

  describe('answerStream', () => {
    /**
     * @template {import('../src/types.js').AssistantStreamEvent['type']} T
     * @param {import('../src/types.js').AssistantStreamEvent[]} events
     * @param {T} type
     * @returns {Extract<import('../src/types.js').AssistantStreamEvent, { type: T }>[]}
     */
    const only = (events, type) =>
      /** @type {any} */ (events.filter((event) => event.type === type));

    /** @param {Parameters<typeof buildAssistant>[0]} [options] */
    async function streamTurn(options) {
      const built = buildAssistant(options);
      /** @type {import('../src/types.js').AssistantStreamEvent[]} */
      const events = [];

      for await (const event of built.assistant.answerStream({
        message: 'How long for returns?',
      })) {
        events.push(event);
      }

      return { ...built, events };
    }

    it('leads with start, so a lost connection still leaves a usable id', async () => {
      const { events } = await streamTurn();
      const [first] = events;

      assert.equal(first.type, 'start');
      assert.match(first.conversationId, /^c_[0-9a-f]{32}$/);
      assert.match(first.messageId, /^m_[0-9a-f]{32}$/);
    });

    it('ends with exactly one done event', async () => {
      const { events } = await streamTurn();

      assert.equal(only(events, 'done').length, 1);
      assert.equal(events.at(-1)?.type, 'done');
    });

    it('reuses the id from start in done, so either event is enough', async () => {
      const { events } = await streamTurn();
      const start = events[0];
      const done = events.at(-1);

      assert.equal(
        start.type === 'start' && start.conversationId,
        done?.type === 'done' && done.reply.conversationId,
      );
      assert.equal(
        start.type === 'start' && start.messageId,
        done?.type === 'done' && done.reply.messageId,
      );
    });

    it('streams the answer in fragments that reassemble to done.answer', async () => {
      const { events } = await streamTurn({ script: [{ content: 'Thirty days, unopened.' }] });
      const done = events.at(-1);
      const streamed = only(events, 'delta')
        .map((event) => event.text)
        .join('');

      assert.equal(streamed, 'Thirty days, unopened.');
      assert.equal(done?.type === 'done' && done.reply.answer, streamed);
    });

    it('agrees with the buffered path on the same question', async () => {
      // The property that stops two delivery modes becoming two products. Same script,
      // same retrieved content, same answer and citations - only the delivery differs.
      const script = [
        { toolCalls: [toolCall('searchKnowledge', { query: 'returns' })] },
        { content: 'Thirty days, unopened.' },
      ];

      const buffered = await buildAssistant({ script }).assistant.answer({ message: 'Returns?' });
      const { events } = await streamTurn({ script });
      const done = events.at(-1);

      assert.ok(done?.type === 'done');
      assert.equal(done.reply.answer, buffered.answer);
      assert.deepEqual(done.reply.sources, buffered.sources);
      assert.equal(done.reply.grounded, buffered.grounded);
    });

    it('puts the no-answer message in done when the model returned no prose', async () => {
      // The reason done.answer is authoritative rather than the deltas: there are none
      // here, and a renderer trusting deltas alone would show an empty bubble.
      const { events } = await streamTurn({ script: [{ content: '' }] });
      const done = events.at(-1);

      assert.deepEqual(only(events, 'delta'), []);
      assert.equal(
        done?.type === 'done' && done.reply.answer,
        'I could not find that in our store information.',
      );
    });

    it('persists the streamed turn, so the next question has history', async () => {
      const { store, events } = await streamTurn({ script: [{ content: 'Thirty days.' }] });
      const start = events[0];

      const history = await store.history({
        siteId: 'demo-store',
        conversationId: start.type === 'start' ? start.conversationId : '',
        limit: 10,
      });

      assert.deepEqual(
        history.map((turn) => [turn.role, turn.content]),
        [
          ['user', 'How long for returns?'],
          ['assistant', 'Thirty days.'],
        ],
      );
    });

    it('persists what the customer saw, including any narration before a tool call', async () => {
      // A model may say "let me check that" and then search. Those tokens were rendered,
      // so the stored turn is the whole thing rather than the final round alone.
      const { store, events } = await streamTurn({
        script: [
          { content: 'Let me check. ', toolCalls: [toolCall('searchKnowledge', { query: 'r' })] },
          { content: 'Thirty days.' },
        ],
      });
      const start = events[0];

      const history = await store.history({
        siteId: 'demo-store',
        conversationId: start.type === 'start' ? start.conversationId : '',
        limit: 10,
      });

      assert.equal(history.at(-1)?.content, 'Let me check. Thirty days.');
    });

    it('does not persist an abandoned turn', async () => {
      // A stream can be cut anywhere, including mid-sentence or before a single token.
      // Storing a fragment would replay it to the model on the next question.
      const { logger, records } = createRecordingLogger();
      const { assistant, store } = buildAssistant({
        script: [{ content: 'A long answer in many pieces.' }],
        logger,
      });

      for await (const event of assistant.answerStream({
        conversationId: 'c_gone',
        message: 'Q',
      })) {
        // Walk away after the first token, the way a closed tab does.
        if (event.type === 'delta') break;
      }

      assert.deepEqual(
        await store.history({ siteId: 'demo-store', conversationId: 'c_gone', limit: 10 }),
        [],
      );

      const abandoned = records.at(-1);
      assert.equal(abandoned?.msg, 'assistant turn abandoned');
      assert.equal(abandoned?.persisted, false);
    });

    it('records an abandoned turn as ordinary, not as a failure', async () => {
      // A closed tab is normal customer behaviour. Filing it at `warn` or `error` buries
      // real failures under it, and this one was found that way: an abort produced an
      // error record with a stack trace on every abandoned chat.
      const { logger, records } = createRecordingLogger();
      const { assistant } = buildAssistant({ script: [{ content: 'Many pieces here.' }], logger });

      for await (const event of assistant.answerStream({ message: 'Q' })) {
        if (event.type === 'delta') break;
      }

      assert.deepEqual(
        records.filter((record) => ['warn', 'error', 'fatal'].includes(record.level)),
        [],
      );
      assert.equal(records.at(-1)?.level, 'info');
    });
  });
});

describe('runToolLoop', () => {
  /**
   * @param {import('./helpers/domain-doubles.js').ScriptedRound[]} script
   * @param {{
   *   chunks?: import('../src/types.js').RetrievedChunk[],
   *   streaming?: boolean,
   *   retrievalFails?: boolean,
   * }} [options]
   */
  async function runLoop(script, options = {}) {
    const siteProfile = testProfile();
    const model = createFakeModel(script);
    const retriever = createFakeRetriever(options.chunks, {
      ...(options.retrievalFails ? { failWith: new Error('vector store down') } : {}),
    });
    const rounds = options.streaming ? streamedRounds : bufferedRounds;

    const drained = await collect(
      runToolLoop({
        runRound: rounds(model),
        registry: createToolRegistry(siteProfile),
        messages: [{ role: 'user', content: 'Question.' }],
        toolContext: { siteId: 'demo-store', siteProfile, retriever },
      }),
    );

    return { model, retriever, ...drained };
  }

  it('returns immediately when the model answers without a tool', async () => {
    const { result } = await runLoop([{ content: 'Direct answer.' }]);

    assert.equal(result.rounds, 0);
    assert.equal(result.exhausted, false);
    assert.deepEqual(result.chunks, []);
  });

  it('executes a tool and feeds the result back', async () => {
    const { result, model, retriever } = await runLoop([
      { toolCalls: [toolCall('searchKnowledge', { query: 'returns' })] },
      { content: 'Thirty days.' },
    ]);

    assert.equal(result.rounds, 1);
    assert.equal(retriever.queries[0].text, 'returns');

    const secondCall = model.calls[1].messages;
    assert.equal(secondCall.at(-1).role, 'tool');
    assert.match(secondCall.at(-1).content, /Store knowledge base excerpts/);
    assert.equal(result.chunks.length, 1);
  });

  it('lets the model search again after a miss, which single-shot RAG cannot', async () => {
    // The payoff of tool calling over a hard-wired retrieve-then-answer flow.
    const { result, retriever } = await runLoop([
      { toolCalls: [toolCall('searchKnowledge', { query: 'first attempt' })] },
      { toolCalls: [toolCall('searchKnowledge', { query: 'rephrased' })] },
      { content: 'Found it.' },
    ]);

    assert.equal(result.rounds, 2);
    assert.deepEqual(
      retriever.queries.map((query) => query.text),
      ['first attempt', 'rephrased'],
    );
  });

  it('withdraws tools on the final round, forcing prose', async () => {
    // A model will occasionally call the same tool forever; nothing else would stop it.
    const { result, model } = await runLoop([
      { toolCalls: [toolCall('searchKnowledge', { query: 'again' })], content: 'partial' },
    ]);

    assert.equal(result.exhausted, true);
    assert.equal(model.calls.at(-1)?.options.tools, undefined);
  });

  it('tells the model when it invents a tool name, naming what exists', async () => {
    const { model } = await runLoop([
      { toolCalls: [toolCall('searchProducts', { query: 'shoes' })] },
      { content: 'Recovered.' },
    ]);

    const toolResult = model.calls[1].messages.at(-1);
    assert.match(toolResult.content, /Unknown tool "searchProducts"/);
    assert.match(toolResult.content, /searchKnowledge/);
  });

  it('turns a tool failure into a tool result, not a failed request', async () => {
    const { result, model } = await runLoop(
      [
        { toolCalls: [toolCall('searchKnowledge', { query: 'x' })] },
        { content: 'Could not look that up.' },
      ],
      { retrievalFails: true },
    );

    assert.equal(result.completion.content, 'Could not look that up.');
    assert.match(model.calls[1].messages.at(-1).content, /tool failed/);
  });

  it('tells the model plainly when retrieval found nothing', async () => {
    // The model must distinguish "nothing is there" from "the tool broke": the first
    // should produce an honest no-answer.
    const { model } = await runLoop(
      [{ toolCalls: [toolCall('searchKnowledge', { query: 'x' })] }, { content: 'Not found.' }],
      { chunks: [] },
    );

    const toolResult = model.calls[1].messages.at(-1);
    assert.match(toolResult.content, /No relevant content found/);
    assert.match(toolResult.content, /Do not guess/);
  });

  it('rejects an empty tool query as a tool result the model can retry', async () => {
    const { model, retriever } = await runLoop([
      { toolCalls: [toolCall('searchKnowledge', { query: '  ' })] },
      { content: 'Asked again.' },
    ]);

    assert.equal(retriever.queries.length, 0);
    assert.match(model.calls[1].messages.at(-1).content, /No query was provided/);
  });

  it('accumulates chunks across rounds', async () => {
    const { result } = await runLoop(
      [
        { toolCalls: [toolCall('searchKnowledge', { query: 'one' })] },
        { toolCalls: [toolCall('searchKnowledge', { query: 'two' })] },
        { content: 'Done.' },
      ],
      { chunks: [testChunk()] },
    );

    assert.equal(result.chunks.length, 2);
  });

  describe('progress events', () => {
    it('emits nothing at all in buffered mode', async () => {
      // The buffered path must not pay for a feature it cannot use: `generate()` is one
      // request, not a stream with the deltas discarded.
      const { events } = await runLoop([
        { toolCalls: [toolCall('searchKnowledge', { query: 'x' })] },
        { content: 'Answer.' },
      ]);

      assert.deepEqual(
        events.filter((event) => event.type === 'delta'),
        [],
      );
    });

    it('emits deltas in streaming mode, and they reassemble to the answer', async () => {
      const { events, result } = await runLoop([{ content: 'Thirty days, unopened.' }], {
        streaming: true,
      });
      const deltas = events.filter((event) => event.type === 'delta');

      // More than one, or the fixture is not exercising streaming at all.
      assert.ok(deltas.length > 1, `expected fragmentation, got ${deltas.length} delta(s)`);
      assert.equal(result.emittedText, 'Thirty days, unopened.');
      assert.equal(deltas.map((event) => event.text).join(''), result.emittedText);
    });

    it('brackets each tool execution, so a caller can show the wait', async () => {
      // The gap between a question and the first token is a whole retrieval round.
      // Without this the connection looks hung.
      const { events } = await runLoop(
        [{ toolCalls: [toolCall('searchKnowledge', { query: 'returns' })] }, { content: 'Done.' }],
        { streaming: true },
      );

      assert.deepEqual(
        events.filter((event) => event.type === 'tool'),
        [
          { type: 'tool', name: 'searchKnowledge', phase: 'started' },
          { type: 'tool', name: 'searchKnowledge', phase: 'finished' },
        ],
      );
    });

    it('reports a failed tool as failed, not finished', async () => {
      const { events } = await runLoop(
        [{ toolCalls: [toolCall('searchKnowledge', { query: 'x' })] }, { content: 'Sorry.' }],
        { streaming: true, retrievalFails: true },
      );

      assert.deepEqual(
        events.filter((event) => event.type === 'tool').map((event) => event.phase),
        ['started', 'failed'],
      );
    });

    it('drops empty deltas rather than forwarding gateway noise', async () => {
      // The first event of an OpenAI-compatible stream carries the role and no content.
      const { events } = await runLoop([{ content: 'Hi.', deltas: ['', 'Hi', '', '.'] }], {
        streaming: true,
      });

      assert.deepEqual(
        events.filter((event) => event.type === 'delta').map((event) => event.text),
        ['Hi', '.'],
      );
    });

    it('fails loudly if a stream ends without a completion', async () => {
      // Silently answering with nothing would look like a model that had nothing to say.
      const truncated = {
        generate: () => Promise.reject(new Error('unused')),
        // eslint-disable-next-line require-yield
        async *stream() {
          return;
        },
      };

      await assert.rejects(
        () =>
          collect(
            runToolLoop({
              runRound: streamedRounds(truncated),
              registry: createToolRegistry(testProfile()),
              messages: [{ role: 'user', content: 'Question.' }],
              toolContext: {
                siteId: 'demo-store',
                siteProfile: testProfile(),
                retriever: createFakeRetriever(),
              },
            }),
          ),
        /without a completion/,
      );
    });
  });
});

describe('createMemoryConversationStore', () => {
  it('returns nothing for an unknown conversation', async () => {
    const store = createMemoryConversationStore();

    assert.deepEqual(
      await store.history({ siteId: 'demo-store', conversationId: 'c_none', limit: 10 }),
      [],
    );
  });

  it('appends and reads back in order', async () => {
    const store = createMemoryConversationStore();
    const turns = [
      { role: /** @type {const} */ ('user'), content: 'Q', at: '2026-01-01T00:00:00.000Z' },
      { role: /** @type {const} */ ('assistant'), content: 'A', at: '2026-01-01T00:00:01.000Z' },
    ];

    await store.append({ siteId: 'demo-store', conversationId: 'c_1', turns });
    const history = await store.history({ siteId: 'demo-store', conversationId: 'c_1', limit: 10 });

    assert.deepEqual(history, turns);
  });

  it('trims from the front, because a question follows what came just before it', async () => {
    const store = createMemoryConversationStore();

    for (const content of ['1', '2', '3', '4']) {
      await store.append({
        siteId: 'demo-store',
        conversationId: 'c_1',
        turns: [{ role: 'user', content, at: '2026-01-01T00:00:00.000Z' }],
      });
    }

    const history = await store.history({ siteId: 'demo-store', conversationId: 'c_1', limit: 2 });
    assert.deepEqual(
      history.map((turn) => turn.content),
      ['3', '4'],
    );
  });

  it('namespaces by site, so two stores never see each other conversations', async () => {
    const store = createMemoryConversationStore();

    await store.append({
      siteId: 'store-a',
      conversationId: 'c_shared',
      turns: [{ role: 'user', content: 'private to a', at: '2026-01-01T00:00:00.000Z' }],
    });

    const fromB = await store.history({
      siteId: 'store-b',
      conversationId: 'c_shared',
      limit: 10,
    });

    assert.deepEqual(fromB, []);
  });

  describe('idle expiry', () => {
    // The same lifetime the Redis store gets from its TTL. Two implementations of one
    // port that expire differently are two products, and the difference surfaces as
    // behaviour a developer cannot reproduce against what production does.

    /** @param {{ idleTimeoutMs?: number }} [options] */
    function storeWithClock(options = {}) {
      let clock = 1_000_000;

      return {
        advance: (/** @type {number} */ ms) => (clock += ms),
        store: createMemoryConversationStore({ ...options, now: () => clock }),
      };
    }

    /** @param {import('../src/types.js').ConversationStore} store */
    const read = (store) =>
      store.history({ siteId: 'demo-store', conversationId: 'c_1', limit: 10 });

    /** @param {import('../src/types.js').ConversationStore} store */
    const write = (store) =>
      store.append({
        siteId: 'demo-store',
        conversationId: 'c_1',
        turns: [{ role: 'user', content: 'Q', at: '2026-01-01T00:00:00.000Z' }],
      });

    it('forgets a conversation that has been idle too long', async () => {
      const { store, advance } = storeWithClock({ idleTimeoutMs: 60_000 });

      await write(store);
      advance(60_001);

      assert.deepEqual(await read(store), []);
    });

    it('keeps one that has not', async () => {
      const { store, advance } = storeWithClock({ idleTimeoutMs: 60_000 });

      await write(store);
      advance(59_999);

      assert.equal((await read(store)).length, 1);
    });

    it('treats the timeout as idle, not as age', async () => {
      // Writing refreshes the clock, so an active conversation never expires under a
      // customer mid-chat.
      const { store, advance } = storeWithClock({ idleTimeoutMs: 60_000 });

      await write(store);
      advance(50_000);
      await write(store);
      advance(50_000);

      assert.equal((await read(store)).length, 2);
    });

    it('starts a fresh conversation rather than resurrecting an expired one', async () => {
      const { store, advance } = storeWithClock({ idleTimeoutMs: 60_000 });

      await write(store);
      advance(60_001);
      await write(store);

      assert.equal((await read(store)).length, 1);
    });

    it('keeps everything for ever when no timeout is configured', async () => {
      const { store, advance } = storeWithClock();

      await write(store);
      advance(10 ** 9);

      assert.equal((await read(store)).length, 1);
    });
  });

  it('warns in production, because it silently breaks with a second replica', () => {
    /** @type {any[]} */
    const warnings = [];
    const logger = /** @type {any} */ ({
      warn: (/** @type {string} */ message, /** @type {any} */ fields) =>
        warnings.push({ message, fields }),
    });

    createMemoryConversationStore({ logger, isProduction: true });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /in-process memory/);
    assert.match(warnings[0].fields.consequence, /some requests will remember/);
  });

  it('stays quiet outside production', () => {
    /** @type {any[]} */
    const warnings = [];
    const logger = /** @type {any} */ ({ warn: (/** @type {any} */ m) => warnings.push(m) });

    createMemoryConversationStore({ logger, isProduction: false });

    assert.deepEqual(warnings, []);
  });
});
