# ADR 0031: The crawler's transport raises Undici's response-header ceiling, scoped to itself

Status: Accepted
Date: 2026-08-04
Stage: 10a

## Context

The first real ingestion run against a live production storefront failed on every single page:

```
TypeError: fetch failed
  cause: HeadersOverflowError: Headers Overflow Error
```

Sitemap discovery worked — the frontier held over 2,100 URLs, proving URL filtering and sitemap
parsing were never the problem. Every page **fetch** failed identically, which narrowed it to the
transport rather than the crawl logic sitting above it.

## Root cause

Node's built-in `fetch` is Undici, and Undici caps total **response** header bytes at 16 KiB by
default — the same ceiling `node:http` has always enforced, there to bound memory a client spends
parsing headers from a server it does not control. A real production commerce platform routinely
exceeds it on an ordinary page: session and cart cookies, a consent-management platform encoding
hundreds of vendor identifiers into one `Set-Cookie`, A/B-test and analytics cookies, CDN and WAF
diagnostic headers — all accumulate on every response, and the combined total crosses 16 KiB before
the actual page headers are even counted. Once it does, Undici's header parser throws
`HeadersOverflowError`.

**This is not caused by anything the crawler sends.** `fetchPage` and `fetchText` send exactly two
request headers — `accept` and `user-agent` — and no `Cookie`, `Authorization`, or credential of any
kind. `fetch` neither stores nor replays cookies unless a caller sets one explicitly, and nothing
here does. Confirmed by reproducing the failure against a throwaway server: sending it _zero_ request
headers still overflows on a response carrying six oversized `Set-Cookie` values, and the crawler's
own two-header request is a rounding error next to that. The overflow is entirely on the response
side, which is exactly the side a crawler — whose whole job is fetching pages it does not operate —
can never control.

## Decision

**Raise Undici's header-size ceiling, scoped to the crawler's own requests, via a custom
`Agent`.** `packages/scraper/src/website/crawler-fetch.js` constructs one Undici `Agent` with
`maxHeaderSize` set to 256 KiB — generous headroom over anything observed, while still bounded, so a
still-possible pathological or malicious response fails cleanly rather than spending unbounded memory
on header parsing — and wraps `fetch` to pass it as the per-call `dispatcher`. The wrapper's
signature is `typeof fetch`, so it satisfies every existing type and every existing test double
without a ripple: `sendRequest`, `fetch-page.js`, and the whole retry/timeout/logging/error-mapping
path are unchanged, because none of them care which function actually performs the fetch.

The only change to `create-website-source.js` is what it falls back to when no `fetchImpl` is
supplied: `crawlerFetch` instead of the bare global `fetch`. Every existing caller that injects its
own `fetchImpl` — every current test — is unaffected.

**Scoped to the crawler, not the process.** The obvious alternative — `NODE_OPTIONS`,
`--max-http-header-size`, or an equivalent process-wide flag — was tested and does raise Undici's
ceiling for `fetch` too. It was rejected anyway, for two reasons. First, it would raise the ceiling
for _every_ outbound call the process makes: the LLM gateway, the embeddings gateway, Qdrant, the
Magento connector. Every one of those talks to infrastructure an operator configured, where a
response bloated past 16 KiB of headers is a genuine anomaly worth failing loudly on, not a shape of
the internet worth silently accommodating everywhere at once. Second, a process flag depends on
whoever invokes `node` remembering it — `npm run ingest`, a bare `node
packages/ingestion/src/cli/ingest.js`, or a future caller of `createWebsiteSource` that goes through
neither. A fix living in the `fetchImpl` travels with the code; a fix living in an invocation flag has
to be reapplied correctly by every future caller.

**`undici` is now a dependency of `packages/scraper`.** This is deliberately not treated as the kind
of dependency this project otherwise avoids. `undici` is not a third-party abstraction over something
easily hand-rolled — the loggers, the metrics registry, and the retry helper all avoided dependencies
because a library would have bought little over writing the arithmetic and string formatting
directly. This is different: `undici` **is** the exact code Node's own `fetch` is built from,
published as an installable package specifically so callers can reach configuration Node exposes no
stable API for on its bundled copy — a per-request `dispatcher`, and through it, a per-call
`maxHeaderSize`. `packages/scraper` already depends on `linkedom` for the equivalent reason on the
parsing side (see [ADR 0032](0032-linkedom-instead-of-node-html-parser.md)): nobody would hand-roll an
HTML parser, and nobody should hand-roll an HTTP/1.1 header parser either. It adds zero transitive
dependencies of its own.

## Consequences

**One Undici `Agent`, shared for the process's life, not one per request.** An Undici `Agent` _is_ a
connection pool; a fresh one per call would open a fresh TCP connection per call too, discarding the
keep-alive reuse that matters most for exactly this workload — hundreds of sequential requests to the
same host in one crawl. It is never explicitly closed: the ingestion CLI is a one-shot process that
exits once the crawl finishes, and this was verified rather than assumed — a process making several
requests through a custom `Agent` and doing nothing else exits immediately, with no idle socket
holding the event loop open.

**Verified against the real failure, twice.** First against a throwaway `node:http` server built to
reproduce the exact symptom (six oversized `Set-Cookie` headers): plain `fetch` overflows, and
`crawlerFetch` — including through the real `createWebsiteSource` path with no `fetchImpl`
override — succeeds and yields a document. Second against the live production site the bug was found
on: the crawl that previously failed on every page (`failed: 50`) now completes with `failed: 0`.

That second run still emitted zero documents (`emitted: 0, skipped: 50`) — a fetch is no longer
failing, but nothing downstream of the fetch was passing the `MIN_TEXT_LENGTH` check either. That
turned out to be a second, unrelated defect in the HTML-to-text step, not this one: see
[ADR 0032](0032-linkedom-instead-of-node-html-parser.md). This ADR's fix is exactly and only "the
crawler's requests no longer fail on oversized response headers" — it does not, by itself, get a
document out the other end.

**Every other outbound client in this codebase keeps the 16 KiB default.** The LLM gateway,
embeddings gateway, Qdrant client, and Magento connector are all unaffected by this change and remain
subject to Node's ordinary ceiling, which is correct: an oversized response from any of them is
something to investigate, not something to route around.

**Request headers were already minimal, and stayed that way.** Confirmed rather than assumed: no
`Cookie`, `Authorization`, or credential of any kind is sent by `fetchPage` or `fetchText` today, and
this change adds none — a synthetic test now pins that the crawler's request carries only `accept`
and `user-agent`.

## Alternatives considered

**A process-wide `--max-http-header-size` flag.** Covered above: works, but widens every outbound
client's tolerance at once and depends on every future invocation remembering to set it.

**A different HTTP client altogether** (`node-fetch`, `axios`, a hand-rolled client over
`node:http`). Rejected: the problem was never that Undici is the wrong client, only that its default
ceiling assumes a server the caller trusts to behave. Undici already supports exactly the
configuration needed; replacing it would trade one well-maintained, zero-dependency implementation for
a worse-understood one to reach a setting the original already exposes.

**Raising the ceiling only for the specific hosts a site profile configures**, rather than for every
request `crawlerFetch` makes. Rejected as unnecessary complexity: `crawlerFetch` is already scoped to
exactly the traffic that needs it — the crawler's own requests — and every other client in the
process is unaffected without needing a per-host allowlist to achieve that.
