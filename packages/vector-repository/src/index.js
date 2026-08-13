/**
 * @shopsage/vector-repository - vector storage behind a port.
 *
 * The exported factory names Qdrant; nothing it returns does. Callers depend on
 * `VectorRepository` from `types.js`, which mentions no store-specific concept -
 * no filter language, no id format, no distance metric, no point struct.
 *
 * Two properties are enforced rather than documented, because both are
 * correctness rather than style:
 *
 * - **`siteId` is required on search and on every stored payload.** One shared
 *   collection serves every store, so a missing tenant filter is not a slow
 *   query - it is one store's assistant answering from another store's content.
 * - **A filtered delete requires `siteId`.** A vector store has no undo.
 *
 * See docs/adr/0006.
 */

export { createQdrantRepository } from './qdrant/create-qdrant-repository.js';

/**
 * @typedef {import('./types.js').VectorRepository} VectorRepository
 * @typedef {import('./types.js').VectorPoint} VectorPoint
 * @typedef {import('./types.js').VectorPayload} VectorPayload
 * @typedef {import('./types.js').VectorFilter} VectorFilter
 * @typedef {import('./types.js').VectorSearchQuery} VectorSearchQuery
 * @typedef {import('./types.js').VectorMatch} VectorMatch
 * @typedef {import('./types.js').VectorDeleteCriteria} VectorDeleteCriteria
 * @typedef {import('./types.js').QdrantRepositoryOptions} QdrantRepositoryOptions
 */
