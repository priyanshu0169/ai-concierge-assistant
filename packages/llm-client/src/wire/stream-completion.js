import { UpstreamError } from '@shopsage/platform';
import { asObject } from './as-object.js';
import { createCompletionAccumulator } from './completion-accumulator.js';
import { decodeSseData } from './sse-decoder.js';

/** OpenAI's end-of-stream sentinel. Not part of SSE itself. */
const DONE_PAYLOAD = '[DONE]';

/**
 * Turn a streamed response body into normalized events.
 *
 * Emits a `delta` per non-empty text fragment and exactly one `end` carrying the
 * assembled completion. Empty deltas are dropped: gateways send keep-alive
 * chunks and role-only openers, and forwarding those as events would make every
 * consumer filter them.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {AsyncGenerator<import('../types.js').LlmStreamEvent, void, void>}
 */
export async function* streamCompletion(stream) {
  const accumulator = createCompletionAccumulator();

  for await (const payload of decodeSseData(stream)) {
    if (payload === DONE_PAYLOAD) break;

    const text = accumulator.accept(parseChunk(payload));
    if (text !== '') yield { type: 'delta', text };
  }

  yield { type: 'end', completion: accumulator.toCompletion() };
}

/**
 * @param {string} payload
 * @returns {Record<string, unknown>}
 */
function parseChunk(payload) {
  try {
    return asObject(JSON.parse(payload));
  } catch (cause) {
    // Not retryable: the caller has already been handed earlier deltas, so
    // replaying the call would duplicate output rather than repair it.
    throw new UpstreamError('LLM gateway sent an unparsable stream chunk', {
      cause,
      retryable: false,
    });
  }
}
