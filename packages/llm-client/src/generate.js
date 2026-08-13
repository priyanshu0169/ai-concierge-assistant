import { readJsonBody, withRetry } from '@shopsage/platform';
import { retryOptionsFor, sendChatRequest } from './call-context.js';
import { logCompletion } from './llm-logs.js';
import { buildRequestBody } from './wire/build-request-body.js';
import { parseCompletion } from './wire/parse-completion.js';

const JSON_ACCEPT = 'application/json';

/**
 * Build the non-streaming call path.
 *
 * The whole attempt - request, body read and parse - sits inside the retry, so a
 * connection that drops mid-body is retried like any other transient failure.
 * That is safe here and deliberately not safe in `stream()`, where the caller has
 * already seen output.
 *
 * @param {import('./call-context.js').CallContext} context
 * @returns {import('./types.js').LlmClient['generate']}
 */
export function createGenerate(context) {
  return async function generate(messages, callOptions = {}) {
    const body = buildRequestBody({
      messages,
      callOptions,
      settings: context.settings,
      stream: false,
    });
    const startedAt = performance.now();

    const completion = await withRetry(
      () => requestCompletion(context, { body, signal: callOptions.signal }),
      retryOptionsFor(context, callOptions),
    );

    logCompletion({
      logger: context.logger,
      settings: context.settings,
      completion,
      metadata: callOptions.metadata,
      durationMs: Math.round(performance.now() - startedAt),
      mode: 'generate',
    });

    return completion;
  };
}

/**
 * @param {import('./call-context.js').CallContext} context
 * @param {{ body: Record<string, unknown>, signal?: AbortSignal }} input
 * @returns {Promise<import('./types.js').LlmCompletion>}
 */
async function requestCompletion(context, input) {
  const response = await sendChatRequest(context, { ...input, accept: JSON_ACCEPT });

  return parseCompletion(await readJsonBody(response, 'LLM gateway'));
}
