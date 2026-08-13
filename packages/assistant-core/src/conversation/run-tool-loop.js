/**
 * How many times the model may call tools before it must answer.
 *
 * Three is enough for the realistic pattern - search, notice the result missed,
 * rephrase and search again - and small enough that a model stuck in a loop costs three
 * calls rather than a runaway bill. The loop is bounded because a model *will*
 * occasionally call the same tool with the same arguments forever, and nothing outside
 * this counter would stop it.
 */
const MAX_TOOL_ROUNDS = 3;

/**
 * Tools that produce a proposal, named rather than detected.
 *
 * A `result.proposal` check would be the obvious implementation and it comes too late: by then the
 * connector has been read and a proposal built, only to be dropped. Naming them lets the second call
 * be refused before any of that happens.
 */
const PROPOSING_TOOLS = new Set(['addToCart', 'applyCoupon']);

/**
 * Progress, for a caller that wants to show a turn happening rather than wait for it.
 *
 * @typedef {{ type: 'delta', text: string }
 *   | { type: 'tool', name: string, phase: 'started' | 'finished' | 'failed' }
 *   | { type: 'proposal', proposal: import('../types.js').CartProposal }} ToolLoopProgress
 */

/**
 * @typedef {object} ToolLoopResult
 * @property {import('@shopsage/llm-client').LlmCompletion} completion The final answer.
 * @property {import('../types.js').RetrievedChunk[]} chunks Everything retrieved, in order.
 * @property {import('../types.js').CartProposal} [proposal] A cart change awaiting confirmation.
 * @property {string} emittedText Every delta yielded, concatenated. Empty when buffered.
 * @property {number} rounds Tool rounds actually used.
 * @property {boolean} exhausted Whether the round limit was hit.
 */

/**
 * Run the model until it produces an answer rather than a tool call.
 *
 * A multi-turn loop, not a single call, because that is what tool calling *is*: the
 * model may ask for a tool, read the result, and decide it needs another. Building the
 * single-shot version first and adding this later would mean rewriting the conversation
 * loop, the error handling and the streaming path together - which is exactly the
 * rewrite docs/adr/0010 chose to avoid.
 *
 * On exhaustion the model is called one final time with tools withdrawn, forcing prose.
 * Returning a tool call to a customer is not an option, and the alternative - erroring -
 * throws away three rounds of retrieved context that probably does answer the question.
 *
 * A generator, so one implementation serves both delivery modes. It yields progress a
 * streaming caller forwards and a buffered caller ignores, and *returns* the result both
 * need. What differs between the two is confined to `runRound` (see model-rounds.js).
 *
 * @param {{
 *   runRound: import('./model-rounds.js').RoundRunner,
 *   registry: import('../tools/tool-registry.js').ToolRegistry,
 *   messages: import('@shopsage/llm-client').LlmMessage[],
 *   toolContext: import('../types.js').ToolContext,
 *   metadata?: Record<string, unknown>,
 *   signal?: AbortSignal,
 * }} input
 * @returns {AsyncGenerator<ToolLoopProgress, ToolLoopResult>}
 */
