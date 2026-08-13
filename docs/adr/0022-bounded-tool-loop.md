# ADR 0022: A bounded tool loop, with tools withdrawn on the final round

Status: Accepted
Date: 2026-07-31
Stage: 6

## Context

[ADR 0010](0010-tool-calling-from-the-start.md) committed the platform to tool calling
from the first stage, with `searchKnowledge` as the only tool, so that adding commerce
tools in Stage 9 would not require rewriting the conversation path. Stage 6 is where
that commitment gets executed, and executing it exposes a control-flow problem the
earlier stage could defer.

Tool calling is not a function call. The model returns _a request_ to call a tool; the
application executes it and hands back the result; the model then decides what to do
next — which may be to answer, or to call another tool. That is a loop with an
unbounded upper bound, and the bound has to come from the application, because two
things reliably happen with real models:

1. It calls the same tool with the same arguments repeatedly, having not noticed the
   result did not help.
2. It finishes with `finish_reason: tool_calls` when the application has decided no
   further calls are allowed — leaving a "response" that contains no prose to show a
   customer.

The retrieval path also has an ordering consequence. Retrieved context could be
injected into the system prompt before the model is ever called — the classic
single-shot RAG shape — or delivered as a tool result inside the loop. This choice is
invisible in the happy path and decisive in the failure path.

## Decision

**`runToolLoop` iterates at most `MAX_TOOL_ROUNDS = 3` tool rounds**, then one final
round. Three covers the realistic pattern — search, notice the result missed, rephrase,
search again — and caps a stuck model at a handful of calls rather than a runaway bill.

**On the final round the tools are withdrawn from the request**
(`{ ...callOptions, tools: undefined }`). This is the part worth stating explicitly.
Ending the loop by _ignoring_ a fourth tool call leaves whatever prose happened to
accompany it, which is usually nothing. Withdrawing the tools removes the option: a
model with no tools available answers in prose, using the context it has already
gathered. The loop reports `exhausted: true` so the condition is visible in logs, but
the customer still gets an answer.

**Retrieved context arrives as a tool result, not as a pre-built system prompt.**
`buildMessages` deliberately does not take chunks — a test asserts this. When the first
search misses, a model that received context inside the loop can search again with
better terms; a model handed a pre-built prompt cannot, because the retrieval already
happened before it was consulted.

**A tool that throws becomes a tool result, not an exception.** The message tells the
model the tool failed and not to retry it. One failed lookup must not turn a customer's
question into a 502, and the model saying "I could not look that up" is a better outcome
than an error envelope.

**An unknown tool name is answered by naming what exists.** Models occasionally invent
a tool name; listing the available ones lets the next round recover instead of burning
the budget.

**Tools are enabled per store by site-profile feature flag**, via a
`TOOL_FACTORIES` table keyed by flag name. Stage 9's `searchProducts`, `trackOrder`,
`addToCart` and `applyCoupon` are entries in that table, not changes to the loop.
Adding a tool to the platform cannot change an existing store's behaviour until that
store's profile opts in — a shared platform where a release silently changes what a
customer's assistant can do is not safely upgradable.

**Wire definitions are derived from the tools themselves**, not hand-written alongside
them, so a tool cannot be executable but undeclared, or declared but unexecutable.

## Alternatives

**Single-shot RAG: retrieve first, then one model call.** Fewer moving parts, one
gateway call per question, lower latency, and no loop to bound. Rejected: it embeds the
assumption that one retrieval is always enough. It also cannot host a commerce tool at
all — `trackOrder` needs an order number the model has to extract from the
conversation, which is only knowable _after_ the model has read it. Converting to a
loop later would mean rewriting the conversation path, the error handling and the
streaming path together, which is the rewrite ADR 0010 was written to avoid.

**An unbounded loop with a wall-clock timeout instead of a round cap.** Rejected: a
timeout produces no answer at all, and it bounds the wrong quantity. Rounds are what
cost money and what indicate a stuck model; elapsed time is already bounded per attempt
by the LLM client ([ADR 0012](0012-llm-retry-and-failure-policy.md)).

**Error on exhaustion.** Simpler and arguably more honest. Rejected: by round three the
application usually holds context that does answer the question, and discarding it to
return a 502 is the worst available outcome for the customer.

**Let a tool failure propagate.** Rejected for the same reason. It also removes the
model's ability to degrade gracefully, which it is genuinely good at.

**Always allow tools and rely on the prompt to say "answer now".** Rejected: a prompt
instruction is a request, and the failure it guards against — a model that ignores it —
is exactly the case the guard exists for. Withdrawing the tools is a mechanism.

## Consequences

A grounded answer costs two gateway calls, not one: one to decide to search, one to
answer from the results. Verified end to end — the first call returns
`finishReason: tool_calls` with a 238-token prompt, the second returns `stop` with 544
tokens after the retrieved context was appended. That is a real latency and cost
increase over single-shot RAG, accepted as the price of an architecture that can host
commerce tools.

Whether retrieval happened at all becomes a _model_ decision. This is why
[ADR 0010](0010-tool-calling-from-the-start.md)'s "answer only from retrieved context"
guarantee cannot be enforced by refusing to call the model — the model must be called to
learn whether it wants to search. Grounding is therefore observed rather than enforced:
`formatAnswer` attaches sources only when chunks were actually retrieved, and the
`grounded` flag is logged on every turn so the rate is monitorable. `docs/RAG.md` states
this limitation rather than the stronger claim it carried before Stage 6.

The `grounded` flag is **not** serialized to the client. It is an operational signal
about how often answers rest on retrieved content; a browser has no use for it, and
publishing it invites a client to branch on it and turn an internal metric into a
contract.

The loop is where a future streaming path gets harder: tokens cannot be streamed to the
customer until the model has stopped asking for tools, so Stage 7 must either buffer
until the final round or stream only that round. The `stream()` method absent from the
`LanguageModel` port ([ADR 0021](0021-the-domain-declares-its-ports.md)) is that
unresolved decision, deliberately left unmade.
