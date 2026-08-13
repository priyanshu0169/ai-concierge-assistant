import { buildContext, rankChunks } from '@shopsage/assistant-core';
import { PAYLOAD_KEYS } from '../to-vector-point.js';
import { mean, ndcg, reciprocalRank, round } from './metrics.js';

/**
 * @typedef {object} GoldenQuestion
 * @property {string} question
 * @property {string[]} [expectedUrls] Any one of these counts as a hit.
 * @property {string[]} [expectedText] Substrings that must appear in a retrieved chunk.
 * @property {boolean} [unanswerable] True when the corpus genuinely cannot answer it.
 * @property {string} [note] Why this question is in the set.
 */

/**
 * @typedef {object} QuestionResult
 * @property {string} question
 * @property {boolean} passed
 * @property {number} rank Position of the first expected hit, 1-based. 0 if absent.
 * @property {number} topScore
 * @property {number} retrieved
 * @property {string} verdict
 * @property {number} [relevant] Retrieved chunks containing expected evidence.
 * @property {number} [meanScore]
 * @property {number} [used] Chunks surviving ranking and the context budget.
 * @property {number} [ndcg]
 */

/**
 * @typedef {object} EvaluationReport
 * @property {QuestionResult[]} results
 * @property {number} passed
 * @property {number} total
 * @property {number} recallAtK Fraction of answerable questions with a hit in topK. A hit rate:
 *   see the note in metrics.js on what these figures can and cannot mean.
 * @property {number} refusalAccuracy Fraction of unanswerable questions correctly empty.
 * @property {number} precisionAtK Mean fraction of retrieved chunks that were provably relevant.
 * @property {number} mrr Mean reciprocal rank of the first relevant chunk.
 * @property {number} ndcgAtK Mean NDCG, binary relevance.
 * @property {number} averageTopScore Mean best score, over answerable questions.
 * @property {number} averageRetrieved Mean chunks clearing the score floor.
 * @property {number} averageUsed Mean chunks the model would actually be given.
 * @property {{ topK: number, minScore: number, maxPerSource: number, maxContextCharacters: number }} settings
 */

/**
 * Measure retrieval against a golden question set.
 *
 * This exists because "improving" chunking or a prompt is otherwise guesswork: a
 * change that helps five questions and breaks eight looks identical, from the inside,
 * to one that helps all thirteen. From here on, a retrieval change is a number that
 * moved.
 *
 * Two metrics, and the second is the one usually missing:
 *
 * - **Recall at K** — did an expected chunk come back at all? This is the headline.
 * - **Refusal accuracy** — for questions the corpus genuinely cannot answer, did
 *   retrieval correctly return nothing above the score floor? A system tuned only for
 *   recall answers everything, confidently and sometimes wrongly, and for a commerce
 *   assistant a confident wrong answer about a price or a policy is the worst output
 *   it can produce.
 *
 * Deliberately no LLM in the loop. This measures retrieval, and adding a
 * non-deterministic step would make a regression impossible to attribute.
 *
 * @param {{
 *   questions: GoldenQuestion[],
 *   siteProfile: import('@shopsage/platform').SiteProfile,
 *   embeddings: import('@shopsage/embeddings-client').EmbeddingsClient,
 *   store: import('@shopsage/vector-repository').VectorRepository,
 * }} input
 * @returns {Promise<EvaluationReport>}
 */
export async function runEvaluation(input) {
  const { questions, siteProfile, embeddings, store } = input;
  const { topK, minScore } = siteProfile.retrieval;

  /** @type {QuestionResult[]} */
  const results = [];

  for (const question of questions) {
    const vector = await embeddings.embedQuery(question.question);
    const matches = await store.search({
      vector,
      siteId: siteProfile.identity.siteId,
      topK,
      minScore,
    });

    results.push(evaluateQuestion(question, matches, siteProfile));
  }

  return summarize(questions, results, siteProfile);
}

/**
 * How many chunks the model would actually receive.
 *
 * Runs the **real** `rankChunks` and `buildContext` rather than reimplementing the per-source cap
 * and the character budget here. Those two settings are precisely what a ranking change tunes, so a
 * copy of their logic that drifted would report progress the assistant never saw. Still no model in
 * the loop - both are pure functions.
 *
 * @param {import('@shopsage/vector-repository').VectorMatch[]} matches
 * @param {import('@shopsage/platform').SiteProfile} siteProfile
 * @returns {number}
 */
