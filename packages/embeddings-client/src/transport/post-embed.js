import { UpstreamError, readJsonBody, sendRequest, withRetry } from '@shopsage/platform';

/**
 * @typedef {object} EmbedRequestInput
 * @property {import('../client-options.js').EmbeddingsSettings} settings
 * @property {import('../providers/types.js').EmbeddingsProvider} provider
 * @property {string[]} inputs
 * @property {import('@shopsage/platform').Logger} [logger]
 * @property {typeof fetch} fetchImpl
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [random]
 */

/**
 * Embed a batch, with retries, whichever backend is configured.
 *
 * Everything here is provider-neutral: the retry policy, the correlation logging, and
 * the shape checks below. The provider supplies only the request, the extraction and
 * the status semantics, so a new backend inherits all of this rather than
 * reimplementing it slightly differently.
 *
 * @param {EmbedRequestInput} input
 * @returns {Promise<number[][]>}
 */
export function postEmbed(input) {
  const { settings, provider, inputs, logger, sleep, random } = input;

  return withRetry(() => embedOnce(input), {
    maxAttempts: settings.maxAttempts,
    sleep,
    random,
    onRetry: (notice) =>
      logger?.warn('embeddings request failed, retrying', {
        provider: provider.name,
        attempt: notice.attempt,
        delayMs: notice.delayMs,
        batchSize: inputs.length,
        err: notice.error,
      }),
  });
}

/**
 * @param {EmbedRequestInput} input
 * @returns {Promise<number[][]>}
 */
async function embedOnce(input) {
  const { settings, provider, inputs, fetchImpl } = input;
  const request = provider.embedRequest({ settings, inputs });

  const response = await sendRequest({
    url: request.url,
    method: 'POST',
    headers: request.headers,
    body: request.body,
    timeoutMs: settings.timeoutMs,
    label: 'Embeddings request',
    fetchImpl,
  });

  if (!response.ok) throw await provider.mapError({ response, settings });

  const vectors = provider.readEmbeddings(await readJsonBody(response, 'Embeddings service'));

  return assertShape(vectors, { expectedCount: inputs.length, dimensions: settings.dimensions });
}

/**
 * Verify the shape of what came back before anything is stored.
 *
 * Shared across providers deliberately: these are the rules that protect the corpus,
 * and they must not be able to differ by backend.
 *
 * The dimension check is the important one. A vector of the wrong length either fails
 * at the vector store or, worse, is accepted into a collection built for a different
 * model - and mixed vector spaces produce similarity scores that look entirely
 * plausible and mean nothing. Checking every response makes a model swap a loud failure
 * instead of a slow corruption.
 *
 * @param {number[][]} vectors
 * @param {{ expectedCount: number, dimensions: number }} expected
 * @returns {number[][]}
 */
function assertShape(vectors, expected) {
  if (vectors.length !== expected.expectedCount) {
    throw new UpstreamError('Embeddings service returned an unexpected number of vectors', {
      retryable: false,
      details: { expected: expected.expectedCount, received: vectors.length },
    });
  }

  for (const vector of vectors) {
    if (vector.length !== expected.dimensions) {
      throw new UpstreamError('Embeddings service returned a vector of the wrong dimension', {
        retryable: false,
        details: {
          expectedDimensions: expected.dimensions,
          receivedDimensions: vector.length,
          remediation: 'EMBEDDING_DIMENSIONS must match EMBEDDING_MODEL',
        },
      });
    }
  }

  return vectors;
}
