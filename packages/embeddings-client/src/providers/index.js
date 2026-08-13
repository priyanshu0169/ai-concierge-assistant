import { ConfigurationError } from '@shopsage/platform';
import { openAiProvider } from './openai-provider.js';
import { teiProvider } from './tei-provider.js';

/** @type {Readonly<Record<string, import('./types.js').EmbeddingsProvider>>} */
const PROVIDERS = Object.freeze({
  [openAiProvider.name]: openAiProvider,
  [teiProvider.name]: teiProvider,
});

/** The names a site's configuration may choose between. */
export const PROVIDER_NAMES = Object.freeze(Object.keys(PROVIDERS).sort());

/**
 * Resolve the configured backend.
 *
 * This lookup is the entire cost of switching between a hosted gateway and a
 * self-hosted inference server: one environment variable, no application change. That
 * is the property the port exists to preserve - see docs/adr/0018.
 *
 * @param {string} name
 * @returns {import('./types.js').EmbeddingsProvider}
 * @throws {ConfigurationError} If the name is not one we implement.
 */
export function selectProvider(name) {
  const provider = PROVIDERS[name];

  if (provider === undefined) {
    throw new ConfigurationError(`Unknown embeddings provider: ${name}`, {
      details: { known: PROVIDER_NAMES, remediation: 'set EMBEDDING_PROVIDER to a known value' },
    });
  }

  return provider;
}
