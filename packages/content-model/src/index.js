/**
 * @shopsage/content-model - the `ContentSource` port and the canonical `Document`.
 *
 * A contract with no implementation, and that is the point. The scraper produces
 * documents and the ingestion pipeline consumes them; if the contract lived in
 * either, the other would have to depend on it. Both depend on this instead, so a
 * new source kind - a PDF reader, Magento CMS blocks, a help-desk export - is a new
 * package that touches neither, and none of their dependencies leak in here.
 *
 * See docs/adr/0016.
 */

export { CONTENT_TYPES, CONTENT_TYPE_VALUES, isContentType } from './content-types.js';
export { createDocument } from './create-document.js';
export { normalizeLine, normalizeText } from './normalize-text.js';
export { scrubCharacters } from './scrub-characters.js';
export { createSourceRegistry } from './source-registry.js';

/**
 * @typedef {import('./types.js').ContentSource} ContentSource
 * @typedef {import('./types.js').ContentSourceFactory} ContentSourceFactory
 * @typedef {import('./types.js').ContentType} ContentType
 * @typedef {import('./types.js').Document} Document
 * @typedef {import('./types.js').DocumentDraft} DocumentDraft
 * @typedef {import('./types.js').DocumentMetadata} DocumentMetadata
 * @typedef {import('./types.js').SourceStats} SourceStats
 * @typedef {import('./source-registry.js').SourceRegistry} SourceRegistry
 */
