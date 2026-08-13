import { randomUUID } from 'node:crypto';
import { formatAnswer } from '../answer/format-answer.js';
import { redactTurn } from '../privacy/redact-personal-data.js';
import { buildMessages } from '../prompt/build-messages.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import { bufferedRounds, streamedRounds } from './model-rounds.js';
import { runToolLoop } from './run-tool-loop.js';

/**
 * Prefixes make an id self-describing in a log line or a support ticket, where a bare
 * hex string tells nobody what it identifies.
 */
const CONVERSATION_PREFIX = 'c_';
const MESSAGE_PREFIX = 'm_';

/**
 * @typedef {object} AssistantRequest
 * @property {string} message Already validated by the delivery layer.
 * @property {string} [conversationId] Continues an existing conversation when supplied.
 * @property {Record<string, unknown>} [metadata] Correlation fields for downstream logs.
 * @property {string[]} [scopes] Capabilities this session holds. Omit to grant all enabled.
 * @property {string} [credential] The session token, forwarded to the commerce connector as-is.
 * @property {string} [subject] The session's pseudonymous subject. Recorded on any proposal.
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} ConversationManager
 * @property {(request: AssistantRequest) => Promise<import('../types.js').AssistantReply>} answer
 * @property {(request: AssistantRequest) => AsyncGenerator<import('../types.js').AssistantStreamEvent, void>} answerStream
 */

/**
 * @typedef {object} TurnContext
 * @property {import('../types.js').LanguageModel} model
 * @property {import('../types.js').KnowledgeRetriever} retriever
 * @property {import('../types.js').ConversationStore} store
 * @property {import('../types.js').CommerceCatalogue} [commerce]
 * @property {import('../types.js').CartProposalStore} [proposals]
 * @property {import('@shopsage/platform').SiteProfile} siteProfile
 * @property {string} siteId
 * @property {import('@shopsage/platform').Logger} [logger]
 */

/**
 * The domain's entry point: one customer question in, one answer out.
 *
 * This is the whole flow, and the order is the design:
 *
 * 1. Load bounded history, so a follow-up question makes sense.
 * 2. Build the prompt from the store's own profile.
 * 3. Run the tool loop, letting the model retrieve what it needs.
 * 4. Format the answer, attaching citations only if it was grounded.
 * 5. Persist the turn.
 *
 * Step 5 comes last deliberately. A turn that failed is not history - persisting the
 * question before answering it would leave a conversation containing a question the
 * assistant never addressed, and the next turn would be built on that gap.
 *
 * Two ways out, one flow. `answer` resolves once with the finished reply; `answerStream`
 * yields the same turn as it happens. They share every step above, differing only in how
 * the model is asked for each round, because a streamed answer that retrieved different
 * content or applied a different prompt would be a second product to maintain.
 *
 * Contains no HTTP, no framework, no vendor SDK. Everything it needs arrives as a port.
 *
 * @param {{
 *   model: import('../types.js').LanguageModel,
 *   retriever: import('../types.js').KnowledgeRetriever,
 *   store: import('../types.js').ConversationStore,
 *   commerce?: import('../types.js').CommerceCatalogue,
 *   proposals?: import('../types.js').CartProposalStore,
 *   siteProfile: import('@shopsage/platform').SiteProfile,
 *   logger?: import('@shopsage/platform').Logger,
 * }} dependencies
 * @returns {ConversationManager}
 */
export function createConversationManager(dependencies) {
  const { siteProfile } = dependencies;

  /** @type {TurnContext} */
  const context = {
    ...dependencies,
    siteId: siteProfile.identity.siteId,
  };

  return {
    answer: (request) => answerBuffered(context, request),
    answerStream: (request) => answerStreamed(context, request),
  };
}

/**
 * @param {TurnContext} context
 * @param {AssistantRequest} request
 * @returns {Promise<import('../types.js').AssistantReply>}
 */
async function answerBuffered(context, request) {
  const turn = await openTurn(context, request);
  const loop = runToolLoop({ ...turn.loopInput, runRound: bufferedRounds(context.model) });

  // Progress is yielded either way; a buffered caller has nowhere to put it.
  let step = await loop.next();
  while (!step.done) step = await loop.next();

  return closeTurn({ context, request, turn, loop: step.value, answerText: undefined });
}

/**
 * @param {TurnContext} context
 * @param {AssistantRequest} request
 * @returns {AsyncGenerator<import('../types.js').AssistantStreamEvent, void>}
 */
