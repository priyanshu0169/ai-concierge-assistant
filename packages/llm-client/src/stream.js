import { UpstreamError, withRetry } from '@shopsage/platform';
import { retryOptionsFor, sendChatRequest } from './call-context.js';
import { logCompletion } from './llm-logs.js';
import { buildRequestBody } from './wire/build-request-body.js';
import { streamCompletion } from './wire/stream-completion.js';

const SSE_ACCEPT = 'text/event-stream';

/**
 * Build the streaming call path.
 *
 * Nothing happens until the caller iterates: the request belongs to the
 * consumption, not to constructing the iterator. That also means an abandoned
 * iterable never spends a token.
 *
 * @param {import('./call-context.js').CallContext} context
 * @returns {import('./types.js').LlmClient['stream']}
 */
export function createStream(context) {
  return async function* stream(messages, callOptions = {}) {
    const body = buildRequestBody({
      messages,
      callOptions,
      settings: context.settings,
      stream: true,
    });
    const startedAt = performance.now();

    // Retry covers opening the connection only, and stops the moment the
    // response is accepted. Once a delta has been yielded the caller has already
    // rendered it, and replaying the call would repeat text rather than repair it.
    const response = await withRetry(
      () => sendChatRequest(context, { body, accept: SSE_ACCEPT, signal: callOptions.signal }),
      retryOptionsFor(context, callOptions),
    );

    if (response.body === null) {
      throw new UpstreamError('LLM gateway returned an empty stream', { retryable: false });
    }

    for await (const event of streamCompletion(response.body)) {
      if (event.type === 'end') {
        logCompletion({
          logger: context.logger,
          settings: context.settings,
          completion: event.completion,
          metadata: callOptions.metadata,
          durationMs: Math.round(performance.now() - startedAt),
          mode: 'stream',
        });
      }

      yield event;
    }
  };
}
