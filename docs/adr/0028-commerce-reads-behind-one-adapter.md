# ADR 0028: Commerce facts arrive through one adapter, and the assistant never does arithmetic on money

Status: Accepted
Date: 2026-08-03
Stage: 9a

## Context

The assistant can answer from store content. It cannot answer "do you sell this", "what does it
cost", "is it in stock" or "where is my order" — the questions a shopping assistant exists for.
Those facts live in Magento, change constantly, and cannot be indexed: a price in a crawled blog
post is whatever it was the day the page was written.

Magento business logic lives in a **separate repository**. ShopSage consumes HTTP APIs and nothing
else. The contract is `docs/proposals/0002-commerce-connector-contract.md`, accepted with the
decisions recorded in its §2, and the reference connector in `packages/magento-client/reference/`
is a runnable form of it.

Three things about this stage are unlike the ones before it. It is the first time ShopSage handles a
**customer's credential** rather than its own. It is the first time an answer contains a **figure a
customer may act on**. And it is the first time a dependency can fail in a way that should _not_
fail the request.

Stage 9 is split. This ADR is the read path. Cart mutation follows a propose → confirm → execute
workflow that needs a stored proposal, a confirmation endpoint, an addition to the SSE event set and
a widget affordance — that is 9b, and bundling it here would have been two stages at once.

## Decision

**One port, `CommerceCatalogue`, with read methods only.** The same shape of decision as
`KnowledgeRetriever` (ADR 0021) and for the same reason: the domain asks for commerce facts and is
never told a Magento module is answering. Splitting it per resource would put the shape of somebody
else's catalogue API into the domain. Every wire field name in the contract appears in
`packages/magento-client/src/wire/` and nowhere else, so replacing the reference connector with the
real module touches that directory and the configuration, not the assistant.

Reads only for now, and that is not merely "writes are later". A read and a write have genuinely
different failure policies — a failed read is worth retrying, a failed "add to basket" is not —
so when 9b arrives the question of whether it joins this port or gets its own is a live one.

**The assistant may quote a price and may never compute one.** Prices arrive pre-formatted from the
connector, because ShopSage does not know a store's locale conventions and must not learn them.
`amount` is carried as a decimal **string** and never parsed. The only operation performed on a
price anywhere in this codebase is **ordering**, which is allowed precisely because it produces no
new monetary figure, and it is done on strings rather than floats.

**Availability is quoted or omitted, never inferred.** Absent means the assistant says nothing about
stock. A value the contract does not define is treated as absent rather than passed through, because
an unrecognised value reaching the prompt invites the model to interpret it.

**Comparison and recommendation logic live in ShopSage.** Magento exposes product data. Deciding
what is worth saying about two products, and which three of ten to put in front of somebody, is
assistant behaviour that changes for reasons unrelated to a catalogue. Keeping it here also means
"never recommend something they cannot buy" is a function with a test rather than a query somebody
wrote in PHP once.

**The customer's session token is forwarded and never interpreted.** Its subject is a pseudonym by
agreement (ADR 0026), so the connector resolves identity because it minted the token. The token is
carried on `req.sessionCredential`, deliberately **not** on `req.session` — the session is bound
into the request logger, so a credential on the same object would be one careless `{ session }`
away from log storage. `trackOrder` therefore takes no customer identifier at all: the model chooses
tool arguments, so any identity parameter in a schema is one it can be talked into changing.

**Connector failures degrade into answers, not HTTP errors.** A commerce outage becomes "I could not
look that up" while every knowledge answer keeps working. The connector is consequently **not** a
readiness probe — failing readiness would pull healthy instances out of the load balancer over a
partial failure.

**Personal data is removed from conversation turns before they are stored.** History is the only
place ShopSage retains free text. Emails, Luhn-valid card numbers and structured phone numbers are
replaced at the moment of writing; the customer still sees what they typed and the model still
answered the real question.

## Consequences

