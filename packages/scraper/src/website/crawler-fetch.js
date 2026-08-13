import { Agent } from 'undici';

/**
 * The default transport for a real crawl, scoped to the one problem it exists to solve.
 *
 * ## The failure this fixes
 *
 * Node's `fetch` (and the Undici it is built on) caps total **response** header bytes at 16 KiB by
 * default - the same ceiling `node:http` has always used. A real production storefront routinely
 * exceeds it: session and cart cookies, a consent-management platform encoding hundreds of vendor
 * IDs into one `Set-Cookie`, A/B-test and analytics cookies, CDN and WAF diagnostic headers - all
 * accumulate on every response, and a modern commerce platform's home page alone can carry several
 * KiB of `Set-Cookie` before the actual page headers are counted. Once the total crosses 16 KiB,
 * Undici's header parser throws `HeadersOverflowError`, wrapped in a `TypeError: fetch failed`.
 *
 * This is **not** caused by anything this crawler sends. `fetchPage`/`fetchText` send exactly two
 * request headers (`accept`, `user-agent`) and no `Cookie`, `Authorization`, or credential of any
 * kind - `fetch` neither stores nor replays cookies unless a caller sets one explicitly, and nothing
 * here does. The overflow is entirely in what the *server* sends back, which the client does not
 * control and - for a crawler, whose entire job is fetching pages it does not operate - can never
 * control. A 16 KiB ceiling is a reasonable default for a client talking to infrastructure someone
 * configures; it is the wrong default for a client whose job is fetching the open web.
 *
 * ## Why this is scoped to the crawler and not the whole process
 *
 * The obvious alternative - `NODE_OPTIONS=--max-http-header-size=...` or a similar CLI flag - raises
 * the ceiling for **every** outbound call the process makes, including the LLM gateway, the
 * embeddings gateway, Qdrant, and the Magento connector. Every one of those talks to infrastructure
 * an operator configured, where a response bloated past 16 KiB of headers is a genuine anomaly worth
 * failing loudly on, not a shape of the internet worth silently accommodating everywhere at once. It
 * would also depend on whoever invokes `node` remembering the flag - `npm run ingest` versus a bare
 * `node packages/ingestion/src/cli/ingest.js` versus a future caller of `createWebsiteSource` that
 * does not go through either. Raising the ceiling in the one `fetchImpl` the crawler actually uses
 * means the fix travels with the code, not with the invocation.
 *
 * ## Why `undici` (a dependency) rather than a global flag or a hand-rolled client
 *
 * This is not a case the "avoid a dependency" default applies to. `undici` is not a third-party
 * abstraction over something easily hand-rolled - it is the literal code Node's own `fetch` is built
 * from, published as an installable package specifically so callers can reach configuration Node
 * does not expose a stable API for on its bundled copy (a per-request `dispatcher`, and therefore a
 * per-call `maxHeaderSize`). `packages/scraper` already accepts `linkedom` for the same reason:
 * nobody would hand-roll an HTML parser, and nobody should hand-roll an HTTP/1.1 header parser
 * either. It has zero dependencies of its own.
 *
 * ## What did not need to change
 *
 * `sendRequest`, `fetch-page.js`'s retry/timeout/logging/error-mapping, and every test double for
 * `fetchImpl` are untouched. This file only changes what `createWebsiteSource` falls back to when no
 * `fetchImpl` is supplied - the real crawl path - and the replacement has the exact same
 * `typeof fetch` shape, so nothing downstream can tell the difference.
 */

/**
 * Generous headroom over anything a real site has been observed to send, while still bounded: an
 * *unbounded* ceiling would turn a still-possible pathological or malicious response into unbounded
 * memory spent parsing headers instead of a clean, fast failure.
 */
const MAX_HEADER_SIZE_BYTES = 262_144;

/**
 * One dispatcher for the life of the process, not one per request.
 *
 * An Undici `Agent` **is** a connection pool; constructing a fresh one per call would open a fresh
 * TCP connection per call too, throwing away the keep-alive reuse that matters most for exactly this
 * workload - hundreds of sequential requests to the same host during one crawl. Module-level and
 * lazy, so importing this file never opens a socket, only using it does; and never explicitly
 * closed, because the ingestion CLI is a one-shot process that exits when the crawl finishes, and
 * Undici's own idle connections do not hold the event loop open past that (verified: a process making
 * several requests through a custom `Agent` and doing nothing else exits immediately once its own
 * work is done).
 *
 * @type {import('undici').Agent | undefined}
 */
let sharedAgent;

/**
 * The default `fetchImpl` for a real crawl.
 *
 * Same signature as global `fetch`, so it satisfies `typeof fetch` and drops into `fetchPage`,
 * `fetchText`, `sendRequest`, and every place already typed against the global function - nothing
 * about the request/response contract changes, only how much of a response's headers the transport
 * is willing to read before giving up.
 *
 * @param {string | URL | Request} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export function crawlerFetch(url, init) {
  sharedAgent ??= new Agent({ maxHeaderSize: MAX_HEADER_SIZE_BYTES });

  // `dispatcher` is cast, not the whole call: `@types/node`'s bundled `undici-types` (which types
  // the global `fetch`'s `RequestInit`) and the standalone `undici` package's own type
  // definitions describe the identical runtime `Agent`/`Dispatcher` shape, but as two separately
  // versioned type-only sources TypeScript's structural checking treats them as incompatible -
  // `undici-types`' `Dispatcher` and `undici`'s do not nominally match, down to their `FormData`
  // helper types. Real objects, real behaviour (proven in crawler-fetch.test.js), a type-checker
  // seam only.
  return fetch(url, { ...init, dispatcher: /** @type {any} */ (sharedAgent) });
}
