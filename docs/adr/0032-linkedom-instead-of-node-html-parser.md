# ADR 0032: Extract page text with `linkedom`, not `node-html-parser`

Status: Accepted
Date: 2026-08-04
Stage: 10a

## Context

[ADR 0031](0031-crawler-scoped-header-size.md) fixed the crawler's transport so pages stopped
failing to fetch. The next real crawl against the same live production storefront confirmed that fix
(`failed: 0`) but still emitted zero documents: `visited: 50, emitted: 0, skipped: 50`. Debug-level
per-page logging (added to `crawl.js` specifically to answer this) showed every one of the 50 visited
pages skipped for the same reason: `"too little text", "textLength": 0`. Not thin content — exactly
zero characters of extracted text, on every page, including ordinary category listing pages that
plainly have hundreds of words of visible product and category copy.

Fetching one such page directly and running it through `parseHtmlPage` in isolation reproduced it:
`root.querySelector('main')` returned nothing, even with **zero** chrome-stripping selectors applied
first. This was surprising, because a plain string search of the same raw HTML found a `<main
id="maincontent">` tag with 189,608 characters between its open and close tags, containing real
breadcrumb text, a category description, and (further in) a product grid. `node-html-parser` was not
finding a small or malformed `<main>` — it was failing to attach a `<main>` that was unambiguously
present in the source to its own parsed tree, silently, with no thrown error and no warning.

## Root cause

`node-html-parser` is not a full HTML5-spec parser: it does not implement the tokenizer/tree-builder
error-recovery algorithm real browsers (and browser-grade parsers) use to stay correct in the presence
of malformed markup. This page has plenty of malformed markup to trigger that gap — over 120 inline
`<script>` tags, Knockout.js comment bindings (`<!-- ko if: ... -->`), a `<script type="text&#x2F;
javascript">` with an HTML-entity-encoded attribute value, and a literally malformed, self-duplicating
`<link rel="canonical">` href emitted by the site's own templating — a real, separate content bug on
the site, unrelated to this one. Somewhere in that combination, `node-html-parser`'s parser state gets
confused badly enough that it drops or
misplaces everything from that point in the document onward, including the `<main>` element that
holds the entire page's substance. A bisection search (parsing progressively shorter suffixes of the
same document) narrowed the point at which the tree recovers correctly to a specific byte offset in
the page's `<head>`, well before `<main>` even begins — confirming the corruption happens once, early,
and then propagates through the rest of the parse rather than being local to `<main>` itself.

This matters more than a normal bug because of _how_ it fails: silently. `toDocument` interpreted an
empty string exactly as it should interpret a genuinely empty or JavaScript-only page — as "nothing
here worth ingesting" — because there was no signal that the emptiness was the parser's fault rather
than the page's. A parsing library that returns wrong output with no error is a worse dependency than
one that throws on what it cannot handle, because the caller has no way to tell the two apart.

## Decision

**Replace `node-html-parser` with `linkedom`.** `linkedom` is built on `htmlparser2` — the same
lenient, battle-tested HTML tokenizer `cheerio` uses, developed specifically to match real browsers'
error-recovery behavior against real-world (frequently malformed) HTML, rather than a smaller,
faster parser optimized for well-formed input. Re-running the exact same real page's HTML through
`linkedom` finds `<main>` correctly and extracts 98,037 characters of real text — no other change,
same bytes in.

