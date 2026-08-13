import { byPrice, comparableByPrice } from '../tools/commerce-context.js';

/**
 * Recommendation, and it lives here by decision.
 *
 * Magento exposes product data; choosing which of it to put in front of a customer is assistant
 * behaviour. Keeping it here means the rule "do not recommend something they cannot buy" is one
 * function in a domain package with tests, rather than a query somebody wrote in PHP once.
 *
 * Three rules, each earning its place, and all of them explainable to a customer:
 *
 * 1. **Buyable first.** An out-of-stock product is not a recommendation, it is a disappointment.
 * 2. **Relevance by stated words.** Term coverage over the name and the store's own summary. Crude,
 *    and honest about being crude - the alternative is inventing an affinity the data cannot support.
 * 3. **Spread the price range.** Five near-identical prices answer one budget. Offering a cheaper and
 *    a dearer option answers the question the customer was actually weighing up.
 *
 * What is deliberately absent: purchase history, browsing behaviour, lookalike audiences. None of it
 * is available - the session subject is a pseudonym by agreement - and none of it should arrive by
 * accident. If personalised recommendation is ever wanted it is a contract change with a privacy
 * review, not a scoring tweak.
 */

/**
 * @typedef {object} Recommendation
 * @property {import('../types.js').Product} product
 * @property {string} reason Why it is here, in terms the connector actually stated.
 */

/**
 * @param {{
 *   query: string,
 *   candidates: import('../types.js').Product[],
 *   limit: number,
 * }} input
 * @returns {Recommendation[]}
 */
export function rankRecommendations(input) {
  const terms = termsOf(input.query);
  const buyable = input.candidates.filter((product) => product.availability !== 'out_of_stock');
  // Falling back to the full set rather than returning nothing. "Everything matching is out of
  // stock" is a useful answer, and the tool text tells the model to say so.
  const pool = buyable.length > 0 ? buyable : input.candidates;

  const scored = pool
    .map((product) => ({ product, score: relevance(product, terms) }))
    .sort((left, right) => right.score - left.score);

  return spreadByPrice(
    scored.map((entry) => entry.product),
    input.limit,
  ).map((product) => ({ product, reason: reasonFor(product, terms) }));
}

/**
 * Take a spread across the price range rather than the top N.
 *
 * Cheapest, dearest, then filling in from the most relevant remainder. Not a clever algorithm and
 * not trying to be: it guarantees the shortlist spans the range the store offers, which is the
 * property a customer comparing options actually needs.
 *
 * Order of relevance is preserved for the middle, so the spread costs at most two slots.
 *
 * @param {import('../types.js').Product[]} ranked Most relevant first.
 * @param {number} limit
 * @returns {import('../types.js').Product[]}
 */
function spreadByPrice(ranked, limit) {
  if (ranked.length <= limit || limit < 3 || !comparableByPrice(ranked)) {
    return ranked.slice(0, limit);
  }

  const byAmount = [...ranked].sort(byPrice);
  const picked = [byAmount[0], byAmount[byAmount.length - 1]];

  for (const product of ranked) {
    if (picked.length >= limit) break;
    if (!picked.includes(product)) picked.push(product);
  }

  // Returned in relevance order, not price order. The tool says nothing about ordering, so an
  // ordering the model might read as a ranking should be the one that is meant.
  return ranked.filter((product) => picked.includes(product));
}

/**
 * @param {import('../types.js').Product} product
 * @param {string[]} terms
 * @returns {number}
 */
function relevance(product, terms) {
  // In stock breaks a tie and never outweighs relevance. A well-stocked irrelevant product is still
  // an irrelevant product.
  return hitsFor(product, terms).length * 2 + (product.availability === 'in_stock' ? 1 : 0);
}

/**
 * Which query terms the store's own words actually contain.
 *
 * Matched at **word starts**, not as substrings, and that is not a nicety. A plain `includes` has
 * "for" match "reinforced" and "ski" match "skirt", which both inflates the ranking and produces a
 * reason that reads as nonsense to the customer it is shown to. Prefix matching still catches the
 * plurals and inflections that matter - "walk" finds "walking", "sock" finds "socks" - without
 * matching the middle of an unrelated word.
 *
 * @param {import('../types.js').Product} product
 * @param {string[]} terms
 * @returns {string[]}
 */
function hitsFor(product, terms) {
  const words = wordsOf(`${product.name} ${product.summary ?? ''}`);

  return terms.filter((term) => words.some((word) => word.startsWith(term)));
}

/**
 * A reason, restricted to what the store said.
 *
 * Every branch here is a restatement of a field the connector returned. Nothing infers quality,
 * popularity or suitability, because none of that is in the data and a fabricated reason is more
 * damaging than no reason - a customer cannot tell the difference.
 *
 * Each branch is phrased to read after "Chosen because it ", so the tool can put the reason into a
 * sentence without the model having to repair the grammar.
 *
 * @param {import('../types.js').Product} product
 * @param {string[]} terms
 * @returns {string}
 */
function reasonFor(product, terms) {
  const hits = hitsFor(product, terms);

  if (hits.length > 0) return `matches "${hits.join('", "')}" in the store's own description`;
  if (product.availability === 'in_stock') return 'is listed in stock in this category';

  return 'is listed in this category';
}

/**
 * Words worth matching on.
 *
 * Three characters and under are articles, prepositions and conjunctions - "the", "for", "and",
 * "a" - which match nearly everything and rank nothing. Dropping them costs no real query term:
 * a shopper's meaningful words are longer.
 *
 * @param {string} text
 * @returns {string[]}
 */
function wordsOf(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 3);
}

/**
 * @param {string} query
 * @returns {string[]}
 */
function termsOf(query) {
  return [...new Set(wordsOf(query))];
}
