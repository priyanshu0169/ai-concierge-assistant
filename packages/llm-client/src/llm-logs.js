/**
 * The two records this package emits.
 *
 * Token accounting lives here rather than in the caller for a reason that also
 * protects the abstraction: cost is the one legitimate reason to know which
 * model served a request, so this package logs the model and no caller ever
 * needs it. `LlmCompletion` stays model-free as a result.
 *
 * `metadata` is spread first so a caller's correlation fields can never
 * overwrite the measurements.
 */

/**
 * @param {{
 *   logger?: import('@shopsage/platform').Logger,
 *   settings: import('./client-options.js').LlmClientSettings,
 *   completion: import('./types.js').LlmCompletion,
 *   metadata?: Record<string, unknown>,
 *   durationMs: number,
 *   mode: 'generate' | 'stream',
 * }} input
 */
export function logCompletion(input) {
  const { logger, settings, completion, metadata, durationMs, mode } = input;

  logger?.info('llm completion', {
    ...metadata,
    mode,
    model: settings.model,
    durationMs,
    finishReason: completion.finishReason,
    promptTokens: completion.usage.promptTokens,
    completionTokens: completion.usage.completionTokens,
    totalTokens: completion.usage.totalTokens,
    toolCallCount: completion.toolCalls.length,
  });
}

/**
 * Warn rather than info: a retry is a symptom. A gateway that needs one on most
 * requests is a problem worth surfacing before it becomes an outage.
 *
 * @param {{
 *   logger?: import('@shopsage/platform').Logger,
 *   notice: import('@shopsage/platform').RetryNotice,
 *   metadata?: Record<string, unknown>,
 * }} input
 */
export function logRetry(input) {
  const { logger, notice, metadata } = input;

  logger?.warn('llm request failed, retrying', {
    ...metadata,
    attempt: notice.attempt,
    delayMs: notice.delayMs,
    err: notice.error,
  });
}
