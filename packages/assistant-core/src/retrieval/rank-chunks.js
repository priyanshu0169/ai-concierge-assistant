/**
 * Fallback for callers that pass no cap.
 *
 * A long page chunks into many pieces, all of which score similarly on a question that
 * page answers. Without a cap, `topK` of 6 can be six slices of one document - which
 * looks like six pieces of evidence and is really one, and it crowds out the page that
 * held the other half of the answer.
 *
 * It is now a *setting* (`retrieval.maxPerSource`) because measurement showed 2 was the binding
 * constraint on breadth questions - "what are the different types of caviar" retrieved six chunks
 * from the one page that answers it and kept two. The default stays 2 so an omitted option behaves
 * exactly as before.
 */
const DEFAULT_MAX_PER_SOURCE = 2;

/**
 * Rank and thin retrieved chunks before they become context.
 *
 * Three steps, in order, each fixing something the previous one cannot:
 *
 * 1. **Sort by score.** The retriever's order is not guaranteed to be meaningful.
 * 2. **Drop exact duplicate text.** The same policy paragraph published under two URLs
 *    is one fact; showing it twice wastes the context budget and inflates apparent
 *    agreement.
 * 3. **Diversify by source.** See `DEFAULT_MAX_PER_SOURCE` above.
 *
 * The score floor is *not* applied here: the retriever applies it, because a vector
 * store can discard below-threshold matches without shipping them back.
 *
 * @param {import('../types.js').RetrievedChunk[]} chunks
 * @param {{ maxPerSource?: number }} [options]
 * @returns {import('../types.js').RetrievedChunk[]}
 */
export function rankChunks(chunks, options = {}) {
  const maxPerSource = options.maxPerSource ?? DEFAULT_MAX_PER_SOURCE;
  const byScore = [...chunks].sort((left, right) => right.score - left.score);

  /** @type {Set<string>} */
  const seenText = new Set();
  /** @type {Map<string, number>} */
  const perSource = new Map();
  /** @type {import('../types.js').RetrievedChunk[]} */
  const kept = [];

  for (const chunk of byScore) {
    const fingerprint = chunk.text.trim();
    if (seenText.has(fingerprint)) continue;

    const source = sourceKey(chunk);
    const used = perSource.get(source) ?? 0;
    if (used >= maxPerSource) continue;

    seenText.add(fingerprint);
    perSource.set(source, used + 1);
    kept.push(chunk);
  }

  return kept;
}

/**
 * Reduce ranked chunks to the citations a customer sees.
 *
 * Deduplicated by URL, because two chunks from one page are one place to send someone.
 * Capped by the store's `maxCitations`: a wall of links reads as evasion rather than
 * evidence, and the point of a citation is that it gets checked.
 *
 * @param {{
 *   chunks: import('../types.js').RetrievedChunk[],
 *   maxCitations: number,
 * }} input
 * @returns {import('../types.js').AnswerSource[]}
 */
export function toSources(input) {
  const { chunks, maxCitations } = input;

  /** @type {Map<string, import('../types.js').AnswerSource>} */
  const unique = new Map();

  for (const chunk of chunks) {
    const key = chunk.url ?? chunk.title;
    if (key === '' || unique.has(key)) continue;

    unique.set(key, { title: chunk.title, ...(chunk.url === undefined ? {} : { url: chunk.url }) });
  }

  return [...unique.values()].slice(0, maxCitations);
}

/**
 * @param {import('../types.js').RetrievedChunk} chunk
 * @returns {string}
 */
function sourceKey(chunk) {
  return chunk.url ?? chunk.title ?? chunk.id;
}
