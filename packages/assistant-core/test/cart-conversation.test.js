import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createConversationManager } from '../src/conversation/create-conversation-manager.js';
import { createMemoryConversationStore } from '../src/conversation/memory-conversation-store.js';
import { createMemoryProposalStore } from '../src/conversation/memory-proposal-store.js';
import {
  collect,
  createFakeCommerce,
  createFakeModel,
  createFakeRetriever,
  createRecordingLogger,
  testProfile,
  toolCall,
} from './helpers/domain-doubles.js';

const CART_PROFILE = { features: { productSearch: true, cart: true, coupons: true } };

/**
 * @param {{
 *   script?: import('./helpers/domain-doubles.js').ScriptedRound[],
 *   proposals?: any,
 *   omitProposals?: boolean,
 * }} [options]
 */
function buildAssistant(options = {}) {
  const siteProfile = testProfile(CART_PROFILE);
  const proposals = options.proposals ?? createMemoryProposalStore();
  const model = createFakeModel(options.script ?? [{ content: 'An answer.' }]);
  const { logger, records } = createRecordingLogger();

  return {
    model,
    proposals,
    records,
    siteProfile,
    assistant: createConversationManager({
      model,
      retriever: createFakeRetriever(),
      store: createMemoryConversationStore(),
      commerce: createFakeCommerce(),
      ...(options.omitProposals === true ? {} : { proposals }),
      siteProfile,
      logger,
    }),
  };
}

const ADD_THEN_ANSWER = [
  { toolCalls: [toolCall('addToCart', { items: [{ sku: 'HD-MRN-NVY-L', quantity: 1 }] })] },
  { content: 'I have prepared that. Confirm below and I will add it.' },
];

describe('a prepared cart change reaches the reply', () => {
  it('carries the proposal on the buffered reply', async () => {
    const { assistant } = buildAssistant({ script: ADD_THEN_ANSWER });

    const reply = await assistant.answer({
      message: 'add the merino hoodie',
      scopes: ['chat', 'cart'],
      subject: 'ps_customer',
    });

    assert.ok(reply.proposal);
    assert.equal(reply.proposal.kind, 'addToCart');
    assert.equal(reply.proposal.subject, 'ps_customer');
  });

  it('stores it, so the confirmation can find it', async () => {
    const { assistant, proposals, siteProfile } = buildAssistant({ script: ADD_THEN_ANSWER });

    const reply = await assistant.answer({
      message: 'add it',
      scopes: ['chat', 'cart'],
      subject: 'ps_customer',
    });

    const held = await proposals.consume({
      siteId: siteProfile.identity.siteId,
      id: /** @type {string} */ (reply.proposal?.id),
    });

    assert.equal(held?.id, reply.proposal?.id);
  });

  it('yields a proposal event before done on the streamed path', async () => {
    const { assistant } = buildAssistant({ script: ADD_THEN_ANSWER });

    const { events } = await collect(
      assistant.answerStream({ message: 'add it', scopes: ['chat', 'cart'], subject: 'ps_c' }),
    );
    const names = events.map((event) => event.type);

    // Emitted as it happens so the confirmation renders while the model is still writing the sentence
    // that explains it.
    assert.ok(names.indexOf('proposal') < names.indexOf('done'));
    assert.ok(names.indexOf('proposal') > names.indexOf('start'));
  });

  it('repeats it on done, so a buffered caller sees it too', async () => {
    const { assistant } = buildAssistant({ script: ADD_THEN_ANSWER });

    const { events } = await collect(
      assistant.answerStream({ message: 'add it', scopes: ['chat', 'cart'], subject: 'ps_c' }),
    );
    const streamed = events.find((event) => event.type === 'proposal');
    const done = events.find((event) => event.type === 'done');

    assert.equal(
      /** @type {any} */ (done).reply.proposal.id,
      /** @type {any} */ (streamed).proposal.id,
    );
  });

  it('records that a change is waiting, without its contents', async () => {
    const { assistant, records } = buildAssistant({
      script: [
        { toolCalls: [toolCall('applyCoupon', { code: 'SECRET50' })] },
        { content: 'Prepared.' },
      ],
    });

    await assistant.answer({ message: 'use SECRET50', scopes: ['chat', 'cart'], subject: 'ps_c' });

    const answered = records.find((entry) => entry.msg === 'assistant answered');

    assert.equal(answered.proposalKind, 'applyCoupon');
    assert.match(answered.proposalId, /^cp_/u);
    // An applyCoupon proposal carries a working discount code, and a log outlives the conversation.
    assert.ok(!JSON.stringify(records).includes('SECRET50'));
  });
});

