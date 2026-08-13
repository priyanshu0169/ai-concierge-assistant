/**
 * The ports `assistant-core` declares, and the shapes it works in.
 *
 * The domain states what it needs, at the narrowest useful width, and the composition
 * root supplies something that satisfies it. Nothing here mentions HTTP, Express,
 * Qdrant, an embedding service or a vector — see docs/adr/0003 and docs/adr/0021.
 *
 * The one deliberate exception is `@shopsage/llm-client`'s message and completion
 * types, imported rather than re-declared. Those types were designed in Stage 2 as
 * the provider-neutral contract "the rest of ShopSage is allowed to know about"
 * (docs/adr/0011), and re-declaring tool-call shapes here would be pure duplication
 * with a drift risk and no gain. The rule that matters is enforced by review: this
 * package may import *types* from an outbound adapter and never a factory function.
 */

/**
 * A language model, narrowed to what the conversation loop actually uses.
 *
 * `stream()` was deliberately absent until Stage 7, because nothing in the domain
 * streamed and a port should describe what is needed rather than what an adapter
 * happens to offer. It is here now, in the shape Stage 2 designed: a sequence of
 * `delta` events followed by exactly one `end` carrying the same completion
 * `generate()` would have returned.
 *
 * That `end` event is why the tool loop can stream without knowing it is streaming.
 * A caller never reassembles fragmented tool-call JSON - the adapter does it, and
 * hands over a finished `LlmCompletion` either way (docs/adr/0011).
 *
 * @typedef {object} LanguageModel
 * @property {(
 *   messages: import('@shopsage/llm-client').LlmMessage[],
 *   options?: import('@shopsage/llm-client').LlmCallOptions,
 * ) => Promise<import('@shopsage/llm-client').LlmCompletion>} generate
 * @property {(
 *   messages: import('@shopsage/llm-client').LlmMessage[],
 *   options?: import('@shopsage/llm-client').LlmCallOptions,
 * ) => AsyncIterable<import('@shopsage/llm-client').LlmStreamEvent>} stream
 */

/**
 * One retrieved piece of store content.
 *
 * @typedef {object} RetrievedChunk
 * @property {string} id
 * @property {number} score Similarity, higher is closer.
 * @property {string} text What the model reads.
 * @property {string} title
 * @property {string} [url] Where a customer can be sent, when there is such a place.
 * @property {string} [headingPath]
 * @property {string} [contentType]
 */

/**
 * Knowledge retrieval, as **one** port.
 *
 * This is the most important shape in the file. The domain asks for "content relevant
 * to this question" and is told nothing about how that happens - not that text is
 * embedded, not that a vector store exists, not that similarity is cosine. The
 * composition root satisfies it by combining an embeddings client with a vector
 * repository.
 *
 * Declaring two ports instead (embed, then search) would have pushed the *orchestration*
 * of retrieval into the domain, which means the domain would know retrieval is
 * vector-based. Then swapping to a keyword index, a hybrid retriever, or a managed
 * search service becomes a domain change rather than an adapter change.
 *
 * @typedef {object} KnowledgeRetriever
 * @property {(query: {
 *   text: string,
 *   siteId: string,
 *   topK: number,
 *   minScore: number,
 * }) => Promise<RetrievedChunk[]>} retrieve
 */

/**
 * Money, as the connector rendered it.
 *
 * `formatted` is the **only** field ever shown to a customer, and that is a contract term rather
 * than a convenience: the connector formats money in the store's locale and currency, because
 * ShopSage does not know a store's conventions and must not learn them.
 *
 * `amount` is a decimal **string** and is never parsed. Floats and money do not mix, and nothing in
 * this domain does arithmetic on a price - see `AssistantTool` and docs/adr/0028 for why that is a
 * rule and not an oversight.
 *
 * @typedef {object} Money
 * @property {string} formatted
 * @property {string} [amount] Decimal string. Carried, never computed with.
 * @property {string} [currency]
 * @property {boolean} [taxIncluded] Absent means **unstated**, never assumed either way.
 */