async function* answerStreamed(context, request) {
  const turn = await openTurn(context, request);
  const messageId = newId(MESSAGE_PREFIX);
  let completed = false;

  // First, before any model call: a caller that loses the connection immediately still
  // holds the id it needs to continue the conversation.
  yield { type: 'start', conversationId: turn.conversationId, messageId };

  try {
    const loop = runToolLoop({ ...turn.loopInput, runRound: streamedRounds(context.model) });

    let step = await loop.next();
    while (!step.done) {
      yield step.value;
      step = await loop.next();
    }

    const reply = await closeTurn({
      context,
      request,
      turn,
      loop: step.value,
      messageId,
      // What the customer actually received, which is not necessarily the final round's
      // content: a model may narrate ("let me check that") before calling a tool, and
      // those tokens were rendered.
      answerText: step.value.emittedText,
    });

    completed = true;
    yield { type: 'done', reply };
  } finally {
    // An abandoned turn is **not** persisted. A stream can be cut at any point, including
    // before a single token, so storing what arrived would sometimes write an empty or
    // half-sentence assistant turn into history - which then gets replayed to the model on
    // the next question. Nothing is a better record than a fragment.
    //
    // It is logged, because otherwise abandonment is invisible: a high rate means either
    // customers are giving up on the wait or a proxy is cutting connections. At `info`,
    // because one abandoned turn is ordinary - it is the rate that is worth alerting on.
    if (!completed) {
      context.logger?.info('assistant turn abandoned', {
        ...request.metadata,
        conversationId: turn.conversationId,
        persisted: false,
      });
    }
  }
}

/**
 * Everything both modes do before the model is involved.
 *
 * @param {TurnContext} context
 * @param {AssistantRequest} request
 */
async function openTurn(context, request) {
  const { siteProfile, siteId, retriever, commerce, logger } = context;
  const conversationId = request.conversationId ?? newId(CONVERSATION_PREFIX);

  // Built per turn rather than once per process, because the tool set now depends on the
  // *session* as well as the store: a guest and a signed-in customer meet the same
  // deployment and must not be offered the same capabilities. Construction is a filter over
  // a frozen table, so this is cheap.
  const registry = createToolRegistry(siteProfile, request.scopes);

  const history = await context.store.history({
    siteId,
    conversationId,
    // Messages, not turns - a turn writes two. This is the prompt budget, deliberately separate
    // from what Redis retains: see the note on `conversationSchema` in site-profile-schema.js.
    limit: siteProfile.conversation.maxPromptMessages,
  });

  const messages = buildMessages({
    siteProfile,
    history,
    message: request.message,
    toolNames: registry.tools.map((tool) => tool.name),
  });

  // TEMPORARY: execution-trace debug instrumentation (widget-vs-Postman divergence
  // investigation). Remove once the divergence point is confirmed.
  //
  // Structure only, never content. A pattern-based redactor (`redactPersonalData`) is not
  // safe enough for this: it has no detector for a coupon code, and a customer's own
  // message can contain one as plain typed text, not only inside a tool argument - proven by
  // this project's own cart-conversation tests, which is what caught an earlier version of
  // this log leaking one. Lengths and roles are enough to confirm the *shape* of the prompt
  // is identical between two calls without retaining what was actually said.
  logger?.debug('turn opened debug', {
    conversationId,
    historyTurns: history.length,
    selectedTools: registry.tools.map((tool) => tool.name),
    messageShape: messages.map((entry) => ({
      role: entry.role,
      contentLength: entry.content?.length ?? 0,
    })),
  });

  return {
    conversationId,
    askedAt: new Date().toISOString(),
    history,
    loopInput: {
      registry,
      messages,
      // `credential` goes into the tool context and no further. It is the customer's session token,
      // forwarded to the connector untouched: not parsed here, not put in `metadata`, and so never
      // reaching a log line - `metadata` is what gets logged.
      toolContext: {
        siteId,
        siteProfile,
        retriever,
        logger,
        conversationId,
        // Falls back to the conversation itself when no session subject was supplied. A caller with no
        // session concept - a test, a future batch entry point - still gets a proposal that can only be
        // confirmed by whoever holds that conversation, rather than one nobody can own.
        subject: request.subject ?? conversationId,
        ...(commerce === undefined ? {} : { commerce }),
        ...(request.credential === undefined ? {} : { credential: request.credential }),
      },
      metadata: { ...request.metadata, conversationId },
      signal: request.signal,
    },
  };
}

/**
 * Everything both modes do once the model has finished: format, persist, record.
 *
 * @param {{
 *   context: TurnContext,
 *   request: AssistantRequest,
 *   turn: Awaited<ReturnType<typeof openTurn>>,
 *   loop: import('./run-tool-loop.js').ToolLoopResult,
 *   messageId?: string,
 *   answerText?: string,
 * }} input
 * @returns {Promise<import('../types.js').AssistantReply>}
 */
async function closeTurn(input) {
  const { context, request, turn, loop, answerText } = input;
  const { conversationId } = turn;

  const formatted = formatAnswer({
    completion:
      answerText === undefined ? loop.completion : { ...loop.completion, content: answerText },
    chunks: loop.chunks,
    siteProfile: context.siteProfile,
    conversationId,
    messageId: input.messageId ?? newId(MESSAGE_PREFIX),
  });

  // Stored **before** the reply is handed over, and a failure here removes the proposal from the reply
  // rather than being swallowed. The asymmetry with a failed history write is deliberate: a lost turn
  // costs the next answer some context, while an unstored proposal would render a confirmation button
  // that cannot possibly work. Better to say nothing was prepared than to offer a dead button.
  const proposal = await storeProposal({ context, request, loop, conversationId });
  const reply = proposal === undefined ? formatted : { ...formatted, proposal };

  const persisted = await persistTurn({ context, request, turn, answer: reply.answer });

  context.logger?.info('assistant answered', {
    ...request.metadata,
    conversationId,
    streamed: answerText !== undefined,
    grounded: reply.grounded,
    sources: reply.sources.length,
    toolRounds: loop.rounds,
    // Worth surfacing: a model that routinely exhausts the loop is either being
    // asked impossible questions or has a prompt problem.
    exhausted: loop.exhausted,
    historyTurns: turn.history.length,
    persisted,
    // Whether a change is waiting, and its id so a confirmation can be traced back to the turn that
    // offered it. The proposal's contents are not logged: an `applyCoupon` proposal carries a working
    // discount code.
    ...(reply.proposal === undefined
      ? {}
      : { proposalId: reply.proposal.id, proposalKind: reply.proposal.kind }),
    finishReason: reply.finishReason,
  });

  return reply;
}

