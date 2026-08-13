# ADR 0011: The LLM client's normalized contract, including tool calls and streaming

Status: Accepted
Date: 2026-07-30
Stage: 2

## Context

[ADR 0005](0005-openai-compatible-llm-gateway.md) settled that one package owns LLM access and that
its surface is `generate()` and `stream()`. It did not settle what flows through that surface, and
that is where an abstraction of this kind usually fails.

The specific risk is that a "normalized" type quietly carries provider concepts. Three cases in the
OpenAI chat-completions format are awkward enough to be tempting to pass through untouched:

1. **Tool-call arguments are a JSON string**, not an object. Every caller would have to parse them,
   and every caller would handle a parse failure differently.
2. **Streamed tool calls arrive as fragments** keyed by position, with the arguments accruing a few
   characters per event. Nothing is parsable until the last fragment lands.
3. **`finish_reason` values are not a closed set.** Gateways emit `eos`, `end_turn`, `max_tokens`,
   `function_call`.

There is also a question of what the completion should say about _which model_ answered. Cost
accounting needs it. The rule that no other package learns the model forbids exposing it.

## Decision

The contract lives in one file, `packages/llm-client/src/types.js`, and no type in it mentions a
provider, a model, an endpoint or an HTTP concept.

- **Tool-call arguments are parsed** into `Record<string, unknown>` before they leave the package.
  Unparsable arguments raise a non-retryable `UpstreamError` naming the tool, and the malformed text
  is _not_ attached to the error, because tool arguments carry customer input and the error is
  destined for log storage.
- **`stream()` emits two event kinds:** `{ type: 'delta', text }` for rendering, and exactly one
  `{ type: 'end', completion }` carrying the same `LlmCompletion` that `generate()` would return —
  assembled text, complete tool calls, finish reason and usage. Fragment reassembly happens inside
  the package.
- **`finishReason` is a closed set** of five values, with anything unrecognised mapped to `unknown`
  rather than raising. The deprecated `function_call` collapses to `tool_calls`.
- **`LlmCompletion` carries no model identifier.** Instead the package logs the model alongside the
  token counts and the duration, which is the only thing anyone legitimately needed it for.
- Empty text deltas are dropped, and `content: null` becomes `''`.

## Alternatives

**Pass tool-call arguments through as a string.** Honest about the wire and avoids a parse-failure
policy inside the client. Rejected because it moves the same parse into every caller, each of which
would invent its own failure handling — and because "the arguments are JSON in a string" is precisely
a provider detail.

**Emit `toolCallDelta` events and let callers reassemble.** Maximum fidelity; a UI could show a tool
call forming. Rejected because the reassembly is the single messiest part of the format, and pushing
it outward guarantees it is implemented more than once and wrongly at least once. The `end` event
gives a tool loop what it actually needs, and nothing wants a half-parsed argument object.

**Raise on an unknown `finishReason`.** Fails loudly on a real incompatibility. Rejected as a
self-inflicted outage: the generated answer is normally perfectly usable, and refusing to return it
because of an unrecognised label would turn a cosmetic difference between gateways into a customer
seeing an error.

**Expose `model` on the completion.** Useful for debugging and for per-model cost attribution.
Rejected because it is the exact leak this boundary exists to prevent — once a completion carries a
model name, something eventually branches on it. Moving usage logging into the client removes the
need. Adding the field later is easy; removing it later is breaking.

## Consequences

Easy: a caller can render a stream and run a tool loop without knowing anything about SSE, fragment
indices or JSON-in-strings. `generate()` and `stream()` return the same information, so a feature
built on one works on the other. Cost visibility is automatic and cannot be forgotten by a caller.

Hard: provider-specific response fields (log probabilities, cached-token breakdowns, reasoning
traces, multiple choices) are unavailable unless deliberately added to the contract. Normalizing
also means a gateway's own error envelope inside a 200 response becomes "no choices" rather than the
gateway's wording.

Accepted: the closed `finishReason` set will occasionally report `unknown` for something meaningful,
and that is preferable to the alternative. Streaming callers cannot see tool calls forming, only
finished ones.

## Postscript: what this found

Wiring token accounting through the platform logger revealed that the Stage 1 redaction pattern
matched `token` anywhere in a key name — so `promptTokens`, `completionTokens`, `totalTokens` and
`maxTokens` were all written to logs as `[redacted]`. Cost visibility, the thing this stage was
adding, was silently destroyed by a security control.

The pattern is now `token(?!s)`: credentials are singular (`accessToken`, `MAGENTO_API_TOKEN`),
measurements are plural. A redaction rule that eats the data it was never meant to protect is not a
safer rule — it teaches whoever reads the logs to stop trusting the redactor.
