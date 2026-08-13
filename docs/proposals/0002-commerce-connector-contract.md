# Proposal 0002: The commerce connector contract

**Status: ACCEPTED — this is the commerce specification for ShopSage.**
Date: 2026-08-03 (accepted 2026-08-03)
Owner: ShopSage
Reviewed by: the ShopSage owner. Still outstanding from the Magento side: questions 6 and 7 below.

The second contract between two repositories. The read half is implemented on ShopSage's side in
Stage 9a, against the reference connector in §11; the write half is Stage 9b.

Resolves [Roadmap](../Roadmap.md) open decision 4. Recorded as
[ADR 0028](../adr/0028-commerce-reads-behind-one-adapter.md).

**Why a proposal rather than code.** The session-token contract needed the other side's answers
about _security_. This one needs answers about what the assistant is **allowed to say** — whether
a price it quotes includes tax, whether it may claim something is in stock, whether it may put
things in a customer's basket. Those are commercial and legal decisions with customer-visible
consequences, and getting them wrong is not a refactor.

**How to review:** the numbered questions in [Open questions](#open-questions) need answers.
Everything else is a recommendation to argue with. Question 1 is the one to read first.

---

## 0. Decisions

Reviewed and accepted with the decisions below. They are binding on both sides; where one narrows
the recommendation in the body, the decision wins.

| #   | Question                                            | Decision                                                                                                                                                               |
| --- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Formatted, tax-explicit prices                      | **Accepted**, with one change: `taxIncluded` is **optional**, and absent means _unstated_. ShopSage says so in as many words rather than assuming either way — see §5. |
| 2   | May the assistant quote prices?                     | **Yes**, but only exactly as returned. It must never calculate totals, discounts, taxes or perform any price arithmetic.                                               |
| 3   | Expose `availability`?                              | **Yes**, from Magento data only, and never inferred. Absent means the assistant says nothing about stock.                                                              |
| 4   | Cart mutation                                       | **Propose → confirm → execute.** The assistant never modifies a cart without explicit customer confirmation. This is Stage 9b.                                         |
| 5   | Order detail                                        | **Status, order number, estimated delivery and tracking only.** No address, contact or payment detail.                                                                 |
| 6   | Latency commitment                                  | **Open**, and needs the module author. ShopSage's default is 5s per call, configurable, with two attempts for a read.                                                  |
| 7   | Repository ownership and versioning                 | **Open**, and needs the module author. The path version in §8 stands as the proposal.                                                                                  |
| 8   | Connector support for comparison and recommendation | **No.** Both live in ShopSage; Magento exposes product data only.                                                                                                      |

Two operational decisions were taken alongside them: decimal values stay **strings**, pagination is
**cursor**-based, retries apply to **idempotent GETs only**, and connector failures degrade into
natural assistant responses rather than HTTP errors.

### What ShopSage built against this, and what it learned

Stage 9a implements the read half. Three things are worth reporting back to whoever reviews the
module against this document:

- **Decision 2 is a mitigation, not a guarantee.** Asked _"which is cheaper and by how much"_, a
  real model against the reference connector answered _"cheaper by £31.00"_ despite the rule being
  in the system prompt and in every tool result. Naming that exact phrasing fixed the three cases
  tested. It should not be read as closed; ADR 0028 records what a structural fix would require.
- **`taxIncluded` being optional matters more than it looks.** Two products, one marked
  tax-inclusive and one silent, are treated as _differing_ on tax treatment rather than agreeing.
  A connector that omits the field for some products and not others will produce comparisons that
  read as evasive, correctly.
- **A 404 on a single product means absent, not failed.** ShopSage answers "we do not sell that"
  from it. A connector returning 500 for an unknown sku will produce an apology instead.

---

## 1. The problem

The assistant can answer from a store's written content and cannot answer anything about a
product, an order or a basket. Those live in Magento, change by the minute, and must be read at
question time.

The failure being designed against is specific and has been named since Stage 4: **a confidently
wrong price is the most damaging output this system can produce.** Everything below follows from
taking that seriously rather than repeating it.

## 2. Principles

| Principle                                               | Consequence                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| Commerce data is **never** embedded or cached           | Read at question time; a snapshot is wrong the moment it is taken  |
| The assistant repeats figures, it does not compute them | See §5 — this is the sharpest constraint here                      |
| ShopSage never learns who the customer is               | It forwards the session token; Magento resolves identity           |
| Magento owns business rules                             | Tax, promotions, eligibility, stock — ShopSage asks, never decides |
| Every capability is refusable                           | Store flag **and** session scope, both already exist               |

The first is settled, not proposed: [ADR 0016](../adr/0016-content-source-port-and-canonical-document.md)
and `docs/RAG.md` already exclude products from the knowledge base for exactly this reason.

## 3. The endpoints

Versioned in the path, so the two repositories can move independently:

```
GET  /assistant/v1/products?q=…&limit=…&cursor=…
GET  /assistant/v1/products/{sku}
GET  /assistant/v1/categories
GET  /assistant/v1/orders?limit=…            (the authenticated customer's own)
GET  /assistant/v1/orders/{reference}
POST /assistant/v1/cart/items
POST /assistant/v1/cart/coupons
```

ShopSage pins the version and treats an unknown field as absent, so the module can add fields
without a coordinated release. Removing or renaming one is breaking.

`/assistant/session` and `/assistant/.well-known/jwks.json` from
[Proposal 0001](0001-assistant-session-token.md) are **unversioned**, deliberately: they are
infrastructure the widget depends on, and a version bump there would break every page in the wild.

## 4. Shapes

### Product

```json
{
  "sku": "TS-BLK-M",
  "name": "Organic cotton t-shirt, black, medium",
  "url": "https://store.example.com/organic-cotton-t-shirt",
  "imageUrl": "https://store.example.com/media/ts-blk.jpg",
  "price": {
    "formatted": "£24.00",
    "amount": "24.00",
    "currency": "GBP",
    "taxIncluded": true
  },
  "availability": "in_stock",
  "summary": "Heavyweight organic cotton, ethically sourced."
}
```

| Field          | Notes                                                                     |
| -------------- | ------------------------------------------------------------------------- |
| `sku`          | Stable identifier; what a follow-up question refers to                    |
| `name`         | Already localised by Magento. ShopSage does no translation                |
| `url`          | **Required.** Every product claim gets a link a customer can verify       |
| `price`        | See §5. `formatted` is required and is what the assistant quotes          |
| `availability` | `in_stock` \| `out_of_stock` \| `backorder` \| `unknown` — see question 3 |
| `summary`      | Optional, ≤200 chars. Prose, not HTML                                     |

`amount` is a **decimal string**, never a number. A JSON number is a float, and floats and money
do not mix — `0.1 + 0.2` is the canonical demonstration. ShopSage never parses it arithmetically
anyway (§5); it exists so a client that needs to sort or compare can.

### Order

```json
{
  "reference": "000001234",
  "placedAt": "2026-07-28T09:14:00Z",
  "status": "shipped",
  "statusLabel": "Shipped",
  "total": { "formatted": "£48.00", "amount": "48.00", "currency": "GBP", "taxIncluded": true },
  "trackingUrl": "https://carrier.example.com/track/XYZ",
  "items": [{ "sku": "TS-BLK-M", "name": "Organic cotton t-shirt", "quantity": 2 }]
}
```

`status` is a small stable enum for logic; `statusLabel` is the store's own wording for a customer
to read. Two fields because a store calls "shipped" whatever it likes, and the assistant should use
the store's word while the code branches on the stable one.

**No address, no payment detail, no email.** ShopSage has no use for them and every reason not to
receive them — see §7 and question 5.

### Cart mutation

```json
POST /assistant/v1/cart/items
{ "sku": "TS-BLK-M", "quantity": 1, "idempotencyKey": "call_abc123" }
```

```json
{ "outcome": "added", "cartUrl": "https://store.example.com/checkout/cart", "itemCount": 3 }
```

`outcome` is `added` | `already_present` | `unavailable` | `refused`, with an optional
`reasonLabel` in the store's words. The response carries **no prices**: if the assistant wants to
tell a customer what their basket costs, it links to the basket. See §5.

## 5. Prices, and why the assistant must not do arithmetic

This is the section most worth arguing with.

**The assistant quotes `price.formatted` verbatim and never computes.** If a customer asks "how
much for three?", the model multiplying £24.00 by three is a plausible-looking number generated by
a language model — which is exactly the thing this project has spent nine stages arranging not to
publish. It will usually be right. When it is wrong it is wrong about money, in writing, in the
store's voice.

So:

- The connector returns **formatted** prices, already rendered by Magento in the store's locale
  and currency. ShopSage does not format money; it does not know a store's conventions and should
  not learn them.
- `taxIncluded` is **optional and, when present, explicit** (decision 1). A store quoting ex-VAT
  prices to a consumer without saying so has a legal problem, and the assistant cannot infer which
  it is — so an absent flag is carried as _unstated_ and the tool result tells the model, in as many
  words, not to claim either. A connector that can state it should; one that cannot must omit it
  rather than guess.
- Quantity totals come from the **cart**, not from the model. "Add three and I'll show you the
  basket" is answerable; "that'll be £72" is not.
- The system prompt gains a rule to this effect, and the `searchProducts` tool description says so
  too — a tool description is where a model actually reads its constraints.

**This is a guarantee ShopSage cannot fully enforce**, and Stage 9a proved it rather than predicting
it: asked _"which is cheaper and by how much"_, a real model answered _"cheaper by £31.00"_ with the
rule already in the prompt and in the tool result. Naming that phrasing explicitly fixed the tested
cases. Grounding is observed, not structural ([ADR 0022](../adr/0022-bounded-tool-loop.md)); so is
this. A model asked nicely
enough will still do sums. The mitigations are the prompt, the tool description, the absence of
any arithmetic-shaped tool, and never returning a unit price without a link. Question 2 asks
whether that is an acceptable residual risk or whether product prices should be withheld from the
assistant entirely.

## 6. Mutations

`POST /cart/items` and `POST /cart/coupon` are different in kind from everything else ShopSage does:
they change a customer's state. Everything else in this contract is a read.

**They are never called on the strength of a model's reading of free text.** Decision 4 chose
propose → confirm → execute, and Stage 9b built it: a tool produces a stored proposal, a customer
clicks a button, and a **separate** HTTP request executes it. The model is out of the commit path as a
property of what it can reach, not as a rule — the tools have no access to the write client at all.

So the sequence the connector sees is:

```
POST /assistant/v1/cart/items        ← only ever from a confirmation, never from a turn
  Authorization: Bearer <customer session token>
  Idempotency-Key: <32 hex chars, derived from the proposal id and hashed>
  { "items": [{ "sku": "…", "quantity": 2 }] }
```

**Only `sku` and `quantity` are sent.** The proposal ShopSage stored also holds the name, the price and
the URL — those exist so a _customer_ can see what they agreed to. Sending a price would invite the
connector to trust ShopSage's copy of one, and the connector is the authority on what things cost.

**Idempotency is required, and the reason changed shape.** The original reason was that a model can
call the same tool twice in one turn. That is still true and no longer the risk it was, because a
proposal is consumed atomically before anything reaches the connector — a duplicate confirmation finds
nothing to confirm. What remains is the case that survives every defence on this side: **the request
arrived and the response was lost.** The key is therefore _derived_ from the proposal, so a retry
carries the same one, and hashed, because the proposal id is a bearer token and idempotency keys end up
in logs.

The connector must treat a repeated key as a no-op that **replays its original outcome**. Returning the
same answer matters as much as not repeating the work.

**Neither is ever retried by ShopSage, at any status.** A 5xx may mean the cart changed and the reply
was lost, so a retry risks a second charge. The write adapter does not import a retry helper, and a test
asserts that.

**Both sit behind their own scope and their own store flag** — `cart` and `coupons` — so a store can
enable product search without ever letting the assistant touch a basket. Both default to off, and the
confirmation route is not mounted at all unless one is on.

**A refusal is not an error.** `{ "applied": false, "message": "That code has expired." }` with a `200`
is the expected way to decline: the message is shown to the customer verbatim, because only the store
knows how it says that. ShopSage maps a missing or unrecognised `applied` to **false** — every other
field falls back to absent, but this one cannot fall back to "it worked".

## 7. Authentication and identity

ShopSage **forwards the customer's session token** on every connector call:

```
GET /assistant/v1/orders
Authorization: Bearer <the same token the widget presented>
```

This is the payoff of the pseudonymous `sub` agreed in
[Proposal 0001](0001-assistant-session-token.md), decision 2. Magento minted the token, so Magento
can resolve it to a customer; ShopSage never holds a customer id, and there is nothing in it to
leak. The connector must reject a token whose scope does not permit the call — belt and braces,
since ShopSage already withholds the tool.

**The retention consequence needs stating.** An answer about an order is written into conversation
history, which is persisted in Redis with a TTL. So order references, item names and statuses will
sit in that store for the conversation's lifetime. That is a change in the _kind_ of data ShopSage
retains, and it is why open decision 5 (PII and retention) needs an answer before this ships rather
than after. Question 5 asks how far the connector should go in limiting what it returns.

ShopSage will not log connector response bodies. Product and order data is business data, and log
storage has a different retention policy from Redis.

## 8. Operational contract

| Concern    | Proposal                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------- |
| Pagination | Opaque `cursor`, not `page`. An offset shifts under a changing catalogue                 |
| `limit`    | ShopSage sends ≤10. A model cannot use fifty products and the prompt cannot hold them    |
| Timeout    | ShopSage bounds each call (`MAGENTO_TIMEOUT_MS`, default 5s)                             |
| Retries    | Idempotent GETs only. **Never** a mutation, whatever the status code                     |
| Errors     | The standard problem shape below; ShopSage never shows a connector message to a customer |
| Latency    | A commerce call sits inside a tool inside a turn — see below                             |

```json
{ "error": { "code": "PRODUCT_NOT_FOUND", "message": "for the log, not the customer" } }
```

| Status | Meaning for ShopSage                                                     |
| ------ | ------------------------------------------------------------------------ |
| 200    | Fine                                                                     |
| 401    | The forwarded token was rejected — surfaces as a failed tool, not a 401  |
| 403    | Scope insufficient. Should not happen; ShopSage withholds the tool first |
| 404    | Empty result, not an error: "I could not find that product"              |
| 409    | Mutation refused by a business rule. `reasonLabel` is shown              |
| 5xx    | A failed tool. The model says it could not look that up                  |

**Every failure degrades to a tool result, never to a failed request.** Already settled
([ADR 0022](../adr/0022-bounded-tool-loop.md)) and it applies unchanged: a connector outage means
the assistant says it cannot check stock, not that a customer gets a 502.

**Latency is the thing to watch.** A grounded knowledge answer is already ~5s over two gateway
rounds. A product question adds a connector call inside a tool round, and a comparison could add
several. If the connector is slow, the assistant is slow, and the customer sees it token by token.
Question 6 asks what latency the module can commit to.

## 9. ShopSage's side, for context

Included so a reviewer can see which answers affect what. **This half needs no agreement** — it is
internal, and it is deliberately arranged so the wire format above touches exactly one file.

Updated after Stage 9a, so this section describes what exists rather than what was planned.

**One new port**, declared by the domain as always
([ADR 0021](../adr/0021-the-domain-declares-its-ports.md)). As built, reads only:

```js
CommerceCatalogue: {
  searchProducts({ query, limit, credential }) -> Product[]
  findProduct({ sku, credential }) -> Product | undefined
  listOrders({ credential }) -> Order[]
}
```

One port rather than three, for the reason `KnowledgeRetriever` is one: the domain asks for commerce
facts and never learns that a Magento module is answering.

Two changes from the proposed shape, both from implementation rather than taste. `siteId` is gone —
one deployment serves one store, so a per-call site was a parameter with one possible value and an
invitation to think otherwise. And `token` became `credential`, named for what the domain is allowed
to know about it: an opaque string to forward, never parsed, never logged.

The mutation methods are **absent** rather than stubbed, because decision 4 makes them a different
shape of thing: a confirmed proposal, not a tool call. Whether they join this port or get their own
is a live question for 9b — a write and a read have genuinely different failure policies, and this
port's reads retry.

**Six tools**, each an entry in the existing `TOOL_FACTORIES` table — not changes to the loop:

| Tool                | Store flag          | Session scope | Notes                               |
| ------------------- | ------------------- | ------------- | ----------------------------------- |
| `searchProducts`    | `productSearch`     | `chat`        | Reads. Every result carries its URL |
| `compareProducts`   | `productComparison` | `chat`        | Several `findProduct` calls         |
| `recommendProducts` | `recommendations`   | `chat`        | **ShopSage** decides (decision 8)   |
| `trackOrder`        | `orderTracking`     | **`orders`**  | Forwards the token; PII surface     |
| `addToCart`         | `cart`              | **`cart`**    | **Proposes only.** Cannot execute   |
| `applyCoupon`       | `coupons`           | **`cart`**    | **Proposes only.** Cannot execute   |

Every flag already exists in the site-profile schema and every one defaults to **off**. The scope
gating already works: a guest asking about an order gets a `200` and an honest "I cannot look that
up", because the tool is absent rather than refused
([ADR 0026](../adr/0026-magento-issued-session-tokens.md)) — verified against the running stack in
Stage 9a.

The four read tools arrived as four entries in that table with **no change to the conversation
loop**, which is the first real evidence for the claim
[ADR 0022](../adr/0022-bounded-tool-loop.md) made. What Stage 9a needed beyond them was not more
plumbing but two things the table cannot express: the arithmetic rule, and removing personal data
from conversation history before it is stored. Both are in
[ADR 0028](../adr/0028-commerce-reads-behind-one-adapter.md).

Stage 9b was the harder test of the same claim, and it found the boundary. `addToCart` and
`applyCoupon` are two more entries — but the loop **did** change, because a proposal is a third kind
of outcome a tool can return, only one may survive a turn, and it has to be yielded as a stream event.
The table absorbed the tools; it could not absorb a new outcome. There is also a new port
(`CommerceCart`), a new store (`CartProposalStore`), a new endpoint, a fourth SSE event and the
widget's first real affordance. See [ADR 0029](../adr/0029-cart-changes-need-a-confirmed-proposal.md).

## 10. What each side implements

**Magento module:**

- [ ] The seven endpoints in §3, versioned
- [ ] Formatted prices, with `taxIncluded` stated wherever the store knows it
- [ ] Idempotent cart mutations keyed by `idempotencyKey`
- [ ] Scope enforcement on the forwarded token
- [ ] A reference implementation ShopSage can test against — see §11

**ShopSage:**

- [ ] `CommerceCatalogue` port in `assistant-core`
- [ ] Six tools, flag- and scope-gated
- [ ] `@shopsage/magento-client` — the only file that knows the wire format
- [ ] `MAGENTO_*` configuration and a readiness probe
- [ ] A system-prompt rule against price arithmetic
- [ ] Token forwarding, and **no** logging of response bodies

## 11. A reference connector

Proposal 0001 shipped shared JWT vectors, and they worked: both sides can prove compliance without
the other running. The same approach applies, one step larger.

**Built.** `packages/magento-client/reference/server.js`, serving the eight-product fictional
catalogue in `catalogue.json`:

```sh
node packages/magento-client/reference/server.js --port 8750
# or, as part of the stack:
docker compose --profile reference up
MAGENTO_API_URL=http://shopsage-reference-connector:8750
```

It gives the module author a runnable specification rather than prose to interpret, and it is what
ShopSage's own commerce path is verified against — which keeps the two honest, since the adapter
cannot quietly grow an assumption this does not satisfy. If the real module disagrees with it, the
disagreement is visible immediately instead of at integration.

**The cart endpoints work now.** They were `501 NOT_IMPLEMENTED` through Stage 9a. The idempotency
ledger is the part worth copying: the first request for a key does the work and records its outcome, and
every later request with that key **replays the recorded outcome** without touching the cart. Returning
the same answer matters as much as not repeating the work — a caller whose response was lost must be
able to retry and learn what happened. A missing `Idempotency-Key` is a `400`, not a tolerated omission.

**One deliberate difference from a real module, and it must stay obvious.** The reference connector
reads the token's `sub` **without verifying the signature**. That is correct for a stand-in — a
verifying stand-in would need the private key, which would make it a second issuer — and
catastrophic anywhere real. It is behind a Compose profile and bound to loopback for that reason.

Two behaviours in it are contract terms rather than convenience, worth checking the real module
against: prices are **pre-formatted**, and orders are keyed by the token's **pseudonymous `sub`**
because the connector is what resolved identity. It also refuses `/orders` with `401` for no token
and `403` for a missing scope, even though ShopSage withholds the tool from such a session — the
thing holding the data does not get to assume its caller filtered correctly.

## Open questions

**Answered in §0.** Kept as written, because the reasoning behind each answer is the argument in the
body, and a decision is easier to revisit when the question it settled is still legible. Questions 6
and 7 remain genuinely open and need the Magento module's author.

1. **Are formatted, tax-explicit prices workable?** `price.formatted` rendered by Magento, plus a
   decimal `amount` and a required `taxIncluded`. This is the question with the most consequence
   attached; §5 is the argument.
2. **Should the assistant quote prices at all?** The residual risk in §5 is that a model asked
   nicely will do arithmetic anyway. The alternative — return names, URLs and availability but no
   prices, and let the customer read the price on the page — is materially safer and noticeably
   less useful. This is a commercial judgement, not a technical one.
3. **Should `availability` be exposed?** Saying "in stock" invites the model to promise something
   that changed while it was typing. A coarse enum plus a link is the proposal; omitting it
   entirely is defensible.
4. **Direct cart mutation, or propose-then-confirm?** Direct is one round trip and lets a model's
   misreading reach a basket. Confirm-first keeps the model out of the commit path and costs a
   widget feature.
5. **How much order detail should the connector return?** Whatever it returns will end up in
   persisted conversation history. The proposal is reference, status, total, tracking URL and item
   names — no address, no payment detail. Related: open decision 5.
6. **What latency can the module commit to?** ShopSage's 5s default per call is a guess. A
   comparison of three products could add three calls to a turn already taking five seconds.
7. **Who owns the module repository, and how is the contract versioned in practice?** A path
   version is proposed; what remains is who cuts a version and how ShopSage learns one has changed.
8. **Do `recommendProducts` and `compareProducts` need connector support**, or should they be built
   from `searchProducts` and `findProduct` on ShopSage's side? Magento knows the merchandising
   rules; ShopSage only knows the conversation.