/**
 * Persist a prepared cart change, or report that none survived.
 *
 * Three ways to end up with no proposal on the reply, and only the first is ordinary: the turn prepared
 * nothing, no store was composed, or the store failed. The last two are logged as errors because a
 * customer was about to be shown a confirmation that could not have worked - and the model has already
 * told them something is prepared, which is the part that cannot be taken back. The answer still ships;
 * the button does not appear.
 *
 * @param {{
 *   context: TurnContext,
 *   request: AssistantRequest,
 *   loop: import('./run-tool-loop.js').ToolLoopResult,
 *   conversationId: string,
 * }} input
 * @returns {Promise<import('../types.js').CartProposal | undefined>}
 */
async function storeProposal(input) {
  const { context, request, loop } = input;

  if (loop.proposal === undefined) return undefined;

  if (context.proposals === undefined) {
    context.logger?.error('a cart change was prepared with no proposal store to hold it', {
      ...request.metadata,
      conversationId: input.conversationId,
      remediation: 'compose a CartProposalStore; the cart feature cannot work without one',
    });

    return undefined;
  }

  try {
    await context.proposals.save(loop.proposal);

    return loop.proposal;
  } catch (error) {
    context.logger?.error('a prepared cart change was not stored', {
      ...request.metadata,
      conversationId: input.conversationId,
      proposalId: loop.proposal.id,
      err: error instanceof Error ? error : new Error(String(error)),
      remediation: 'the customer was not offered the confirmation; they can ask again',
    });

    return undefined;
  }
}

/**
 * Record the turn, and do not lose an answer if that fails.
 *
 * The asymmetry with `history()` is deliberate, and it only became a real decision once
 * the store was a network dependency rather than a Map:
 *
 * - **A failed read fails the turn.** Answering a follow-up with no memory produces a
 *   reply that reads as the assistant being stupid rather than as a broken dependency, and
 *   a customer cannot tell the difference. A 502 is honest, and it is retryable.
 * - **A failed write does not.** By this point the answer exists and, on the streaming
 *   path, has already been rendered. Turning that into an error would throw away work the
 *   customer can see, to report a problem they cannot act on.
 *
 * The cost is a conversation that silently loses a turn, so it is logged and reported on
 * the turn's own record rather than swallowed.
 *
 * @param {{
 *   context: TurnContext,
 *   request: AssistantRequest,
 *   turn: Awaited<ReturnType<typeof openTurn>>,
 *   answer: string,
 * }} input
 * @returns {Promise<boolean>}
 */
async function persistTurn(input) {
  const { context, request, turn } = input;

  // Redacted here, at the write, and nowhere earlier. The customer read their own message back in
  // the widget and the model answered the real question; it is only the copy that outlives the turn
  // that is reduced. Doing it earlier would degrade an answer to protect a record.
  const redacted = [
    redactTurn({ role: 'user', content: request.message, at: turn.askedAt }),
    redactTurn({ role: 'assistant', content: input.answer, at: new Date().toISOString() }),
  ];
  const removed = [...new Set(redacted.flatMap((entry) => entry.removed))];

  try {
    await context.store.append({
      siteId: context.siteId,
      conversationId: turn.conversationId,
      turns: redacted.map((entry) => entry.turn),
    });

    if (removed.length > 0) {
      // The categories, never the values - the whole point was to stop this data being retained, and
      // a log is retention. Worth recording at all because a store seeing this constantly has a
      // conversational design problem: something is prompting customers to type card numbers.
      context.logger?.info('personal data removed before storing turn', {
        ...request.metadata,
        conversationId: turn.conversationId,
        categories: removed,
      });
    }

    return true;
  } catch (error) {
    context.logger?.error('conversation turn was not recorded', {
      ...request.metadata,
      conversationId: turn.conversationId,
      err: error instanceof Error ? error : new Error(String(error)),
      remediation: 'the answer was still delivered; the next turn will not see this exchange',
    });

    return false;
  }
}

/**
 * Random rather than time-sortable. A sortable id needs a dependency and leaks creation
 * time to anyone holding it; ordering comes from stored timestamps instead.
 *
 * @param {string} prefix
 * @returns {string}
 */
function newId(prefix) {
  return `${prefix}${randomUUID().replaceAll('-', '')}`;
}
