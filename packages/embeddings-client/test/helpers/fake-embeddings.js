import { createLogger } from '@shopsage/platform';

export const TEST_DIMENSIONS = 4;
export const TEST_API_KEY = 'sk-embed-000111222333';

/**
 * @param {Partial<import('../../src/types.js').EmbeddingsClientOptions>} [overrides]
 * @returns {import('../../src/types.js').EmbeddingsClientOptions}
 */
export function openAiOptions(overrides = {}) {
  return {
    provider: 'openai',
    baseUrl: 'https://gateway.test/v1',
    apiKey: TEST_API_KEY,
    model: 'text-embedding-3-small',
    dimensions: TEST_DIMENSIONS,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    ...overrides,
  };
}

/**
 * @param {Partial<import('../../src/types.js').EmbeddingsClientOptions>} [overrides]
 * @returns {import('../../src/types.js').EmbeddingsClientOptions}
 */
export function teiOptions(overrides = {}) {
  return {
    provider: 'tei',
    baseUrl: 'http://tei.test',
    model: 'BAAI/bge-m3',
    dimensions: TEST_DIMENSIONS,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    ...overrides,
  };
}

/**
 * A vector derived from its input, so ordering assertions mean something.
 *
 * @param {string} text
 * @returns {number[]}
 */
export function vectorFor(text) {
  return Array.from({ length: TEST_DIMENSIONS }, (_unused, index) => text.length + index / 10);
}

/**
 * @param {unknown} body
 * @param {{ status?: number }} [init]
 * @returns {() => Response}
 */
export function jsonResponse(body, init = {}) {
  return () =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
}

/**
 * @param {string} body
 * @param {number} status
 * @param {Record<string, string>} [headers]
 * @returns {() => Response}
 */
export function textResponse(body, status, headers) {
  return () => new Response(body, { status, headers });
}

/**
 * @typedef {(body: any) => Response} EmbedHandler
 */

/**
 * @typedef {object} FakeEmbeddings
 * @property {typeof fetch} fetchImpl
 * @property {{ url: string, method: string, body: any, headers: Record<string, string> }[]} requests
 * @property {() => any[]} batchesSeen Inputs of each embed call, whichever route.
 */

/**
 * A `fetch` double serving both wire formats.
 *
 * Routes by path so one helper covers a hosted gateway (`/embeddings`, `/models`) and a
 * self-hosted service (`/embed`, `/info`). Outcomes are functions, not values: a
 * `Response` body reads once, so a retry test reusing one would pass for the wrong
 * reason.
 *
 * @param {{
 *   embed?: EmbedHandler | Error | (EmbedHandler | Error)[],
 *   models?: () => Response,
 *   info?: () => Response,
 * }} [script]
 * @returns {FakeEmbeddings}
 */
export function createFakeEmbeddings(script = {}) {
  const outcomes = toList(script.embed ?? echoOpenAi);
  const models = script.models ?? jsonResponse({ data: [{ id: 'text-embedding-3-small' }] });
  const info = script.info ?? jsonResponse({ model_id: 'BAAI/bge-m3', max_input_length: 8192 });

  /** @type {{ url: string, method: string, body: any, headers: Record<string, string> }[]} */
  const requests = [];
  let embedCalls = 0;

  const fetchImpl = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (
      (/** @type {string} */ url, /** @type {RequestInit} */ init = {}) => {
        const address = String(url);
        const body = init.body === undefined ? undefined : JSON.parse(String(init.body));

        requests.push({
          url: address,
          method: init.method ?? 'GET',
          body,
          headers: /** @type {Record<string, string>} */ (init.headers ?? {}),
        });

        if (address.endsWith('/models')) return Promise.resolve(models());
        if (address.endsWith('/info')) return Promise.resolve(info());

        const outcome = outcomes[Math.min(embedCalls, outcomes.length - 1)];
        embedCalls += 1;

        return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome(body));
      }
    )
  );

  return {
    fetchImpl,
    requests,
    batchesSeen: () =>
      requests
        .filter((request) => /\/embeddings$|\/embed$/.test(request.url))
        .map((request) => request.body.input ?? request.body.inputs),
  };
}

/**
 * The OpenAI envelope, with indexes shuffled so order handling is exercised.
 *
 * @type {EmbedHandler}
 */
function echoOpenAi(body) {
  const inputs = Array.isArray(body?.input) ? body.input : [];
  const data = inputs.map((/** @type {unknown} */ text, /** @type {number} */ index) => ({
    object: 'embedding',
    index,
    embedding: vectorFor(String(text)),
  }));

  return new Response(
    JSON.stringify({ object: 'list', model: 'text-embedding-3-small', data: data.reverse() }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * The TEI envelope: a bare array of vectors.
 *
 * @type {EmbedHandler}
 */
export function echoTei(body) {
  const inputs = Array.isArray(body?.inputs) ? body.inputs : [];

  return new Response(
    JSON.stringify(inputs.map((/** @type {unknown} */ text) => vectorFor(String(text)))),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * @template T
 * @param {T | T[]} value
 * @returns {T[]}
 */
function toList(value) {
  return Array.isArray(value) ? value : [value];
}

/**
 * @returns {{ logger: import('@shopsage/platform').Logger, records: Record<string, any>[] }}
 */
export function createRecordingLogger() {
  /** @type {Record<string, any>[]} */
  const records = [];

  const logger = createLogger({
    level: 'trace',
    sink: { write: (line) => records.push(JSON.parse(line)) },
  });

  return { logger, records };
}
