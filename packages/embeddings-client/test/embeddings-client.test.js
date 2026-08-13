import assert from 'node:assert/strict';
import {
  ConfigurationError,
  ServiceUnavailableError,
  TimeoutError,
  UpstreamError,
  ValidationError,
} from '@shopsage/platform';
import { describe, it } from 'node:test';
import { createEmbeddingsClient } from '../src/create-embeddings-client.js';
import {
  TEST_API_KEY,
  TEST_DIMENSIONS,
  createFakeEmbeddings,
  createRecordingLogger,
  echoTei,
  jsonResponse,
  openAiOptions,
  teiOptions,
  textResponse,
  vectorFor,
} from './helpers/fake-embeddings.js';

describe('createEmbeddingsClient', () => {
  describe('the port is the same whichever backend answers', () => {
    it('returns identical vectors from both providers', async () => {
      // The property the whole seam exists for: swapping the backend changes nothing a
      // caller can observe.
      const hosted = createFakeEmbeddings();
      const selfHosted = createFakeEmbeddings({ embed: echoTei });

      const fromHosted = await createEmbeddingsClient(
        openAiOptions({ fetchImpl: hosted.fetchImpl }),
      ).embedQuery('returns');
      const fromSelfHosted = await createEmbeddingsClient(
        teiOptions({ fetchImpl: selfHosted.fetchImpl }),
      ).embedQuery('returns');

      assert.deepEqual(fromHosted, vectorFor('returns'));
      assert.deepEqual(fromSelfHosted, fromHosted);
    });

    it('exposes the same three methods regardless of provider', () => {
      const surface = (/** @type {any} */ options) =>
        Object.keys(createEmbeddingsClient(options)).sort();

      assert.deepEqual(surface(openAiOptions()), ['embedDocuments', 'embedQuery', 'health']);
      assert.deepEqual(surface(teiOptions()), ['embedDocuments', 'embedQuery', 'health']);
    });

    it('rejects an unknown provider by name, at construction', () => {
      assert.throws(
        () => createEmbeddingsClient(openAiOptions({ provider: 'telepathy' })),
        ConfigurationError,
      );
    });

    it('defaults to the hosted provider', async () => {
      const gateway = createFakeEmbeddings();
      const options = openAiOptions({ fetchImpl: gateway.fetchImpl });
      delete options.provider;

      await createEmbeddingsClient(options).embedQuery('hello');

      assert.match(gateway.requests[0].url, /\/embeddings$/);
    });
  });

  describe('the OpenAI wire format', () => {
    it('posts to /embeddings on the configured base, preserving its path', async () => {
      const gateway = createFakeEmbeddings();

      await createEmbeddingsClient(openAiOptions({ fetchImpl: gateway.fetchImpl })).embedQuery('x');

      assert.equal(gateway.requests[0].url, 'https://gateway.test/v1/embeddings');
      assert.equal(gateway.requests[0].method, 'POST');
    });

    it('sends a bearer credential', async () => {
      const gateway = createFakeEmbeddings();

      await createEmbeddingsClient(openAiOptions({ fetchImpl: gateway.fetchImpl })).embedQuery('x');

      assert.equal(gateway.requests[0].headers.authorization, `Bearer ${TEST_API_KEY}`);
    });

    it('uses the api-key header when configured for Azure', async () => {
      const gateway = createFakeEmbeddings();

      await createEmbeddingsClient(
        openAiOptions({ fetchImpl: gateway.fetchImpl, authStyle: 'api-key' }),
      ).embedQuery('x');

      assert.equal(gateway.requests[0].headers['api-key'], TEST_API_KEY);
      assert.equal(gateway.requests[0].headers.authorization, undefined);
    });

    it('sends no credential header when none is configured', async () => {
      const gateway = createFakeEmbeddings();
      const options = openAiOptions({ fetchImpl: gateway.fetchImpl });
      delete options.apiKey;

      await createEmbeddingsClient(options).embedQuery('x');

      assert.equal(gateway.requests[0].headers.authorization, undefined);
    });

    it('asks for float encoding explicitly', async () => {
      // Some gateways default to base64, which arrives as strings and fails the
      // dimension check with a baffling message.
      const gateway = createFakeEmbeddings();

      await createEmbeddingsClient(openAiOptions({ fetchImpl: gateway.fetchImpl })).embedQuery('x');

      assert.equal(gateway.requests[0].body.encoding_format, 'float');
      assert.equal(gateway.requests[0].body.model, 'text-embedding-3-small');
    });

    it('re-orders results by the index the provider assigned', async () => {
      // The fake returns data reversed. Response order is not promised, and `index`
      // exists precisely so a caller need not trust it - a silently reordered batch
      // would attach every vector to the wrong chunk.
      const gateway = createFakeEmbeddings();
      const texts = ['a', 'bb', 'ccc'];

      const vectors = await createEmbeddingsClient(
        openAiOptions({ fetchImpl: gateway.fetchImpl }),
      ).embedDocuments(texts);

      assert.deepEqual(vectors, texts.map(vectorFor));
    });
  });

  describe('the self-hosted wire format', () => {
    it('posts to /embed and asks for normalized, truncated vectors', async () => {
      const service = createFakeEmbeddings({ embed: echoTei });

      await createEmbeddingsClient(teiOptions({ fetchImpl: service.fetchImpl })).embedQuery('x');

      assert.equal(service.requests[0].url, 'http://tei.test/embed');
      assert.equal(service.requests[0].body.normalize, true);
      assert.equal(service.requests[0].body.truncate, true);
    });

    it('sends no credential, because a private service has none', async () => {
      const service = createFakeEmbeddings({ embed: echoTei });

      await createEmbeddingsClient(teiOptions({ fetchImpl: service.fetchImpl })).embedQuery('x');

      assert.equal(service.requests[0].headers.authorization, undefined);
    });
  });

  describe('batching and ordering', () => {
    it('preserves order across batches', async () => {
      const gateway = createFakeEmbeddings();
      const texts = ['a', 'bb', 'ccc', 'dddd', 'eeeee'];

      const vectors = await createEmbeddingsClient(
        openAiOptions({ fetchImpl: gateway.fetchImpl, batchSize: 2 }),
      ).embedDocuments(texts);

      assert.deepEqual(vectors, texts.map(vectorFor));
    });

    it('splits into batches of the configured size', async () => {
      const gateway = createFakeEmbeddings();

      await createEmbeddingsClient(
        openAiOptions({ fetchImpl: gateway.fetchImpl, batchSize: 2 }),
      ).embedDocuments(['a', 'bb', 'ccc', 'dddd', 'eeeee']);

      assert.deepEqual(gateway.batchesSeen(), [['a', 'bb'], ['ccc', 'dddd'], ['eeeee']]);
    });

    it('makes no request at all for an empty list', async () => {
      // Matters more now that a request may be billable.
      const gateway = createFakeEmbeddings();
      const client = createEmbeddingsClient(openAiOptions({ fetchImpl: gateway.fetchImpl }));

      assert.deepEqual(await client.embedDocuments([]), []);
      assert.equal(gateway.requests.length, 0);
    });

    it('applies the query prefix to queries only', async () => {
      const gateway = createFakeEmbeddings();
      const client = createEmbeddingsClient(
        openAiOptions({ fetchImpl: gateway.fetchImpl, queryPrefix: 'Query: ' }),
      );

      await client.embedQuery('returns');
      await client.embedDocuments(['policy text']);

      assert.deepEqual(gateway.requests[0].body.input, ['Query: returns']);
      assert.deepEqual(gateway.requests[1].body.input, ['policy text']);
    });

    it('names the offending index when a document is empty', async () => {
      const gateway = createFakeEmbeddings();
      const client = createEmbeddingsClient(openAiOptions({ fetchImpl: gateway.fetchImpl }));

      await assert.rejects(
        () => client.embedDocuments(['fine', '', 'also fine']),
        (error) => {
          assert.ok(error instanceof ValidationError);
          assert.match(error.message, /index 1/);
          return true;
        },
      );

      assert.equal(gateway.requests.length, 0, 'nothing is sent if any input is unusable');
    });

    it('rejects a non-array input as a rejection, not a synchronous throw', async () => {
      const client = createEmbeddingsClient(openAiOptions());

      await assert.rejects(
        () => client.embedDocuments(/** @type {any} */ ('not a list')),
        ValidationError,
      );
    });
  });

  describe('response validation, shared by both providers', () => {
    it('rejects a vector of the wrong dimension', async () => {
      for (const options of [openAiOptions(), teiOptions()]) {
        const backend = createFakeEmbeddings({
          embed: () =>
            options.provider === 'tei'
              ? jsonResponse([[1, 2]])()
              : jsonResponse({ data: [{ index: 0, embedding: [1, 2] }] })(),
        });

        await assert.rejects(
          () =>
            createEmbeddingsClient({ ...options, fetchImpl: backend.fetchImpl }).embedQuery('x'),
          (error) => {
            assert.ok(error instanceof UpstreamError);
            assert.equal(error.retryable, false);
            assert.equal(error.details?.expectedDimensions, TEST_DIMENSIONS);
            assert.match(String(error.details?.remediation), /EMBEDDING_DIMENSIONS/);
            return true;
          },
        );
      }
    });

    it('rejects a response with the wrong number of vectors', async () => {
      const gateway = createFakeEmbeddings({
        embed: () => jsonResponse({ data: [{ index: 0, embedding: vectorFor('a') }] })(),
      });

      await assert.rejects(
        () =>
          createEmbeddingsClient(openAiOptions({ fetchImpl: gateway.fetchImpl })).embedDocuments([
            'a',
            'b',
          ]),
        UpstreamError,
      );
    });

    it('rejects an envelope with no data array', async () => {
      const gateway = createFakeEmbeddings({ embed: () => jsonResponse({ object: 'list' })() });

      await assert.rejects(
        () =>
          createEmbeddingsClient(openAiOptions({ fetchImpl: gateway.fetchImpl })).embedQuery('x'),
        UpstreamError,
      );
    });

    it('rejects a body that is not JSON', async () => {
      const gateway = createFakeEmbeddings({ embed: () => textResponse('<html>', 200)() });

      await assert.rejects(
        () =>
          createEmbeddingsClient(openAiOptions({ fetchImpl: gateway.fetchImpl })).embedQuery('x'),
        UpstreamError,
      );
    });
  });

  describe('failure handling', () => {
    it('retries a 429 and honours Retry-After', async () => {
      /** @type {number[]} */
      const delays = [];
      const gateway = createFakeEmbeddings({
        embed: [
          () => textResponse('slow down', 429, { 'retry-after': '2' })(),
          (body) => jsonResponse({ data: [{ index: 0, embedding: vectorFor(body.input[0]) }] })(),
        ],
      });

      await createEmbeddingsClient(
        openAiOptions({
          fetchImpl: gateway.fetchImpl,
          sleep: (ms) => {
            delays.push(ms);
            return Promise.resolve();
          },
        }),
      ).embedQuery('hello');

      assert.deepEqual(delays, [2000]);
    });

    it('retries a 5xx and an unreachable service', async () => {
      for (const failure of [() => textResponse('boom', 503)(), new TypeError('fetch failed')]) {
        const gateway = createFakeEmbeddings({
          embed: [
            failure,
            (body) => jsonResponse({ data: [{ index: 0, embedding: vectorFor(body.input[0]) }] })(),
          ],
        });

        await createEmbeddingsClient(openAiOptions({ fetchImpl: gateway.fetchImpl })).embedQuery(
          'hello',
        );

        assert.equal(gateway.batchesSeen().length, 2);
      }
    });

    it('does not retry a 400', async () => {
      const gateway = createFakeEmbeddings({ embed: () => textResponse('bad input', 400)() });

      await assert.rejects(
        () =>
          createEmbeddingsClient(openAiOptions({ fetchImpl: gateway.fetchImpl })).embedQuery('x'),
        UpstreamError,
      );
      assert.equal(gateway.batchesSeen().length, 1);
    });

    it('names the model as well as the key on 401', async () => {
      // Gateways answer 401 for a model the key may not use, not 403.
      const gateway = createFakeEmbeddings({ embed: () => textResponse('unauthorized', 401)() });

      await assert.rejects(
        () =>
          createEmbeddingsClient(openAiOptions({ fetchImpl: gateway.fetchImpl })).embedQuery('x'),
        (error) => {
          const remediation = String(/** @type {UpstreamError} */ (error).details?.remediation);
          assert.match(remediation, /EMBEDDING_API_KEY/);
          assert.match(remediation, /EMBEDDING_MODEL/);
          return true;
        },
      );
    });

    it('never lets an echoed credential reach a log record', async () => {
      // Providers quote the key back: OpenAI's 401 body reads "Incorrect API key
      // provided: sk-...". This is now a credentialed client, so the guard matters.
      const { logger, records } = createRecordingLogger();
      const gateway = createFakeEmbeddings({
        embed: [
          () => textResponse(`Incorrect API key provided: ${TEST_API_KEY}`, 500)(),
          (body) => jsonResponse({ data: [{ index: 0, embedding: vectorFor(body.input[0]) }] })(),
        ],
      });

      await createEmbeddingsClient(
        openAiOptions({ fetchImpl: gateway.fetchImpl, logger }),
      ).embedQuery('hello');

      assert.ok(!JSON.stringify(records).includes(TEST_API_KEY));
      assert.ok(JSON.stringify(records).includes('[redacted]'));
    });

    it('does not retry a self-hosted 413, and says which setting to lower', async () => {
      const service = createFakeEmbeddings({
        embed: () => textResponse('Batch size error', 413)(),
      });

      await assert.rejects(
        () => createEmbeddingsClient(teiOptions({ fetchImpl: service.fetchImpl })).embedQuery('x'),
        (error) => {
          assert.equal(/** @type {UpstreamError} */ (error).retryable, false);
          assert.match(
            String(/** @type {UpstreamError} */ (error).details?.remediation),
            /EMBEDDING_BATCH_SIZE/,
          );
          return true;
        },
      );
    });

    it('times out rather than waiting on a wedged backend', async () => {
      const client = createEmbeddingsClient(
        openAiOptions({
          timeoutMs: 20,
          fetchImpl: /** @type {typeof fetch} */ (
            /** @type {unknown} */ (
              (/** @type {string} */ _url, /** @type {RequestInit} */ init) =>
                new Promise((_resolve, reject) => {
                  init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                })
            )
          ),
        }),
      );

      await assert.rejects(() => client.embedQuery('hello'), TimeoutError);
    });

    it('names the provider in a retry warning', async () => {
      const { logger, records } = createRecordingLogger();
      const gateway = createFakeEmbeddings({
        embed: [
          () => textResponse('overloaded', 429)(),
          (body) => jsonResponse({ data: [{ index: 0, embedding: vectorFor(body.input[0]) }] })(),
        ],
      });

      await createEmbeddingsClient(
        openAiOptions({ fetchImpl: gateway.fetchImpl, logger }),
      ).embedQuery('hello');

      const retry = records.find((entry) => entry.msg === 'embeddings request failed, retrying');
      assert.equal(retry?.provider, 'openai');
      assert.equal(retry?.level, 'warn');
    });
  });

  describe('health', () => {
    it('verifies the model is on offer, from the gateway model list', async () => {
      const gateway = createFakeEmbeddings();

      assert.deepEqual(
        await createEmbeddingsClient(openAiOptions({ fetchImpl: gateway.fetchImpl })).health(),
        { model: 'text-embedding-3-small', maxInputTokens: 0 },
      );
      assert.match(gateway.requests[0].url, /\/models$/);
    });

    it('fails readiness when the gateway does not offer the model', async () => {
      const gateway = createFakeEmbeddings({
        models: jsonResponse({ data: [{ id: 'some-other-model' }] }),
      });

      await assert.rejects(
        () => createEmbeddingsClient(openAiOptions({ fetchImpl: gateway.fetchImpl })).health(),
        (error) => {
          assert.ok(error instanceof ServiceUnavailableError);
          assert.match(String(error.details?.remediation), /EMBEDDING_MODEL/);
          return true;
        },
      );
    });

    it('treats a gateway without model discovery as reachable, not unhealthy', async () => {
      // Discovery is optional in the wire format; refusing to start over its absence
      // would be a false alarm.
      const gateway = createFakeEmbeddings({ models: textResponse('nope', 404) });

      await assert.doesNotReject(() =>
        createEmbeddingsClient(openAiOptions({ fetchImpl: gateway.fetchImpl })).health(),
      );
    });

    it('fails when the gateway is unwell', async () => {
      const gateway = createFakeEmbeddings({ models: textResponse('down', 503) });

      await assert.rejects(
        () => createEmbeddingsClient(openAiOptions({ fetchImpl: gateway.fetchImpl })).health(),
        ServiceUnavailableError,
      );
    });

    it('reports the running model and input limit for a self-hosted service', async () => {
      const service = createFakeEmbeddings({ embed: echoTei });

      assert.deepEqual(
        await createEmbeddingsClient(teiOptions({ fetchImpl: service.fetchImpl })).health(),
        { model: 'BAAI/bge-m3', maxInputTokens: 8192 },
      );
    });

    it('fails when a self-hosted service serves a different model', async () => {
      // The silent-corruption case: the variable changed, the container did not.
      const service = createFakeEmbeddings({
        embed: echoTei,
        info: jsonResponse({ model_id: 'BAAI/bge-small-en-v1.5', max_input_length: 512 }),
      });

      await assert.rejects(
        () => createEmbeddingsClient(teiOptions({ fetchImpl: service.fetchImpl })).health(),
        (error) => {
          assert.ok(error instanceof ServiceUnavailableError);
          assert.match(String(error.details?.remediation), /re-ingest/);
          return true;
        },
      );
    });
  });

  describe('configuration', () => {
    it('refuses a non-http base URL', () => {
      assert.throws(
        () => createEmbeddingsClient(openAiOptions({ baseUrl: 'ftp://gateway.test' })),
        ConfigurationError,
      );
    });

    it('refuses a missing dimension, which nothing downstream can guess', () => {
      assert.throws(
        () =>
          createEmbeddingsClient(
            /** @type {any} */ ({ ...openAiOptions(), dimensions: undefined }),
          ),
        ConfigurationError,
      );
    });

    it('refuses a batch size the backend would reject', () => {
      assert.throws(
        () => createEmbeddingsClient(openAiOptions({ batchSize: 500 })),
        ConfigurationError,
      );
    });

    it('never puts the credential in a configuration error', () => {
      try {
        createEmbeddingsClient(openAiOptions({ model: '' }));
        assert.fail('expected a ConfigurationError');
      } catch (error) {
        assert.ok(!JSON.stringify(error).includes(TEST_API_KEY));
      }
    });
  });
});
