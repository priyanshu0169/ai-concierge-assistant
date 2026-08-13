# ADR 0005: One package owns LLM access, via an OpenAI-compatible gateway

Status: Accepted
Date: 2026-07-30
Stage: 1 (interface), 2 (implementation)

## Context

The company provides an OpenAI-compatible AI gateway. The platform must also work with Azure OpenAI,
LiteLLM, OpenRouter, vLLM and OpenAI directly, because different deployments and different customers
will land on different infrastructure.

Model providers change faster than anything else in this system. Models are deprecated, gateways are
replaced, pricing shifts, and a vendor SDK's major version arrives with breaking changes. Any of those
events should touch one package.

There is also a subtler risk. Provider-specific concepts leak easily: a "system message" versus a
"system parameter", token counting, tool-call encodings, streaming event shapes. Once business logic
branches on any of those, the abstraction is gone even if the interface still looks clean.

## Decision

A single package, `@shopsage/llm-client`, is the only code in the repository that knows an LLM exists.

- Public surface: `generate(messages, options)` and `stream(messages, options)`.
- It owns retries with jittered backoff, timeouts, rate-limit handling, and normalization of both
  responses and errors into ShopSage's own error taxonomy.
- It speaks the **OpenAI chat-completions wire format** over plain HTTP, configured entirely by
  `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_TEMPERATURE`, `LLM_MAX_TOKENS`, `LLM_TIMEOUT_MS`.
- No other package reads those variables or learns the provider, model, or base URL. Callers only ever
  see `llm.generate(messages)`.

Direct integration with the Anthropic or OpenAI SDK is explicitly excluded.

## Alternatives

**Use a provider SDK directly.** Best ergonomics, typed clients, provider-specific features. Rejected
because it couples the platform to one vendor's release cycle and its concepts spread by import: once
`assistant-core` imports an SDK type, every consumer of that type is coupled too.

**Use LangChain or a similar abstraction framework.** Provider abstraction plus chains, memory and
agents for free. Rejected on two grounds. It is a large dependency with its own opinions about
architecture — precisely the layer this project is deliberately building itself, so most of it would
be unused. And it abstracts by adding a layer we do not control, which is worse than a thin layer we
do: when retrieval quality or a prompt needs debugging, the last thing wanted is a framework between
the prompt and the wire.

**A plugin architecture with one adapter per provider.** Maximum flexibility. Rejected as unnecessary:
the OpenAI chat-completions format has become the de facto standard, and every target endpoint already
speaks it. One HTTP client against one wire format covers all of them. If a genuinely incompatible
provider appears, the port already exists and an adapter can be added then.

## Consequences

Easy: switching gateway or model is an environment change with no code change. One place implements
retry and timeout policy, so behaviour under failure is consistent. The client is trivially faked in
tests by injecting `fetch`. Runs against a local vLLM in development and a hosted gateway in
production with no branching.

Hard: provider-specific features are unavailable unless surfaced through the port deliberately, which
is the point but will feel restrictive at least once. HTTP is hand-rolled rather than SDK-provided, so
retry semantics, streaming parsing and error mapping are ours to get right — and the SDKs do handle
real edge cases. Nominally "OpenAI-compatible" endpoints also differ in practice, especially in
streaming and tool-call encoding, so compatibility needs testing per endpoint rather than assuming.

Accepted: the abstraction only holds if nothing else imports the client's internals. A single
`import` of a provider SDK elsewhere defeats it, so that is a review blocker.
