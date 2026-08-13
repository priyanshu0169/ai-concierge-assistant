import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createConversationManager } from '../src/conversation/create-conversation-manager.js';
import { createMemoryConversationStore } from '../src/conversation/memory-conversation-store.js';
import { buildMessages } from '../src/prompt/build-messages.js';
import {
  collect,
  createFakeCommerce,
  createFakeModel,
  createFakeRetriever,
  createRecordingLogger,
  testProfile,
  toolCall,
} from './helpers/domain-doubles.js';

const COMMERCE_PROFILE = { features: { productSearch: true, orderTracking: true } };

/**
 * The system prompt for a turn, as the model would receive it.
 *
 * `LlmMessage.content` is optional on the wire - an assistant message carrying only tool calls has
 * none - so it is narrowed once here rather than at every assertion.
 *
 * @param {import('@shopsage/platform').SiteProfile} siteProfile
 * @param {string[]} toolNames
 * @returns {string}
 */
function systemPromptFor(siteProfile, toolNames) {
  const [system] = buildMessages({ siteProfile, history: [], message: 'anything', toolNames });

  assert.equal(typeof system.content, 'string');

  return String(system.content);
}

/**
 * @param {{
 *   script?: import('./helpers/domain-doubles.js').ScriptedRound[],
 *   commerce?: any,
 *   profile?: Record<string, unknown>,
 * }} [options]
 */
function buildAssistant(options = {}) {
  const siteProfile = testProfile(options.profile ?? COMMERCE_PROFILE);
  const store = createMemoryConversationStore();
  const commerce = options.commerce ?? createFakeCommerce();
  const model = createFakeModel(options.script ?? [{ content: 'An answer.' }]);
  const { logger, records } = createRecordingLogger();

  return {
    model,
    store,
    commerce,
    records,
    siteProfile,
    assistant: createConversationManager({
      model,
      retriever: createFakeRetriever(),
      store,
      commerce,
      siteProfile,
      logger,
    }),
  };
}

