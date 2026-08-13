import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { openSseStream } from '../src/http/sse-stream.js';

/**
 * A response that records what was written to it.
 *
 * Framing is asserted against raw bytes on purpose. An SSE consumer is a browser's
 * `EventSource`, which is unforgiving about the exact `event:`/`data:`/blank-line shape,
 * and a framing bug looks like a stream that simply never delivers anything.
 */
function fakeResponse() {
  /** @type {string[]} */
  const writes = [];
  /** @type {{ status?: number, headers?: Record<string, string> }} */
  const head = {};

  return {
    writes,
    head,
    writableEnded: false,
    /**
     * @param {number} status
     * @param {Record<string, string>} headers
     */
    writeHead(status, headers) {
      head.status = status;
      head.headers = headers;
    },
    flushHeaders() {},
    /** @param {string} chunk */
    write(chunk) {
      writes.push(chunk);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  };
}

describe('openSseStream', () => {
  it('writes nothing at all until the first event', () => {
    // The whole point of opening lazily: while no status line has gone out, a failure can
    // still become a real HTTP status code.
    const res = fakeResponse();

    const stream = openSseStream(/** @type {any} */ (res));

    assert.equal(res.head.status, undefined);
    assert.deepEqual(res.writes, []);
    assert.equal(stream.started(), false);
  });

  it('opens with the streaming headers on the first event', () => {
    const res = fakeResponse();
    const stream = openSseStream(/** @type {any} */ (res));

    stream.send('start', { conversationId: 'c_1' });

    assert.equal(res.head.status, 200);
    assert.match(res.head.headers?.['content-type'] ?? '', /^text\/event-stream/);
    assert.equal(res.head.headers?.['x-accel-buffering'], 'no');
    assert.equal(stream.started(), true);
  });

  it('frames an event exactly as EventSource requires', () => {
    const res = fakeResponse();
    const stream = openSseStream(/** @type {any} */ (res));

    stream.send('delta', { text: 'Thirty ' });

    assert.equal(res.writes[0], 'event: delta\ndata: {"text":"Thirty "}\n\n');
  });

  it('closing without ever sending leaves the response untouched', () => {
    // Otherwise a rethrown failure would find headers already sent and could not produce
    // an envelope.
    const res = fakeResponse();

    openSseStream(/** @type {any} */ (res)).close();

    assert.equal(res.head.status, undefined);
    assert.equal(res.writableEnded, false);
  });

  it('does not write to a response that has already ended', () => {
    // A disconnected client is the normal end of a stream; writing would throw and there
    // is nobody left to tell.
    const res = fakeResponse();
    const stream = openSseStream(/** @type {any} */ (res));

    stream.send('start', {});
    res.writableEnded = true;
    stream.send('delta', { text: 'lost' });

    assert.equal(res.writes.length, 1);
  });

  it('sends a comment line while idle, so a proxy does not time the stream out', () => {
    // The gap between a question and its first token is a whole retrieval round. Without
    // this, a slow answer is indistinguishable from a dead connection to every hop in
    // between - and the failure only ever appears in production, behind a real proxy.
    mock.timers.enable({ apis: ['setInterval'] });

    try {
      const res = fakeResponse();
      const stream = openSseStream(/** @type {any} */ (res));

      stream.send('start', {});
      mock.timers.tick(45_000);

      const comments = res.writes.filter((write) => write.startsWith(':'));
      assert.equal(comments.length, 3);
      assert.equal(comments[0], ': keepalive\n\n');
      stream.close();
    } finally {
      mock.timers.reset();
    }
  });

  it('stops the heartbeat when the stream closes', () => {
    mock.timers.enable({ apis: ['setInterval'] });

    try {
      const res = fakeResponse();
      const stream = openSseStream(/** @type {any} */ (res));

      stream.send('start', {});
      stream.close();
      mock.timers.tick(60_000);

      assert.deepEqual(
        res.writes.filter((write) => write.startsWith(':')),
        [],
      );
    } finally {
      mock.timers.reset();
    }
  });
});