function countUsable(matches, siteProfile) {
  const chunks = matches.map((match) => ({
    id: match.id,
    score: match.score,
    text: String(match.payload[PAYLOAD_KEYS.TEXT] ?? ''),
    title: String(match.payload[PAYLOAD_KEYS.TITLE] ?? ''),
    ...(typeof match.payload[PAYLOAD_KEYS.URL] === 'string'
      ? { url: String(match.payload[PAYLOAD_KEYS.URL]) }
      : {}),
  }));

  const { used } = buildContext({
    chunks: rankChunks(chunks, { maxPerSource: siteProfile.retrieval.maxPerSource }),
    maxContextCharacters: siteProfile.retrieval.maxContextCharacters,
  });

  return used.length;
}

/**
 * @param {GoldenQuestion} question
 * @param {import('@shopsage/vector-repository').VectorMatch[]} matches
 * @param {import('@shopsage/platform').SiteProfile} siteProfile
 * @returns {QuestionResult}
 */
function evaluateQuestion(question, matches, siteProfile) {
  const topScore = matches[0]?.score ?? 0;
  const base = { question: question.question, topScore, retrieved: matches.length };

  if (question.unanswerable === true) {
    // Anything retrieved above the floor for an unanswerable question is a chance for
    // the model to be confidently wrong.
    const passed = matches.length === 0;

    return {
      ...base,
      passed,
      rank: 0,
      verdict: passed
        ? 'correctly found nothing'
        : `retrieved ${matches.length} despite being unanswerable`,
    };
  }

  const relevance = matches.map((match) => isExpected(match, question));
  const rank = relevance.indexOf(true) + 1;
  const relevant = relevance.filter(Boolean).length;

  return {
    ...base,
    passed: rank > 0,
    rank,
    relevant,
    meanScore: round(mean(matches.map((match) => match.score))),
    used: countUsable(matches, siteProfile),
    ndcg: round(ndcg(relevance)),
    verdict: rank > 0 ? `expected chunk at rank ${rank}` : 'expected chunk not retrieved',
  };
}

/**
 * @param {import('@shopsage/vector-repository').VectorMatch} match
 * @param {GoldenQuestion} question
 * @returns {boolean}
 */
function isExpected(match, question) {
  const url = String(match.payload[PAYLOAD_KEYS.URL] ?? '');
  const text = String(match.payload[PAYLOAD_KEYS.TEXT] ?? '').toLowerCase();

  const urlHit = (question.expectedUrls ?? []).some((expected) => url.includes(expected));
  const textHit = (question.expectedText ?? []).some((expected) =>
    text.includes(expected.toLowerCase()),
  );

  return urlHit || textHit;
}

/**
 * @param {GoldenQuestion[]} questions
 * @param {QuestionResult[]} results
 * @param {import('@shopsage/platform').SiteProfile} siteProfile
 * @returns {EvaluationReport}
 */
function summarize(questions, results, siteProfile) {
  const answerable = results.filter((_result, index) => questions[index].unanswerable !== true);
  const unanswerable = results.filter((_result, index) => questions[index].unanswerable === true);
  const { topK, minScore, maxPerSource, maxContextCharacters } = siteProfile.retrieval;

  return {
    results,
    passed: results.filter((result) => result.passed).length,
    total: results.length,
    recallAtK: ratio(answerable.filter((result) => result.passed).length, answerable.length),
    refusalAccuracy: ratio(
      unanswerable.filter((result) => result.passed).length,
      unanswerable.length,
    ),
    // Averaged over answerable questions only. Including the unanswerable ones would reward
    // retrieving nothing, which is the opposite of what these four measure.
    precisionAtK: round(
      mean(
        answerable.map((result) =>
          result.retrieved === 0 ? 0 : (result.relevant ?? 0) / result.retrieved,
        ),
      ),
    ),
    mrr: round(mean(answerable.map((result) => reciprocalRank(result.rank)))),
    ndcgAtK: round(mean(answerable.map((result) => result.ndcg ?? 0))),
    averageTopScore: round(mean(answerable.map((result) => result.topScore))),
    averageRetrieved: round(mean(answerable.map((result) => result.retrieved))),
    averageUsed: round(mean(answerable.map((result) => result.used ?? 0))),
    // Recorded with the numbers, because a metric without the settings that produced it cannot be
    // compared against anything later.
    settings: { topK, minScore, maxPerSource, maxContextCharacters },
  };
}

/**
 * @param {number} hits
 * @param {number} total
 * @returns {number}
 */
function ratio(hits, total) {
  return total === 0 ? 1 : Number((hits / total).toFixed(3));
}
