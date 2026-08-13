import { createLogger, loadConfig, serializeError } from '@shopsage/platform';
import { createSourceRegistry } from '@shopsage/content-model';
import { WEBSITE_SOURCE_TYPE, createWebsiteSource } from '../index.js';

/**
 * Crawl a site profile's content sources and print what they produce.
 *
 * A dry run: it embeds nothing, stores nothing, and costs nothing but the crawl. It
 * exists because `include` and `exclude` patterns are the hardest part of onboarding
 * a store to get right, and the alternative way to find out whether they work is to
 * run a full ingestion and inspect a vector store afterwards.
 *
 * Not the ingestion pipeline - that is Stage 5. This only proves what a source emits.
 *
 * Usage:
 *   node packages/scraper/src/cli/preview.js [--source <id>] [--limit <n>] [--full]
 */
async function main() {
  const options = parseArguments(process.argv.slice(2));
  const config = await loadConfig();
  const logger = createLogger({
    level: options.verbose ? 'debug' : 'info',
    format: 'pretty',
    name: 'scraper-preview',
  });

  const registry = createSourceRegistry({ [WEBSITE_SOURCE_TYPE]: createWebsiteSource });
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

  const sources = registry.build({
    configs: configured,
    siteId: config.siteProfile.identity.siteId,
    logger,
  });

  for (const source of sources) await previewSource({ source, options, logger });
}

/**
 * @param {{
 *   source: import('@shopsage/content-model').ContentSource,
 *   options: ReturnType<typeof parseArguments>,
 *   logger: import('@shopsage/platform').Logger,
 * }} input
 */
async function previewSource(input) {
  const { source, options, logger } = input;
  let shown = 0;

  for await (const document of source.fetch()) {
    if (shown >= options.limit) break;
    shown += 1;
    print(document, options.full);
  }

  logger.info('source finished', { sourceId: source.id, shown, ...source.stats() });
}

/**
 * @param {import('@shopsage/content-model').Document} document
 * @param {boolean} full
 */
function print(document, full) {
  const preview = full ? document.text : `${document.text.slice(0, 300)}…`;

  process.stdout.write(
    [
      '',
      '─'.repeat(78),
      `${document.contentType.toUpperCase()}  ${document.title}`,
      `${document.url ?? document.reference}`,
      `id=${document.id}  hash=${document.contentHash.slice(0, 20)}…  chars=${document.text.length}`,
      '',
      preview,
      '',
    ].join('\n'),
  );
}

/**
 * @param {string[]} argv
 * @returns {{ sourceId?: string, limit: number, full: boolean, verbose: boolean }}
 */
function parseArguments(argv) {
  const valueOf = (/** @type {string} */ flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };

  const limit = Number(valueOf('--limit') ?? '10');

  return {
    sourceId: valueOf('--source'),
    limit: Number.isFinite(limit) && limit > 0 ? limit : 10,
    full: argv.includes('--full'),
    verbose: argv.includes('--verbose'),
  };
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ msg: 'preview failed', err: serializeError(error) })}\n`,
  );
  process.exit(1);
});