/**
 * One product, as the assistant may describe it.
 *
 * `url` is required. Every product claim gets a link a customer can check, which is the same
 * reasoning that makes a grounded answer carry citations.
 *
 * `availability` is absent when the connector did not say. Absent means the assistant says nothing
 * about stock - never that it is available, and never inferred from anything else here.
 *
 * @typedef {object} Product
 * @property {string} sku
 * @property {string} name
 * @property {string} url
 * @property {string} [imageUrl]
 * @property {string} [summary]
 * @property {Money} [price]
 * @property {'in_stock' | 'out_of_stock' | 'backorder' | 'unknown'} [availability]
 */

/**
 * One order, narrowed to what a customer asks about.
 *
 * Deliberately carries **no** address, email, phone or payment detail. Two reasons, and the second
 * is the binding one: the assistant has no use for them, and an answer about an order is written
 * into persisted conversation history - so a field that is never fetched is a field never retained.
 *
 * @typedef {object} Order
 * @property {string} reference
 * @property {string} [status] Stable enum, for logic.
 * @property {string} [statusLabel] The store's own wording, for a customer to read.
 * @property {string} [placedAt]
 * @property {string} [estimatedDelivery]
 * @property {string} [trackingUrl]
 * @property {Money} [total]
 * @property {{ name: string, quantity: number, sku?: string }[]} items
 */

/**
 * Commerce facts, as **one** port.
 *
 * The same shape of decision as `KnowledgeRetriever`, for the same reason: the domain asks for
 * commerce facts and never learns that a Magento module is answering, so replacing the connector is
 * an adapter change. Splitting it per resource would put the *shape* of somebody's catalogue API
 * into the domain.
 *
 * `credential` is the customer's session token, forwarded and **never interpreted**. Its subject is
 * a pseudonym by agreement, so the connector resolves identity because it minted the token. The
 * domain must not parse it, branch on it, or log it - it is an opaque string passing through.
 *
 * Read methods only. Cart mutation follows a propose → confirm → execute workflow that needs a
 * confirmed proposal, an endpoint and a widget affordance, and is Stage 9b.
 *
 * @typedef {object} CommerceCatalogue
 * @property {(query: { query: string, limit?: number, credential?: string }) => Promise<Product[]>} searchProducts
 * @property {(query: { sku: string, credential?: string }) => Promise<Product | undefined>} findProduct
 * @property {(query: { credential?: string }) => Promise<Order[]>} listOrders
 */

/**
 * A cart change the assistant has **prepared and not made**.
 *
 * The central object of the propose → confirm → execute workflow, and the reason it exists is a
 * single sentence: a language model must not be in the commit path of a customer's basket. It can
 * misread "not the blue one" as an instruction to add the blue one, and an apology does not undo a
 * charge. So a tool produces one of these, a human confirms it, and only then does anything move.
 *
 * Three fields are load-bearing beyond their obvious use:
 *
 * - `subject` is checked at confirmation. A proposal id that leaks - in a shared screenshot, a log,
 *   a copied URL - must not let anybody else alter that cart, so the confirming session has to be
 *   the session that was offered it.
 * - `expiresAt` is minutes, not hours. A proposal shows the customer a price; executing an
 *   hour-old proposal against a repriced catalogue is exactly the surprise this design avoids.
 * - `summary` is what the customer reads before agreeing, and it is built by ShopSage from connector
 *   data rather than written by the model. Consent to a sentence a model composed is not consent to
 *   what the proposal actually does.
 *
 * @typedef {object} CartProposal
 * @property {string} id Opaque. The confirmation token, so it is unguessable rather than sequential.
 * @property {'addToCart' | 'applyCoupon'} kind
 * @property {string} siteId
 * @property {string} conversationId
 * @property {string} subject Whose proposal this is. Checked on confirmation.
 * @property {string} summary Plain text, built from connector data. What consent is given to.
 * @property {string} expiresAt ISO 8601.
 * @property {CartProposalLine[]} [lines] For `addToCart`.
 * @property {string} [code] For `applyCoupon`.
 */

