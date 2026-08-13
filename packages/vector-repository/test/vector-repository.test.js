import assert from 'node:assert/strict';
import {
  ConfigurationError,
  ServiceUnavailableError,
  UpstreamError,
  ValidationError,
} from '@shopsage/platform';
import { describe, it } from 'node:test';
import { createQdrantRepository } from '../src/qdrant/create-qdrant-repository.js';
import {
  createFakeQdrant,
  qdrantError,
  qdrantOk,
  testOptions,
  testVector,
} from './helpers/fake-qdrant.js';

/** @param {import('./helpers/fake-qdrant.js').FakeQdrant} store */
const repositoryFor = (store, overrides = {}) =>
  createQdrantRepository(testOptions({ fetchImpl: store.fetchImpl, ...overrides }));

/**
 * @param {Partial<import('../src/types.js').VectorPoint>} [overrides]
 * @returns {import('../src/types.js').VectorPoint}
 */
function testPoint(overrides = {}) {
  return {
    id: 'sha256:abc123',
    vector: testVector(),
    payload: { siteId: 'demo-store', title: 'Returns policy' },
    ...overrides,
  };
}

describe('createQdrantRepository', () => {
  describe('configuration', () => {
    it('refuses a collection name that would corrupt a URL path', () => {
      assert.throws(
        () => createQdrantRepository(testOptions({ collection: 'bad/name' })),
        ConfigurationError,
      );
    });

    it('refuses a non-http URL', () => {
      assert.throws(
        () => createQdrantRepository(testOptions({ url: 'tcp://qdrant' })),
        ConfigurationError,
      );
    });

    it('sends the api key only when one is configured', async () => {
      const withKey = createFakeQdrant({ '/points/count': () => qdrantOk({ count: 0 }) });
      await repositoryFor(withKey, { apiKey: 'secret-key' }).count();
      assert.equal(withKey.calls[0].headers['api-key'], 'secret-key');

      const without = createFakeQdrant({ '/points/count': () => qdrantOk({ count: 0 }) });
      await repositoryFor(without).count();
      assert.ok(!('api-key' in without.calls[0].headers));
    });
  });

  describe('createCollection', () => {
    it('creates the collection with the configured dimension and cosine distance', async () => {
      const store = createFakeQdrant({
        '/index': () => qdrantOk(true),
        'collections/shopsage_test': () => qdrantOk(true),
      });

      await repositoryFor(store).createCollection();

      const create = store.calls[0];
      assert.equal(create.method, 'PUT');
      assert.deepEqual(create.body, { vectors: { size: 4, distance: 'Cosine' } });
    });

    it('indexes siteId, documentId and sourceId, which every query pattern filters on', async () => {
      // siteId: with one shared collection, an unindexed tenant field means every
      // query scans the whole corpus and discards most of it. documentId and
      // sourceId back ingestion's own access patterns - "what do I already hold for
      // this document?" and "what belongs to this source?" - which run on every
      // re-ingestion and every prune.
      const store = createFakeQdrant({
        '/index': () => qdrantOk(true),
        'collections/shopsage_test': () => qdrantOk(true),
      });

      await repositoryFor(store).createCollection();

      const indexes = store.matching('/index');
      assert.deepEqual(
        indexes.map((call) => call.body),
        [
          { field_name: 'siteId', field_schema: 'keyword' },
          { field_name: 'documentId', field_schema: 'keyword' },
          { field_name: 'sourceId', field_schema: 'keyword' },
        ],
      );
      assert.ok(indexes.every((call) => /wait=true/.test(call.url)));
    });

    it('is idempotent, because the ingestion CLI runs repeatedly', async () => {
      const store = createFakeQdrant({
        '/index': () => qdrantError(409, 'index already exists'),
        'collections/shopsage_test': () => qdrantError(409, 'collection already exists'),
      });

      await assert.doesNotReject(() => repositoryFor(store).createCollection());
    });
  });

  describe('collectionExists', () => {
    it('reports true', async () => {
      const store = createFakeQdrant({ '/exists': () => qdrantOk({ exists: true }) });

      assert.equal(await repositoryFor(store).collectionExists(), true);
    });

    it('reports false', async () => {
      const store = createFakeQdrant({ '/exists': () => qdrantOk({ exists: false }) });

      assert.equal(await repositoryFor(store).collectionExists(), false);
    });

    it('treats a 404 as absent rather than as an error', async () => {
      const store = createFakeQdrant({ '/exists': () => qdrantError(404, 'not found') });

      assert.equal(await repositoryFor(store).collectionExists(), false);
    });
  });

  describe('insert', () => {
    it('waits for the write to be visible', async () => {
      // Qdrant indexes asynchronously by default, which would make an ingestion
      // run that counts its own output intermittently wrong.
      const store = createFakeQdrant({ '/points': () => qdrantOk({ operation_id: 1 }) });

      await repositoryFor(store).insert([testPoint()]);

      assert.match(store.calls[0].url, /wait=true/);
      assert.equal(store.calls[0].method, 'PUT');
    });

    it('derives a UUID from a content-hash id, deterministically', async () => {
      // Qdrant accepts only integers and UUIDs. Pushing that onto callers would
      // leak the store's constraint; deriving it keeps re-ingestion idempotent.
      const first = createFakeQdrant({ '/points': () => qdrantOk({}) });
      const second = createFakeQdrant({ '/points': () => qdrantOk({}) });

      await repositoryFor(first).insert([testPoint()]);
      await repositoryFor(second).insert([testPoint()]);

      const id = first.calls[0].body.points[0].id;
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(
        id,
        second.calls[0].body.points[0].id,
        'the same id must always derive the same UUID',
      );
    });

    it('keeps an id that is already a UUID', async () => {
      const store = createFakeQdrant({ '/points': () => qdrantOk({}) });
      const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

      await repositoryFor(store).insert([testPoint({ id: uuid })]);

      assert.equal(store.calls[0].body.points[0].id, uuid);
    });

    it('carries the caller id in the payload so search can give it back', async () => {
      const store = createFakeQdrant({ '/points': () => qdrantOk({}) });

      await repositoryFor(store).insert([testPoint()]);

      assert.equal(store.calls[0].body.points[0].payload._pointId, 'sha256:abc123');
    });

    it('rejects a payload that sets the reserved key', async () => {
      const store = createFakeQdrant({ '/points': () => qdrantOk({}) });

      await assert.rejects(
        () =>
          repositoryFor(store).insert([
            testPoint({ payload: { siteId: 'demo-store', _pointId: 'forged' } }),
          ]),
        ValidationError,
      );
    });

    it('rejects a point with no siteId', async () => {
      // The one constraint keeping stores isolated.
      const store = createFakeQdrant({ '/points': () => qdrantOk({}) });

      await assert.rejects(
        () => repositoryFor(store).insert([testPoint({ payload: /** @type {any} */ ({}) })]),
        ValidationError,
      );
      assert.equal(store.calls.length, 0);
    });

    it('rejects a vector of the wrong width before it reaches the store', async () => {
      const store = createFakeQdrant({ '/points': () => qdrantOk({}) });

      await assert.rejects(
        () => repositoryFor(store).insert([testPoint({ vector: [1, 2] })]),
        ValidationError,
      );
    });

    it('rejects a vector containing NaN', async () => {
      // NaN is accepted happily by a vector store and then poisons every score
      // computed against it.
      const store = createFakeQdrant({ '/points': () => qdrantOk({}) });

      await assert.rejects(
        () => repositoryFor(store).insert([testPoint({ vector: [1, Number.NaN, 3, 4] })]),
        UpstreamError,
      );
    });

    it('rejects a point with no id', async () => {
      const store = createFakeQdrant({ '/points': () => qdrantOk({}) });

      await assert.rejects(
        () => repositoryFor(store).insert([testPoint({ id: '' })]),
        ValidationError,
      );
    });

    it('makes no request for an empty list', async () => {
      const store = createFakeQdrant({ '/points': () => qdrantOk({}) });

      await repositoryFor(store).insert([]);

      assert.equal(store.calls.length, 0);
    });
  });

  describe('search', () => {
    const match = {
      id: 'ignored-uuid',
      score: 0.82,
      payload: { siteId: 'demo-store', title: 'Returns', _pointId: 'sha256:abc123' },
    };

    it('always filters by siteId', async () => {
      // A missing tenant filter is not a slow query - it is one store answering
      // from another store's content.
      const store = createFakeQdrant({ '/points/search': () => qdrantOk([]) });

      await repositoryFor(store).search({ vector: testVector(), siteId: 'demo-store' });

      assert.deepEqual(store.calls[0].body.filter, {
        must: [{ key: 'siteId', match: { value: 'demo-store' } }],
      });
    });

    it('combines the tenant filter with additional narrowing', async () => {
      const store = createFakeQdrant({ '/points/search': () => qdrantOk([]) });

      await repositoryFor(store).search({
        vector: testVector(),
        siteId: 'demo-store',
        filter: { contentType: 'policy' },
      });

      assert.deepEqual(store.calls[0].body.filter.must, [
        { key: 'contentType', match: { value: 'policy' } },
        { key: 'siteId', match: { value: 'demo-store' } },
      ]);
    });

    it('rejects a search with no siteId', async () => {
      const store = createFakeQdrant({ '/points/search': () => qdrantOk([]) });

      await assert.rejects(
        () => repositoryFor(store).search(/** @type {any} */ ({ vector: testVector() })),
        ValidationError,
      );
      assert.equal(store.calls.length, 0);
    });

    it('pushes the score floor down to the store', async () => {
      const store = createFakeQdrant({ '/points/search': () => qdrantOk([]) });

      await repositoryFor(store).search({
        vector: testVector(),
        siteId: 'demo-store',
        topK: 3,
        minScore: 0.4,
      });

      assert.equal(store.calls[0].body.limit, 3);
      assert.equal(store.calls[0].body.score_threshold, 0.4);
      assert.equal(store.calls[0].body.with_payload, true);
    });

    it('defaults topK and omits an absent score floor', async () => {
      const store = createFakeQdrant({ '/points/search': () => qdrantOk([]) });

      await repositoryFor(store).search({ vector: testVector(), siteId: 'demo-store' });

      assert.equal(store.calls[0].body.limit, 6);
      assert.ok(!('score_threshold' in store.calls[0].body));
    });

    it('returns the caller id, not the derived one, and hides the reserved key', async () => {
      const store = createFakeQdrant({ '/points/search': () => qdrantOk([match]) });

      const results = await repositoryFor(store).search({
        vector: testVector(),
        siteId: 'demo-store',
      });

      assert.deepEqual(results, [
        {
          id: 'sha256:abc123',
          score: 0.82,
          payload: { siteId: 'demo-store', title: 'Returns' },
        },
      ]);
    });

    it('returns an empty list when nothing matches', async () => {
      const store = createFakeQdrant({ '/points/search': () => qdrantOk([]) });

      assert.deepEqual(
        await repositoryFor(store).search({ vector: testVector(), siteId: 'demo-store' }),
        [],
      );
    });

    it('leaks no Qdrant concept into a result', async () => {
      const store = createFakeQdrant({
        '/points/search': () => qdrantOk([{ ...match, version: 7, vector: null, shard_key: 'a' }]),
      });

      const [result] = await repositoryFor(store).search({
        vector: testVector(),
        siteId: 'demo-store',
      });

      assert.deepEqual(Object.keys(result).sort(), ['id', 'payload', 'score']);
    });
  });

  describe('list', () => {
    const stored = {
      id: 'ignored-uuid',
      payload: { siteId: 'demo-store', documentId: 'doc_1', _pointId: 'sha256:abc123' },
    };

    it('always filters by siteId', async () => {
      const store = createFakeQdrant({ '/points/scroll': () => qdrantOk({ points: [] }) });

      await repositoryFor(store).list({ siteId: 'demo-store' });

      assert.deepEqual(store.calls[0].body.filter, {
        must: [{ key: 'siteId', match: { value: 'demo-store' } }],
      });
    });

    it('rejects a list with no siteId', async () => {
      const store = createFakeQdrant({ '/points/scroll': () => qdrantOk({ points: [] }) });

      await assert.rejects(
        () => repositoryFor(store).list(/** @type {any} */ ({})),
        ValidationError,
      );
      assert.equal(store.calls.length, 0);
    });

    it('never asks for vectors, which a page of them would dominate', async () => {
      const store = createFakeQdrant({ '/points/scroll': () => qdrantOk({ points: [] }) });

      await repositoryFor(store).list({ siteId: 'demo-store' });

      assert.equal(store.calls[0].body.with_vector, false);
      assert.equal(store.calls[0].body.with_payload, true);
    });

    it('defaults the page size and honours an override', async () => {
      const store = createFakeQdrant({ '/points/scroll': () => qdrantOk({ points: [] }) });

      await repositoryFor(store).list({ siteId: 'demo-store' });
      assert.equal(store.calls[0].body.limit, 256);

      await repositoryFor(store).list({ siteId: 'demo-store', limit: 10 });
      assert.equal(store.calls[1].body.limit, 10);
    });

    it('returns the caller id and hides the reserved key, with no score', async () => {
      const store = createFakeQdrant({ '/points/scroll': () => qdrantOk({ points: [stored] }) });

      const page = await repositoryFor(store).list({ siteId: 'demo-store' });

      assert.deepEqual(page.points, [
        { id: 'sha256:abc123', payload: { siteId: 'demo-store', documentId: 'doc_1' } },
      ]);
    });

    it('carries a cursor forward and omits it on the last page', async () => {
      const store = createFakeQdrant({
        '/points/scroll': () => qdrantOk({ points: [stored], next_page_offset: 'next-uuid' }),
      });

      const page = await repositoryFor(store).list({ siteId: 'demo-store' });
      assert.equal(page.cursor, 'next-uuid');

      await repositoryFor(store).list({ siteId: 'demo-store', cursor: page.cursor });
      assert.equal(store.calls[1].body.offset, 'next-uuid');

      const last = createFakeQdrant({
        '/points/scroll': () => qdrantOk({ points: [stored], next_page_offset: null }),
      });
      assert.equal((await repositoryFor(last).list({ siteId: 'demo-store' })).cursor, undefined);
    });

    it('combines the tenant filter with additional narrowing', async () => {
      const store = createFakeQdrant({ '/points/scroll': () => qdrantOk({ points: [] }) });

      await repositoryFor(store).list({ siteId: 'demo-store', filter: { documentId: 'doc_1' } });

      assert.deepEqual(store.calls[0].body.filter.must, [
        { key: 'documentId', match: { value: 'doc_1' } },
        { key: 'siteId', match: { value: 'demo-store' } },
      ]);
    });
  });

  describe('delete', () => {
    it('deletes by id, deriving the same UUIDs insert used', async () => {
      const store = createFakeQdrant({ '/points/delete': () => qdrantOk({}) });

      await repositoryFor(store).delete({ ids: ['sha256:abc123'] });

      assert.match(store.calls[0].body.points[0], /^[0-9a-f]{8}-/);
      assert.match(store.calls[0].url, /wait=true/);
    });

    it('deletes by filter', async () => {
      const store = createFakeQdrant({ '/points/delete': () => qdrantOk({}) });

      await repositoryFor(store).delete({
        filter: { siteId: 'demo-store', sourceUrl: 'https://x/y' },
      });

      assert.deepEqual(store.calls[0].body.filter.must, [
        { key: 'siteId', match: { value: 'demo-store' } },
        { key: 'sourceUrl', match: { value: 'https://x/y' } },
      ]);
    });

    it('refuses a filtered delete with no siteId, because there is no undo', async () => {
      const store = createFakeQdrant({ '/points/delete': () => qdrantOk({}) });

      await assert.rejects(
        () =>
          repositoryFor(store).delete({ filter: /** @type {any} */ ({ contentType: 'policy' }) }),
        ValidationError,
      );
      assert.equal(store.calls.length, 0);
    });

    it('refuses both ids and filter at once', async () => {
      const store = createFakeQdrant({ '/points/delete': () => qdrantOk({}) });

      await assert.rejects(
        () =>
          repositoryFor(store).delete(
            /** @type {any} */ ({ ids: ['a'], filter: { siteId: 'demo-store' } }),
          ),
        ValidationError,
      );
    });

    it('refuses neither', async () => {
      const store = createFakeQdrant({ '/points/delete': () => qdrantOk({}) });

      await assert.rejects(
        () => repositoryFor(store).delete(/** @type {any} */ ({})),
        ValidationError,
      );
    });

    it('refuses an empty id list, which would otherwise be a silent no-op', async () => {
      const store = createFakeQdrant({ '/points/delete': () => qdrantOk({}) });

      await assert.rejects(() => repositoryFor(store).delete({ ids: [] }), ValidationError);
    });
  });

  describe('count', () => {
    it('counts exactly, since it exists to verify an ingestion run', async () => {
      const store = createFakeQdrant({ '/points/count': () => qdrantOk({ count: 42 }) });

      assert.equal(await repositoryFor(store).count(), 42);
      assert.equal(store.calls[0].body.exact, true);
      assert.equal(store.calls[0].body.filter, undefined);
    });

    it('counts one store', async () => {
      const store = createFakeQdrant({ '/points/count': () => qdrantOk({ count: 7 }) });

      assert.equal(await repositoryFor(store).count({ siteId: 'demo-store' }), 7);
      assert.deepEqual(store.calls[0].body.filter.must, [
        { key: 'siteId', match: { value: 'demo-store' } },
      ]);
    });
  });

  describe('failure handling', () => {
    it('retries a 5xx, which is safe because every operation is idempotent', async () => {
      const store = createFakeQdrant({
        '/points/count': [() => qdrantError(503, 'unavailable'), () => qdrantOk({ count: 3 })],
      });

      assert.equal(await repositoryFor(store).count(), 3);
      assert.equal(store.calls.length, 2);
    });

    it('does not retry a 4xx', async () => {
      const store = createFakeQdrant({ '/points/count': () => qdrantError(400, 'bad request') });

      await assert.rejects(() => repositoryFor(store).count(), UpstreamError);
      assert.equal(store.calls.length, 1);
    });

    it('names the credential on 403', async () => {
      const store = createFakeQdrant({ '/points/count': () => qdrantError(403, 'forbidden') });

      await assert.rejects(
        () => repositoryFor(store).count(),
        (error) => {
          assert.match(
            String(/** @type {UpstreamError} */ (error).details?.remediation),
            /QDRANT_API_KEY/,
          );
          return true;
        },
      );
    });

    it('names the collection on 404', async () => {
      const store = createFakeQdrant({ '/points/search': () => qdrantError(404, 'not found') });

      await assert.rejects(
        () => repositoryFor(store).search({ vector: testVector(), siteId: 'demo-store' }),
        (error) => {
          const details = /** @type {UpstreamError} */ (error).details;
          assert.match(String(details?.remediation), /QDRANT_COLLECTION/);
          return true;
        },
      );
    });

    it('masks its message, so a store hostname never reaches a customer', async () => {
      const store = createFakeQdrant({ '/points/count': () => qdrantError(500) });

      await assert.rejects(
        () => repositoryFor(store).count(),
        (error) => {
          assert.equal(/** @type {UpstreamError} */ (error).expose, false);
          return true;
        },
      );
    });
  });

  describe('health', () => {
    it('uses shard readiness, not mere reachability', async () => {
      const store = createFakeQdrant({ '/readyz': () => new Response('all shards are ready') });

      await assert.doesNotReject(() => repositoryFor(store).health());
      assert.match(store.calls[0].url, /\/readyz$/);
    });

    it('fails when shards are not ready', async () => {
      const store = createFakeQdrant({
        '/readyz': () => new Response('not ready', { status: 503 }),
      });

      await assert.rejects(() => repositoryFor(store).health(), ServiceUnavailableError);
    });

    it('does not require the collection to exist', async () => {
      // A missing collection is the correct state before the first ingestion run.
      // Failing readiness on it would mean a fresh deployment could never become
      // ready enough to be ingested into.
      const store = createFakeQdrant({ '/readyz': () => new Response('ready') });

      await repositoryFor(store).health();

      assert.equal(store.matching('/exists').length, 0);
    });
  });
});
