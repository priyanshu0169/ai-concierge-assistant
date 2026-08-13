# Retrieval evaluation records

Every retrieval or chunking change is an experiment, and this directory is where the results live.
One JSON snapshot per run, written by the harness rather than typed by hand:

```bash
npm run evaluate -- --report docs/evaluation/00N-label.json
```

## Why these are committed

A retrieval change cannot be judged by trying a few questions. Two experiences on this project
settled that:

- A hand-rolled check reported **86.4%** recall on this corpus where the harness measured
  **77.3%** — the expected-evidence strings were too loose and three answers made of pure noise
  counted as passes.
- The same question (`"How should caviar be served?"`) answered, refused, then answered again in
  manual testing. Nine scripted repetitions could not reproduce the refusal. A single manual retry
  cannot distinguish a real regression from sampling.

So the rule is: **record the numbers before the change, record them after, and keep both.**

## Reading the numbers honestly

The metrics come from **binary, non-exhaustive** relevance labels — a golden question names evidence
that proves the right content came back, and nobody has labelled all 4,174 chunks against all 26
questions. Consequences, spelled out in `packages/ingestion/src/evaluation/metrics.js`:

- **Recall@K is a hit rate** — "did at least one correct chunk come back", not "what fraction of all
  relevant chunks came back".
- **Precision@K is a lower bound.** A genuinely useful chunk that happens not to contain the
  expected string counts against it.
- **NDCG@K uses the retrieved set as its own ideal**, so it measures ordering within what was
  found and cannot see what was missed entirely.

They are comparable across runs, which is the point. They are not absolute.

**The settings are part of the measurement.** Each snapshot records `retrieval`, the chunking
settings, and the embedding model, because a score floor tuned for one model does not transfer to
another — and because some changes move no retrieval metric at all (see Tier 1 below).

## Runs

| #   | Run                       | Recall@6   | Precision@6 | MRR        | NDCG@6     | Refusal  | Avg top    | Avg used   | Notes                                                                          |
| --- | ------------------------- | ---------- | ----------- | ---------- | ---------- | -------- | ---------- | ---------- | ------------------------------------------------------------------------------ |
| 001 | Baseline                  | 0.7730     | 0.4773      | 0.6326     | 0.6558     | 1.0000   | 0.5769     | 3.3182     | `maxPerSource=2`, `maxContextChars=8000`                                       |
| 002 | Tier 1                    | 0.7730     | 0.4773      | 0.6326     | 0.6558     | 1.0000   | 0.5769     | **4.2273** | `maxPerSource=3`, `maxContextChars=16000`                                      |
| 003 | Tier 2a                   | 0.8180\*   | 0.5303      | _0.6152_   | 0.6684     | 1.0000   | 0.5939     | 4.3182     | `headingPath` restored. \*one pass is spurious — see below                     |
| 004 | Tier 2a, corrected labels | 0.7730     | 0.4848      | _0.5697_   | _0.6229_   | 1.0000   | 0.5939     | 4.3182     | Same corpus as 003. Two label defects fixed — this is the honest post-2a state |
| 005 | Tier 2b                   | 0.7730     | _0.4621_    | **0.6439** | **0.6719** | 1.0000   | 0.6014     | 4.1364     | `splitOnHeadingLevel: 4`. 3 improved, **0 regressed**                          |
| 006 | Tier 3 coverage           | 0.7730     | 0.4621      | **0.6591** | **0.6827** | _0.7500_ | **0.6324** | **4.7273** | 4 pages crawled. Return policy fixed; delivery regressed; refusal regressed    |
| 007 | Remove badge strip        | **0.8180** | **0.4848**  | **0.6818** | **0.7120** | 0.7500   | 0.6316     | 4.7273     | `section.delivery-returns` stripped. 1 improved, **0 regressed**               |

### 007: remove the trust-badge strip — best result of the sequence

`section.delivery-returns` added to `CHROME_SELECTORS`. Ingestion deleted **exactly 724 chunks**
(4,501 → 3,777), matching the count of badge chunks precisely; zero remain. The FAQ (47 chunks) and
return policy (5 chunks) are untouched.

