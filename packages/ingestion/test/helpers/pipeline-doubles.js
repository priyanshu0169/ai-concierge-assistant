import { createDocument } from '@shopsage/content-model';
import { parseSiteProfile } from '@shopsage/platform';

export const TEST_DIMENSIONS = 4;

/**
 * Build a site profile through the **real** parser.
 *
 * A hand-written object would drift from the schema and skip the defaults - and the
 * defaults are where most of the chunker's behaviour comes from.
 *
 * @param {Record<string, unknown>} [ingestion]
 * @returns {import('@shopsage/platform').SiteProfile}
 */
export function testProfile(ingestion = {}) {
  return parseSiteProfile({
    identity: { siteId: 'demo-store', companyName: 'Demo', assistantName: 'Sage' },
    prompts: {
      systemPrompt: 'You are a helpful shopping assistant for this store.',
      welcomeMessage: 'Hi.',
      fallbackMessage: 'Oops.',
      noAnswerMessage: 'Not found.',
    },
    integrations: { backendUrl: 'https://assistant.example.com' },
    ingestion,
  });
}

/**
 * @param {Partial<import('@shopsage/content-model').DocumentDraft>} [overrides]
 * @returns {import('@shopsage/content-model').Document}
 */
export function testDocument(overrides = {}) {
  return createDocument({
    siteId: 'demo-store',
    sourceId: 'help-centre',
    sourceType: 'website',
    contentType: 'policy',
    reference: 'https://example.com/help/returns',
    url: 'https://example.com/help/returns',
    title: 'Returns policy',
    text: 'Unopened items may be returned within thirty days of delivery.',
    ...overrides,
  });
}

/**
 * An in-memory `VectorRepository`.
 *
 * A fake rather than a mock: it actually stores points and answers `list` from them,
 * so the idempotency logic is exercised against real behaviour instead of a script
 * that would agree with whatever the code did.
 *
 * @returns {import('@shopsage/vector-repository').VectorRepository & {
 *   points: Map<string, import('@shopsage/vector-repository').VectorPoint>,
 *   pageSize: (size: number) => void,
 * }}
 */
export function createFakeStore() {
  /** @type {Map<string, import('@shopsage/vector-repository').VectorPoint>} */
  const points = new Map();
  let pageSize = 1000;

  const matches = (/** @type {any} */ payload, /** @type {any} */ filter) =>
    Object.entries(filter ?? {}).every(
      ([key, value]) => value === undefined || payload[key] === value,
    );

  return {
    points,
    pageSize: (size) => {
      pageSize = size;
    },

    createCollection: () => Promise.resolve(),
    collectionExists: () => Promise.resolve(true),
    health: () => Promise.resolve(),

    insert(incoming) {
      for (const point of incoming) points.set(point.id, point);
      return Promise.resolve();
    },

    list(query) {
      const all = [...points.values()]
        .filter((point) => matches(point.payload, { siteId: query.siteId, ...query.filter }))
        .sort((left, right) => left.id.localeCompare(right.id));

      const start = query.cursor === undefined ? 0 : all.findIndex((p) => p.id === query.cursor);
      const page = all.slice(start, start + pageSize);
      const next = all[start + pageSize];

      return Promise.resolve({
        points: page.map((point) => ({ id: point.id, payload: point.payload })),
        ...(next === undefined ? {} : { cursor: next.id }),
      });
    },

    delete(criteria) {
      for (const id of criteria.ids ?? []) points.delete(id);

      if (criteria.filter !== undefined) {
        for (const [id, point] of points) {
          if (matches(point.payload, criteria.filter)) points.delete(id);
        }
      }

      return Promise.resolve();
    },

    count: (filter) =>
      Promise.resolve(
        [...points.values()].filter((point) => matches(point.payload, filter)).length,
      ),

    search: () => Promise.resolve([]),
  };
}

/**
 * An embeddings client that counts what it was asked to embed.
 *
 * The count is the assertion that matters: idempotent re-ingestion means the second
 * run embeds nothing, and only a counter can prove it.
 *
 * @returns {import('@shopsage/embeddings-client').EmbeddingsClient & {
 *   embedded: string[],
 *   calls: () => number,
 * }}
 */
export function createFakeEmbeddings() {
  /** @type {string[]} */
  const embedded = [];
  let callCount = 0;

  const vectorFor = (/** @type {string} */ text) =>
    Array.from({ length: TEST_DIMENSIONS }, (_unused, index) => text.length + index);

  return {
    embedded,
    calls: () => callCount,

    embedDocuments(texts) {
      callCount += 1;
      embedded.push(...texts);
      return Promise.resolve(texts.map(vectorFor));
    },

    embedQuery: (text) => Promise.resolve(vectorFor(text)),
    health: () => Promise.resolve({ model: 'fake', maxInputTokens: 0 }),
  };
}

/**
 * A `ContentSource` over a fixed list of documents.
 *
 * @param {import('@shopsage/content-model').Document[]} documents
 * @param {{ failed?: number }} [stats]
 * @returns {import('@shopsage/content-model').ContentSource}
 */
export function createFakeSource(documents, stats = {}) {
  return {
    id: 'help-centre',
    type: 'website',
    stats: () => ({ emitted: documents.length, skipped: 0, failed: stats.failed ?? 0 }),
    async *fetch() {
      for (const document of documents) yield document;
    },
  };
}
