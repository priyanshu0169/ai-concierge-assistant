import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readJsonFile, serializeError } from '@shopsage/platform';
import { runEvaluation } from '../evaluation/run-evaluation.js';
import { buildPipeline } from './build-pipeline.js';

const DEFAULT_QUESTIONS_PATH = './config/golden-questions.json';

/**
 * Measure retrieval against the golden question set.
 *
 * ```
 * node packages/ingestion/src/cli/evaluate.js [--questions <path>] [--report <path>] [--verbose]
 * ```
 *
 * Exits non-zero when any question fails, so it can gate a change to chunking,
 * `minScore` or the embedding model. That is the point: from here on, "retrieval got
 * better" is a number, not an impression formed by trying three questions by hand.
 *
 * `--report` writes the run to a JSON file, which is how a retrieval change becomes reviewable
 * rather than remembered. Transcribing these numbers by hand is not a safe alternative: an earlier
 * hand-rolled check on this corpus reported 86.4% recall where the real figure was 77.3%, because
 * the expected-evidence strings were too loose. A machine-written snapshot cannot flatter itself.
 */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { config, logger, embeddings, store } = await buildPipeline(options);

  const questionsPath = path.resolve(process.cwd(), options.questionsPath);
  const questions = /** @type {import('../evaluation/run-evaluation.js').GoldenQuestion[]} */ (
    await readJsonFile(questionsPath)
  );

  logger.info('evaluating retrieval', {
    questions: questions.length,
    questionsPath,
    topK: config.siteProfile.retrieval.topK,
    minScore: config.siteProfile.retrieval.minScore,
    model: config.env.EMBEDDING_MODEL,
  });

  const report = await runEvaluation({
    questions,
    siteProfile: config.siteProfile,
    embeddings,
    store,
  });

  printReport(report, config.siteProfile.retrieval);

  if (options.reportPath !== undefined) {
    await writeReport({ report, config, questionsPath, reportPath: options.reportPath, logger });
  }

  return report.passed < report.total;
}

/**
 * Persist one run so it can be compared against another.
 *
 * Records the **settings and the embedding model alongside the metrics**, because a figure without
 * its configuration cannot be compared with anything: a score floor tuned for one model does not
 * transfer to another, and `maxPerSource` silently changes how much evidence reaches the model
 * without moving any retrieval metric at all.
 *
 * Per-question rows are kept as well as the summary. A summary tells you a change helped; only the
 * rows tell you *which questions* moved, which is what decides whether the change was the one
 * intended or a lucky trade.
 *
 * @param {{
 *   report: import('../evaluation/run-evaluation.js').EvaluationReport,
 *   config: Readonly<import('@shopsage/platform').AppConfig>,
 *   questionsPath: string,
 *   reportPath: string,
 *   logger: import('@shopsage/platform').Logger,
 * }} input
 */
async function writeReport(input) {
  const { report, config, questionsPath, reportPath, logger } = input;
  const target = path.resolve(process.cwd(), reportPath);

  const snapshot = {
    recordedAt: new Date().toISOString(),
    siteId: config.siteProfile.identity.siteId,
    embeddingModel: config.env.EMBEDDING_MODEL,
    embeddingDimensions: config.env.EMBEDDING_DIMENSIONS,
    questionsPath: path.relative(process.cwd(), questionsPath).replaceAll('\\', '/'),
    settings: report.settings,
    chunking: config.siteProfile.ingestion,
    metrics: {
      passed: report.passed,
      total: report.total,
      recallAtK: report.recallAtK,
      precisionAtK: report.precisionAtK,
      mrr: report.mrr,
      ndcgAtK: report.ndcgAtK,
      refusalAccuracy: report.refusalAccuracy,
      averageTopScore: report.averageTopScore,
      averageRetrieved: report.averageRetrieved,
      averageUsed: report.averageUsed,
    },
    questions: report.results,
  };

  await writeFile(target, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  logger.info('evaluation report written', { path: target });
}

/**
 * @param {import('../evaluation/run-evaluation.js').EvaluationReport} report
 * @param {import('@shopsage/platform').SiteProfile['retrieval']} retrieval
 */
function printReport(report, retrieval) {
  const lines = ['', '─'.repeat(78), 'RETRIEVAL EVALUATION', ''];

  for (const result of report.results) {
    lines.push(
      `  ${result.passed ? 'PASS' : 'FAIL'}  ${result.question}`,
      `        ${result.verdict}; top ${result.topScore.toFixed(4)}, ` +
        `${result.retrieved} retrieved, ${result.relevant ?? 0} relevant, ${result.used ?? 0} used`,
    );
  }

  const k = retrieval.topK;

  lines.push(
    '',
    `  passed              ${report.passed}/${report.total}`,
    '',
    `  recall@${k}            ${report.recallAtK}      hit rate: at least one relevant chunk`,
    `  precision@${k}         ${report.precisionAtK}      lower bound - see metrics.js`,
    `  MRR                 ${report.mrr}      rank of the first relevant chunk`,
    `  NDCG@${k}              ${report.ndcgAtK}      ordering quality, binary relevance`,
    `  refusal accuracy    ${report.refusalAccuracy}      unanswerable questions correctly empty`,
    '',
    `  avg top score       ${report.averageTopScore}`,
    `  avg retrieved       ${report.averageRetrieved}      chunks clearing the score floor`,
    `  avg used            ${report.averageUsed}      chunks the model would actually receive`,
    '',
    `  settings  topK=${k}  minScore=${retrieval.minScore}  ` +
      `maxPerSource=${retrieval.maxPerSource}  maxContextChars=${retrieval.maxContextCharacters}`,
    '',
    '  Record these before and after any retrieval or chunking change. The settings line is',
    '  part of the measurement: a score floor tuned for one embedding model does not transfer',
    '  to another, and a metric without its configuration cannot be compared. Precision and',
    '  NDCG are computed from non-exhaustive binary labels and are lower bounds, not verdicts',
    '  - see packages/ingestion/src/evaluation/metrics.js. See also docs/RAG.md.',
    '',
  );

  process.stdout.write(lines.join('\n'));
}

/**
 * @param {string[]} argv
 * @returns {{ questionsPath: string, reportPath?: string, verbose: boolean }}
 */
function parseArguments(argv) {
  const questions = argv.indexOf('--questions');
  const report = argv.indexOf('--report');

  return {
    questionsPath: questions === -1 ? DEFAULT_QUESTIONS_PATH : argv[questions + 1],
    ...(report === -1 ? {} : { reportPath: argv[report + 1] }),
    verbose: argv.includes('--verbose'),
  };
}

main()
  // Non-zero on any failing question, so this can gate a change to chunking,
  // `minScore` or the embedding model.
  .then((hasFailures) => process.exit(hasFailures ? 1 : 0))
  .catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ msg: 'evaluation failed', err: serializeError(error) })}\n`,
    );
    process.exit(1);
  });
