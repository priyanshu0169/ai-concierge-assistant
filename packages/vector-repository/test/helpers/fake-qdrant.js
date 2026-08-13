export const TEST_DIMENSIONS = 4;

/**
 * @param {Partial<import('../../src/types.js').QdrantRepositoryOptions>} [overrides]
 * @returns {import('../../src/types.js').QdrantRepositoryOptions}
 */
export function testOptions(overrides = {}) {
  return {
    url: 'http://qdrant.test:6333',
    collection: 'shopsage_test',
    dimensions: TEST_DIMENSIONS,
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    ...overrides,
  };
}

/**
 * @param {number} [seed]
 * @returns {number[]}
 */
export function testVector(seed = 1) {
  return Array.from({ length: TEST_DIMENSIONS }, (_unused, index) => seed + index);
}

/**
 * @param {unknown} result
 * @param {number} [status]
 * @returns {Response}
 */
export function qdrantOk(result, status = 200) {
  return new Response(JSON.stringify({ result, status: 'ok', time: 0.001 }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * @param {number} status
 * @param {string} [message]
 * @returns {Response}
 */
export function qdrantError(status, message = 'something went wrong') {
  return new Response(JSON.stringify({ status: { error: message }, time: 0 }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * @typedef {object} RecordedCall
 * @property {string} url
 * @property {string} method
 * @property {any} body
 * @property {Record<string, string>} headers
 */

/**
 * @typedef {object} FakeQdrant
 * @property {typeof fetch} fetchImpl
 * @property {RecordedCall[]} calls
 * @property {(fragment: string) => RecordedCall[]} matching
 */

/**
 * A `fetch` double routing by URL fragment.
 *
 * Handlers receive the parsed body and may be given as a list, in which case each
 * call consumes the next - which is how retry behaviour is asserted without
 * re-reading a consumed `Response`.
 *
 * @param {Record<string, ((body: any) => Response) | Error | (((body: any) => Response) | Error)[]>} routes
 * @returns {FakeQdrant}
 */
export function createFakeQdrant(routes) {
  /** @type {RecordedCall[]} */
  const calls = [];
  /** @type {Map<string, number>} */
  const consumed = new Map();

  const fetchImpl = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (
      (/** @type {string} */ url, /** @type {RequestInit} */ init = {}) => {
        const address = String(url);
        const body = init.body === undefined ? undefined : JSON.parse(String(init.body));

        calls.push({
          url: address,
          method: init.method ?? 'GET',
          body,
          headers: /** @type {Record<string, string>} */ (init.headers ?? {}),
        });

        const key = Object.keys(routes).find((fragment) => address.includes(fragment));
        if (key === undefined) {
          return Promise.reject(new Error(`fake qdrant has no route for ${address}`));
        }

        const outcomes = Array.isArray(routes[key]) ? routes[key] : [routes[key]];
        const index = consumed.get(key) ?? 0;
        consumed.set(key, index + 1);
        const outcome = outcomes[Math.min(index, outcomes.length - 1)];

        return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome(body));
      }
    )
  );

  return {
    fetchImpl,
    calls,
    matching: (fragment) => calls.filter((call) => call.url.includes(fragment)),
  };
}
