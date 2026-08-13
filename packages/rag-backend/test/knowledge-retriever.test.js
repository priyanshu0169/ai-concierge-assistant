import assert from 'node:assert/strict';
import { PAYLOAD_KEYS } from '@shopsage/ingestion';
import { describe, it } from 'node:test';
import { createKnowledgeRetriever } from '../src/retrieval/create-knowledge-retriever.js';

/**
 * A store returning whatever payloads a test hands it, recording the query it was given.
 *
 * @param {Record<string, unknown>[]} payloads
 */
function storeReturning(payloads) {
  return {
    calls: /** @type {any[]} */ ([]),
    /** @param {any} query */
    search(query) {
      this.calls.push(query);

      return Promise.resolve(
        payloads.map((payload, index) => ({
          id: `doc_1#${index}`,
          score: 0.7 - index * 0.01,
          payload: { siteId: 'demo-store', ...payload },
        })),
      );
    },
  };
}

const embeddings = { embedQuery: () => Promise.resolve(Array.from({ length: 8 }, () => 0.1)) };

/** @param {Record<string, unknown>[]} payloads */
function retrieverOver(payloads) {
  return createKnowledgeRetriever({
    embeddings: /** @type {any} */ (embeddings),
    store: /** @type {any} */ (storeReturning(payloads)),
  });
}

const query = { text: 'what caviar do you sell', siteId: 'demo-store', topK: 6, minScore: 0.35 };

describe('createKnowledgeRetriever', () => {
  it('masks prices before a chunk leaves the retrieval boundary', async () => {
    // The regression this pins is a real one, found by asking a live deployment "how much does
    // Osetra cost right now?". The commerce connector was down, the model fell back to knowledge,
    // and answered "starting from $95" - a figure read off a page indexed days earlier, presented
    // as current, in the store's voice. Three separate instructions forbidding exactly that were
    // already in the prompt.
    //
    // The guarantee has to be that no price reaches the domain at all, so this asserts on what
    // crosses the boundary rather than on what a model does with it.
    const retriever = retrieverOver([
      { [PAYLOAD_KEYS.TEXT]: 'Osetra FROM $95', [PAYLOAD_KEYS.TITLE]: 'Osetra' },
      { [PAYLOAD_KEYS.TEXT]: 'Caviar Butter $68', [PAYLOAD_KEYS.TITLE]: 'Butter $68' },
    ]);

    const chunks = await retriever.retrieve(query);

    for (const chunk of chunks) {
      assert.doesNotMatch(chunk.text, /\$\s?\d/u, `price leaked in text: ${chunk.text}`);
      assert.doesNotMatch(chunk.title, /\$\s?\d/u, `price leaked in title: ${chunk.title}`);
    }
  });

  it('keeps the descriptive content the corpus exists to provide', async () => {
    const retriever = retrieverOver([
      {
        [PAYLOAD_KEYS.TEXT]: 'Beluga has large pearls and a buttery flavour. FROM $280',
        [PAYLOAD_KEYS.TITLE]: 'Beluga',
      },
    ]);

    const [chunk] = await retriever.retrieve(query);

    assert.match(chunk.text, /large pearls and a buttery flavour/u);
    assert.match(chunk.text, /\[price not shown\]/u);
  });

  it('still maps every field a citation needs', async () => {
    const retriever = retrieverOver([
      {
        [PAYLOAD_KEYS.TEXT]: 'Osetra caviar description.',
        [PAYLOAD_KEYS.TITLE]: 'Osetra',
        [PAYLOAD_KEYS.URL]: 'https://example.test/osetra',
        [PAYLOAD_KEYS.CONTENT_TYPE]: 'page',
      },
    ]);

    const [chunk] = await retriever.retrieve(query);

    assert.equal(chunk.url, 'https://example.test/osetra');
    assert.equal(chunk.contentType, 'page');
    assert.equal(chunk.title, 'Osetra');
    assert.equal(chunk.id, 'doc_1#0');
  });

  it('passes the tenant and the score floor through to the store', async () => {
    const store = storeReturning([{ [PAYLOAD_KEYS.TEXT]: 'x', [PAYLOAD_KEYS.TITLE]: 'y' }]);
    const retriever = createKnowledgeRetriever({
      embeddings: /** @type {any} */ (embeddings),
      store: /** @type {any} */ (store),
    });

    await retriever.retrieve(query);

    assert.equal(store.calls[0].siteId, 'demo-store');
    assert.equal(store.calls[0].minScore, 0.35);
    assert.equal(store.calls[0].topK, 6);
  });
});