/**
 * One line of a proposed basket change.
 *
 * `price` is the price **as quoted at proposal time**, carried so the customer can see what they are
 * agreeing to. It is never sent to the connector and never added up - the connector owns the cart
 * total, and see docs/adr/0028 for why nothing here does arithmetic on money.
 *
 * @typedef {object} CartProposalLine
 * @property {string} sku
 * @property {string} name
 * @property {number} quantity
 * @property {Money} [price]
 * @property {string} [url]
 */

/**
 * What happened when a confirmed proposal was executed.
 *
 * `message` comes from the connector, because only the connector knows a store's wording for "that
 * coupon has expired". ShopSage does not compose commerce copy.
 *
 * @typedef {object} CartOutcome
 * @property {boolean} applied Whether the cart actually changed.
 * @property {string} [message] The store's own wording, for the customer.
 * @property {number} [itemCount] Lines in the cart afterwards, if the connector said.
 * @property {Money} [total] The cart total **as the connector computed it**.
 * @property {string} [cartUrl] Where the customer can see it.
 */

/**
 * Cart mutation, as a port **separate** from `CommerceCatalogue`.
 *
 * Stage 9a left this open and the answer is separation, for a reason that outlived the tidiness
 * argument: the read adapter wraps every call in a retry, and a write must never be retried. Keeping
 * them apart makes that structural - there is no code path from a mutation to `withRetry` - rather
 * than a comment somebody edits away. The scopes differ too (`cart`, not `chat`), and so does the
 * failure policy: a failed read is worth another attempt, a failed "add to basket" is a question for
 * the customer.
 *
 * `idempotencyKey` is derived from the proposal, so a retried confirmation - a double-tap, a flaky
 * network, a customer reloading - is the same key and the connector can recognise it. ShopSage's own
 * defence is stronger and comes first: a proposal is consumed atomically, so a second confirmation
 * finds nothing to confirm. The key is what protects the case where the connector received the
 * request and the response was lost.
 *
 * @typedef {object} CommerceCart
 * @property {(input: {
 *   lines: CartProposalLine[],
 *   idempotencyKey: string,
 *   credential?: string,
 * }) => Promise<CartOutcome>} addToCart
 * @property {(input: {
 *   code: string,
 *   idempotencyKey: string,
 *   credential?: string,
 * }) => Promise<CartOutcome>} applyCoupon
 */

/**
 * Where proposals wait to be confirmed.
 *
 * **`consume` is take-once and must be atomic.** That single property is what makes a double-tapped
 * confirm button safe, and it is why this is not a general key-value store: a `get` followed by a
 * `delete` is a race that adds two jackets to a basket, and only the backend can close it.
 *
 * `save` is not `set` for the same reason `ConversationStore.append` is not `set` - the operation the
 * domain needs is the operation the port offers, so an adapter can make it atomic.
 *
 * @typedef {object} CartProposalStore
 * @property {(proposal: CartProposal) => Promise<void>} save
 * @property {(query: { siteId: string, id: string }) => Promise<CartProposal | undefined>} consume
 */

/**
 * One turn in a conversation, as the domain stores it.
 *
 * Only `user` and `assistant` turns are persisted. Tool calls and tool results are
 * working state of a single turn, not history: replaying them to the model on the next
 * question would grow the prompt without adding anything a customer said or was told.
 *
 * @typedef {object} ConversationTurn
 * @property {'user' | 'assistant'} role
 * @property {string} content
 * @property {string} at ISO 8601.
 */

/**
 * Conversation history.
 *
 * Deliberately not a general key-value store: `append` rather than `set` keeps the
 * read-modify-write inside the adapter, where a real backend can make it atomic.
 * Two browser tabs on one conversation would otherwise race and lose a turn.
 *
 * @typedef {object} ConversationStore
 * @property {(input: { siteId: string, conversationId: string, limit: number }) => Promise<ConversationTurn[]>} history
 * @property {(input: { siteId: string, conversationId: string, turns: ConversationTurn[] }) => Promise<void>} append
 */

