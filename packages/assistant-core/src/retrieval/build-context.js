/**
 * Assemble ranked chunks into the text a tool hands back to the model.
 *
 * Two things this does that a naive join does not:
 *
 * - **Numbers each excerpt and labels it with its source.** The model needs to be able
 *   to say *which* excerpt an answer came from, and a customer-facing citation has to
 *   match. An unlabelled blob makes both impossible.
 * - **Truncates at a chunk boundary, never mid-chunk.** A half-excerpt is worse than a
 *   missing one: it reads as complete and may cut off the qualifying clause that makes
 *   it true ("returns accepted within thirty days *if unopened*").
 *
 * The budget is a character count from the store's profile rather than a token count,
 * for the same reason chunking is (docs/adr/0020): the default embedding backend
 * publishes no token limit, and a tokenizer dependency would be model-specific.
 *
 * @param {{
 *   chunks: import('../types.js').RetrievedChunk[],
 *   maxContextCharacters: number,
 * }} input
 * @returns {{ context: string, used: import('../types.js').RetrievedChunk[] }}
 */
export function buildContext(input) {
  const { chunks, maxContextCharacters } = input;

  /** @type {string[]} */
  const parts = [];
  /** @type {import('../types.js').RetrievedChunk[]} */
  const used = [];
  let length = 0;

  for (const chunk of chunks) {
    const excerpt = formatExcerpt(chunk, used.length + 1);

    // Always include the first excerpt, even if it alone exceeds the budget: returning
    // no context at all because the best match was long would be worse than a long
    // prompt, and the chunker already caps chunk size.
    if (used.length > 0 && length + excerpt.length > maxContextCharacters) break;

    parts.push(excerpt);
    used.push(chunk);
    length += excerpt.length;
  }

  return { context: parts.join('\n\n'), used };
}

/**
 * @param {import('../types.js').RetrievedChunk} chunk
 * @param {number} position
 * @returns {string}
 */
function formatExcerpt(chunk, position) {
  const label = [chunk.title, chunk.headingPath].filter((part) => Boolean(part)).join(' > ');
  const location = chunk.url === undefined ? '' : `\nSource: ${chunk.url}`;

  return `[${position}] ${label}${location}\n${chunk.text}`;
}
