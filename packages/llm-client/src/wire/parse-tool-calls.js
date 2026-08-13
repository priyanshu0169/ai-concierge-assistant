import { UpstreamError } from '@shopsage/platform';
import { asObject } from './as-object.js';

/**
 * Normalize the wire `tool_calls` array.
 *
 * @param {unknown} raw
 * @returns {import('../types.js').LlmToolCall[]}
 */
export function parseToolCalls(raw) {
  return Array.isArray(raw) ? raw.map(toToolCall) : [];
}

/**
 * @param {unknown} raw
 * @param {number} index
 * @returns {import('../types.js').LlmToolCall}
 */
function toToolCall(raw, index) {
  const entry = asObject(raw);
  const fn = asObject(entry.function);
  const name = typeof fn.name === 'string' ? fn.name : '';

  if (name === '') {
    throw new UpstreamError('LLM gateway returned a tool call without a name', {
      retryable: false,
      details: { index },
    });
  }

  return {
    // A synthetic id keeps the call/result correlation intact for the gateways
    // that omit one. An unmatched result is rejected by the next request, which
    // would strand the tool loop.
    id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : `call_${index}`,
    name,
    arguments: parseArguments(fn.arguments, name),
  };
}

/**
 * @param {unknown} raw
 * @param {string} toolName
 * @returns {Record<string, unknown>}
 */
function parseArguments(raw, toolName) {
  // A no-argument tool is variously reported as absent, `null`, `""` or `"{}"`.
  if (raw === undefined || raw === null || raw === '') return {};

  // Non-conforming gateways send the arguments already parsed.
  if (typeof raw === 'object') return asObject(raw);

  if (typeof raw !== 'string') {
    throw unparsableArguments(toolName, new TypeError(`arguments were ${typeof raw}`));
  }

  return parseArgumentsJson(raw, toolName);
}

/**
 * @param {string} raw
 * @param {string} toolName
 * @returns {Record<string, unknown>}
 */
function parseArgumentsJson(raw, toolName) {
  /** @type {unknown} */
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw unparsableArguments(toolName, cause);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw unparsableArguments(toolName, new TypeError('arguments were not a JSON object'));
  }

  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * Not retryable, and deliberately so.
 *
 * The usual cause is `max_tokens` truncating the arguments mid-JSON, which
 * repeats identically on a retry while charging for it again. `finishReason`
 * on the surrounding completion is the signal that distinguishes truncation
 * from a genuine formatting failure.
 *
 * The malformed text is *not* attached: tool arguments carry customer input,
 * and this object is destined for log storage.
 *
 * @param {string} toolName
 * @param {unknown} cause
 * @returns {UpstreamError}
 */
function unparsableArguments(toolName, cause) {
  return new UpstreamError('LLM gateway returned unparsable tool call arguments', {
    cause,
    retryable: false,
    details: { toolName },
  });
}
