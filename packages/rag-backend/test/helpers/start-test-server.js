/**
 * Read a JSON response body.
 *
 * `Response.json()` is typed as `unknown`, which is correct for production code
 * but makes assertions unreadable. Tests assert on the shape they expect and
 * fail loudly when it differs, so the cast is contained here.
 *
 * @param {Response} response
 * @returns {Promise<any>}
 */
export function readJson(response) {
  return response.json();
}

/**
 * Parse a finished server-sent-event body into its events.
 *
 * Reads the whole body, which is exactly what a test wants and exactly what a browser must
 * not do. Keepalive comment lines are dropped, the way a real client drops them.
 *
 * @param {Response} response
 * @returns {Promise<{ name: string, data: any }[]>}
 */
export async function readSseEvents(response) {
  const body = await response.text();

  return body
    .split('\n\n')
    .filter((block) => block.startsWith('event:'))
    .map((block) => {
      const lines = block.split('\n');
      const data = lines.find((line) => line.startsWith('data:'));

      return {
        name: lines[0].slice('event:'.length).trim(),
        data: data === undefined ? undefined : JSON.parse(data.slice('data:'.length).trim()),
      };
    });
}

/**
 * Wait for a condition instead of guessing how long it takes.
 *
 * Written to kill a flake. Two concurrency tests need a first request to have reached the
 * guard before a second arrives, and expressed that as `setTimeout(30)` — which holds until
 * the suite runs every package in parallel on a loaded machine, and then fails about once in
 * five runs with nothing to show for it. Polling an actual signal is both faster and
 * deterministic.
 *
 * @param {() => boolean} condition
 * @param {{ timeoutMs?: number, label?: string }} [options]
 * @returns {Promise<void>}
 */
export async function until(condition, options = {}) {
  const { timeoutMs = 2_000, label = 'condition' } = options;
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);

    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * @typedef {object} TestServer
 * @property {string} baseUrl
 * @property {(path: string, init?: RequestInit) => Promise<Response>} request
 * @property {() => Promise<void>} close
 */

/**
 * Bind an Express app to an ephemeral port and return a client for it.
 *
 * Port 0 lets the OS choose, so tests never collide with a developer's running
 * stack or with each other under a parallel test runner.
 *
 * @param {import('express').Express} app
 * @returns {Promise<TestServer>}
 */
export function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address();

      if (address === null || typeof address === 'string') {
        throw new Error('expected the test server to bind a TCP port');
      }

      const baseUrl = `http://127.0.0.1:${address.port}`;

      resolve({
        baseUrl,
        request: (path, init) => fetch(`${baseUrl}${path}`, init),
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
          }),
      });
    });
  });
}