`linkedom` exposes the same DOM shape `html-document.js` already programs against — `querySelector`,
`querySelectorAll`, `getAttribute`, `textContent`, `childNodes`, `remove()` — so the rewrite is
confined to `packages/scraper/src/website/html-document.js`: swapping the import, and replacing
`node-html-parser`'s `rawTagName`-based text/element distinction with the standard DOM `nodeType`
check (`Node.TEXT_NODE` / `Node.COMMENT_NODE`), since `node-html-parser`'s `{ comment: false }` parse
option (used to elide comment nodes so they wouldn't be mistaken for text) has no `linkedom`
equivalent — comments are now filtered explicitly in the tree walk instead. Every other behavior —
chrome removal, heading-to-Markdown, list items, inline-text continuation, the content-selector
fallback chain — is unchanged and still covered by the same 18 existing tests in
`html-document.test.js`, all of which pass unmodified.

**A narrow `any` cast, not threaded types.** `linkedom`'s shipped `.d.ts` declares every DOM class as
a bare `function X(): void` — real behavior at runtime, but no member shape TypeScript can check
against (the same category of type-only mismatch already accepted in ADR 0031 for `undici`). Rather
than fight that with per-property casts throughout the file, `document` is cast to `any` once, at the
point it comes out of `parseHTML`, and every internal helper takes it as `any` from there. This trades
compile-time checking inside `html-document.js`'s DOM-walking code for a working parser; the file's
externally-visible contract (`parseHtmlPage(html: string): ParsedPage`) stays fully typed, and its
behavior is pinned by tests rather than by the type checker either way.

## Consequences

**The live crawl now completes end-to-end.** Re-running the same ingestion CLI against the same live
site after this change: `visited: 50, emitted: 50, skipped: 0, failed: 0`, `documents: 50,
chunksTotal: 299, chunksEmbedded: 299`. Qdrant's `shopsage_knowledge` collection holds 299 points
afterward, up from 0. This is the first time the full pipeline — crawl, fetch, extract, chunk, embed,
store — has been verified end-to-end against a real, uncontrolled production site rather than
synthetic fixtures.

**A real, separate content bug on the site surfaced along the way.** Several ingested documents carry
a malformed `reference`/`url` — the site's own domain appears twice, concatenated, inside the value —
because `toDocument` correctly prefers a page's declared `<link rel="canonical">` over the URL
actually fetched, and this site's canonical tags on category pages are themselves malformed. This is
not a ShopSage defect: the canonical-preference behavior is correct in
general, and "trust what the site declares as canonical" is the right default. It is a data-quality
issue on the storefront worth flagging back to whoever maintains its templates, since a broken
reference URL cannot be used to send a customer to the page it was supposedly citing. No code change
was made for this in the scope of this fix.

**`node-html-parser` is no longer a dependency of `packages/scraper`.** `linkedom` replaces it
one-for-one; nothing else in the package referenced it.

**`packages/scraper` now depends on `linkedom`'s own dependency tree** (`htmlparser2`, `css-select`,
`cssom`, `html-escaper`, `uhyphen` — five packages, pure JavaScript, no native bindings, no install
scripts). This is a larger footprint than `node-html-parser`'s zero transitive dependencies, and is
accepted for the same reason `undici` was in ADR 0031: this is not a case where a thinner dependency
would do — the entire point of the swap is the correctness a more complete, more widely used
implementation buys on real-world HTML that a lighter one demonstrably gets wrong.

## Alternatives considered

**Patch around the specific malformed construct** (e.g. strip Knockout comment bindings, or the
malformed `<link>`, before parsing). Rejected: the bisection search located _a_ point at which
`node-html-parser`'s tree recovers, but not _the_ single malformed construct responsible, and a real
production site will always have some new construct expose the same class of bug next. Fixing the
parser's blind spot one construct at a time is an unbounded, reactive workload; a parser with a real
error-recovery algorithm closes the whole class at once.

**`jsdom`.** Considered and rejected as heavier than this problem needs: `jsdom` implements a much
larger surface (a full `window`, event loops, `CSSStyleSheet`, form submission semantics) that this
file has no use for — it only ever calls `querySelector`/`querySelectorAll`/`getAttribute`/
`textContent`/`remove()`. `linkedom` is built for exactly this "just the DOM tree" use case and is
substantially lighter, while sharing the same `htmlparser2`-grade tokenizer robustness.

**Regular expressions instead of any HTML parser.** Already rejected once, in the original
`html-document.js` (a real parser is "the single highest-impact thing this file does" against chrome
bleeding into extracted text); nothing about this bug reopens that question, since a regex-based
extractor would not have caught this class of malformed markup any more reliably, and would reintroduce
the navigation/footer leakage the parser exists to prevent.