**Recall@6 moved off 0.7730 for the first time in seven runs**, and legitimately: 1 improved, **0
regressed**.

|                  | 006    | 007        |
| ---------------- | ------ | ---------- |
| Recall@6         | 0.7730 | **0.8180** |
| Precision@6      | 0.4621 | **0.4848** |
| MRR              | 0.6591 | **0.6818** |
| NDCG@6           | 0.6827 | **0.7120** |
| Refusal accuracy | 0.7500 | 0.7500     |
| Avg top score    | 0.6324 | 0.6316     |
| Avg used         | 4.7273 | 4.7273     |

`"How long does delivery take?"` went **fail → pass** (rank 0 → 2). Verified by hand rather than
trusted, given two earlier false passes: the satisfying chunks carry real timelines — _"Ground
Shipping: 2–7 business days. Overnight Shipping: 1 business day. If you place your order today
before 2 PM Eastern Time…"_ — and the top result is now the FAQ's own
`Do you offer Saturday delivery?`. `"What is your return policy?"` held at rank 1, top 0.605.

This confirms the 006 diagnosis: the badges were not merely noise, they were **suppressing better
content that was already in the corpus**. Removing 724 duplicates surfaced the FAQ and per-product
delivery windows that had been sitting below them.

**Accepted loss:** `next day delivery`, `priority delivery`, `quality guarantee` and
`guaranteed freshness` existed _only_ in that strip (724 occurrences inside, 0 outside). The
substance survives on the FAQ in better form — _"All merchandise is guaranteed to be fresh…"_,
Saturday delivery for $16, a 10 AM day-prior cancellation cut-off — but the literal phrase "next day
delivery" is now absent from the corpus. Recorded because it is a real trade, not a free win.

**Still open, not bundled:** `Beluga Hybrid > You May Also Like` upsell blocks now hold 1 of the 6
delivery slots. Same class of defect, smaller magnitude. And refusal accuracy stays 0.7500 — the
`order status` label ambiguity from 006 is unresolved by design.

### 006: crawl coverage — one question fixed, one lost, and a new defect exposed

Four pages added as `startUrls` and verified in Qdrant: `/our-story` (14 chunks), `/contact` (2),
`/return-and-consumer-safety-policy` (5), `/faq-s` (47).

This also required fixing a **crawl defect**: `buildFrontier` seeded `[...sitemapUrls,
...startUrls]` into a FIFO queue bounded by `maxPages`. With a 2,167-URL sitemap against a 1,000-page
ceiling, an explicitly named start URL sat at position ~2,168 and was never dequeued — and was never
reported as skipped, because nothing skipped it. Start URLs are seeded first now, pinned by a test.

**Per-question changes:**

| Question                                          | 005 → 006                                          |
| ------------------------------------------------- | -------------------------------------------------- |
| What is your return policy?                       | **fail → pass**, rank 0 → **1**, top 0.398 → 0.605 |
| How long does delivery take?                      | **pass → fail**, rank 6 → 0                        |
| Can you tell me my order status? _(unanswerable)_ | **pass → fail**, retrieved 0 → 6                   |
| Do you have a physical shop I can visit?          | still fails, retrieved 0 → 1                       |
| Do you ship internationally?                      | still fails, retrieved 2 → 5                       |

Recall@6 is unchanged because the return-policy gain and the delivery loss cancel exactly.

**The new defect, and Tier 2 caused it.** The top 6 for "How long does delivery take?" is now five
product-page footer blocks (`Beluga Hybrid > DELIVERY & RETURNS`, `Sterlet > DELIVERY & RETURNS`, …)
scoring 0.428–0.445. There are **724 such chunks**, and their bodies are not about delivery at all —
they are "You May Also Like" upsell lists. The restored heading path is what makes them _look_ like
delivery content: the prefix says `DELIVERY & RETURNS` while the body is product listings.

They also evade duplicate suppression: **413 distinct bodies among 724 chunks**, because each carries
a different upsell list, so exact-text dedup cannot collapse them and `maxPerSource` does not apply
(each is a different document).

This is a measurable defect rather than a judgement call, and it is the first thing that would
justify unfreezing retrieval work.

