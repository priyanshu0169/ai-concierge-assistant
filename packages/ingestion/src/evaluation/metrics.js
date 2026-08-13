/**
 * Ranking metrics over a golden question set.
 *
 * ## What these numbers can and cannot tell you
 *
 * They are computed against **binary, non-exhaustive** relevance labels: a golden question names
 * evidence that proves the right content came back, and a retrieved chunk either contains it or does
 * not. Nobody has labelled every chunk in the corpus for every question, and at 4,174 chunks nobody
 * is going to.
 *
 * That has a specific consequence worth stating rather than burying, because it is easy to quote
 * these figures as though they were absolute:
 *
 * - **Recall@K is a hit rate.** It answers "did at least one piece of correct evidence come back",
 *   not "what fraction of all relevant chunks came back". The latter needs exhaustive labels.
 * - **Precision@K is a lower bound.** A chunk that is genuinely useful but happens not to contain
 *   the expected string counts against it. A precision of 0.3 does not mean 70% of results were
 *   junk; it means 70% were not *provably* on target.
 * - **NDCG@K uses the retrieved set as its own ideal.** With no exhaustive labels the ideal ranking
 *   is "every relevant chunk we found, first", so it measures ordering quality within what was
 *   retrieved and cannot see relevant chunks that were missed entirely.
 *
 * They are still worth recording. The point is not absolute truth, it is **comparability**: the same
 * questions and the same labels before and after a change, so a chunking or ranking decision is a
 * number that moved rather than an opinion about a handful of manual tests.
 */

/**
 * @typedef {object} QuestionMetrics
 * @property {number} retrieved How many chunks cleared the score floor.
 * @property {number} relevant How many of those contained expected evidence.
 * @property {number} firstRelevantRank 1-based; 0 when none was relevant.
 * @property {number} topScore
 * @property {number} meanScore Across everything retrieved.
 * @property {number} used Chunks that survived ranking and the context budget.
 */

/**
 * Reciprocal rank of the first relevant result.
 *
 * Rewards putting the answer first rather than merely somewhere in the list, which matters because
 * the context budget and the per-source cap both cut from the bottom.
 *
 * @param {number} firstRelevantRank
 * @returns {number}
 */
export function reciprocalRank(firstRelevantRank) {
  return firstRelevantRank === 0 ? 0 : 1 / firstRelevantRank;
}

/**
 * Normalised discounted cumulative gain, binary relevance.
 *
 * The ideal is "every relevant chunk this query found, ranked first" - see the file note on why that
 * is the honest ideal to use without exhaustive labels. Returns 0 when nothing relevant was found,
 * so a total miss scores 0 rather than being undefined.
 *
 * @param {boolean[]} relevanceByRank Position 0 is rank 1.
 * @returns {number}
 */
export function ndcg(relevanceByRank) {
  const gain = (/** @type {number} */ index) => 1 / Math.log2(index + 2);

  const dcg = relevanceByRank.reduce(
    (total, isRelevant, index) => total + (isRelevant ? gain(index) : 0),
    0,
  );

  const relevantCount = relevanceByRank.filter(Boolean).length;
  if (relevantCount === 0) return 0;

  const ideal = Array.from({ length: relevantCount }, (_unused, index) => gain(index)).reduce(
    (total, value) => total + value,
    0,
  );

  return dcg / ideal;
}

/**
 * Average a list, returning 0 rather than NaN for an empty one.
 *
 * A metric of "no questions" is reported as zero and read alongside the question count, which is
 * safer than a NaN appearing in a report somebody is comparing against last week's.
 *
 * @param {number[]} values
 * @returns {number}
 */
export function mean(values) {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Round for a report. Four places: enough to see a change worth acting on, few enough to read.
 *
 * @param {number} value
 * @returns {number}
 */
export function round(value) {
  return Number(value.toFixed(4));
}
