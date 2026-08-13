import assert from 'node:assert/strict';
import { UpstreamError } from '@shopsage/platform';
import { describe, it } from 'node:test';
import { decodeSseData } from '../src/wire/sse-decoder.js';

/**
 * @param {string[]} chunks Raw bytes as the gateway would write them.
 * @returns {ReadableStream<Uint8Array>}
 */
function streamOf(chunks) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/**
 * @param {string[]} chunks
 * @returns {Promise<string[]>}
 */
async function collect(chunks) {
  /** @type {string[]} */
  const payloads = [];

  for await (const payload of decodeSseData(streamOf(chunks))) payloads.push(payload);

  return payloads;
}

describe('decodeSseData', () => {
  it('yields the data payload of each event', async () => {
    const payloads = await collect(['data: one\n\n', 'data: two\n\n']);

    assert.deepEqual(payloads, ['one', 'two']);
  });

  it('reassembles an event split across chunk boundaries', async () => {
    // The failure this protects against: a decoder that assumes one event per
    // read passes every simple test and drops tokens against a real gateway.
    const payloads = await collect(['data: {"cho', 'ices":[]}\n', '\ndata: second\n\n']);

    assert.deepEqual(payloads, ['{"choices":[]}', 'second']);
  });

  it('joins a multi-line data field with newlines, as the specification says', async () => {
    const payloads = await collect(['data: first line\ndata: second line\n\n']);

    assert.deepEqual(payloads, ['first line\nsecond line']);
  });

  it('handles CRLF line endings', async () => {
    const payloads = await collect(['data: one\r\n\r\ndata: two\r\n\r\n']);

    assert.deepEqual(payloads, ['one', 'two']);
  });

  it('ignores comments and keep-alives', async () => {
    // Proxies inject `:` comment lines to hold the connection open.
    const payloads = await collect([': keep-alive\n\n', 'data: real\n\n', '\n\n']);

    assert.deepEqual(payloads, ['real']);
  });

  it('ignores non-data fields', async () => {
    const payloads = await collect(['event: message\nid: 7\ndata: payload\n\n']);

    assert.deepEqual(payloads, ['payload']);
  });

  it('emits a final event that was not terminated by a blank line', async () => {
    const payloads = await collect(['data: one\n\n', 'data: trailing']);

    assert.deepEqual(payloads, ['one', 'trailing']);
  });

  it('tolerates no leading space after the colon', async () => {
    const payloads = await collect(['data:tight\n\n']);

    assert.deepEqual(payloads, ['tight']);
  });

  it('yields nothing for an empty stream', async () => {
    assert.deepEqual(await collect([]), []);
  });

  it('refuses to buffer an unbounded event', async () => {
    // A gateway that streams bytes but never a blank line would otherwise
    // consume the heap.
    await assert.rejects(() => collect(['data: ', 'x'.repeat(1_200_000), '\n\n']), UpstreamError);
  });

  it('cancels the body when the caller stops early', async () => {
    let cancelled = false;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: one\n\ndata: two\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const payload of decodeSseData(stream)) {
      assert.equal(payload, 'one');
      break;
    }

    assert.equal(cancelled, true, 'an abandoned stream must not leave the connection open');
  });
});
