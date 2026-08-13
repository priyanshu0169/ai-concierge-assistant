# ADR 0029: A cart changes only through a proposal the customer confirmed

Status: Accepted
Date: 2026-08-04
Stage: 9b

## Context

Stage 9a gave the assistant commerce reads. This stage lets it change a basket, which is the first
thing in nine stages that **spends a customer's money**. Every earlier failure mode was a wrong
sentence; this one is a wrong charge, and an apology does not undo it.

[Proposal 0002](../proposals/0002-commerce-connector-contract.md) decision 4 settled the shape:
propose → confirm → execute, with the assistant never modifying a cart without explicit customer
confirmation. This ADR records how that is built and what it does and does not guarantee.

The specific failure being designed against is not a hypothetical. A model asked "not the blue one,
the green" will sometimes add the blue one. It will read "I already have two" as an instruction to
add two. Given a tool that commits, each of those is a charge.

## Decision

**A tool can only propose. Execution is a separate HTTP request made by a click.** `addToCart` and
`applyCoupon` return a stored `CartProposal`; `POST /v1/cart/confirm` executes one. The model is out
of the commit path entirely — and that is a property of **what is reachable**, not a rule the code is
trusted to follow: `ToolContext` carries the read port and nothing else, so there is no path from a
tool to the write port.

There is deliberately **no** `POST /v1/cart/items` and no `POST /v1/cart/coupon`. A client cannot ask
for a basket change at all, only agree to one ShopSage already prepared. The surface a hostile caller
sees is "guess 128 random bits belonging to your own session inside ten minutes".

**The summary a customer consents to is written by ShopSage, not by the model.** Built from connector
data, rendered as **text** rather than markdown, and shown as its own card rather than inside the
assistant's bubble. Consent to a sentence a model composed is not consent to what the button does; if
the prose and the summary disagree, the customer must be reading the one that is true.

**Every sku is re-read from the connector before being proposed.** A model naming a product from
memory, from an earlier turn, or from a customer's typo would otherwise put an unverified line at an
unchecked price in front of somebody to approve.

**Consumption is take-once and atomic** — `GETDEL` in Redis, a single `Map` delete in memory — and it
happens **before** any validation, because a proposal that has been offered up is spent whatever
happens next. Validating first would reopen the window that a double-tapped button drives straight
through.

**A separate write port, `CommerceCart`, in a separate adapter that does not import `withRetry`.**
Stage 9a left this open; the answer is separation, and the reason outlived the tidiness argument: the
read client wraps every call in a retry, and a mutation must never be retried. Apart, that is
structural. Together, one plausible refactor — somebody consolidating two nearly identical request
helpers — makes it false with the whole suite still green, because no test can observe a second charge.

**A failed write is never retryable, whatever the status.** A 5xx is not "worth another attempt" here:
the connector may have added the item and lost the response. The honest outcome is telling the
customer it did not confirm and sending them to their basket.

**Idempotency keys are derived from the proposal id and hashed.** Derived, because two attempts at the
same confirmation must carry the _same_ key for a connector to recognise the repeat — a random key
would defeat the purpose. Hashed, because the id is a bearer token, and a connector logging its
idempotency keys (a normal thing to do) would otherwise be writing confirmation tokens to disk.

**At most one proposal per turn.** Two confirmation buttons is two decisions where a customer expects
one; confirming one and forgetting the other is the likely outcome. The second call is refused _before
the tool runs_, and the model is told plainly — which is what lets it say "confirm that one and I will
do the other next".

**The proposal store is a readiness dependency**, unlike the commerce connector. The difference is
what a failure costs: a connector outage degrades commerce answers while knowledge answers keep
working, but an unreachable proposal store means every confirmation button in flight is dead and the
assistant will keep cheerfully preparing more.

## Consequences

**A stranger who obtains a proposal id could originally destroy it.** Because consumption precedes the
ownership check, a wrong-session attempt burned the proposal and left its owner unable to confirm their
own change. Found by running two sessions against a live stack, not by any test. Fixed by restoring the
proposal when — and only when — the refusal was a subject mismatch: an expired one is finished either
way. The residual race is a sub-millisecond window where an owner's consume lands between a stranger's
consume and restore, which costs one retry.

**A failed execution spends the proposal.** The customer must ask again rather than re-click. That is
the deliberate consequence of consuming first, and it is why the widget says "we could not tell whether
that worked — please check your basket" rather than guessing. Putting the proposal back on a failed
_execution_ would be wrong: the write may have partially happened, and offering the button again invites
a second one.

**Stock is checked at execution, not at proposal time, and cannot be otherwise.** Stock moves between a
customer reading a summary and clicking confirm. The connector is the last and only word, so a proposal
can be prepared for something that is gone by the time it is confirmed — and the answer is the store's
own wording, not a claim ShopSage invented.

**`ToolResult` gained a third kind of outcome, and the tool loop changed.** ADR 0022 claimed a new
capability is an entry in `TOOL_FACTORIES` and nothing else. Stage 9a was evidence for that; this stage
is the honest boundary of it. The two tools _are_ two table entries — but a proposal is neither text nor
chunks, only one may survive a turn, and it must be yielded as an event. The table absorbed the tools;
it could not absorb a new outcome.

**A fourth stream event, and a client that ignores it is broken rather than degraded.** Every other
event is safe to skip. A `proposal` a renderer drops leaves an assistant claiming to have prepared
something the customer cannot accept, so `done.proposal` repeats it — and the widget renders the repeat
only if the event never arrived, which is what a proxy that buffers unknown event types looks like.

**`DEV_SESSION_SCOPES` exists, and it is a sharp edge.** With authentication off the synthetic session
held `chat` alone, which made the cart and order paths unreachable to anybody working on them. It is
honoured only on the branch that runs when authentication is _disabled_, so no configuration can widen
a verified session — and anything beyond `chat` is warned about at boot. The committed `.env.example`
leaves it at the default on purpose: a widened default in a file everybody copies would make "every
developer's guest can confirm cart changes" the starting point.

**The shared JWT vectors gained `valid-cart`.** `cart` joined the scope set, and the capability that
spends money deserves a shared vector. That change also caught a test asserting the vector set exactly
where the contract specifies a minimum — extra coverage was failing the build.

## Alternatives considered

**Direct mutation from a tool, with a confirmation sentence in the prose.** One round trip, no stored
state, no new endpoint. Rejected: "did the customer agree?" would live in text a model wrote, and the
model would be the thing deciding whether agreement had happened.

**A confirmation field on the next `/v1/chat` request** — the customer replies "yes" and the turn
executes. Rejected for the same reason one layer along: consent would be a model's interpretation of a
sentence. "Yes, but make it the large one" is not consent to the proposal on the table, and a model will
read it as one.

**Cart mutation on `CommerceCatalogue`.** Fewer ports, one adapter. Rejected because the read adapter's
retry would then be one refactor away from wrapping a write, and that is a mistake no test can catch.

**Reference-counting a proposal instead of consuming it** — allowing N confirmations until the cart
agrees. Rejected: every failure mode of this design is preferable to one where a button can be pressed
twice.

**Putting proposals in the conversation store.** It already exists and already has a TTL. Rejected: a
conversation is an append-only list with a sliding idle expiry, a proposal is a single value read exactly
once, and `consume` needs to be atomic in a way `append` does not. They share a _connection_, which is
where the saving actually was.