**`Do you ship internationally?` cannot be fixed by crawling.** None of the four pages contains
`internationally`, `international shipping` or `ship internationally` — the three `international`
hits are marketing copy and a CSS class — and eight shipping-page URL candidates all 404. The store
does not appear to publish international shipping terms.

**The refusal regression is a label question, not clearly a bug.** `"Can you tell me my order
status?"` is labelled `unanswerable` because it needs the live commerce tools, and the newly crawled
FAQ genuinely discusses order tracking. Retrieval now returns 6 chunks at 0.658. Whether that is a
failure depends on whether FAQ context helps the model or distracts it from calling `trackOrder`.
**Deliberately left as-is:** relabelling it to restore 1.0000 would be manufacturing the same kind of
false pass that run 004 had to clean up.

### 005: `splitOnHeadingLevel` 3 → 4 — keep

Structurally modest: 4,167 → 4,447 chunks, multi-topic chunks 31.1% → 25.1%, mean length 906 → 860.
Only 945 chunks changed, because the deeper `#####`/`######` badge blocks the site uses in footers
still do not force a cut.

**Per-question: 3 improved, 0 regressed, 23 unchanged.**

| Improved                                                      | rank      |
| ------------------------------------------------------------- | --------- |
| What is the difference between caviar and fish roe?           | 5 → **1** |
| What are the different types of caviar?                       | 3 → **1** |
| Which caviar would suit someone trying it for the first time? | 3 → 2     |

It also **repaired Tier 2a's regression**: MRR 0.5697 → 0.6439 and NDCG 0.6229 → 0.6719, both now
_above_ baseline. That is the pair behaving as predicted — the heading prefix only pays off once
sections are split.

**The target questions did not enter the top 6, but they did move a long way.** The chunk holding
`Founded in 1983` went from **rank >201 → rank 33** (score 0.443), and the About section is now
genuinely isolated: 1,141–1,854 characters with one heading, carrying paths like
`About Marky's and the Hackleback Sturgeon` instead of being fused into a 2,106-character
Hackleback chunk. The cosine pre-validation predicted 0.485 for exactly this shape; the measured
0.443 is close.

So chunking did its job and is not the remaining obstacle. **The obstacle is corpus content**: there
is no About or contact page, and "Marky's" appears in hundreds of _product_ names, so a company
question competes against 32 higher-scoring branded items (baseball cap, gift cards). Only Tier 3
coverage moves these into the top 6.

**Why Precision@6 fell while everything else improved.** Smaller chunks are individually less likely
to contain any particular expected string, so `relevant` counts drop even when retrieval is equal or
better — `"What is Beluga caviar?"` went from 5 relevant to 1 at the same rank. **Precision@K under
substring labels is biased against smaller chunks.** Read it as a measurement artefact here, not as
degradation; MRR, NDCG and average top score all moved the other way.

### 003: `headingPath` restoration — mechanically correct, but MRR regressed

The fix worked at corpus level: heading-path coverage **40.6% → 74.1%**, and **864 of 885** documents
now carry per-section paths instead of one frozen value. Average top score rose 0.5769 → 0.5939, so
the prefixes do improve similarity on genuinely on-topic chunks.

Three findings that matter more than the headline:

**1. The Recall@6 gain is not real.** The newly-passing question is "What is your return policy?",
and the chunk that satisfied it is a **gift-card page footer** — `Marky's Digital Gift Card >
DELIVERY & RETURNS`, containing "NEXT DAY DELIVERY / QUALITY GUARANTEE / SUPPORT" marketing badges.
The restored heading path pushed it over the score floor (0.398), and the question's label was the
bare word `return`, which a footer badge satisfies. **Corrected Recall@6 is 0.7730 — unchanged.**
The label is too weak and should be tightened before it contaminates another run.

**2. MRR regressed for a real reason.** `"How long does delivery take?"` moved from rank 3 to rank 6
and from 3 relevant chunks to 1. Heading prefixes change every affected chunk's embedding, so ranks
reshuffle: some questions gain, some lose. The evaluation is deterministic, so this is a genuine
movement rather than noise.