**The price rule is a mitigation, not a guarantee, and this is the honest limit of the stage.**
It is enforced in three places — the platform section of the system prompt, every commerce tool
result, and the deliberate absence of any tool shaped like a calculator — and a model can still be
talked past all three. That is not speculation. Asked _"which is cheaper and by how much"_, a real
model against the reference connector answered **"cheaper by £31.00"** despite the general rule.
Naming that exact question in the prompt and in the compare tool's own result fixed it, and the
three phrasings tested — a total for three, a difference, a percentage — are now refused. Nobody
should read that as closed. The only structural fix is to check an answer's monetary figures against
what the tools actually returned, and on the streaming path the tokens are delivered before such a
check could run. That is a real design problem, not a tightening, and it needs its own stage.

**A missing `MAGENTO_API_URL` with a commerce feature on is a boot failure.** This follows directly
from degrading failures: a missing URL would otherwise look like a model that had gone vague, one
customer at a time. Boot is the only place left where the mistake cannot be missed, so the error
names the offending feature and offers both ways out.

**Free-text addresses are not detected, and the redactor does not pretend to detect them.** "34
Bridge Street, flat 2" has no structure that "34 pairs, size 2" lacks; a detector aggressive enough
to catch one would shred ordinary product questions. The defence against addresses is structural
instead: no tool fetches one, `Order` has no field for one, and `trackOrder` tells the model never
to ask. A control believed to work stops being reviewed, so the gap is documented rather than
papered over.

**The redactor's false positives were the design risk, not its misses.** A customer whose order
number gets eaten watches the assistant lose the thread of their own question, so the card detector
requires a Luhn check, the phone detector ignores anything under ten digits, and URLs are excluded
outright — roughly one in ten arbitrary digit runs passes Luhn, and breaking a tracking link to
protect data that was never there is the worse outcome.

**Order responses carry no address, contact or payment detail, even if a connector sends them.** The
adapter maps four fields and drops the rest. What is never mapped is never written into history.

**Two log-hygiene consequences worth knowing.** The logger's structural key redactor matches
`token`, `auth`, `credential`, `secret`, `key`, `bearer` and `signature` — two attempts to log
_whether_ a service credential is configured were published as `"[redacted]"` before the field was
renamed to avoid every one of those words. Renaming is the right fix; weakening a blanket secret
rule so one boolean can through is not.

**Adding a commerce tool is an entry in `TOOL_FACTORIES` and nothing else.** ADR 0022 claimed this;
four tools arriving without a change to the conversation loop is the first real evidence. 9b will
test it harder, because a confirmed mutation is not just another entry.

## Alternatives considered

**Index the catalogue into Qdrant alongside store content.** Retrieval already works and product
text would embed cleanly. Rejected because it answers a live question with a snapshot: prices and
stock would be as fresh as the last ingestion run, and an assistant confidently quoting yesterday's
price is worse than one that says it cannot check.

**Let the connector return computed totals.** Would remove the arithmetic problem entirely, by
putting the sums where the tax rules and cart logic already live. Genuinely attractive, and it
returns in 9b where a cart total is a real thing to fetch. Rejected here because there is no cart
in the read path — a "total" for products a customer has not chosen would be ShopSage inventing the
quantities.

**Two ports, one for products and one for orders.** They have different scopes and different
sensitivity. Rejected because both are reads over the same contract to the same connector with the
same credential, and the split would have been about how the endpoints are grouped rather than
about anything the domain needs to distinguish.

**Put the customer's token on `req.session`.** One object, one place to look. Rejected: the session
is deliberately safe to log and is bound into the request logger, and the whole value of that
property is lost the moment a bearer credential shares it.

**Personalised recommendations from purchase history.** Rejected outright, not deferred. The session
subject is a pseudonym by agreement, so the data is not available — and it should not arrive by
accident later. If it is ever wanted it is a contract change with a privacy review, not a scoring
tweak.
