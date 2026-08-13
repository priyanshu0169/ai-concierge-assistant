/**
 * The published contract of `@shopsage/llm-client`.
 *
 * Everything here is provider-neutral on purpose. No type in this file mentions
 * a provider, a model, an endpoint or an HTTP concept, because these are the
 * shapes the rest of ShopSage is allowed to know about - and a leak here would
 * defeat the boundary the whole package exists to hold. See docs/adr/0005.
 *
 * This module has no runtime content; it is a type declaration that happens to
 * be written in JSDoc so the codebase stays plain JavaScript.
 */

/**
 * Who is speaking.
 *
 * `tool` carries the *result* of a tool the model asked for. There is no
 * `function` role: the deprecated function-calling shape is translated at the
 * wire boundary, never surfaced here.
 *
 * @typedef {'system' | 'user' | 'assistant' | 'tool'} LlmRole
 */

/**
 * A tool invocation requested by the model.
 *
 * `arguments` is a parsed object, not the JSON string the wire carries.
 * Un-parsing it is exactly the kind of provider detail callers should never
 * have to think about.
 *
 * @typedef {object} LlmToolCall
 * @property {string} id Correlates the call with its result message.
 * @property {string} name The tool the model asked for.
 * @property {Record<string, unknown>} arguments Parsed arguments.
 */

/**
 * @typedef {object} LlmMessage
 * @property {LlmRole} role
 * @property {string} [content] Absent on an assistant turn that only requested tools.
 * @property {LlmToolCall[]} [toolCalls] Only meaningful on an `assistant` message.
 * @property {string} [toolCallId] Required on a `tool` message.
 */

/**
 * A tool offered to the model.
 *
 * @typedef {object} LlmToolDefinition
 * @property {string} name
 * @property {string} description What the tool does, and when to reach for it.
 * @property {Record<string, unknown>} parameters JSON Schema for the arguments.
 */

/**
 * Why generation stopped.
 *
 * `unknown` exists because gateways invent values, and an unrecognised reason
 * must not become an exception - the answer itself is usually still usable.
 *
 * @typedef {'stop' | 'length' | 'tool_calls' | 'content_filter' | 'unknown'} LlmFinishReason
 */

/**
 * Token accounting for one call. Zeroes mean the gateway reported nothing, not
 * that nothing was spent.
 *
 * @typedef {object} LlmUsage
 * @property {number} promptTokens
 * @property {number} completionTokens
 * @property {number} totalTokens
 */

/**
 * A finished generation.
 *
 * Deliberately carries no model identifier. Callers must not branch on which
 * model served them, and the one legitimate need for it - cost accounting - is
 * met inside this package, which logs the model alongside the token counts.
 *
 * @typedef {object} LlmCompletion
 * @property {string} content Empty string when the model only requested tools.
 * @property {LlmToolCall[]} toolCalls Always present, possibly empty.
 * @property {LlmFinishReason} finishReason
 * @property {LlmUsage} usage
 */

/**
 * A streamed generation, as two event kinds.
 *
 * `delta` is text to render immediately. `end` arrives exactly once and carries
 * the same `LlmCompletion` that `generate()` would have returned - assembled
 * text, complete tool calls, finish reason and usage.
 *
 * That asymmetry is the point: a UI consumes `delta` and ignores the rest,
 * while a tool-calling loop waits for `end` and never has to reassemble
 * fragmented tool-call JSON. Making callers do that reassembly is how provider
 * details escape into business logic.
 *
 * @typedef {{ type: 'delta', text: string }
 *   | { type: 'end', completion: LlmCompletion }} LlmStreamEvent
 */

/**
 * @typedef {object} LlmCallOptions
 * @property {number} [temperature] Overrides the client default for one call.
 * @property {number} [maxTokens] Overrides the client default for one call.
 * @property {LlmToolDefinition[]} [tools]
 * @property {'auto' | 'none' | 'required'} [toolChoice] Default `auto` when tools are offered.
 * @property {AbortSignal} [signal] Cancels the call, including pending retries.
 * @property {Record<string, unknown>} [metadata] Correlation fields for this package's logs.
 */

/**
 * The port. This is the whole surface the rest of ShopSage may depend on.
 *
 * @typedef {object} LlmClient
 * @property {(messages: LlmMessage[], options?: LlmCallOptions) => Promise<LlmCompletion>} generate
 * @property {(messages: LlmMessage[], options?: LlmCallOptions) => AsyncIterable<LlmStreamEvent>} stream
 */

/**
 * @typedef {object} LlmClientOptions
 * @property {string} apiKey Credential presented to the gateway.
 * @property {string} baseUrl API base, or a full chat-completions URL.
 * @property {string} model Provider's model identifier.
 * @property {number} [temperature] Default 0.2.
 * @property {number} [maxTokens] Default 1024.
 * @property {number} [timeoutMs] Per-attempt budget. Default 60000.
 * @property {number} [maxAttempts] Total attempts including the first. Default 3.
 * @property {'bearer' | 'api-key'} [authStyle] Default `bearer`.
 * @property {boolean} [includeStreamUsage] Ask for usage on streams. Default true.
 * @property {import('@shopsage/platform').Logger} [logger] Receives usage and retry records.
 * @property {typeof fetch} [fetchImpl] Injection seam for tests.
 * @property {(ms: number) => Promise<void>} [sleep] Injection seam for tests.
 * @property {() => number} [random] Injection seam for deterministic jitter.
 */

export {};
