/**
 * The `ContentSource` port and the canonical `Document`.
 *
 * This package holds a contract and no implementation. That is deliberate: the
 * scraper produces documents and the ingestion pipeline consumes them, and if the
 * contract lived in either one the other would have to depend on it. Both depend
 * on this instead, so a new source kind - a PDF reader, Magento CMS blocks, a help
 * desk export - is a new package that touches neither.
 */

/**
 * What a document *is*, for retrieval purposes.
 *
 * A closed set, because it is a retrieval filter and a facet the assistant may
 * reason about; an open string would accumulate near-duplicates (`policy`,
 * `policies`, `Policy`) that quietly fragment filtering. `other` is the escape
 * hatch for a source that genuinely does not know.
 *
 * @typedef {'page' | 'faq' | 'guide' | 'policy' | 'blog' | 'other'} ContentType
 */

/**
 * Extra facts about a document, as scalars only.
 *
 * Scalars because this travels into a vector store payload, where a nested object
 * graph is not filterable and not size-bounded. A source that wants to record
 * structure should flatten it.
 *
 * @typedef {Record<string, string | number | boolean>} DocumentMetadata
 */

/**
 * One unit of ingestible content, in the shape every source must produce.
 *
 * The invariants worth knowing:
 *
 * - **`id` is derived, never supplied.** It is a hash of
 *   `siteId + sourceId + reference`, so it is stable across runs (which is what
 *   makes re-ingestion an upsert rather than a duplication) and cannot collide
 *   between two sources that happen to use the same reference.
 * - **`reference` identifies the document within its source**, and is the only
 *   locator every source can supply: a URL for a website, a path for a file, a
 *   block id for a CMS. `url` is separate and optional, because it means
 *   something stronger - a place a customer can be sent.
 * - **`text` preserves heading structure** as Markdown ATX lines. Flattening to
 *   featureless prose would make the structure-aware chunking planned for Stage 5
 *   impossible, and structure is the difference between a chunk that contains a
 *   return window and one that contains only its conditions.
 * - **`contentHash` covers title and text, nothing else.** Not `retrievedAt`,
 *   which would change on every crawl and defeat the point.
 *
 * @typedef {object} Document
 * @property {string} id Derived. Stable across runs, unique across sources.
 * @property {string} siteId Tenant. Never optional - see docs/adr/0006.
 * @property {string} sourceId Which configured source produced this.
 * @property {string} sourceType The kind of source, e.g. `website`.
 * @property {ContentType} contentType
 * @property {string} reference Opaque, source-scoped locator.
 * @property {string} [url] Customer-facing citable location, when one exists.
 * @property {string} title
 * @property {string} text Normalized, with headings preserved as `## ` lines.
 * @property {string} contentHash Of title and text. Drives idempotent re-ingestion.
 * @property {string} [locale] BCP 47, when the source knows it.
 * @property {string} retrievedAt ISO 8601.
 * @property {DocumentMetadata} metadata
 */

/**
 * Everything needed to build a `Document`; `id` and `contentHash` are computed.
 *
 * @typedef {object} DocumentDraft
 * @property {string} siteId
 * @property {string} sourceId
 * @property {string} sourceType
 * @property {ContentType} [contentType] Default `page`.
 * @property {string} reference
 * @property {string} [url]
 * @property {string} title
 * @property {string} text
 * @property {string} [locale]
 * @property {string} [retrievedAt] Default: now.
 * @property {DocumentMetadata} [metadata]
 */

/**
 * What a run produced. Read after iteration completes.
 *
 * @typedef {object} SourceStats
 * @property {number} emitted Documents yielded.
 * @property {number} skipped Deliberately not emitted - filtered, excluded, empty.
 * @property {number} failed Attempted and errored.
 */

/**
 * A producer of documents.
 *
 * `fetch()` is an **async iterable**, not a promise of an array. A crawl of a few
 * hundred pages should not be buffered in memory before ingestion can start, and
 * streaming lets the pipeline embed and store incrementally - so a run that fails
 * at page 400 has still made 399 pages' worth of progress, and progress is
 * reportable while it happens.
 *
 * A per-document failure is **counted and logged, never thrown**. One unreachable
 * page must not abandon a five-hundred-page crawl. Failures that are the run's
 * fault rather than a document's - an unreadable robots.txt, a start URL that does
 * not resolve - do throw, because continuing would silently produce a partial
 * corpus that looks complete.
 *
 * @typedef {object} ContentSource
 * @property {string} id
 * @property {string} type
 * @property {(options?: { signal?: AbortSignal }) => AsyncIterable<Document>} fetch
 * @property {() => SourceStats} stats
 */

/**
 * Builds a `ContentSource` from its site-profile entry.
 *
 * @typedef {(input: {
 *   config: Record<string, any>,
 *   siteId: string,
 *   logger?: import('@shopsage/platform').Logger,
 *   fetchImpl?: typeof fetch,
 * }) => ContentSource} ContentSourceFactory
 */

export {};
