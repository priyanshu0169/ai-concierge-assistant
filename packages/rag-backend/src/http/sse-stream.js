/**
 * How often to send a comment line when nothing else is going out.
 *
 * Fifteen seconds is under every default idle timeout worth worrying about - nginx's
 * `proxy_read_timeout` is 60s, most cloud load balancers sit between 30s and 60s - with
 * enough margin that one lost tick does not drop the connection.
 *
 * This is not theoretical for this API. The gap between a question and the first token of
 * its answer is a whole retrieval round, and a model that stalls extends that gap to
 * whatever `LLM_TIMEOUT_MS` allows. Without a heartbeat a slow answer is indistinguishable
 * from a dead connection to everything between here and the browser.
 */
const KEEPALIVE_MS = 15_000;

const SSE_HEADERS = Object.freeze({
  'content-type': 'text/event-stream; charset=utf-8',
  // `no-transform` matters as much as `no-cache`: a proxy that "optimises" the body
  // breaks the framing, and the symptom is events arriving in clumps or not at all.
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  // Nginx-specific and deliberately present anyway. Nginx buffers proxied responses by
  // default, which holds every event until the response ends - turning a stream into a
  // slow non-stream, with nothing in any log to say why.
  'x-accel-buffering': 'no',
});

/**
 * @typedef {object} SseStream
 * @property {(name: string, data: unknown) => void} send
 * @property {() => void} close
 * @property {() => boolean} started Whether a status line has gone out.
 */

/**
 * A server-sent-event response that opens on its first event, not on construction.
 *
 * The laziness is the design decision here. Writing the head commits a 200 and makes every
 * later failure unreportable as a status code - so it is deferred until there is something
 * to say. A turn that fails before its first event (a conversation store that is down, for
 * instance) therefore still becomes an ordinary 503 with the standard envelope, handled by
 * the same middleware as every other route.
 *
 * Once a single event is out, that option is gone for good and failures become `error`
 * events instead. See docs/adr/0023.
 *
 * @param {import('express').Response} res
 * @returns {SseStream}
 */
export function openSseStream(res) {
  /** @type {NodeJS.Timeout | undefined} */
  let keepalive;

  const start = () => {
    if (keepalive !== undefined) return;

    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders();

    keepalive = setInterval(() => {
      // A comment line: valid SSE that every client ignores.
      if (!res.writableEnded) res.write(': keepalive\n\n');
    }, KEEPALIVE_MS);

    // Otherwise this timer alone keeps the process alive through shutdown.
    keepalive.unref();
  };

  return {
    started: () => keepalive !== undefined,

    send(name, data) {
      start();

      // A disconnected client is the normal end of a stream, not an error. Writing to a
      // finished response throws, and there is nobody left to tell.
      if (res.writableEnded) return;

      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    },

    close() {
      if (keepalive === undefined) return;

      clearInterval(keepalive);
      if (!res.writableEnded) res.end();
    },
  };
}