describe('a commerce question, end to end through the domain', () => {
  it('forwards the session token from the request to the connector', async () => {
    const { assistant, commerce } = buildAssistant({
      script: [
        { toolCalls: [toolCall('searchProducts', { query: 'wool hoodie' })] },
        { content: 'We have a merino hoodie at £120.00.' },
      ],
    });

    await assistant.answer({
      message: 'do you sell wool hoodies?',
      scopes: ['chat'],
      credential: 'header.body.signature',
    });

    assert.equal(commerce.calls[0].method, 'searchProducts');
    assert.equal(commerce.calls[0].credential, 'header.body.signature');
  });

  it('never writes the session token to a log line', async () => {
    const { assistant, records } = buildAssistant({
      script: [
        { toolCalls: [toolCall('searchProducts', { query: 'x' })] },
        { content: 'An answer.' },
      ],
    });

    await assistant.answer({
      message: 'anything?',
      scopes: ['chat'],
      credential: 'secret.token.value',
      metadata: { requestId: 'req-1' },
    });

    assert.ok(records.length > 0);
    assert.ok(!JSON.stringify(records).includes('secret.token.value'));
  });

  it('turns a connector outage into an answer rather than a failed request', async () => {
    const { assistant } = buildAssistant({
      commerce: createFakeCommerce({ failWith: new Error('ECONNREFUSED 10.0.0.4:443') }),
      script: [
        { toolCalls: [toolCall('searchProducts', { query: 'hoodie' })] },
        { content: 'I could not check our stock just now, sorry.' },
      ],
    });

    // The chosen degradation: a connector failure is a conversational outcome, not a 502. The
    // customer gets a reply; the operator gets the error in the log.
    const reply = await assistant.answer({ message: 'got hoodies?', scopes: ['chat'] });

    assert.equal(reply.answer, 'I could not check our stock just now, sorry.');
  });

  it('logs the connector failure so an outage is not invisible', async () => {
    const { assistant, records } = buildAssistant({
      commerce: createFakeCommerce({ failWith: new Error('ECONNREFUSED 10.0.0.4:443') }),
      script: [
        { toolCalls: [toolCall('searchProducts', { query: 'hoodie' })] },
        { content: 'Sorry.' },
      ],
    });

    await assistant.answer({ message: 'got hoodies?', scopes: ['chat'] });

    const failure = records.find((entry) => entry.msg === 'tool execution failed');

    assert.ok(failure, 'the failure should be recorded');
    assert.equal(failure.tool, 'searchProducts');
  });

  it('reports the failure to the model as a tool result it can act on', async () => {
    const { assistant } = buildAssistant({
      commerce: createFakeCommerce({ failWith: new Error('down') }),
      script: [
        { toolCalls: [toolCall('searchProducts', { query: 'hoodie' })] },
        { content: 'Sorry.' },
      ],
    });

    const { events } = await collect(
      assistant.answerStream({ message: 'got hoodies?', scopes: ['chat'] }),
    );

    assert.deepEqual(
      events.filter((event) => event.type === 'tool'),
      [
        { type: 'tool', name: 'searchProducts', phase: 'started' },
        { type: 'tool', name: 'searchProducts', phase: 'failed' },
      ],
    );
  });

  it('tells the model a failure is an outage, not an empty result', async () => {
    const { assistant, model } = buildAssistant({
      commerce: createFakeCommerce({ failWith: new Error('ECONNREFUSED') }),
      script: [
        { toolCalls: [toolCall('searchProducts', { query: 'wool hoodie' })] },
        { content: 'I could not check just now.' },
      ],
    });

    await assistant.answer({ message: 'got wool hoodies?', scopes: ['chat'] });

    // Real finding: told only that the tool "failed", a live model answered "I could not find any
    // wool hoodies" - which a customer reads as "the store does not sell them", about a store that
    // does. A failed lookup and an empty result are different facts.
    const toolResult = model.calls[1].messages.at(-1);

    assert.equal(toolResult.role, 'tool');
    assert.match(String(toolResult.content), /this is an outage, not an empty result/u);
    assert.match(
      String(toolResult.content),
      /do not say or imply that what they asked about does not exist/u,
    );
  });

  it('sends the model to searchKnowledge after a commerce outage, instead of ending the turn', async () => {
    // The defect this pins cost a live deployment every product-discovery answer it had. With the
    // commerce connector unreachable, "what kinds of caviar does Marky's sell?" routed to
    // searchProducts, which threw - and the failure message told the model "Do not retry it" and
    // handed it a ready-made apology. It obeyed: it never consulted a knowledge base holding 887
    // product and category pages that answered the question, and replied "I couldn't check".
    //
    // A failed *live* lookup says nothing about whether the store's website describes what was
    // asked about, so the message must redirect rather than conclude.
    const { assistant, model } = buildAssistant({
      commerce: createFakeCommerce({ failWith: new Error('ECONNREFUSED') }),
      script: [
        { toolCalls: [toolCall('searchProducts', { query: 'caviar' })] },
        { content: 'I could not check just now.' },
      ],
    });

    await assistant.answer({ message: 'what kinds of caviar do you sell?', scopes: ['chat'] });

    const toolResult = String(model.calls[1].messages.at(-1).content);

    assert.match(toolResult, /call searchKnowledge/u);
    // The instruction that ended the turn must not come back.
    assert.doesNotMatch(toolResult, /Do not retry it/u);
    // The freshness rule has to survive the redirection: indexed pages carry stale prices.
    assert.match(toolResult, /[Nn]ever state a price or stock level/u);
  });

  it('never mentions trackOrder to a guest session', async () => {
    const { assistant, model } = buildAssistant({ script: [{ content: 'Please sign in.' }] });

    await assistant.answer({ message: 'where is my order?', scopes: ['chat'] });

    // Read off the prompt the model was actually given, through the real turn - not off the registry.
    // A tool the session cannot use must be absent from the prompt too, or the model will offer it.
    const systemPrompt = String(model.calls[0].messages[0].content);

    assert.ok(!systemPrompt.includes('trackOrder'));
    assert.ok(systemPrompt.includes('searchProducts'));
  });

  it('names only the live tools the session actually holds in the money rules', () => {
    // Caught a real regression: the price-provenance rule was written with the commerce tools
    // hard-coded, so a guest read "quote prices only as ... or trackOrder returned them" about a
    // tool absent from their registry. Naming a capability the model does not have is how it comes
    // to offer one (docs/adr/0022) - the same reason this file's other test reads the prompt rather
    // than the registry.
    const guest = buildMessages({
      siteProfile: testProfile(),
      history: [],
      message: 'how much is it?',
      toolNames: ['searchKnowledge', 'searchProducts', 'compareProducts'],
    });
    const prompt = String(guest[0].content);

    assert.match(prompt, /only as searchProducts or compareProducts returned them/u);
    assert.ok(!prompt.includes('trackOrder'));
    // The knowledge exclusion is the point of the rule and must survive whatever the tool set is.
    assert.match(
      prompt,
      /Never take a price, a stock level or a delivery date from searchKnowledge/u,
    );
  });

  it('offers trackOrder once the session holds the scope', async () => {
    const { assistant, model } = buildAssistant({ script: [{ content: 'Let me check.' }] });

    await assistant.answer({ message: 'where is my order?', scopes: ['chat', 'orders'] });

    assert.ok(String(model.calls[0].messages[0].content).includes('trackOrder'));
  });
});