**3. The target question still fails.** `"When was Marky's founded?"` remains rank 0 (6 retrieved, 0
relevant). This is consistent with the cosine pre-validation rather than a contradiction of it: that
experiment measured an _isolated section_ carrying its heading path at 0.485, whereas the same
prefix on a still-fused 2,100-character chunk was only 0.262. The prefix needs the split to work.
`headingPath` restoration is a **prerequisite** for `splitOnHeadingLevel`, not a fix on its own.

### 004: two label defects, and a worse verdict on Tier 2a

Run 003 was measured with two faulty labels. Both are fixed in `config/golden-questions.json`, and
run 004 re-measures the **same corpus** so the difference is purely the instrument:

| Question                               | Old label | Defect                                                                                                                                                                                                       |
| -------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What is your return policy?            | `return`  | Satisfied by a gift-card page's `DELIVERY & RETURNS` footer badge block. Now labelled by URL only — no text label, because `expectedUrls` and `expectedText` are OR-ed, so adding text would loosen it again |
| Tell me about white truffles from Alba | `Alba`    | Matched as a **substring** of `Albacore` and `Albariño` — 25 of 47 matching chunks were tuna or wine. Now `Tuber magnatum` / `Alba truffle`                                                                  |

Labels are matched by substring, deliberately, so stems like `refrigerat` keep working across
`refrigerated`/`refrigeration`. The cost is that a short label must be distinctive on its own, and
`Alba` was not.

**The whole 003 → 004 movement is one question.** MRR fell 0.6152 → 0.5697, and 0.0455 is exactly
1/22 — a single question losing a reciprocal rank of 1.0, namely the return-policy false pass. The
precision and NDCG drops have the same single cause. Nothing else moved.

**Which makes Tier 2a's real effect worse than first reported:**

| vs baseline 001 | Baseline | Tier 2a (004) | Î”          |
| --------------- | -------- | ------------- | ----------- |
| Recall@6        | 0.7730   | 0.7730        | flat        |
| MRR             | 0.6326   | **0.5697**    | **−0.0629** |
| NDCG@6          | 0.6558   | **0.6229**    | **−0.0329** |
| Precision@6     | 0.4773   | 0.4848        | ~flat       |
| Avg top score   | 0.5769   | 0.5939        | +0.0170     |

Baseline MRR is directly comparable despite the label change: Alba passed at rank 1 under either
label, and both policy questions failed under both. So the −0.063 is a genuine regression, roughly
10% relative, not a measurement artefact.

Tier 2a is kept regardless, for one reason: the cosine evidence says the heading prefix only pays off
once sections are actually split (0.485 isolated+prefixed vs 0.262 fused+prefixed). It is a
**prerequisite for 2b**, and reverting it would make 2b untestable. If 2b does not recover MRR, both
should be reverted together.

Rows 001 and 002 are **transcribed from CLI output**: they were measured before `--report` existed,
and neither can be regenerated — 001 needs the pre-fix corpus and 002 needs the pre-fix corpus with
Tier 1 settings. They have no JSON snapshot for that reason. Every run from 003 onward is written by
the harness.

### 001 → 002: why only one number moved

Recall, Precision, MRR and NDCG measure the **retrieval** stage — what the vector store returned
above the score floor. Tier 1 changed only the **ranking and context** stage: how much of that
survives the per-source cap and the character budget. Those four metrics _could not_ move, by
construction. `averageUsed` is the only metric that observes the change, and it rose 27%.

This is worth internalising before reading any future row: **a change can be a real improvement and
be invisible to Recall@K.** It also means the reverse — that a change moving Recall@K is acting on
retrieval, not on how much evidence reaches the model.

What Tier 1 therefore does _not_ prove is that answers improved. That needs a model in the loop, and
this harness deliberately excludes one so a retrieval regression stays attributable to retrieval.

## Known ceiling

Two of the 26 questions — the return policy and international shipping — ask about content that was
never crawled (the pages exist at `/return-and-consumer-safety-policy` and `/faq-s`). No chunking or
ranking change can lift them. **Recall@6 cannot exceed 0.909 until crawl coverage is fixed.**
