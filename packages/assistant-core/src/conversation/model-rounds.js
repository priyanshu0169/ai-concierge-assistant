/**
 * How the tool loop asks the model for one round.
 *
 * The loop must work for a buffered answer and a streamed one without being written
 * twice - two copies of round bounding, tool-withdrawal and tool execution would drift,
 * and the half that is exercised less would drift first.
 *
 * The seam is this file, and it costs almost nothing because Stage 2 already chose the
 * right shape. `LlmClient.stream()` yields `delta` events and then exactly one `end`
 * carrying a finished `LlmCompletion` (docs/adr/0011). A buffered call is just that
 * sequence with the deltas left out. So the streaming runner *is* `stream()`, and the
 * buffered runner is a two-line adapter - rather than the loop branching on a
 * `streaming` flag in four places.
 *
 * @typedef {(
 *   messages: import('@shopsage/llm-client').LlmMessage[],
 *   options: import('@shopsage/llm-client').LlmCallOptions,
 * ) => AsyncIterable<import('@shopsage/llm-client').LlmStreamEvent>} RoundRunner
 */

/**
 * Run each round as a single request, emitting no deltas.
 *
 * `generate()` rather than draining `stream()` and discarding the deltas: it is one
 * request instead of a server-sent-event connection, and it does not require the gateway
 * to support streaming at all. `LLM_STREAM_INCLUDE_USAGE` exists because some gateways
 * are particular about streaming options, and `/v1/chat` should not inherit that risk.
 *
 * @param {import('../types.js').LanguageModel} model
 * @returns {RoundRunner}
 */
export function bufferedRounds(model) {
  return async function* round(messages, options) {
    yield { type: 'end', completion: await model.generate(messages, options) };
  };
}

/**
 * Run each round as a stream, emitting deltas as the model produces them.
 *
 * @param {import('../types.js').LanguageModel} model
 * @returns {RoundRunner}
 */
export function streamedRounds(model) {
  return (messages, options) => model.stream(messages, options);
}