/**
 * A tool the model may call.
 *
 * `execute` returns a string because that is what a tool result message carries. JSON
 * is the conventional encoding and the tool decides its own shape.
 *
 * @typedef {object} AssistantTool
 * @property {string} name
 * @property {string} description
 * @property {Record<string, unknown>} parameters JSON Schema for the arguments.
 * @property {(input: {
 *   arguments: Record<string, unknown>,
 *   context: ToolContext,
 * }) => Promise<ToolResult>} execute
 */

/**
 * What a tool is given about the request it is serving.
 *
 * @typedef {object} ToolContext
 * @property {string} siteId
 * @property {import('@shopsage/platform').SiteProfile} siteProfile
 * @property {KnowledgeRetriever} retriever
 * @property {CommerceCatalogue} [commerce] Absent when no commerce tool is enabled.
 * @property {string} [conversationId] Which conversation a proposal belongs to.
 * @property {string} [subject] Whose session this is. Recorded on a proposal, checked on confirm.
 * @property {string} [credential] The session token, to forward. **Never** inspected or logged.
 * @property {import('@shopsage/platform').Logger} [logger]
 */

/**
 * @typedef {object} ToolResult
 * @property {string} content Fed back to the model as the tool result.
 * @property {RetrievedChunk[]} [chunks] Surfaced for citation; not shown to the model twice.
 * @property {CartProposal} [proposal] A cart change awaiting the customer's confirmation.
 */

/**
 * A source shown to the customer alongside an answer.
 *
 * @typedef {object} AnswerSource
 * @property {string} title
 * @property {string} [url]
 */

/**
 * @typedef {object} AssistantReply
 * @property {string} conversationId
 * @property {string} messageId Identifies this assistant turn.
 * @property {string} answer
 * @property {AnswerSource[]} sources
 * @property {import('@shopsage/llm-client').LlmFinishReason} finishReason
 * @property {boolean} grounded Whether the answer was supported by retrieved content.
 * @property {CartProposal} [proposal] Present when the turn prepared a cart change to confirm.
 */

/**
 * One turn, delivered progressively.
 *
 * Four events, and the ordering guarantees matter as much as the shapes:
 *
 * - `start` arrives **first, always**, before any model call. A caller that loses the
 *   connection immediately still holds the `conversationId` needed to continue, which
 *   it could not reconstruct from a half-received answer.
 * - `tool` brackets each tool execution. It exists because the gap between a question
 *   and the first token of its answer is a whole retrieval round - several seconds of
 *   silence that reads as a hung connection unless something fills it. It is a status
 *   signal ("Searching…"), not content.
 * - `delta` is text to append as it arrives.
 * - `proposal` arrives when a turn has prepared a cart change, **before** `done`. It is the one event
 *   a client may not merely display: a proposal is unusable without something to confirm it, so a
 *   renderer that ignores this shows an assistant claiming to have prepared something the customer
 *   cannot accept. It is emitted separately rather than only inside `done` so the confirmation can be
 *   rendered the moment the tool has run, rather than after the model finishes writing prose.
 * - `done` arrives **exactly once, last**, and its `reply.answer` is **authoritative**. `reply.proposal`
 *   repeats what the `proposal` event carried, so a buffered caller sees it too.
 *
 * That last rule is the one to get right. Deltas are a progressive preview of
 * `reply.answer`, not an independent source of truth: when a model returns no prose at
 * all there are zero deltas and the store's `noAnswerMessage` appears only in `done`. A
 * renderer that trusts deltas alone shows an empty bubble in exactly the case where
 * saying something matters most. Reconcile against `done.answer` at the end - in the
 * normal case the two are identical and reconciling changes nothing.
 *
 * A failure has no event here. It cannot: by the time one happens the response status is
 * already sent, so it is the delivery layer's problem, and it is solved there
 * (docs/adr/0023).
 *
 * @typedef {{ type: 'start', conversationId: string, messageId: string }
 *   | { type: 'tool', name: string, phase: 'started' | 'finished' | 'failed' }
 *   | { type: 'delta', text: string }
 *   | { type: 'proposal', proposal: CartProposal }
 *   | { type: 'done', reply: AssistantReply }} AssistantStreamEvent
 */

export {};
