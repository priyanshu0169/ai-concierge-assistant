import { serializeError } from '@shopsage/platform';
import { runIngestion } from '../run-ingestion.js';
import { buildPipeline } from './build-pipeline.js';

/**
 * Crawl, chunk, embed and store every configured content source.
 *
 * Run as a job, never at application startup: a crawl takes minutes and a backend
 * that blocked on one would never become ready.
 *
 * ```
 * node packages/ingestion/src/cli/ingest.js [options]
 *
 *   --source <id>   Only this source. Repeatable by re-running.
 *   --force         Re-embed everything, ignoring content hashes.
 *   --no-prune      Never delete, even for documents the source no longer produces.
 *   --verbose       Per-document logging.
 * ```
 *
 * `--force` exists for the case hashes cannot detect: the *chunking settings*
 * changed. A chunk's hash covers its text, so re-chunking with a different size
 * produces different text and is caught - but a change to `includeHeadingPath`, or a
 * new embedding model at the same dimensions, is not. When in doubt, force.
 */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { config, logger, embeddings, store, registry } = await buildPipeline(options);

  const configured = config.siteProfile.content.sources.filter(
    (source) => options.sourceId === undefined || source.id === options.sourceId,
  );

  if (configured.length === 0) {
    logger.warn('no matching content sources in the site profile', {
      siteProfilePath: config.siteProfilePath,
      requested: options.sourceId,
      remediation: 'add an entry under content.sources - see docs/Configuration.md',
    });
    return;
  }

  const controller = new AbortController();
  // A half-finished run is fine - documents already stored stay stored - but it must
  // not prune, and the failure count guard handles that.
  process.on('SIGINT', () => {
    logger.warn('interrupted, finishing the current document');
    controller.abort();
  });

  const report = await runIngestion({
    sources: registry.build({
      configs: configured,
      siteId: config.siteProfile.identity.siteId,
      logger,
    }),
    siteProfile: config.siteProfile,
    embeddings,
    store,
    logger,
    force: options.force,
    prune: options.prune,
    signal: controller.signal,
  });

  printReport(report);
}

/**
 * @param {import('../run-ingestion.js').IngestionReport} report
 */
function printReport(report) {
  const lines = ['', '─'.repeat(78), 'INGESTION REPORT', ''];

  for (const source of report.sources) {
    lines.push(
      `  ${source.sourceId}`,
      `    documents ${source.documents}   chunks ${source.chunksTotal}`,
      `    embedded ${source.chunksEmbedded}   skipped ${source.chunksSkipped} (unchanged)   deleted ${source.chunksDeleted}`,
      `    failures ${source.failures}`,
      source.prune.pruned
        ? `    pruned ${source.prune.documentsRemoved} removed documents (${source.prune.chunksRemoved} chunks)`
        : `    prune SKIPPED: ${source.prune.skippedReason}`,
      '',
    );
  }

  lines.push(`  completed in ${(report.durationMs / 1000).toFixed(1)}s`, '');
  process.stdout.write(lines.join('\n'));
}

/**
 * @param {string[]} argv
 * @returns {{ sourceId?: string, force: boolean, prune: boolean, verbose: boolean }}
 */
function parseArguments(argv) {
  const index = argv.indexOf('--source');

  return {
    sourceId: index === -1 ? undefined : argv[index + 1],
    force: argv.includes('--force'),
    prune: !argv.includes('--no-prune'),
    verbose: argv.includes('--verbose'),
  };
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ msg: 'ingestion failed', err: serializeError(error) })}\n`,
  );
  process.exit(1);
});