export async function* runToolLoop(input) {
  const { runRound, registry, toolContext } = input;

  /** @type {import('@shopsage/llm-client').LlmMessage[]} */
  const conversation = [...input.messages];
  /** @type {import('../types.js').RetrievedChunk[]} */
  const chunks = [];
  /** @type {string[]} */
  const emitted = [];
  /**
   * At most **one** proposal per turn, and the first one wins.
   *
   * A model asked to "add the jacket and apply my code" will call both tools, and two confirmation
   * buttons is two decisions where the customer expects one - each of which silently invalidates
   * nothing about the other, so confirming one and forgetting the second is the likely outcome.
   * Holding the first and telling the model the second was not prepared keeps the turn honest: it
   * has to say so rather than describe a change nobody can accept.
   *
   * @type {import('../types.js').CartProposal | undefined}
   */
  let proposal;

  const callOptions = buildCallOptions(input);

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    // The final round withdraws the tools, which is what guarantees prose rather than a
    // fourth tool call.
    const isFinalRound = round === MAX_TOOL_ROUNDS;
    const completion = yield* consumeRound({
      events: runRound(
        conversation,
        isFinalRound ? { ...callOptions, tools: undefined } : callOptions,
      ),
      onText: (text) => emitted.push(text),
    });

    const result = {
      completion,
      chunks,
      emittedText: emitted.join(''),
      rounds: round,
      ...(proposal === undefined ? {} : { proposal }),
    };

    // TEMPORARY: execution-trace debug instrumentation (widget-vs-Postman divergence
    // investigation). Remove once the divergence point is confirmed. This is the model's own
    // sampled decision for this round - the first place two otherwise-identical requests can
    // stop being identical.
    //
    // Structure only, never content - same reasoning as the log in create-conversation-manager.js.
    // `narrationText` is not logged, only its length: an assistant can repeat back something a
    // customer typed ("just to confirm, that was ...?"), including a shape no pattern-based
    // redactor catches (a coupon code has none), so the safe boundary is "did it narrate at
    // all", not "what did it say". Tool-call *arguments* are omitted the same way and for the
    // same reason - `applyCoupon`'s `code` is a working discount code. The one argument this
    // investigation actually needs, `searchKnowledge`'s query text, is already logged safely
    // and specifically in create-knowledge-retriever.js.
    toolContext.logger?.debug('round completed debug', {
      round,
      isFinalRound,
      narrationLength: completion.content?.length ?? 0,
      toolCallNames: completion.toolCalls.map((call) => call.name),
      finishReason: completion.finishReason,
    });

    if (completion.toolCalls.length === 0) return { ...result, exhausted: false };
    // Tools were withdrawn and it still asked for one. Nothing left to do but use
    // whatever prose came with it.
    if (isFinalRound) return { ...result, exhausted: true };

    conversation.push({
      role: 'assistant',
      content: completion.content,
      toolCalls: completion.toolCalls,
    });

    yield* runRoundTools({
      calls: completion.toolCalls,
      registry,
      toolContext,
      hasProposal: () => proposal !== undefined,
      onChunks: (found) => chunks.push(...found),
      onProposal: (prepared) => {
        proposal = prepared;
      },
      onToolMessage: (message) => conversation.push(message),
    });
  }

  // Unreachable: the loop returns on every path.
  throw new Error('tool loop terminated without a completion');
}

/**
 * Execute one round's tool calls, in order.
 *
 * Extracted from the loop above rather than inlined, which is what keeps that function readable now
 * that a tool call can produce three different kinds of outcome. The callbacks are how a generator
 * reports back without the loop having to inspect what it yielded.
 *
 * @param {{
 *   calls: import('@shopsage/llm-client').LlmToolCall[],
 *   registry: import('../tools/tool-registry.js').ToolRegistry,
 *   toolContext: import('../types.js').ToolContext,
 *   hasProposal: () => boolean,
 *   onChunks: (chunks: import('../types.js').RetrievedChunk[]) => void,
 *   onProposal: (proposal: import('../types.js').CartProposal) => void,
 *   onToolMessage: (message: import('@shopsage/llm-client').LlmMessage) => void,
 * }} input
 * @returns {AsyncGenerator<ToolLoopProgress, void>}
 */
async function* runRoundTools(input) {
  const { registry, toolContext } = input;

  for (const call of input.calls) {
    yield { type: 'tool', name: call.name, phase: 'started' };

    const outcome = await executeTool({
      call,
      registry,
      toolContext,
      hasProposal: input.hasProposal(),
    });

    yield { type: 'tool', name: call.name, phase: outcome.failed ? 'failed' : 'finished' };

    input.onChunks(outcome.result.chunks ?? []);

    if (outcome.result.proposal !== undefined && !input.hasProposal()) {
      input.onProposal(outcome.result.proposal);
      // Yielded as it happens rather than only at the end, so a streaming caller can render the
      // confirmation while the model is still writing the sentence that explains it.
      yield { type: 'proposal', proposal: outcome.result.proposal };
    }

    input.onToolMessage({ role: 'tool', toolCallId: call.id, content: outcome.result.content });
  }
}

/**
 * Drain one round's events, forwarding text and keeping the completion.
 *
 * Empty deltas are dropped rather than forwarded. Gateways emit them - the first event of
 * an OpenAI-compatible stream carries the role and no content - and a caller should not
 * have to filter noise out of a progress feed.
 *
 * @param {{
 *   events: AsyncIterable<import('@shopsage/llm-client').LlmStreamEvent>,
 *   onText: (text: string) => void,
 * }} input
 * @returns {AsyncGenerator<ToolLoopProgress, import('@shopsage/llm-client').LlmCompletion>}
 */
