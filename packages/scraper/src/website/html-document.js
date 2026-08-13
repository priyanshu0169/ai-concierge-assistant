import { parseHTML } from 'linkedom';

/**
 * Elements that appear on every page and belong to none of them.
 *
 * Removing these is the single highest-impact thing this file does. A navigation
 * menu repeated across 300 pages makes 300 chunks that are 40% identical, and an
 * embedding model cannot tell them apart - so retrieval starts returning whichever
 * page happens to sort first, for every query.
 */
const CHROME_SELECTORS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'form',
  'nav',
  'header',
  'footer',
  'aside',
  '[aria-hidden="true"]',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="search"]',
  // A per-product trust-badge strip, and the one site-specific selector here. It earns its place
  // because it was measurably poisoning retrieval rather than merely adding noise.
  //
  // The block is four slogans - NEXT DAY DELIVERY / QUALITY GUARANTEE / SUPPORT AVAILABLE /
  // SINCE 1983 - repeated **identically on 724 product pages**, verified by sampling 35 of them:
  // 35 of 35 carried byte-identical text, with no return terms, no timelines, no legal notices.
  //
  // It became actively harmful once heading paths were restored (docs/evaluation 003-006). The
  // section heading is "DELIVERY & RETURNS", so every one of the 724 chunks began carrying that
  // phrase in its embedded prefix, which made a marketing strip look like delivery policy: five of
  // the six results for "how long does delivery take?" were these badges, crowding out the FAQ's
  // real answers about Saturday delivery, holiday exclusions and cancellation cut-offs. They evade
  // every existing safeguard - 413 distinct bodies among the 724 (each carries a different upsell
  // list) defeats exact-text de-duplication, and one-per-document defeats `maxPerSource`.
  //
  // Removing it does discard the only corpus mention of "next day delivery". That is accepted: the
  // phrase is an unspecific slogan, the FAQ states the substance better ("All merchandise is
  // guaranteed to be fresh...", Saturday delivery for $16, a 10 AM day-prior cancellation cut-off),
  // and it was those very duplicates suppressing it. Verified absent from all four real content
  // pages - /faq-s, /return-and-consumer-safety-policy, /our-story, /contact - so no genuine policy
  // content is at risk.
  'section.delivery-returns',
];

/**
 * Where a page's actual content usually is, in descending order of confidence.
 *
 * Tried in order because a site that marks up `<main>` is telling us something more
 * reliable than any heuristic we could invent.
 */
const CONTENT_SELECTORS = ['main', '[role="main"]', 'article', '#content', '.content', 'body'];

/** Headings become Markdown ATX lines so heading structure survives into chunking. */
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** Elements that end a line of prose. */
const BLOCK_ELEMENTS = new Set([
  'p',
  'div',
  'section',
  'li',
  'tr',
  'td',
  'th',
  'dt',
  'dd',
  'blockquote',
  'pre',
  'figcaption',
  'br',
  'hr',
  'table',
  'ul',
  'ol',
  'dl',
]);

/** `Node.TEXT_NODE` / `Node.COMMENT_NODE`, spelled out rather than trusted from the
 * instance, since linkedom's own type declarations do not describe them (see below). */
const TEXT_NODE = 3;
const COMMENT_NODE = 8;

/**
 * @typedef {object} ParsedPage
 * @property {string} title
 * @property {string} text Markdown-ish: headings as `## `, list items as `- `.
 * @property {string | undefined} canonicalUrl
 * @property {string | undefined} locale
 * @property {boolean} noindex
 * @property {string | undefined} description
 * @property {string[]} links Raw `href` values, unresolved.
 */

