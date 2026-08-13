import { ValidationError } from '@shopsage/platform';
import { intoBatches } from './batches.js';
import { resolveEmbeddingsSettings } from './client-options.js';
import { selectProvider } from './providers/index.js';
import { postEmbed } from './transport/post-embed.js';

/**
 * @typedef {object} EmbedContext
 * @property {import('./client-options.js').EmbeddingsSettings} settings
 * @property {import('./providers/types.js').EmbeddingsProvider} provider
 * @property {import('@shopsage/platform').Logger} [logger]
 * @property {typeof fetch} fetchImpl
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [random]
 */

/**
 * Construct the embeddings client.
 *
 * The backend is a configuration choice. `EMBEDDING_PROVIDER=openai` speaks the OpenAI
 * embeddings wire format to any compatible endpoint - an internal AI gateway, Azure,
 * OpenAI itself; `EMBEDDING_PROVIDER=tei` speaks to a self-hosted HuggingFace inference
 * server. Nothing above this file can tell which answered, and switching costs one
 * environment variable and a re-ingestion. See docs/adr/0018.
 *
 * Both methods delegate to async functions rather than being async methods themselves,
 * so a validation failure arrives as a *rejection* like every other failure. A
 * promise-returning method that sometimes throws synchronously forces callers to write
 * both a `catch` block and a `.catch()`, and they will write only one.
 *
 * @param {import('./types.js').EmbeddingsClientOptions} options
 * @returns {import('./types.js').EmbeddingsClient}
 * @throws {import('@shopsage/platform').ConfigurationError} On invalid settings.
 */
export function createEmbeddingsClient(options) {
  const settings = resolveEmbeddingsSettings(options);

  /** @type {EmbedContext} */
  const context = {
    settings,
    provider: selectProvider(settings.provider),
    logger: options.logger,
    fetchImpl: options.fetchImpl ?? fetch,
    sleep: options.sleep,
    random: options.random,
  };

  return {
    embedQuery: (text) => embedQuery(context, text),
    embedDocuments: (texts) => embedDocuments(context, texts),
    health: () =>
      context.provider.health({ settings: context.settings, fetchImpl: context.fetchImpl }),
  };
}

/**
 * @param {EmbedContext} context
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function embedQuery(context, text) {
  assertUsableText(text, 'query');

  // The prefix is applied here and nowhere else. Some models are trained with an
  // asymmetric query instruction, and applying it to documents too would defeat the
  // purpose.
  const prepared = `${context.settings.queryPrefix}${text}`;
  const [vector] = await postEmbed({ ...context, inputs: [prepared] });

  // TEMPORARY: retrieval debug instrumentation (sources: [] investigation). Remove
  // once the empty-sources cause is confirmed. Named `embedQuery debug` rather than
  // reusing another label, so it can be grepped out cleanly on removal.
  context.logger?.debug('embedQuery debug', {
    query: text,
    provider: context.settings.provider,
    model: context.settings.model,
    configuredDimensions: context.settings.dimensions,
    vectorLength: vector.length,
  });

  return vector;
}

/**
 * Embed documents in **sequential** batches.
 *
 * Sequential regardless of backend, and for two different reasons that happen to agree.
 * A self-hosted service runs one model on CPU, so parallel requests do not make it
 * faster - they queue inside it and come back as 429s our own retries then absorb. A
 * hosted gateway is rate-limited per key, and a burst is the fastest way to find that
 * limit. Concurrency here would be a per-provider tuning decision, and it has not been
 * measured for either.
 *
 * Every input is validated before the first request, so a bad chunk halfway through
 * cannot leave a partially embedded corpus behind.
 *
 * @param {EmbedContext} context
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
async function embedDocuments(context, texts) {
  if (!Array.isArray(texts)) throw new ValidationError('texts must be an array');

  // No inputs, no request. An ingestion run over an unchanged corpus should cost
  // nothing at all - which matters more now that a request may be billable.
  if (texts.length === 0) return [];

  texts.forEach((text, index) => assertUsableText(text, `document at index ${index}`));

  /** @type {number[][]} */
  const vectors = [];

  for (const batch of intoBatches(texts, context.settings.batchSize)) {
    vectors.push(...(await postEmbed({ ...context, inputs: batch })));
  }

  return vectors;
}

/**
 * An empty input is an upstream 4xx waiting to happen, and inside a batch it would fail
 * every other document with it. Rejecting it here names the offending index instead.
 *
 * @param {unknown} text
 * @param {string} description
 */
function assertUsableText(text, description) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new ValidationError(`Cannot embed an empty ${description}`);
  }
}
