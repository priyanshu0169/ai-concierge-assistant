import { sendRequest } from '@shopsage/platform';
import { buildAuthHeaders } from '../client-options.js';
import { mapUpstreamError } from './map-upstream-error.js';

/**
 * @typedef {object} PostChatCompletionInput
 * @property {import('../client-options.js').LlmClientSettings} settings
 * @property {Record<string, unknown>} body
 * @property {string} accept `application/json` or `text/event-stream`.
 * @property {AbortSignal} [signal]
 * @property {typeof fetch} fetchImpl
 */

/**
 * Perform one authenticated chat-completions request.
 *
 * One attempt, no retry policy: retrying is a decision about *what* failed, and
 * that belongs to the caller. Transport mechanics and transport-error
 * classification come from `sendRequest`; what a status code *means* is decided
 * here, because that is the vendor-specific part.
 *
 * The response body is left unread. `generate()` needs the JSON, `stream()`
 * needs the byte stream, and reading here would foreclose one of them.
 *
 * @param {PostChatCompletionInput} input
 * @returns {Promise<Response>} A successful response, body unconsumed.
 */
export async function postChatCompletion(input) {
  const { settings, body, accept, signal, fetchImpl } = input;

  const response = await sendRequest({
    url: settings.endpoint,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept,
      ...buildAuthHeaders(settings),
    },
    body,
    timeoutMs: settings.timeoutMs,
    signal,
    label: 'LLM request',
    fetchImpl,
  });

  if (!response.ok) throw await mapUpstreamError({ response, apiKey: settings.apiKey });

  return response;
}
