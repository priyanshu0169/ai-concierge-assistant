/**
 * The internal seam that makes the embedding backend a configuration choice.
 *
 * `EmbeddingsClient` - the port every caller sees - does not change when the backend
 * does. Batching, ordering, input validation, dimension verification, retries and
 * logging all live above this line and are shared. A provider supplies only the four
 * things that genuinely differ between an OpenAI-compatible endpoint and a self-hosted
 * inference server: the request shape, how to read vectors out of the response, what a
 * status code means, and how to prove the service is usable.
 *
 * Adding a backend is a new file here plus a registry entry. It is not a change to
 * anything that calls `embedQuery`.
 */

/**
 * @typedef {object} EmbedHttpRequest
 * @property {string} url
 * @property {Record<string, string>} headers
 * @property {unknown} body
 */

/**
 * @typedef {object} EmbeddingsProvider
 * @property {string} name
 * @property {(input: {
 *   settings: import('../client-options.js').EmbeddingsSettings,
 *   inputs: string[],
 * }) => EmbedHttpRequest} embedRequest
 * @property {(body: unknown) => number[][]} readEmbeddings Order-preserving. Envelope shape only -
 *   count and dimension checks stay shared, because those rules are the same whoever answered.
 * @property {(input: {
 *   response: Response,
 *   settings: import('../client-options.js').EmbeddingsSettings,
 * }) => Promise<import('@shopsage/platform').AppError>} mapError
 * @property {(input: {
 *   settings: import('../client-options.js').EmbeddingsSettings,
 *   fetchImpl: typeof fetch,
 * }) => Promise<import('../types.js').EmbeddingsHealth>} health
 */

export {};
