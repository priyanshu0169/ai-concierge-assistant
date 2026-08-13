import { ValidationError } from '@shopsage/platform';

/**
 * @typedef {object} BuildRequestBodyInput
 * @property {import('../types.js').LlmMessage[]} messages
 * @property {import('../types.js').LlmCallOptions} callOptions
 * @property {import('../client-options.js').LlmClientSettings} settings
 * @property {boolean} stream
 */

/**
 * Translate a normalized call into an OpenAI chat-completions request body.
 *
 * This function and its counterparts in `parse-*.js` are the only places in
 * ShopSage that know what the wire looks like.
 *
 * @param {BuildRequestBodyInput} input
 * @returns {Record<string, unknown>}
 */
export function buildRequestBody(input) {
  const { messages, callOptions, settings, stream } = input;

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ValidationError('At least one message is required');
  }

  return {
    model: settings.model,
    messages: messages.map(toWireMessage),
    temperature: callOptions.temperature ?? settings.temperature,
    max_tokens: callOptions.maxTokens ?? settings.maxTokens,
    ...toolFields(callOptions),
    ...streamFields({ stream, includeStreamUsage: settings.includeStreamUsage }),
  };
}

/**
 * @param {import('../types.js').LlmMessage} message
 * @returns {Record<string, unknown>}
 */
function toWireMessage(message) {
  // Widened deliberately: the exhaustive branches below narrow a *runtime*
  // value, and a caller reaching this from untyped JavaScript should get the
  // explicit error rather than a malformed request.
  const role = /** @type {string} */ (message.role);

  if (role === 'system' || role === 'user') return { role, content: message.content ?? '' };
  if (role === 'assistant') return toWireAssistantMessage(message);
  if (role === 'tool') return toWireToolResult(message);

  throw new ValidationError(`Unsupported message role: ${JSON.stringify(role)}`);
}

/**
 * @param {import('../types.js').LlmMessage} message
 * @returns {Record<string, unknown>}
 */
function toWireAssistantMessage(message) {
  const toolCalls = message.toolCalls ?? [];

  if (toolCalls.length === 0) return { role: 'assistant', content: message.content ?? '' };

  return {
    role: 'assistant',
    // Null rather than an empty string: a tool-only turn has no text, and some
    // gateways reject `""` alongside `tool_calls`.
    content: message.content ?? null,
    tool_calls: toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
    })),
  };
}

/**
 * @param {import('../types.js').LlmMessage} message
 * @returns {Record<string, unknown>}
 */
function toWireToolResult(message) {
  if (message.toolCallId === undefined || message.toolCallId === '') {
    throw new ValidationError('A tool message requires toolCallId');
  }

  return { role: 'tool', tool_call_id: message.toolCallId, content: message.content ?? '' };
}

/**
 * @param {import('../types.js').LlmCallOptions} callOptions
 * @returns {Record<string, unknown>}
 */
function toolFields(callOptions) {
  const tools = callOptions.tools ?? [];

  if (tools.length === 0) return {};

  return {
    tools: tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    })),
    tool_choice: callOptions.toolChoice ?? 'auto',
  };
}

/**
 * @param {{ stream: boolean, includeStreamUsage: boolean }} input
 * @returns {Record<string, unknown>}
 */
function streamFields(input) {
  const { stream, includeStreamUsage } = input;

  if (!stream) return {};

  return {
    stream: true,
    ...(includeStreamUsage ? { stream_options: { include_usage: true } } : {}),
  };
}