describe('at most one proposal per turn', () => {
  it('keeps the first and refuses the second', async () => {
    const { assistant } = buildAssistant({
      script: [
        {
          toolCalls: [
            toolCall('addToCart', { items: [{ sku: 'HD-MRN-NVY-L', quantity: 1 }] }),
            toolCall('applyCoupon', { code: 'SAGE10' }),
          ],
        },
        { content: 'I have prepared the first one.' },
      ],
    });

    const reply = await assistant.answer({
      message: 'add it and use my code',
      scopes: ['chat', 'cart'],
      subject: 'ps_c',
    });

    // Two confirmation buttons is two decisions where the customer expects one, and confirming one and
    // forgetting the other is the likely outcome.
    assert.equal(reply.proposal?.kind, 'addToCart');
  });

  it('tells the model plainly, so it can say so', async () => {
    const { assistant, model } = buildAssistant({
      script: [
        {
          toolCalls: [
            toolCall('addToCart', { items: [{ sku: 'HD-MRN-NVY-L', quantity: 1 }] }),
            toolCall('applyCoupon', { code: 'SAGE10' }),
          ],
        },
        { content: 'Prepared the first.' },
      ],
    });

    await assistant.answer({ message: 'both please', scopes: ['chat', 'cart'], subject: 'ps_c' });

    const toolResults = model.calls[1].messages.filter((/** @type {any} */ m) => m.role === 'tool');
    const refusal = toolResults.map((/** @type {any} */ m) => String(m.content)).join('\n');

    assert.match(refusal, /A change is already waiting for the customer's confirmation/u);
    assert.match(refusal, /Ask them to confirm that one first/u);
  });

  it('does not read the connector for the refused call', async () => {
    const siteProfile = testProfile(CART_PROFILE);
    const commerce = createFakeCommerce();
    const assistant = createConversationManager({
      model: createFakeModel([
        {
          toolCalls: [
            toolCall('addToCart', { items: [{ sku: 'HD-MRN-NVY-L', quantity: 1 }] }),
            toolCall('addToCart', { items: [{ sku: 'HD-MRN-NVY-L', quantity: 5 }] }),
          ],
        },
        { content: 'Prepared.' },
      ]),
      retriever: createFakeRetriever(),
      store: createMemoryConversationStore(),
      commerce,
      proposals: createMemoryProposalStore(),
      siteProfile,
      logger: undefined,
    });

    await assistant.answer({ message: 'add it twice', scopes: ['chat', 'cart'], subject: 'ps_c' });

    // Refused before the tool runs, so nothing is read and no proposal is built and thrown away.
    assert.equal(commerce.calls.length, 1);
  });
});

describe('when a proposal cannot be stored', () => {
  it('withholds it from the reply rather than offering a dead button', async () => {
    const failing = {
      save: () => Promise.reject(new Error('ECONNREFUSED')),
      consume: () => Promise.resolve(undefined),
    };
    const { assistant } = buildAssistant({ script: ADD_THEN_ANSWER, proposals: failing });

    const reply = await assistant.answer({
      message: 'add it',
      scopes: ['chat', 'cart'],
      subject: 'ps_c',
    });

    // The answer still ships - the model has already told the customer something is prepared, and that
    // cannot be taken back. The button does not appear, because it could not have worked.
    assert.equal(reply.proposal, undefined);
    assert.match(reply.answer, /prepared/u);
  });

  it('logs it as an error, because a customer was nearly misled', async () => {
    const failing = {
      save: () => Promise.reject(new Error('ECONNREFUSED')),
      consume: () => Promise.resolve(undefined),
    };
    const { assistant, records } = buildAssistant({
      script: ADD_THEN_ANSWER,
      proposals: failing,
    });

    await assistant.answer({ message: 'add it', scopes: ['chat', 'cart'], subject: 'ps_c' });

    const failure = records.find((entry) => entry.msg === 'a prepared cart change was not stored');

    assert.ok(failure);
    assert.equal(failure.level, 'error');
  });

  it('reports a missing store as a composition error', async () => {
    const { assistant, records } = buildAssistant({
      script: ADD_THEN_ANSWER,
      omitProposals: true,
    });

    const reply = await assistant.answer({
      message: 'add it',
      scopes: ['chat', 'cart'],
      subject: 'ps_c',
    });

    assert.equal(reply.proposal, undefined);

    const failure = records.find(
      (entry) => entry.msg === 'a cart change was prepared with no proposal store to hold it',
    );

    assert.ok(failure);
    assert.match(failure.remediation, /cannot work without one/u);
  });
});

describe('who owns a proposal', () => {
  it('records the session subject when one was supplied', async () => {
    const { assistant } = buildAssistant({ script: ADD_THEN_ANSWER });

    const reply = await assistant.answer({
      message: 'add it',
      scopes: ['chat', 'cart'],
      subject: 'ps_the_customer',
    });

    assert.equal(reply.proposal?.subject, 'ps_the_customer');
  });

  it('falls back to the conversation when there is no session', async () => {
    const { assistant } = buildAssistant({ script: ADD_THEN_ANSWER });

    const reply = await assistant.answer({ message: 'add it', scopes: ['chat', 'cart'] });

    // A caller with no session concept still gets a proposal only the holder of that conversation can
    // confirm, rather than one nobody owns.
    assert.equal(reply.proposal?.subject, reply.conversationId);
  });
});
