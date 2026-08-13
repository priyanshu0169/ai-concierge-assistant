# ADR 0020: Structure-aware chunking in characters, with an evaluation harness

Status: Accepted
Date: 2026-07-31
Stage: 5

## Context

A chunk is the unit retrieval actually returns. Getting its boundaries wrong is not a
cosmetic problem: the canonical failure is a returns policy split so that one chunk
holds the conditions ("must be unopened, packaging intact") and another holds the
number that matters ("thirty days"), and a customer asking "how long do I have"
retrieves the wrong half.

Two design questions had to be settled before any code:

**What unit measures chunk size?** Tokens are what an embedding model actually
consumes, and TEI publishes a token limit (`max_input_length`) a chunker could size
against. But the default backend as of Stage 4 is a hosted OpenAI-compatible gateway,
and that wire format publishes no such limit. A token-based design would need a
tokenizer dependency specific to one model family, contradicting the mandate that the
embeddings backend is a configuration choice ([ADR 0018](0018-embeddings-backend-is-configuration.md)).

**How is "did this change help?" answered?** A chunking or `minScore` change is
otherwise judged by trying a few questions by hand — exactly the guesswork the project
brief and `docs/RAG.md` already flagged as the reason a golden question set matters.

## Decision

**Chunking is measured in characters** and cuts in a fixed order of preference:
heading first, paragraph second, sentence third, and only then an arbitrary
character offset. Each step down that list is a worse seam, reached only when the one
above cannot apply.

This is the entire reason `Document.text` (ADR 0016) keeps Markdown heading markers
(`## `) rather than being flattened to prose: headings are what let the chunker cut
where a human would. Two further decisions inside the chunker:

- **The heading trail is prepended to what gets embedded**, not to what is displayed.
  "Returns policy > International" gives an isolated chunk the surrounding context a
  reader gets from the page around it. The _displayed_ chunk (`Chunk.body`, stored in
  the payload) omits it — showing the breadcrumb back to a customer as if it were
  content would be nonsense.
- **A too-short trailing chunk is merged into its predecessor**, refusing the merge if
  it would breach the size ceiling. A 40-character fragment retrieves badly on its own
  and dilutes the source it came from; a merge that would create an oversized chunk is
  worse than leaving the fragment short.

Characters are model-agnostic, directly observable in the scraper's preview CLI, and
sit in a defensible range (roughly 500–700 tokens for English prose at the chosen
defaults) without needing to know which model will consume them.

**A golden-question evaluation harness ships alongside the chunker**, with no LLM in
the loop — it measures retrieval, and a non-deterministic model call in the loop would
make a regression impossible to attribute to the change that caused it. Two metrics:

- **Recall at K** — did an expected chunk come back at all.
- **Refusal accuracy** — for a question the corpus genuinely cannot answer, did
  retrieval correctly return nothing above `minScore`. Recall alone rewards a system
  that answers everything; for a commerce assistant, a confident wrong answer about a
  price or a policy is the most damaging output it can produce, and nothing measures
  that except asking questions with no right answer on purpose.

## Alternatives

**Fixed-size character or token windows, no structure awareness.** The simplest
chunker there is. Rejected as the exact failure this project's own documentation
already named: it cuts a policy in half with no regard for where its conditions and
its consequences live in the text.

**Size chunks against the embedding backend's published token limit.** Precise when
available. Rejected as the default because it is not always available — the hosted
provider (the default per ADR 0018) reports none — and a chunker whose behaviour
depends on which backend answered today would be a second axis of variation to reason
about on top of the model itself.

**Structured block output** (`[{ type: 'heading', level, text }, …]`) instead of
Markdown-ish text as the boundary between `content-model` and `ingestion`. Cleaner for
a chunker to consume, and considered explicitly in ADR 0016. Deferred there for the
same reason it is not revisited here: every source would have to build it, and the
text is what gets embedded regardless.

**No evaluation harness yet — wait until there is a real corpus.** Less to build this
stage. Rejected because a chunker and a golden set are the same decision looked at from
two sides: writing chunking logic with no way to measure whether it helps is choosing
to guess, and the fake-site demonstration in this stage (7 questions, 100% recall and
100% refusal accuracy on a first pass) is what makes the chunker's defaults a measured
choice rather than an assumed one.

**Score the evaluation with an LLM judge instead of substring/URL matching.** More
forgiving of paraphrase, and closer to what a customer experiences. Rejected for now:
it reintroduces the non-determinism the harness exists to avoid, and it costs a model
call per question on every run. Worth revisiting once the corpus is large enough that
exact matching produces false negatives on genuinely correct retrieval.

## Consequences

Easy: chunking behaves the same regardless of embedding backend, and a store's own
profile (`ingestion.*`) tunes it without a code change. Retrieval changes — a
different `minScore`, a different chunk size, a new embedding model — are now a
number that moved, not an impression formed by trying three questions.

Hard: character counts are a proxy for tokens, not a measurement of them, and the
relationship varies by script — the defaults are tuned for English prose and will
under- or over-shoot for other languages. The evaluation harness's substring matching
is brittle to paraphrase in the _golden set itself_, not just in what a real customer
might ask, so a golden question needs care in how its `expectedText` is chosen.

Accepted: the harness only evaluates what it is asked to evaluate. Seven questions
against a four-page fake site prove the mechanism works end to end; they prove
nothing about retrieval quality at real corpus scale. Building a representative
question set for an actual store's content remains a task for whoever onboards that
store, not something this stage could do in the abstract.
