/**
 * The published contract of `@shopsage/embeddings-client`.
 *
 * A vector is a `number[]`. Nothing here mentions HTTP, a provider, batching or
 * truncation - those are this package's problems, and a caller that learned about them
 * would be coupled to whichever backend happens to be configured today.
 */

/**
 * @typedef {object} EmbeddingsHealth
 * @property {string} model The model the service reports, or the one configured when
 *   the backend cannot report it.
 * @property {number} maxInputTokens Longest input accepted, or `0` when unknown - a
 *   hosted endpoint does not publish one, so chunking cannot be sized from it.
 */

/**
 * Embedding generation.
 *
 * The two methods are deliberately asymmetric, and it is not an oversight:
 *
 * - `embedQuery` is **latency critical** and single-item. A customer is waiting, and
 *   with some models it also needs an instruction prefix that documents do not get -
 *   embedding a question exactly like a document measurably degrades retrieval on the
 *   models trained that way.
 * - `embedDocuments` is **throughput critical** and batched. Nobody is waiting, and
 *   every backend is far more efficient per item in batches.
 *
 * Collapsing them into one `embed(texts)` would force every caller to decide which
 * regime it is in, and they would get it wrong.
 *
 * @typedef {object} EmbeddingsClient
 * @property {(text: string) => Promise<number[]>} embedQuery
 * @property {(texts: string[]) => Promise<number[][]>} embedDocuments Order-preserving.
 * @property {() => Promise<EmbeddingsHealth>} health Throws if unusable.
 */

/**
 * @typedef {object} EmbeddingsClientOptions
 * @property {string} [provider] `openai` (any compatible endpoint) or `tei`
 *   (self-hosted HuggingFace). Default `openai`.
 * @property {string} baseUrl API base of the embeddings service.
 * @property {string} [apiKey] Omitted for a self-hosted service on a private network.
 * @property {'bearer' | 'api-key'} [authStyle] Default `bearer`; `api-key` for Azure.
 * @property {string} model
 * @property {number} dimensions Expected vector length. Every response is verified.
 * @property {number} [batchSize] Documents per request. Default 16.
 * @property {number} [timeoutMs] Per-attempt budget. Default 30000.
 * @property {number} [maxAttempts] Total attempts including the first. Default 3.
 * @property {string} [queryPrefix] Instruction prepended to queries only. Default none.
 * @property {import('@shopsage/platform').Logger} [logger]
 * @property {typeof fetch} [fetchImpl] Injection seam for tests.
 * @property {(ms: number) => Promise<void>} [sleep] Injection seam for tests.
 * @property {() => number} [random] Injection seam for tests.
 */

export {};
