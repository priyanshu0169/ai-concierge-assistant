import { createLogger } from '@shopsage/platform';

/** Long enough to exercise the secret-scrubbing path in error bodies. */
export const TEST_API_KEY = 'sk-test-000111222333';

/**
 * Client options with instant retries and no wall-clock waiting.
 *
 * @param {Partial<import('../../src/types.js').LlmClientOptions>} [overrides]
 * @returns {import('../../src/types.js').LlmClientOptions}
 */
export function testClientOptions(overrides = {}) {
  return {
    apiKey: TEST_API_KEY,
    baseUrl: 'https://gateway.test/v1',
    model: 'test-model',
    sleep: () => Promise.resolve(),
    random: () => 0.5,
    ...overrides,
  };
}

/**
 * @param {unknown} body
 * @param {{ status?: number, headers?: Record<string, string> }} [init]
 * @returns {() => Response}
 */
export function jsonResponse(body, init = {}) {
  return () =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
}

/**
 * @param {string} body
 * @param {{ status: number, headers?: Record<string, string> }} init
 * @returns {() => Response}
 */
export function textResponse(body, init) {
  return () => new Response(body, { status: init.status, headers: init.headers });
}

/**
 * A response whose body is a stream of the supplied raw SSE text chunks.
 *
 * Chunk boundaries are part of the test: real gateways split events across TCP
 * reads, and a decoder that assumes one event per chunk passes every naive test
 * and fails in production.
 *
 * @param {string[]} chunks
 * @returns {() => Response}
 */
export function sseResponse(chunks) {
  return () => {
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
}

/**
 * @typedef {object} RecordedRequest
 * @property {string} url
 * @property {Record<string, string>} headers
 * @property {Record<string, any>} body
 */

/**
 * @typedef {object} FetchStub
 * @property {typeof fetch} fetchImpl
 * @property {RecordedRequest[]} requests
 */

/**
 * A `fetch` double driven by a script.
 *
 * Each outcome is a *thunk* rather than a value, because a `Response` body can
 * only be read once - a retry test that reused one response would pass for the
 * wrong reason. The last outcome repeats if the client tries more attempts than
 * the script anticipated.
 *
 * @param {(() => Response) | Error | ((() => Response) | Error)[]} script
 * @returns {FetchStub}
 */
export function createFetchStub(script) {
  const outcomes = Array.isArray(script) ? script : [script];
  /** @type {RecordedRequest[]} */
  const requests = [];

  const fetchImpl = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (
      (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
        requests.push({
          url: String(url),
          headers: /** @type {Record<string, string>} */ (init.headers ?? {}),
          body: JSON.parse(String(init.body)),
        });

        const outcome = outcomes[Math.min(requests.length - 1, outcomes.length - 1)];

        return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome());
      }
    )
  );

  return { fetchImpl, requests };
}

/**
 * @typedef {object} RecordingLogger
 * @property {import('@shopsage/platform').Logger} logger
 * @property {Record<string, any>[]} records
 */

/**
 * A real logger writing to memory, so tests assert on the records that would
 * actually be shipped rather than on a hand-made double.
 *
 * @returns {RecordingLogger}
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
