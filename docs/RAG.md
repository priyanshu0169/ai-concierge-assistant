# Retrieval-Augmented Generation

> **Status: the whole pipeline is implemented and wired into `/v1/chat`.** As of Stage 6 a question
> arriving at the API is embedded, retrieved, ranked, assembled into context, answered by the model
> and returned with citations. Verified end to end against a real crawl, real Qdrant, the real
> embedding gateway and the real LLM gateway: "How long do I have to return something?" →
> _"You have thirty days from the delivery date to return unopened items…"_ with three sources, and
> "Who is the chief executive?" → the store's no-answer message with no sources.
>
> Retrieval reaches a question through the `searchKnowledge` **tool**, not through a pre-built prompt.
> Which means the model decides whether to search — see [Grounding](#grounding) for what that does and
> does not guarantee.

## Pipeline

Each stage is a separate unit with one responsibility. They are never combined.

```
question
   │
   ├─ 1. embed ............... embeddings-client.embedQuery()          ✅ Stage 3
   ├─ 2. retrieve ............ vector-repository.search(), by siteId    ✅ Stage 3
   ├─ 3. rank ................ score threshold, dedupe + diversify     ✅ Stage 6
   ├─ 4. build context ....... assemble and truncate to a budget        ✅ Stage 6
   ├─ 5. build prompt ........ system prompt + history (+ tool result) ✅ Stage 6
   ├─ 6. generate ............ llm-client.generate()                   ✅ Stage 2
   └─ 7. format answer ....... citations, no-answer handling            ✅ Stage 6
answer
```

Steps 1–4 sit **inside** the `searchKnowledge` tool, which is why step 5 does not receive context: the
prompt is built before any retrieval has happened, and the context arrives later as a tool result. The
loop that connects them is [ADR 0022](adr/0022-bounded-tool-loop.md).

One file per step, none of them combined:

| Step | File                                                         | Package        |
| ---- | ------------------------------------------------------------ | -------------- |
| 1–2  | `retrieval/create-knowledge-retriever.js`                    | `rag-backend`  |
| 3    | `retrieval/rank-chunks.js`                                   | assistant-core |
| 4    | `retrieval/build-context.js`                                 | assistant-core |
| 5    | `prompt/build-messages.js`                                   | assistant-core |
| 6    | `conversation/run-tool-loop.js` → `LanguageModel.generate()` | assistant-core |
| 7    | `answer/format-answer.js`                                    | assistant-core |

Steps 1–2 live in `rag-backend` because they are the adapter satisfying the domain's
`KnowledgeRetriever` port: the domain asks for content relevant to a question and never learns that
answering involves an embedding model or a vector index ([ADR 0021](adr/0021-the-domain-declares-its-ports.md)).

The pipeline that _fills the store_ runs separately, ahead of any question:

```
content source
   │
   ├─ acquire ................ ContentSource.fetch()                    ✅ Stage 4
   ├─ chunk .................. structure-aware, by heading/paragraph    ✅ Stage 5
   ├─ embed (if changed) ..... embeddings-client.embedDocuments()       ✅ Stage 5
   ├─ store .................. vector-repository.insert(), upsert       ✅ Stage 5
   ├─ prune (if safe) ........ delete documents no longer produced      ✅ Stage 5
   └─ evaluate ............... golden questions, recall + refusal       ✅ Stage 5
```

The score threshold sits in step 3 conceptually but is applied by the store, in step 2: Qdrant discards
below-threshold matches itself rather than shipping them back to be filtered.

The separation is not ceremony. An LLM makes end-to-end assertions weak — the same input can produce
different output — so the deterministic stages must be independently testable. "Did we retrieve the
right chunks?", "did truncation drop the most relevant one?", "did ranking collapse five chunks from
one page into a single source?" are all answerable without a model in the loop, but only if each stage
is its own unit.

## Content scope

**In scope:** CMS pages, buying guides, FAQs, blog posts, shipping and returns policies.

**Out of scope: products.** Products come from the Magento API at query time. Embedding a product
catalogue produces a snapshot that is wrong the moment a price or stock level changes, and a
confidently wrong price is the most damaging output this system can produce. Product questions are
answered by the `searchProducts` tool against live Magento data (Stage 9), not by retrieval.

## Chunking ✅

Structure-aware splitting: heading boundaries first, paragraphs second, sentences third, and only
then an arbitrary character cut. Measured in **characters, not tokens** — a token-based design would
need a tokenizer specific to one model family, and the default embedding backend (a hosted gateway)
publishes no token limit to size against. Defaults sit around 500–700 tokens for English prose. See
[ADR 0020](adr/0020-structure-aware-chunking.md) and `config/site-profile.json`'s `ingestion` section.

The reasoning: FAQ and policy content is already written in self-contained sections, and splitting on
a fixed character count cuts answers in half — the classic failure is a return policy whose retrieved
chunk contains the conditions but not the time window. Overlap (`ingestion.overlapCharacters`,
default 200) protects against a boundary falling mid-answer by carrying the tail of one chunk into the
next.

Each chunk carries: `siteId`, `documentId`, `sourceId`, content type, a heading path, the source URL
(when the document has one), a content hash, and an ingestion timestamp. The content hash is what
makes re-ingestion idempotent — unchanged chunks are skipped rather than re-embedded, verified in this
stage's own run: an unchanged four-page corpus went from several seconds to embed down to a fraction
of a second to confirm nothing had changed. See
[ADR 0019](adr/0019-content-hash-idempotent-ingestion.md).

**Deletion is the harder half.** A page removed at the source must not leave its chunks answering
questions forever, but a crawl that failed partway through must not be mistaken for one that saw
everything and have 90% of a corpus deleted. Pruning refuses to run unless the crawl had zero failures
and covered at least half of what is already stored — verified against a real, deliberately narrowed
crawl in this stage, which correctly skipped pruning rather than deleting three live documents.

## Embeddings

| Property   | Default                                                 | Alternative              |
| ---------- | ------------------------------------------------------- | ------------------------ |
| Backend    | OpenAI-compatible gateway (`EMBEDDING_PROVIDER=openai`) | Self-hosted TEI (`=tei`) |
| Model      | `text-embedding-3-small`                                | `BAAI/bge-m3`            |
| Dimensions | 1536                                                    | 1024                     |
| Runtime    | The same gateway that serves the LLM                    | HuggingFace TEI, CPU     |

**The backend is a deployment decision, not an architectural one.** The client's port is identical
either way and no application code knows which is configured; switching is an environment change plus a
re-ingestion. See [ADR 0018](adr/0018-embeddings-backend-is-configuration.md).

> **Superseded:** Stage 1 recorded that embeddings were "local and free by mandate" and that a paid
> embedding API must never be called. That rule is **withdrawn**. It was written against a metered
> third-party account, and the company gateway is the same commercial arrangement chat completions
> already run under. Self-hosting stays a first-class option — for data residency, an air-gapped
> install, or a multilingual open model — which is exactly why it is still one setting away.

Self-hosting is the answer whenever content may not leave the network. BGE-M3 is multilingual, which
matters for stores serving more than one locale, and it produces sparse and multi-vector
representations alongside the dense vector — leaving the door open to hybrid retrieval without changing
models.

Note one thing the hosted path gives up: it reports no input-token limit, so chunk sizing cannot be
derived from `health()` the way it can against TEI, which publishes `max_input_length`. Chunking
(Stage 5) uses a configured character budget instead — see `ingestion.maxChunkCharacters` in
[Configuration](Configuration.md#ingestion--how-content-is-chunked).

**Changing the model invalidates the corpus.** Dimensions must be updated together with the model
name, the collection re-created, everything re-ingested — and `minScore` re-tuned, because score
distributions differ per model (see below). Vectors from two models in one collection produce
similarity scores that look plausible and mean nothing.

Two guards make that mistake loud rather than silent: every response is checked against
`EMBEDDING_DIMENSIONS`, and `/health/ready` fails when the backend is not serving the configured model.

## Retrieval and tenancy

Vectors live in a **single collection with a `siteId` payload filter**, not one collection per store.
This is Qdrant's own recommendation for multi-tenancy and keeps the repository interface uniform;
collection-per-store multiplies index overhead and turns "add a store" into an operational task. See
[ADR 0006](adr/0006-vector-repository-port.md).

Every search is filtered by `siteId`. That filter is a correctness requirement, not an optimisation:
without it one store's assistant can answer from another store's policies.

It is enforced structurally rather than by convention: `siteId` is a **required top-level field** of
`search()`, not an entry in an optional filter object, so it cannot be omitted. The same applies to
stored payloads and to filtered deletes. Verified against a real Qdrant with two stores in one
collection — a query as `demo-store` never returned the rival store's content, and a query as
`other-store` returned only its own.

Retrieval settings come from the site profile, because the right values depend on corpus size and
writing style:

| Setting                | Default | Effect                                                  |
| ---------------------- | ------- | ------------------------------------------------------- |
| `topK`                 | 6       | Chunks retrieved                                        |
| `minScore`             | 0.35    | Similarity floor; below it, decline instead of guessing |
| `maxContextCharacters` | 8000    | Context budget                                          |
| `maxCitations`         | 3       | Sources shown to the customer                           |

`minScore` is the main accuracy/coverage lever. Raising it makes the assistant say "I don't know" more
often and hallucinate less — for a commerce assistant that is usually the right trade.

**Calibrate it against measurements, not intuition — and re-calibrate per model.** The same five short
policy sentences, the same question (_"What is the return window?"_), two embedding models:

| Rank | `text-embedding-3-small`                                  | `bge-small-en-v1.5`                                       |
| ---- | --------------------------------------------------------- | --------------------------------------------------------- |
| 1    | **0.4205** Unopened items may be returned within 30 days… | **0.5423** Unopened items may be returned within 30 days… |
| 2    | 0.2877 Sale items are final and cannot be returned…       | 0.5230 Sale items are final and cannot be returned…       |
| 3    | 0.2450 Standard shipping takes three to five days…        | 0.4349 Gift wrapping is available at checkout…            |

Both rank the right answer first, but the _shape_ differs completely. The hosted model separates the
correct chunk from a related-but-wrong one by **0.13**; the small local model by **0.02**. Yet the small
model's absolute scores are _higher_ across the board.

Two lessons, and the second is the one that bites:

- **Absolute score is not confidence.** A higher number from a weaker model means nothing; the gap
  between first and second is what carries information.
- **`minScore` is model-specific and does not travel.** A floor of `0.35` admits all three results on
  `bge-small` and rejects everything below rank 1 on `text-embedding-3-small`. A floor of `0.9`
  returned nothing on either. **Changing the embedding model means re-tuning `minScore`**, in the same
  breath as re-creating the collection.

This is precisely why the golden question set in Stage 5 matters more than any amount of tuning by
inspection — and why reranking is on the list: a cross-encoder separates those top two far better than a
similarity score can.

## Grounding

Four mechanisms, because prompt instructions alone are not sufficient:

1. **A strict system prompt** (site profile) — answer only from context, never invent prices, stock
   or policies, offer human escalation when unsure.
2. **A score floor** — nothing below `minScore` reaches the context builder, so a chunk that merely
   shares vocabulary with the question cannot be presented to the model as an answer.
3. **Citations** — every grounded answer carries its sources, so a customer and a support agent can
   both check it. `formatAnswer` attaches them **only** when chunks were actually retrieved, so an
   answer the model produced from its own knowledge is visibly uncited rather than falsely attributed.
4. **An observed `grounded` flag** — logged on every turn, so the rate at which answers rest on
   retrieved content is monitorable rather than assumed.

### What grounding does not guarantee

Before Stage 6 this section claimed that when nothing clears `minScore`, the system would "not call the
model at all". **That is not achievable in a tool-calling architecture, and the claim was wrong.**
Retrieval happens inside a tool the _model_ chooses to call, so the model must be called at least once
to discover whether it wants to search — there is no earlier point at which a score floor could
short-circuit it.

What actually happens when retrieval returns nothing:

- The tool returns a "nothing found" result rather than context.
- The model, told by the system prompt to answer only from provided context, says it cannot answer.
- `formatAnswer` substitutes `noAnswerMessage` if the model returned no prose at all, and attaches no
  sources either way.

Verified: _"Who is the chief executive of the company?"_ against a corpus with no such page returned the
store's no-answer copy with `sources: []` and `grounded: false`.

So grounding is **observed and heavily encouraged, not structurally enforced**. A model that ignores its
system prompt and answers from parametric knowledge produces an answer with no citations and
`grounded: false` in the logs — detectable, but not prevented. Preventing it would mean refusing to
return any answer whose claims are not traceable to a retrieved chunk, which needs claim-level
attribution the project does not have. It is on the deferred list below.

The `grounded` flag is deliberately **not** returned to the client. It is an operational signal; a
browser has no use for it, and publishing it invites a client to branch on it.

## Tool calling

Retrieval is exposed to the model as a **tool**, not hard-wired ahead of generation:

```
searchKnowledge({ query: string }) → { chunks: [...], sources: [...] }
```

This is the architecture from Stage 1 even though it is the only tool, because a tool-calling loop is
multi-turn by nature: the model may request a tool, receive the result, then request another. A
single-shot "retrieve then answer" flow has to be rewritten when the second capability arrives, and
that rewrite touches the conversation loop, streaming, and error handling all at once.

As implemented in Stage 6 ([ADR 0022](adr/0022-bounded-tool-loop.md)):

- **At most three tool rounds**, then a final call with the tools **withdrawn** so the model has no
  option but prose. A stuck model costs a handful of calls, and an exhausted loop still answers.
- **A tool that throws becomes a tool result**, not an exception — one failed lookup must not turn a
  question into a 502.
- **An invented tool name is answered by naming what exists**, so the next round can recover.

The measured cost of the loop on a grounded answer is **two gateway calls**: the first returns
`finish_reason: tool_calls` from a 238-token prompt, the second returns `stop` from 544 tokens once the
retrieved context has been appended.

The same loop serves the streamed endpoint, parameterized only by how each round is fetched
([ADR 0023](adr/0023-streaming-delivery-over-sse.md)) — so retrieval, ranking, context assembly and
citation are identical whichever way the answer is delivered, and a test asserts the two agree. Streaming
also makes the loop's shape visible to a customer for the first time: the `tool` events are where the
1.8s-to-2.9s retrieval round shows up as "searching the help centre" rather than as silence. The tool description states explicitly that the corpus holds no
product listings, prices or stock, because a model believing otherwise will present whatever it finds
as current.

The tool description tells the model what the corpus contains; the `searchKnowledge` tool itself owns
steps 1–4 of the question pipeline and hands back both a rendered context block and the chunks behind
it — the chunks are what the citations are derived from, so a source can never be cited that was not
actually retrieved.

### Commerce tools ✅

Stage 9a added four, and they arrived as **four entries in `TOOL_FACTORIES` with no change to the loop**
— the first real evidence for the claim [ADR 0022](adr/0022-bounded-tool-loop.md) made:

| Tool                | Flag                | Scope        | What it does                                        |
| ------------------- | ------------------- | ------------ | --------------------------------------------------- |
| `searchProducts`    | `productSearch`     | `chat`       | Live products by description or sku                 |
| `compareProducts`   | `productComparison` | `chat`       | Two to four skus; comparison computed in ShopSage   |
| `recommendProducts` | `recommendations`   | `chat`       | A shortlist plus a reason, chosen in ShopSage       |
| `trackOrder`        | `orderTracking`     | **`orders`** | Status, reference, delivery, tracking. Nothing else |

**The catalogue and the knowledge base are deliberately separate tools**, and the reason is freshness.
A price in an indexed blog post is whatever it was on the day the page was written; a price from the
connector is whatever the store says now. Blending them would let stale money answer a current
question, and no amount of ranking makes that safe. The `searchKnowledge` description says in as many
words that the corpus holds no prices or stock.

**Comparison and recommendation logic lives here, not in Magento.** Magento exposes product data;
deciding what is worth saying about two products, or which three of ten to offer, is assistant
behaviour that changes for reasons unrelated to a catalogue. It also means "never recommend something
they cannot buy" is a function in `assistant-core/src/commerce/` with a test, rather than a query
somebody wrote in PHP once.

**Every commerce tool result restates the rules about money**, and that duplication is deliberate where
duplication is avoided elsewhere: instructions at the top of a long conversation lose against fresh
content further down, and these are the ones where being ignored produces a wrong number about money
in the store's voice. What that does and does not guarantee is in
[ADR 0028](adr/0028-commerce-reads-behind-one-adapter.md) — it is a mitigation, and the ADR names the
question that defeated an earlier version of it.

Still planned: `addToCart` and `applyCoupon` (Stage 9b, behind a propose → confirm → execute
workflow), `recommendRecipes`, `recommendWine`. Each behind a flag that defaults to off.

## Ranking and context assembly ✅

Retrieval returns up to `topK` chunks. Two problems remain before they can be shown to a model.

**Five chunks from one page is a false consensus.** A model handed five excerpts from the same shipping
page reads that as five sources agreeing. `rank-chunks.js` caps each source URL at
`MAX_PER_SOURCE = 2` after sorting by score and dropping exact-duplicate text, so a second relevant
page is not crowded out by the first page's runner-up chunks.

**The context budget is finite.** `build-context.js` assembles numbered excerpts —
`[1] Title > Heading` with a `Source:` line — and truncates at a **chunk boundary** rather than
mid-sentence, so the model is never handed half a sentence to reason from. The highest-scoring excerpt
is always included, even if it alone exceeds the budget: dropping it to stay under a character count
would discard the best answer to save space.

Citations are derived from the same chunks, deduplicated by URL and capped at `maxCitations`, so the
numbers a model cites and the sources a customer sees come from one list.

## Evaluation ✅

A golden question set with expected content, run by `npm run evaluate`, is
the most valuable testing in the project. Without it, "improving" chunking or `minScore` is guesswork:
a change that helps five questions and breaks eight is indistinguishable from a change that helps all
thirteen. See [ADR 0020](adr/0020-structure-aware-chunking.md).

Two metrics, no LLM in the loop — a non-deterministic step would make a regression impossible to
attribute:

- **Recall at K** — did an expected chunk come back at all, within `retrieval.topK`.
- **Refusal accuracy** — for a question the corpus genuinely cannot answer, did retrieval correctly
  return nothing above `retrieval.minScore`. This is the direct measure of hallucination resistance: a
  system tuned only for recall answers everything, and a confident wrong answer about a price or
  policy is the most damaging output this system can produce.

On the fake-site demonstration corpus built for this stage (4 pages, 7 chunks, 7 golden questions
including 2 deliberately unanswerable ones): **recall@6 = 1, refusal accuracy = 1**. That proves the
mechanism, not retrieval quality at real scale — a representative question set for an actual store's
content is a task for whoever onboards that store.

**Citation correctness is still not a metric**, and now that citations exist the gap is sharper. The
harness measures whether the right chunk was _retrieved_; it does not measure whether the answer's claims
came from the chunks that were cited. Doing so needs an LLM judge, which reintroduces the
non-determinism this harness exists to avoid — so it belongs in a separate, explicitly
non-deterministic quality suite, not here.

## Deferred decisions

| Decision                | Notes                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reranking               | A cross-encoder over the top ~20 usually beats raising `topK`. Adds a service and latency; revisit once quality is measurable.                                                                                                                                                                                                         |
| Hybrid dense + sparse   | BGE-M3 supports it and Qdrant supports named vectors. Helps most with exact terms like SKUs.                                                                                                                                                                                                                                           |
| Query rewriting         | Follow-up questions ("does that apply to sale items?") retrieve poorly without history-aware rewriting. Partly mitigated: history is now replayed to the model, which lets _it_ phrase the tool query — verified with "And internationally?" resolving to a delivery question. A dedicated rewriting step would still retrieve better. |
| Claim-level attribution | The only way to make grounding structural rather than observed. Needs each sentence traced to a chunk; expensive and imperfect.                                                                                                                                                                                                        |
| Semantic caching        | Cheap latency and cost win for repeated FAQ questions; must be keyed by `siteId`.                                                                                                                                                                                                                                                      |
