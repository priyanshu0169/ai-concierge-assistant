# ADR 0010: Tool-calling architecture from the first stage

Status: Accepted
Date: 2026-07-30
Stage: 1 (architecture), 6 (implementation)

## Context

The first capability is answering questions from a knowledge base — one retrieval call, then one
generation call. The roadmap then adds product search, comparison, recommendations, order tracking,
add-to-cart, coupons, recipes and wine pairings.

Those later capabilities are not variations on retrieval. They are _actions the model must choose
between_, often several within one customer turn: "do you have this in stock, and can you add it to my
basket?" requires deciding to look up a product, then deciding to modify a cart, with the second call
depending on the first result.

The question is whether to build the simple thing now and generalise later.

## Decision

Build the tool-calling loop from Stage 1, even though `searchKnowledge` is the only tool.

- A **tool registry** holds tools as `{ name, description, parameters (JSON Schema), handler }`.
- `assistant-core` runs a **multi-turn loop**: send messages and available tools to the model; if the
  model requests a tool, execute it, append the result, and continue; otherwise return the answer.
- Retrieval is exposed as a tool — `searchKnowledge({ query })` — not hard-wired before generation.
- Tools are gated by site-profile feature flags, so the set of available tools is per-store
  configuration.
- The tool schema is normalized on the OpenAI function-calling shape, consistent with
  [ADR 0005](0005-openai-compatible-llm-gateway.md).

## Alternatives

**Single-shot retrieve-then-answer, generalise later.** Much simpler: embed the question, retrieve,
build a prompt, call the model once. Genuinely sufficient for Stage 6's requirements.

Rejected because the retrofit is not additive. A single-shot pipeline assumes exactly one model call
with all context assembled up front, and that assumption is embedded in the conversation manager, the
streaming implementation (a tool call mid-stream has to interrupt and resume token streaming), error
handling (a tool failure must be reported _to the model_, not to the customer), and turn accounting.
Converting it means rewriting all of those simultaneously — the highest-risk kind of change, in the most
central code, after it is in production. Building the loop now costs a few days; retrofitting it costs a
rewrite of the component everything else depends on.

**Always retrieve, then let the model use tools for everything else.** A hybrid: keep retrieval
unconditional and add tools alongside. Rejected because unconditional retrieval is wasteful and often
harmful — "add two of those to my basket" triggers a pointless embedding and search, and irrelevant
retrieved context measurably degrades answers. Letting the model decide whether it needs the knowledge
base is both cheaper and more accurate.

**A framework's agent abstraction.** LangChain-style agents provide the loop, tool schemas and parsing.
Rejected consistently with ADR 0005: a large dependency with its own opinions, for a loop that is a few
dozen lines when the tool contract is ours.

## Consequences

Easy: adding a capability is registering a tool plus flipping a feature flag — no change to the
conversation loop. Each tool is independently unit-testable, since a handler is a plain function.
Multi-step reasoning works from day one. Per-store capability sets fall out of the design.

Hard: more machinery than Stage 6 strictly needs, and the loop needs guards that a single-shot pipeline
does not — a maximum iteration count to prevent a model looping indefinitely, per-tool timeouts, and a
policy for reporting tool failures back to the model rather than to the customer. Non-determinism also
increases: the model may decline to call `searchKnowledge` and answer from parameters instead, which is
a hallucination risk that a forced-retrieval design does not have. Mitigations are a strict system
prompt, the `minScore` floor, and the evaluation set from Stage 5.

Accepted: tools that take actions with side effects — `addToCart`, `applyCoupon` — need an authorization
model, not just a feature flag. A model deciding to modify a customer's cart is a different risk class
from a model deciding to search. That is tracked as open decision #2 in the roadmap and must be settled
before Stage 9.
