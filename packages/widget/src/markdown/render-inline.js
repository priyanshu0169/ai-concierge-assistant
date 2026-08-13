/**
 * Inline markdown, rendered as **DOM nodes** rather than as an HTML string.
 *
 * This is the security core of the widget, and the reason it builds nodes instead of setting
 * `innerHTML`: the text being rendered comes from a language model, which means it is
 * untrusted input. A model can be talked into emitting `<script>`, `<img onerror=…>` or a
 * `javascript:` URL, and any of those assigned through `innerHTML` executes. Building nodes
 * makes injection structurally impossible instead of a sanitiser away - there is no code path
 * here that can produce an element the parser did not explicitly create.
 *
 * The subset is what language models actually emit in prose: emphasis, inline code and links.
 * Everything unrecognised stays literal text, which is the right failure mode - an unclosed
 * `**` should look like asterisks, not silently swallow the rest of a sentence.
 */

/**
 * Ordered by precedence. Code first, because a backtick span must win over emphasis inside
 * it: `` `**not bold**` `` is code containing asterisks.
 */
const PATTERNS = [
  { name: 'code', expression: /`([^`\n]+)`/u },
  // The href alternation allows one level of balanced parentheses, because real URLs contain
  // them - `…/wiki/Ruby_(programming_language)` is the canonical case. A plain `[^)]+` stops at
  // the first bracket, which both breaks that link and leaves a stray `)` in the prose.
  { name: 'link', expression: /\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/u },
  { name: 'strong', expression: /\*\*([^*\n]+)\*\*/u },
  { name: 'emphasis', expression: /(?<!\*)\*([^*\n]+)\*(?!\*)/u },
];

/**
 * @param {string} text
 * @returns {DocumentFragment}
 */
export function renderInline(text) {
  const fragment = document.createDocumentFragment();
  let rest = text;

  while (rest.length > 0) {
    const match = firstMatch(rest);

    if (match === undefined) {
      fragment.append(document.createTextNode(rest));
      break;
    }

    if (match.index > 0) fragment.append(document.createTextNode(rest.slice(0, match.index)));

    fragment.append(toNode(match));
    rest = rest.slice(match.index + match.length);
  }

  return fragment;
}

/**
 * @typedef {{ name: string, index: number, length: number, groups: string[] }} Match
 * @param {string} text
 * @returns {Match | undefined}
 */
function firstMatch(text) {
  /** @type {Match | undefined} */
  let earliest;

  for (const { name, expression } of PATTERNS) {
    const found = expression.exec(text);

    if (found === null) continue;
    // Earliest position wins; on a tie the pattern order above decides, which is what keeps
    // code spans opaque to emphasis.
    if (earliest !== undefined && found.index >= earliest.index) continue;

    earliest = { name, index: found.index, length: found[0].length, groups: found.slice(1) };
  }

  return earliest;
}

/**
 * @param {Match} match
 * @returns {Node}
 */
function toNode(match) {
  const [first, second] = match.groups;

  if (match.name === 'code') return withText('code', first);
  if (match.name === 'strong') return withText('strong', first);
  if (match.name === 'emphasis') return withText('em', first);

  return toLink(first, second);
}

/**
 * @param {string} tag
 * @param {string} text
 * @returns {HTMLElement}
 */
function withText(tag, text) {
  const element = document.createElement(tag);

  element.textContent = text;

  return element;
}

/**
 * A link, or plain text if the target is not one this widget will open.
 *
 * Only `http` and `https` survive. `javascript:` is the obvious attack, but `data:` is the one
 * people forget - a `data:text/html` URL opens an attacker-authored page on a blank origin.
 * An unusable scheme degrades to the label as text rather than throwing away the words.
 *
 * @param {string} label
 * @param {string} href
 * @returns {Node}
 */
function toLink(label, href) {
  if (!isSafeHref(href)) return document.createTextNode(label);

  const anchor = withText('a', label);

  anchor.setAttribute('href', href);
  anchor.setAttribute('target', '_blank');
  // `noopener` denies the opened page a handle on this one; `noreferrer` keeps the customer's
  // current URL out of a third party's logs.
  anchor.setAttribute('rel', 'noopener noreferrer');

  return anchor;
}

/**
 * @param {string} href
 * @returns {boolean}
 */
export function isSafeHref(href) {
  try {
    // Resolved against the page, so a relative link is judged by the scheme it inherits.
    const { protocol } = new URL(href, window.location.href);

    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