/**
 * Turn an HTML page into the fields a `Document` needs.
 *
 * A real parser rather than regular expressions, and that is a deliberate
 * dependency. Extracting text with regexes means shipping navigation and footer copy
 * into every chunk, which degrades retrieval quality with no error and no obvious
 * cause - the worst failure mode a search system has. An HTML parser also carries
 * none of the lock-in risk a vendor SDK would: it sits behind this function, and
 * nothing outside this file knows it exists.
 *
 * ## Why `linkedom`, not `node-html-parser`
 *
 * This used to run on `node-html-parser`. Against a real production category page
 * (heavy with inline `<script>`/`<style>` blocks, Knockout comment bindings, and a
 * duplicated malformed `<link rel="canonical">`), it silently produced a broken tree:
 * `root.querySelector('main')` returned nothing at all, even with **zero** elements
 * removed - the `<main>` element is genuinely in the markup, confirmed by a raw string
 * search, but the parser never attached it. No error, no warning - just an empty
 * result, which this file then quietly reported as "too little text" for every page.
 * `linkedom` (built on `htmlparser2`, the same lenient HTML parser `cheerio` uses)
 * parses the identical bytes correctly and recovers the real content. The lesson
 * generalises: a hand-rolled or lightweight HTML tokenizer is a reasonable bet against
 * hand-authored fixtures, but a crawler's whole job is real-world, often malformed,
 * production markup - the one input class that most rewards a battle-tested parser
 * with actual HTML5 error-recovery behaviour over a smaller, faster one.
 *
 * @param {string} html
 * @returns {ParsedPage}
 */
export function parseHtmlPage(html) {
  // linkedom's shipped `.d.ts` declares every DOM class as a bare `function X(): void`
  // stub - real, correct behaviour at runtime, but no member shape TypeScript can
  // check. Cast once, here, rather than threading `any` through every helper below.
  const document = /** @type {any} */ (parseHTML(html)).document;

  // Read metadata before stripping, since some of it lives in <head>.
  const canonicalUrl = attributeOf(document, 'link[rel="canonical"]', 'href');
  const description = attributeOf(document, 'meta[name="description"]', 'content');
  const locale = document.querySelector('html')?.getAttribute('lang')?.trim() || undefined;
  const noindex = hasNoindex(document);
  const title = readTitle(document);
  const links = Array.from(document.querySelectorAll('a[href]')).map(
    (/** @type {any} */ anchor) => anchor.getAttribute('href') ?? '',
  );

  for (const selector of CHROME_SELECTORS) {
    for (const element of document.querySelectorAll(selector)) element.remove();
  }

  return {
    title,
    text: extractText(document),
    canonicalUrl: canonicalUrl?.trim() || undefined,
    locale,
    noindex,
    description: description?.trim() || undefined,
    links: links.filter((href) => href !== ''),
  };
}

/**
 * Prefer the visible heading over `<title>`.
 *
 * A `<title>` is written for search engines and usually carries a suffix - "Returns
 * Policy | Example Store" - which would appear in every citation. The `<h1>` is what
 * the page calls itself.
 *
 * @param {any} document
 * @returns {string}
 */
function readTitle(document) {
  const candidates = [
    document.querySelector('h1')?.textContent,
    attributeOf(document, 'meta[property="og:title"]', 'content'),
    document.querySelector('title')?.textContent,
  ];

  return candidates.map((value) => (value ?? '').trim()).find((value) => value !== '') ?? '';
}

/**
 * @param {any} document
 * @returns {boolean}
 */
function hasNoindex(document) {
  const directives = [
    attributeOf(document, 'meta[name="robots"]', 'content'),
    attributeOf(document, 'meta[name="googlebot"]', 'content'),
  ];

  return directives.some((value) => (value ?? '').toLowerCase().includes('noindex'));
}

/**
 * @param {any} document
 * @param {string} selector
 * @param {string} attribute
 * @returns {string | undefined}
 */
function attributeOf(document, selector, attribute) {
  return document.querySelector(selector)?.getAttribute(attribute) ?? undefined;
}

/**
 * @param {any} document
 * @returns {string}
 */
