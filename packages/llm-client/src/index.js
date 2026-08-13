/**
 * @shopsage/llm-client - the only package in ShopSage that knows an LLM exists.
 *
 * Speaks the OpenAI chat-completions wire format over plain HTTP, so any
 * compatible endpoint works unchanged: an internal AI gateway, Azure OpenAI,
 * LiteLLM, OpenRouter, vLLM, or OpenAI itself. Switching between them is an
 * environment change.
 *
 * The public surface is deliberately two functions. If a caller ever needs to
 * know which provider, model or base URL is in use, the abstraction has failed
 * and the fix belongs here rather than in the caller. See docs/adr/0005.
 */

export { createLlmClient } from './create-llm-client.js';

/**
 * Re-exported types. Consumers reference these as
 * `import('@shopsage/llm-client').LlmMessage`.
 *
 * @typedef {import('./types.js').LlmClient} LlmClient
 * @typedef {import('./types.js').LlmClientOptions} LlmClientOptions
 * @typedef {import('./types.js').LlmCallOptions} LlmCallOptions
 * @typedef {import('./types.js').LlmCompletion} LlmCompletion
 * @typedef {import('./types.js').LlmFinishReason} LlmFinishReason
 * @typedef {import('./types.js').LlmMessage} LlmMessage
 * @typedef {import('./types.js').LlmRole} LlmRole
 * @typedef {import('./types.js').LlmStreamEvent} LlmStreamEvent
 * @typedef {import('./types.js').LlmToolCall} LlmToolCall
 * @typedef {import('./types.js').LlmToolDefinition} LlmToolDefinition
 * @typedef {import('./types.js').LlmUsage} LlmUsage
 */