async function* consumeRound(input) {
  /** @type {import('@shopsage/llm-client').LlmCompletion | undefined} */
  let completion;

  for await (const event of input.events) {
    if (event.type === 'end') {
      completion = event.completion;
      continue;
    }

    if (event.text.length === 0) continue;

    input.onText(event.text);
    yield { type: 'delta', text: event.text };
  }

  if (completion === undefined) {
    // The adapter guarantees exactly one `end`. Reaching here means a stream was
    // truncated without one, and continuing would silently answer with nothing.
    throw new Error('model round ended without a completion');
  }

  return completion;
}

/**
 * @param {{
 *   registry: import('../tools/tool-registry.js').ToolRegistry,
 *   metadata?: Record<string, unknown>,
 *   signal?: AbortSignal,
 * }} input
 * @returns {import('@shopsage/llm-client').LlmCallOptions}
 */
function buildCallOptions(input) {
  const { registry, metadata, signal } = input;

  return {
    ...(registry.definitions.length === 0 ? {} : { tools: registry.definitions }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * Execute one tool call, converting any failure into a tool result.
 *
 * A tool that throws must not fail the customer's whole question. The model is told the
 * tool failed and can decide what to do - usually saying it could not look something up,
 * which is a far better outcome than a 502.
 *
 * @param {{
 *   call: import('@shopsage/llm-client').LlmToolCall,
 *   registry: import('../tools/tool-registry.js').ToolRegistry,
 *   toolContext: import('../types.js').ToolContext,
 *   hasProposal: boolean,
 * }} input
 * @returns {Promise<{ result: import('../types.js').ToolResult, failed: boolean }>}
 */
async function executeTool(input) {
  const { call, registry, toolContext } = input;
  const tool = registry.find(call.name);

  if (tool === undefined) {
    // Models occasionally invent a tool name. Naming what is available lets it recover.
    return {
      failed: true,
      result: {
        content: `Unknown tool "${call.name}". Available tools: ${registry.tools
          .map((entry) => entry.name)
          .join(', ')}.`,
      },
    };
  }

  // Refused before the tool runs, so nothing is read from the connector and no second proposal is
  // built and thrown away. The model is told plainly, which is what lets it say "I have prepared the
  // first; confirm it and I will do the other" instead of describing both as done.
  if (input.hasProposal && PROPOSING_TOOLS.has(call.name)) {
    return {
      failed: false,
      result: {
        content: `A change is already waiting for the customer's confirmation, so ${call.name} did nothing. Ask them to confirm that one first, then offer to do this next.`,
      },
    };
  }

  try {
    return {
      failed: false,
      result: await tool.execute({ arguments: call.arguments, context: toolContext }),
    };
  } catch (error) {
    toolContext.logger?.error('tool execution failed', {
      tool: call.name,
      err: error instanceof Error ? error : new Error(String(error)),
    });

    return {
      failed: true,
      result: {
        // Two distinct instructions, and both exist because of observed model behaviour.
        //
        // "An outage, not an empty result" is here because a model told only that `searchProducts`
        // had failed answered "I could not find any wool hoodies" - which a customer reads as "the
        // store does not sell them", about a store that does. A failed lookup and an empty result
        // are different facts and must not collapse into one sentence.
        //
        // The redirection to `searchKnowledge` replaces an earlier "Do not retry it" plus a ready-
        // made apology, which ended the turn outright: the model stopped, and never consulted a
        // knowledge base that held the answer. A failed *live* lookup says nothing about whether
        // the store's own website describes what was asked about, and the tool loop exists
        // precisely so a second, better call can be made in the same turn (docs/adr/0010).
        content:
          `The ${call.name} tool failed - this is an outage, not an empty result. Do not call ` +
          `${call.name} again this turn. ` +
          'If the question is about what the store sells, its categories, or how a product is ' +
          'described, call searchKnowledge now: the store website describes those, and that ' +
          'content is unaffected by this outage. Only if that also finds nothing, tell the ' +
          'customer you could not check just now, and do not say or imply that what they asked ' +
          'about does not exist. Never state a price or stock level - those need the live lookup ' +
          'that just failed.',
      },
    };
  }
}