function extractText(document) {
  const container = CONTENT_SELECTORS.map((selector) => document.querySelector(selector)).find(
    (element) => element !== null && element !== undefined,
  );

  if (container === null || container === undefined) return '';

  const buffer = createLineBuffer();
  collectLines(container, buffer);

  return buffer.toText();
}

/**
 * Accumulate output lines.
 *
 * State lives in a closure rather than in an array threaded through the walk,
 * because appending inline text has to *amend the previous line* - and the coding
 * standard forbids writing to a parameter's properties, for the good reason that a
 * function which rewrites its caller's array is hard to reason about.
 *
 * @returns {{
 *   heading: (level: number, text: string) => void,
 *   listItem: (text: string) => void,
 *   blank: () => void,
 *   inline: (text: string) => void,
 *   toText: () => string,
 * }}
 */
function createLineBuffer() {
  /** @type {string[]} */
  const lines = [];
  const isContinuable = (/** @type {string} */ line) =>
    line !== '' && !line.startsWith('#') && !line.startsWith('- ');

  return {
    heading(level, text) {
      lines.push('', `${'#'.repeat(level)} ${text.trim()}`, '');
    },

    listItem(text) {
      lines.push(`- ${collapseSpaces(text).trim()}`);
    },

    blank() {
      lines.push('');
    },

    inline(text) {
      const collapsed = collapseSpaces(text);
      if (collapsed.trim() === '') return;

      const previous = lines.at(-1) ?? '';

      // Continue the current line rather than starting one, so a sentence containing
      // a <strong> or an <a> is not broken into fragments - which would otherwise
      // shatter a paragraph into unchunkable slivers.
      //
      // Only the *start* of a line is trimmed, never the end. Trimming the end would
      // delete the single space that separates this fragment from the next one, and
      // "Return <strong>unopened</strong> items" would come out as
      // "Returnunopened items". Trailing space is removed later, by normalizeText.
      if (isContinuable(previous)) {
        lines[lines.length - 1] = collapseSpaces(`${previous}${collapsed}`);
        return;
      }

      lines.push(collapsed.trimStart());
    },

    toText: () => lines.join('\n'),
  };
}

/**
 * Walk the tree, emitting one line per block element.
 *
 * @param {any} element
 * @param {ReturnType<typeof createLineBuffer>} buffer
 */
function collectLines(element, buffer) {
  for (const child of element.childNodes) {
    if (handleLeaf(child, buffer)) continue;

    collectLines(child, buffer);
    if (BLOCK_ELEMENTS.has((child.tagName ?? '').toLowerCase())) buffer.blank();
  }
}

/**
 * Handle the node kinds that never recurse: comments (skipped, e.g. Knockout's
 * `<!-- ko if -->` bindings), text (emitted inline), and headings/list items (emitted
 * as their own line via `textContent`, flattening whatever inline markup they hold).
 *
 * @param {any} child
 * @param {ReturnType<typeof createLineBuffer>} buffer
 * @returns {boolean} Whether the node was fully handled - the caller should not recurse into it.
 */
function handleLeaf(child, buffer) {
  if (child.nodeType === COMMENT_NODE) return true;

  if (child.nodeType === TEXT_NODE) {
    buffer.inline(child.textContent ?? '');
    return true;
  }

  const tag = (child.tagName ?? '').toLowerCase();

  if (HEADINGS.has(tag)) {
    buffer.heading(Number(tag.slice(1)), child.textContent ?? '');
    return true;
  }

  if (tag === 'li') {
    buffer.listItem(child.textContent ?? '');
    return true;
  }

  return false;
}

/**
 * Collapse whitespace runs **without** trimming.
 *
 * The distinction matters: a fragment's trailing space is the word boundary before
 * whatever follows it.
 *
 * @param {string} text
 * @returns {string}
 */
function collapseSpaces(text) {
  return text.replace(/\s+/g, ' ');
}
