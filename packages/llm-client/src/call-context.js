import { resolveClientSettings } from './client-options.js';
import { logRetry } from './llm-logs.js';
import { isRetryableLlmError } from './retry-policy.js';
import { postChatCompletion } from './transport/post-chat-completion.js';

/**
 * Everything the two call paths share, resolved once at construction.
 *
 * @typedef {object} CallContext
 * @property {import('./client-options.js').LlmClientSettings} settings
 * @property {import('@shopsage/platform').Logger} [logger]
 * @property {typeof fetch} fetchImpl
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [random]
 */

/**
 * @param {import('./types.js').LlmClientOptions} options
 * @returns {CallContext}
 * @throws {import('@shopsage/platform').ConfigurationError} On invalid settings.
 */
export function createCallContext(options) {
  return {
    settings: resolveClientSettings(options),
    logger: options.logger,
    fetchImpl: options.fetchImpl ?? fetch,
    sleep: options.sleep,
    random: options.random,
  };
}

/**
 * The retry policy for one call.
 *
 * Built per call rather than once, because the caller's `AbortSignal` and
 * correlation metadata belong to the call, not to the client.
 *
 * @param {CallContext} context
 * @param {import('./types.js').LlmCallOptions} callOptions
 * @returns {import('@shopsage/platform').WithRetryOptions}
 */
export function retryOptionsFor(context, callOptions) {
  return {
    maxAttempts: context.settings.maxAttempts,
    isRetryable: isRetryableLlmError,
    signal: callOptions.signal,
    sleep: context.sleep,
    random: context.random,
    onRetry: (notice) =>
      logRetry({ logger: context.logger, notice, metadata: callOptions.metadata }),
  };
}

/**
 * @param {CallContext} context
 * @param {{ body: Record<string, unknown>, accept: string, signal?: AbortSignal }} input
 * @returns {Promise<Response>}
 */
export function sendChatRequest(context, input) {
  return postChatCompletion({
    settings: context.settings,
    fetchImpl: context.fetchImpl,
    ...input,
  });
}
