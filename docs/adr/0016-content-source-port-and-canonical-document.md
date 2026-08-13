# ADR 0016: A `ContentSource` port and a canonical `Document`

Status: Accepted
Date: 2026-07-31
Stage: 4

## Context

A website crawler is the first content source, not the only one. Magento CMS blocks,
PDF manuals, a help-desk export and hand-authored FAQ files are all plausible, and
each would be a different acquisition mechanism producing the same kind of thing.

Building only a scraper makes the ingestion pipeline depend on crawling. Every later
source then either pretends to be a crawler or gets special-cased inside a pipeline
that was never designed to have two of anything.

Two questions have to be answered together:

1. **What does every source produce?** If sources emit whatever shape suits them,
   normalization moves into the pipeline and is done slightly differently per source.
   That difference surfaces much later as duplicate points in the vector store, or as
   content that re-embeds on every run because one source trims whitespace and another
   does not.
2. **Where does the contract live?** The scraper produces documents; ingestion
   consumes them. If the contract sits in either, the other must depend on it — and
   `ingestion` depending on `scraper` would mean the pipeline could not be built or
   tested without an HTML parser.

## Decision

**A separate contract package, `@shopsage/content-model`, containing the
`ContentSource` port and the canonical `Document` — and no implementation.** The
scraper and the ingestion pipeline both depend on it and never on each other.

The `Document`, with the invariants that make "canonical" true rather than
aspirational:

- **`id` is derived, never supplied**: a hash of `siteId + sourceId + reference`.
  Stable across runs, so re-ingestion upserts rather than duplicates; scoped by
  source, so two sources may both hold a reference of `/returns`.
- **`contentHash` covers title and text only.** Not `retrievedAt`, which changes on
  every crawl and would defeat the purpose. Text is normalized first, so a page whose
  CDN swapped a non-breaking space does not re-embed.
- **`reference` is the locator every source can supply** — a URL, a file path, a CMS
  block id. `url` is separate and optional, because it means something stronger: a
  place a customer can be sent.
- **`text` preserves headings** as Markdown ATX lines, and paragraph breaks as blank
  lines.
- **`contentType` is a closed set** of six values.
- **`metadata` is scalars only.**
- **`siteId` is required**, as everywhere else (ADR 0006).

`ContentSource.fetch()` returns an **async iterable**, and a per-document failure is
counted rather than thrown. Failures that belong to the _run_ — an unresolvable start
URL — do throw.

Every document is built by `createDocument()`. A source that assembled the object
itself would eventually differ.

## Alternatives

**Put the contract in `scraper`.** One less package. Rejected because `ingestion`
would then depend on the scraper — and on its HTML parser — to define the type it
consumes. The dependency arrow would also say the pipeline is downstream of crawling,
which is exactly the coupling this stage exists to avoid.

**Put it in `ingestion`.** Symmetrically wrong: the scraper would depend on the
pipeline it feeds, which inverts the direction and makes a source untestable without
the consumer.

**No contract — let the scraper hand chunks straight to ingestion.** Fewer moving
parts for exactly one source. Rejected because the second source is the one that pays,
and by then the pipeline has been written against crawl-shaped input.

**`fetch(): Promise<Document[]>`.** Far simpler to write and to test. Rejected on two
counts. A few hundred pages buffered before ingestion starts means no progress is
observable and a failure at page 400 discards 399 pages of work. And it makes the
memory ceiling the size of the corpus rather than the size of a page.

**Structured blocks — `[{ type: 'heading', level, text }, …]` — instead of
Markdown-ish text.** Genuinely richer, and cleaner for a chunker to consume. Rejected
for now because every source would have to build it, the text is what gets embedded
anyway, and a Markdown-ish string is human-readable — which is what makes the preview
CLI useful for tuning crawl patterns. If Stage 5's chunker needs more structure than
`## ` lines carry, this is the decision to revisit.

**An open `contentType` string.** Flexible for a new source. Rejected because it is a
retrieval filter: an open string accumulates `policy`, `policies` and `Policy`, and
filtering quietly fragments. `other` is the escape hatch.

**A document-level `id` supplied by the source.** Rejected: sources would invent
different schemes, and two of them would eventually collide in one collection with no
way to tell which was which.

## Consequences

Easy: a new source kind is a new package implementing one interface — no pipeline
change, no schema change beyond a site-profile entry, and no dependency of that source
leaking anywhere. Idempotent re-ingestion falls out of the derived id and the content
hash rather than being a feature of the pipeline. A source is testable by draining its
iterator.

Hard: the port is the lowest common denominator. A source with something richer to
offer — page hierarchy, structured product attributes, revision history — has to flatten
it into `metadata` or lose it. Streaming also means a source cannot report a total up
front, so progress is "documents so far", never a percentage.

Accepted: a contract designed against one implementation encodes that implementation's
assumptions. `reference` doubling as `url` for a website is the obvious place this
shows. The second source is where this design is really tested, and revision then is
expected rather than a failure.
