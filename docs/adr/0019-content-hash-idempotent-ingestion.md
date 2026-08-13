# ADR 0019: Idempotent ingestion via content-hash comparison, with a guarded prune

Status: Accepted
Date: 2026-07-31
Stage: 5

## Context

A store's content changes slowly and its corpus is re-crawled repeatedly - on a
schedule, or by hand after an editor changes a page. Embedding is the expensive step
in the pipeline: metered on the default hosted backend, CPU-bound on a self-hosted
one. Re-embedding an entire corpus every run because a handful of pages changed makes
the cost of a re-crawl scale with the size of the corpus rather than with the size of
the change.

The harder half of "re-run safely" is not re-embedding the unchanged; it is knowing
when to delete. Two failure modes sit on either side of correct:

- **Deleting too little.** A page taken down at the source stays in the index
  forever, because nothing about a normal crawl would ever notice its absence. The
  assistant keeps answering questions from content that no longer exists.
- **Deleting too much.** A crawl that dies after ten of five hundred pages - a
  network blip, a rate limit, `Ctrl+C` - has "seen" ten documents. Treating everything
  else as "no longer exists" would erase 490 pages of live content because of a
  transient failure, not because the content went away.

## Decision

**Compare content hashes to decide what to re-embed; refuse to prune unless the run
looks complete.**

Chunk ids are **positional** — `documentId#0`, `documentId#1`, and so on — not
content-based. Ingestion asks the store (via the new `list()` method) what it already
holds for a document, compares each stored hash against the freshly chunked one, and
embeds only where they differ. A changed chunk overwrites its predecessor at the same
id; an id no longer produced (the document got shorter) is deleted explicitly.

Deletion of whole documents — the case where a page disappears entirely — is a
**separate, guarded operation**, `pruneRemovedDocuments`, run once per source after
every document has been walked. It refuses to run at all when either signal says the
run might be incomplete:

- **Any failure in the run.** An unreachable page is not a deleted page, and the two
  are indistinguishable from ingestion's side without this rule.
- **Coverage below 50% of what is already stored.** Not a measurement, a judgement:
  content shrinking by more than half in one run is possible but rare, while a crawl
  cut short is common. Erring toward stale content is the cheaper mistake — it
  answers slightly out-of-date questions, where the alternative silently empties a
  store's knowledge base.

A skipped prune is loud, not silent: it is logged with the reason and the exact
coverage numbers, so an operator watching ingestion output sees the safety rail fire
rather than wondering later why old content is missing.

## Alternatives

**Content-based chunk ids** (hash of the chunk text, rather than position). Makes an
unchanged chunk trivially identifiable and needs no lookup. Rejected because an edited
chunk then gets a _new_ id, orphaning the old one — which reintroduces exactly the
deletion problem this design solves, just at the chunk level instead of the document
level. Positional ids make "this chunk changed" a natural overwrite.

**Full re-embedding on every run, always.** No comparison logic, no `list()` method,
trivially correct. Rejected as the thing this ADR exists to avoid: it makes
re-ingestion cost scale with corpus size instead of with what changed, which is the
wrong bill for a metered backend.

**Delete everything for a source before re-inserting (drop and rebuild).** Simplest
possible deletion story, and correct if the run always completes. Rejected because a
crawl failure then means a **window with no content at all** — the delete already
happened before the new data landed. Comparing and pruning afterward means a failed
run degrades to "some stale content," never to "no content."

**Time-based staleness** (delete anything not touched in N days) instead of
coverage-based pruning. Simpler to reason about, no per-run coverage math. Rejected
because it conflates two different signals: a slow content-refresh cadence and a
broken crawl look identical under a time threshold, and the threshold itself becomes
another number to tune per store. Coverage compares a run against itself, which needs
no calibration.

**No prune at all — deletion is a manual operation.** Safest by construction. Rejected
because it is a certainty of silent staleness rather than a rare risk of it: every
store, eventually, removes a page, and "an operator must remember to run a separate
command" is not a plan that survives contact with an actual deployment.

## Consequences

Easy: a scheduled, repeated ingestion run costs almost nothing when the corpus is
unchanged — the demonstration run in this stage went from several seconds to embed
seven chunks down to a fraction of a second to confirm none had changed. A page that
gets shorter cleans up its own trailing chunks automatically. A truly removed page is
pruned automatically on the next clean run.

Hard: `list()` is now part of the `VectorRepository` port, which every future adapter
must implement, including cursor pagination — a real cost for a store with no equivalent
scroll primitive. The 50% coverage threshold is a judgement call with no formula behind
it, and it will occasionally skip a prune that was actually safe, or (much less likely,
by design) allow one that was not.

Accepted: nothing detects a chunking-_settings_ change (a different `maxChunkCharacters`,
say) through the hash comparison, because the resulting text differs and is correctly
seen as new — but a change that does _not_ alter chunk text, such as toggling
`includeHeadingPath` at exactly the boundary where it doesn't change output, could in
principle slip through. `--force` exists as the deliberate escape hatch: when in doubt,
force.
