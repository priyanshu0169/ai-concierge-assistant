import { UpstreamError, sendRequest } from '@shopsage/platform';

/** Identifies the crawler so a site operator can find us in their logs and block us. */
export const USER_AGENT = 'ShopSageBot/0.1 (+https://github.com/shopsage)';

const PAGE_TIMEOUT_MS = 15_000;

/** A page larger than this is a download, a data dump, or a mistake. */
const MAX_BYTES = 5_000_000;

/** Content types worth parsing as a page. */
const HTML_TYPES = ['text/html', 'application/xhtml+xml'];

/**
 * @typedef {object} FetchedPage
 * @property {string} html
 * @property {string} finalUrl After redirects.
 * @property {string | undefined} lastModified
 */

/**
 * Fetch one page.
 *
 * Returns `undefined` for anything that is simply not a page to ingest - a 404, a
 * PDF, a redirect to another host, a response too large to be prose. Those are
 * *outcomes* of a crawl, not failures of it, and a crawler that threw on them would
 * abandon a run over a single broken link.
 *
 * Throws only when the failure is the run's, not the page's: a network-level problem
 * classified by `sendRequest`.
 *
 * @param {{
 *   url: string,
 *   fetchImpl: typeof fetch,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<FetchedPage | undefined>}
 */
export async function fetchPage(input) {
  const { url, fetchImpl, signal } = input;

  const response = await sendRequest({
    url,
    headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': USER_AGENT },
    timeoutMs: PAGE_TIMEOUT_MS,
    signal,
    label: 'Page request',
    fetchImpl,
  });

  if (!response.ok) return undefined;
  if (!isHtml(response)) return undefined;
  if (isTooLarge(response)) return undefined;

  const html = await readBounded(response);
  if (html === undefined) return undefined;

  return {
    html,
    // The final URL after redirects, so a page reached by two paths is stored once
    // under the location the server considers authoritative.
    finalUrl: response.url === '' ? url : response.url,
    lastModified: response.headers.get('last-modified') ?? undefined,
  };
}

/**
 * Fetch a supporting document such as robots.txt or a sitemap.
 *
 * Returns `undefined` rather than throwing on any non-2xx: a site with no robots.txt
 * answers 404, and that means "no restrictions", not "stop".
 *
 * @param {{ url: string, fetchImpl: typeof fetch, signal?: AbortSignal }} input
 * @returns {Promise<string | undefined>}
 */
export async function fetchText(input) {
  const { url, fetchImpl, signal } = input;

  try {
    const response = await sendRequest({
      url,
      headers: { 'user-agent': USER_AGENT },
      timeoutMs: PAGE_TIMEOUT_MS,
      signal,
      label: 'Support file request',
      fetchImpl,
    });

    if (!response.ok) return undefined;

    return await readBounded(response);
  } catch (error) {
    // Cancellation must still propagate; anything else is an absent support file.
    if (signal?.aborted === true) throw error;

    return undefined;
  }
}

/**
 * @param {Response} response
 * @returns {boolean}
 */
function isHtml(response) {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

  // An absent content-type is treated as HTML: some CMS platforms omit it, and the
  // parser copes with whatever arrives.
  return contentType === '' || HTML_TYPES.some((type) => contentType.includes(type));
}

/**
 * @param {Response} response
 * @returns {boolean}
 */
function isTooLarge(response) {
  const declared = Number(response.headers.get('content-length') ?? '0');

  return Number.isFinite(declared) && declared > MAX_BYTES;
}

/**
 * Read a body while enforcing the size ceiling.
 *
 * `content-length` is a hint a server may omit or lie about, so the limit is
 * enforced against bytes actually received. Without this, one page served by a
 * misbehaving endpoint could exhaust the heap.
 *
 * @param {Response} response
 * @returns {Promise<string | undefined>}
 */
async function readBounded(response) {
  const body = response.body;
  if (body === null) return undefined;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  /** @type {string[]} */
  const parts = [];
  let bytes = 0;

  try {
    let chunk = await reader.read();

    while (chunk.done === false) {
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) return undefined;

      parts.push(decoder.decode(chunk.value, { stream: true }));
      chunk = await reader.read();
    }

    parts.push(decoder.decode());

    return parts.join('');
  } catch (cause) {
    throw new UpstreamError('Page body could not be read', { cause, retryable: true });
  } finally {
    await reader.cancel().catch(() => {});
  }
}
