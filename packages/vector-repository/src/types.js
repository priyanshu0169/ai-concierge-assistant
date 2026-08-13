/**
 * The `VectorRepository` port.
 *
 * Every type here is a ShopSage shape. No Qdrant client, filter, point struct or
 * scored point crosses this boundary - see docs/adr/0006. The test of the
 * abstraction is simple: nothing in this file would need to change to put a
 * different vector database behind it.
 */

/**
 * Metadata stored alongside a vector.
 *
 * `siteId` is **required**, and that is a correctness constraint rather than
 * bookkeeping: it is the only thing keeping one store's answers out of another
 * store's assistant.
 *
 * @typedef {{ siteId: string } & Record<string, unknown>} VectorPayload
 */

/**
 * A vector and its metadata.
 *
 * `id` is any non-empty string - a content hash is the expected choice, since it
 * makes re-ingestion idempotent. Whatever id format the underlying store demands
 * is the adapter's problem, not the caller's.
 *
 * @typedef {object} VectorPoint
 * @property {string} id
 * @property {number[]} vector
 * @property {VectorPayload} payload
 */

/**
 * Declarative filter: payload keys matched for equality. The adapter translates it
 * into the store's own language.
 *
 * Open rather than a closed list of fields. What is worth filtering on is decided by
 * whoever wrote the payload - ingestion filters by `documentId` and `sourceId`,
 * retrieval by `contentType` - and enumerating those here would mean this package
 * knowing another package's schema. The named entries below are documentation of the
 * common ones, not a restriction.
 *
 * @typedef {{
 *   siteId?: string,
 *   contentType?: string,
 *   sourceId?: string,
 *   documentId?: string,
 * } & Record<string, string | undefined>} VectorFilter
 */

/**
 * A similarity search.
 *
 * `siteId` is a **required top-level field**, not an optional filter entry. That
 * placement is the whole design: tenancy cannot be forgotten if it cannot be
 * omitted, and a missing tenant filter is not a slow query - it is one store
 * answering from another store's content.
 *
 * @typedef {object} VectorSearchQuery
 * @property {number[]} vector
 * @property {string} siteId
 * @property {number} [topK] Default 6.
 * @property {number} [minScore] Similarity floor. Below it, results are dropped.
 * @property {Omit<VectorFilter, 'siteId'>} [filter] Additional narrowing.
 */

/**
 * @typedef {object} VectorMatch
 * @property {string} id The id originally supplied to `insert`.
 * @property {number} score Similarity, higher is closer.
 * @property {VectorPayload} payload
 */

/**
 * Enumerate stored points without a query vector.
 *
 * Exists for one job: letting ingestion discover what it already stored, so an
 * unchanged chunk is skipped rather than re-embedded. Embedding is the expensive
 * step - metered, on the hosted backend - so "what is already here?" is the
 * question that makes re-ingestion cheap.
 *
 * Cursor-paginated rather than returning everything: a source can hold tens of
 * thousands of chunks, and a method that must materialise all of them to answer
 * would be unusable exactly when it matters.
 *
 * @typedef {object} VectorListQuery
 * @property {string} siteId Required, as everywhere.
 * @property {Omit<VectorFilter, 'siteId'>} [filter]
 * @property {number} [limit] Page size. Default 256.
 * @property {string} [cursor] Opaque; from a previous page.
 */

/**
 * @typedef {object} VectorPage
 * @property {{ id: string, payload: VectorPayload }[]} points No vectors - callers
 *   enumerating state never need them, and shipping them would dominate the response.
 * @property {string} [cursor] Absent on the last page.
 */

/**
 * Exactly one of `ids` or `filter` must be given.
 *
 * A filtered delete requires `siteId`, so "delete this store's content" cannot
 * become "delete everything" through an omitted field.
 *
 * @typedef {{ ids: string[], filter?: never }
 *   | { filter: VectorFilter & { siteId: string }, ids?: never }} VectorDeleteCriteria
 */

/**
 * @typedef {object} VectorRepository
 * @property {() => Promise<void>} createCollection Idempotent.
 * @property {() => Promise<boolean>} collectionExists
 * @property {(points: VectorPoint[]) => Promise<void>} insert Upsert by id.
 * @property {(query: VectorSearchQuery) => Promise<VectorMatch[]>} search
 * @property {(query: VectorListQuery) => Promise<VectorPage>} list Enumerate stored state.
 * @property {(criteria: VectorDeleteCriteria) => Promise<void>} delete
 * @property {(filter?: VectorFilter) => Promise<number>} count
 * @property {() => Promise<void>} health Throws if the store is unusable.
 */

/**
 * @typedef {object} QdrantRepositoryOptions
 * @property {string} url Base URL of the Qdrant instance.
 * @property {string} collection Collection name.
 * @property {number} dimensions Vector length. Must match the embedding model.
 * @property {string} [apiKey] Sent as the `api-key` header when present.
 * @property {number} [timeoutMs] Per-attempt budget. Default 10000.
 * @property {number} [maxAttempts] Total attempts including the first. Default 3.
 * @property {import('@shopsage/platform').Logger} [logger]
 * @property {typeof fetch} [fetchImpl] Injection seam for tests.
 * @property {(ms: number) => Promise<void>} [sleep] Injection seam for tests.
 * @property {() => number} [random] Injection seam for tests.
 */

export {};
