/**
 * @shopsage/embeddings-client - embedding generation, backend-agnostic.
 *
 * Two backends ship, chosen by `EMBEDDING_PROVIDER`:
 *
 * - `openai` — any endpoint speaking the OpenAI embeddings wire format: an internal AI
 *   gateway, LiteLLM, Azure OpenAI, OpenAI itself.
 * - `tei` — a self-hosted HuggingFace Text Embeddings Inference server.
 *
 * The port does not change between them, and nothing above this package can tell which
 * one answered. Moving from a hosted gateway to self-hosted inference, or back, is an
 * environment change plus a re-ingestion - never an application change. That property
 * is the reason the seam exists; see docs/adr/0018.
 */

export { createEmbeddingsClient } from './create-embeddings-client.js';
export { PROVIDER_NAMES } from './providers/index.js';

/**
 * @typedef {import('./types.js').EmbeddingsClient} EmbeddingsClient
 * @typedef {import('./types.js').EmbeddingsClientOptions} EmbeddingsClientOptions
 * @typedef {import('./types.js').EmbeddingsHealth} EmbeddingsHealth
 */