describe('what gets written into conversation history', () => {
  it('removes an email address a customer typed', async () => {
    const { assistant, store, siteProfile } = buildAssistant();

    const reply = await assistant.answer({
      message: 'email me at sam.taylor@example.com when it ships',
      scopes: ['chat'],
    });

    const history = await store.history({
      siteId: siteProfile.identity.siteId,
      conversationId: reply.conversationId,
      limit: 10,
    });

    assert.equal(history[0].content, 'email me at [removed] when it ships');
  });

  it("removes it from the assistant's reply too, not only the question", async () => {
    // An assistant repeats what it was told - "just to confirm, that was sam@example.com?" - so
    // redacting one side would leave the same string one message further down.
    const { assistant, store, siteProfile } = buildAssistant({
      script: [{ content: 'Confirming sam.taylor@example.com for you.' }],
    });

    const reply = await assistant.answer({ message: 'is that right?', scopes: ['chat'] });
    const history = await store.history({
      siteId: siteProfile.identity.siteId,
      conversationId: reply.conversationId,
      limit: 10,
    });

    assert.equal(history[1].content, 'Confirming [removed] for you.');
  });

  it('still delivers the unredacted answer to the customer', async () => {
    // Redaction is a retention control, not an output filter. The customer sees the real reply; only
    // the copy that outlives the turn is reduced.
    const { assistant } = buildAssistant({
      script: [{ content: 'Confirming sam.taylor@example.com for you.' }],
    });

    const reply = await assistant.answer({ message: 'is that right?', scopes: ['chat'] });

    assert.equal(reply.answer, 'Confirming sam.taylor@example.com for you.');
  });

  it('records the category removed and never the value', async () => {
    const { assistant, records } = buildAssistant();

    await assistant.answer({ message: 'card 4242 4242 4242 4242', scopes: ['chat'] });

    const entry = records.find((line) => line.msg === 'personal data removed before storing turn');

    assert.ok(entry);
    assert.deepEqual(entry.categories, ['payment card']);
    assert.ok(!JSON.stringify(records).includes('4242 4242 4242 4242'));
  });

  it('says nothing when there was nothing to remove', async () => {
    const { assistant, records } = buildAssistant();

    await assistant.answer({ message: 'do you sell wool hoodies?', scopes: ['chat'] });

    assert.equal(
      records.find((line) => line.msg === 'personal data removed before storing turn'),
      undefined,
    );
  });
});

describe('the rules the platform adds to every commerce prompt', () => {
  it('forbids arithmetic on money whenever a commerce tool is present', () => {
    const prompt = systemPromptFor(testProfile(COMMERCE_PROFILE), [
      'searchKnowledge',
      'searchProducts',
    ]);

    assert.match(prompt, /Never work out a total, a discount, a saving, a tax amount/u);
    assert.match(prompt, /Do no arithmetic on money at all/u);
  });

  it('separates "which is cheaper" from "by how much"', () => {
    const prompt = systemPromptFor(testProfile(COMMERCE_PROFILE), ['compareProducts']);

    // Pinned because the general no-arithmetic rule was **not** enough on its own: asked "which is
    // cheaper and by how much", a real model against the reference connector answered "cheaper by
    // £31.00". A model reads the two halves as one request unless they are separated in as many
    // words. See docs/adr/0028 for what this does and does not guarantee.
    assert.match(prompt, /If asked which of two products is cheaper, name it/u);
    assert.match(prompt, /Never say by how much/u);
    assert.match(prompt, /difference, a percentage or a multiple/u);
  });

  it('forbids asking for personal details', () => {
    const prompt = systemPromptFor(testProfile(COMMERCE_PROFILE), ['trackOrder']);

    assert.match(prompt, /Never ask for an address, email address, phone number/u);
  });

  it('says nothing about prices to a knowledge-only store', () => {
    // Prompt text describing capabilities the model does not have invites it to invent them.
    const prompt = systemPromptFor(testProfile(), ['searchKnowledge']);

    assert.ok(!prompt.includes('arithmetic'));
  });

  it('keeps the wording the store wrote for itself intact', () => {
    const prompt = systemPromptFor(testProfile(COMMERCE_PROFILE), ['searchProducts']);

    assert.match(prompt, /^You are Sage for Demo Store\./u);
  });
});
