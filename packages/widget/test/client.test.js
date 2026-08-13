import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApiClient } from '../src/client/create-api-client.js';
import { readSse } from '../src/client/read-sse.js';

/**
 * A readable stream of the given string pieces, so a test controls exactly where the network
 * would have split the bytes.
 *
 * @param {string[]} chunks
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

/** @param {string[]} chunks */
async function collect(chunks) {
  /** @type {any[]} */
  const events = [];

  for await (const event of readSse(streamOf(chunks))) events.push(event);

  return events;
}

describe('readSse', () => {
  it('reads whole events', async () => {
    const events = await collect(['event: delta\ndata: {"text":"Hi"}\n\n']);

    assert.deepEqual(events, [{ name: 'delta', data: { text: 'Hi' } }]);
  });

  it('reassembles an event split across chunks', async () => {
    // The failure that passes every local test and drops tokens against a real gateway. The
    // backend's own decoder was written against the same hazard.
    const events = await collect(['event: del', 'ta\ndata: {"te', 'xt":"Hi"}\n\n']);

    assert.deepEqual(events, [{ name: 'delta', data: { text: 'Hi' } }]);
  });

  it('reads several events arriving in one chunk', async () => {
    const events = await collect([
      'event: delta\ndata: {"text":"a"}\n\nevent: delta\ndata: {"text":"b"}\n\n',
    ]);

    assert.deepEqual(
      events.map((event) => event.data.text),
      ['a', 'b'],
    );
  });

  it('ignores keepalive comments', async () => {
    // The backend sends one every 15 seconds while idle. A client that surfaced them would
    // render a blank message.
    const events = await collect([': keepalive\n\nevent: delta\ndata: {"text":"x"}\n\n']);

    assert.equal(events.length, 1);
  });

  it('survives a multi-byte character split across chunks', async () => {
    // A naive decoder that handles each chunk independently corrupts this into replacement
    // characters, and the symptom is mangled text in exactly one language.
    const encoder = new TextEncoder();
    const bytes = encoder.encode('event: delta\ndata: {"text":"café"}\n\n');
    const split = bytes.length - 6;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });

    /** @type {any[]} */
    const events = [];
    for await (const event of readSse(stream)) events.push(event);

    assert.equal(events[0].data.text, 'café');
  });

  it('skips a malformed payload without killing the stream', async () => {
    // The events around it are still good, and the terminal `done` carries the authoritative
    // answer — so giving up on one bad frame would lose a working reply.
    const events = await collect([
      'event: delta\ndata: not json\n\nevent: done\ndata: {"answer":"ok"}\n\n',
    ]);

    assert.deepEqual(
      events.map((event) => event.name),
      ['done'],
    );
  });

  it('discards a trailing partial event', async () => {
    // A dropped connection mid-event. Emitting half of it would render a fragment as if it
    // were complete.
    const events = await collect(['event: delta\ndata: {"text":"a"}\n\nevent: delta\ndata: {"te']);

    assert.equal(events.length, 1);
  });
});

describe('createApiClient', () => {
  /**
   * @param {(url: string, init?: any) => Promise<Response>} handler
   */
  const clientWith = (handler, options = {}) =>
    createApiClient({
      backendUrl: 'https://assistant.example.com',
      fetchImpl: /** @type {any} */ (handler),
      ...options,
    });

  const json = (/** @type {unknown} */ body, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );

  it('fetches config without a token', async () => {
    // The route is public by design, and the widget needs it before a customer has interacted
    // with anything.
    /** @type {any[]} */
    const calls = [];
    const client = clientWith(
      (url, init) => {
        calls.push({ url, init });
        return json({ assistantName: 'Sage' });
      },
      { tokenUrl: 'https://store.example.com/assistant/session' },
    );

    await client.config();

    assert.equal(calls.length, 1, 'no token request should have been made');
    assert.match(calls[0].url, /\/v1\/config$/u);
    assert.equal(calls[0].init.headers.authorization, undefined);
  });

  it('trims a trailing slash off the backend URL', async () => {
    // `https://host/` plus `/v1/config` is `https://host//v1/config`, which some proxies 404.
    /** @type {string[]} */
    const urls = [];
    const client = createApiClient({
      backendUrl: 'https://assistant.example.com/',
      fetchImpl: /** @type {any} */ (
        (/** @type {string} */ url) => {
          urls.push(url);
          return json({});
        }
      ),
    });

    await client.config();

    assert.equal(urls[0], 'https://assistant.example.com/v1/config');
  });

  it('presents a bearer token on a chat request', async () => {
    /** @type {any[]} */
    const calls = [];
    const client = clientWith(
      (url, init) => {
        calls.push({ url, init });

        return url.endsWith('/session') ? json({ token: 'tok_1' }) : json({ answer: 'Hi' });
      },
      { tokenUrl: 'https://store.example.com/assistant/session' },
    );

    await client.ask({ message: 'Hello' });

    const chat = calls.find((call) => call.url.endsWith('/v1/chat'));
    assert.equal(chat.init.headers.authorization, 'Bearer tok_1');
  });

  it('sends the host session cookie only when minting a token', async () => {
    // Every call to ShopSage itself is deliberately cookie-free — the API is CSRF-immune
    // because it carries no credentials. The token endpoint is the one exception, and it is
    // same-origin to the host.
    /** @type {any[]} */
    const calls = [];
    const client = clientWith(
      (url, init) => {
        calls.push({ url, init });

        return url.endsWith('/session') ? json({ token: 't' }) : json({ answer: 'a' });
      },
      { tokenUrl: 'https://store.example.com/assistant/session' },
    );

    await client.ask({ message: 'Hello' });

    assert.equal(calls.find((c) => c.url.endsWith('/session')).init.credentials, 'include');
    assert.equal(calls.find((c) => c.url.endsWith('/v1/chat')).init.credentials, undefined);
  });

  it('reuses a token rather than minting one per request', async () => {
    let mints = 0;
    const client = clientWith(
      (url) => {
        if (url.endsWith('/session')) {
          mints += 1;
          return json({ token: `tok_${mints}` });
        }
        return json({ answer: 'a' });
      },
      { tokenUrl: 'https://store.example.com/assistant/session' },
    );

    await client.ask({ message: 'one' });
    await client.ask({ message: 'two' });

    assert.equal(mints, 1);
  });

  it('refreshes once on a 401 and retries', async () => {
    // Expected roughly every fifteen minutes: the backend distinguishes an expiry from a
    // rejection precisely so a client can do this instead of giving up.
    /** @type {string[]} */
    const tokens = [];
    let mints = 0;
    const client = clientWith(
      (url, init) => {
        if (url.endsWith('/session')) {
          mints += 1;
          return json({ token: `tok_${mints}` });
        }

        tokens.push(init.headers.authorization);

        return tokens.length === 1
          ? json({ error: { code: 'TOKEN_EXPIRED' } }, 401)
          : json({ answer: 'Hi' });
      },
      { tokenUrl: 'https://store.example.com/assistant/session' },
    );

    const reply = await client.ask({ message: 'Hello' });

    assert.equal(reply.answer, 'Hi');
    assert.deepEqual(tokens, ['Bearer tok_1', 'Bearer tok_2']);
    assert.equal(mints, 2);
  });

  it('does not retry a second 401, so a rejection cannot loop', async () => {
    let attempts = 0;
    const client = clientWith(
      (url) => {
        if (url.endsWith('/session')) return json({ token: 't' });
        attempts += 1;
        return json({ error: { code: 'UNAUTHORIZED' } }, 401);
      },
      { tokenUrl: 'https://store.example.com/assistant/session' },
    );

    await assert.rejects(() => client.ask({ message: 'Hello' }));

    assert.equal(attempts, 2);
  });

  it('carries the API error code, which is what a caller branches on', async () => {
    const client = clientWith(() => json({ error: { code: 'RATE_LIMITED' } }, 429));

    await assert.rejects(
      () => client.ask({ message: 'Hello' }),
      (error) => {
        assert.equal(/** @type {any} */ (error).code, 'RATE_LIMITED');
        assert.equal(/** @type {any} */ (error).status, 429);
        return true;
      },
    );
  });

  it('sends only the two fields the API accepts', async () => {
    // The API rejects unknown fields deliberately, so a stray one would turn a working widget
    // into a 400 after a backend upgrade.
    /** @type {any} */
    let sent;
    const client = clientWith((_url, init) => {
      sent = JSON.parse(init.body);
      return json({ answer: 'a' });
    });

    await client.ask({ message: 'Hello', conversationId: 'c_1' });

    assert.deepEqual(Object.keys(sent).sort(), ['conversationId', 'message']);
  });

  it('omits conversationId entirely on a first question', async () => {
    /** @type {any} */
    let sent;
    const client = clientWith((_url, init) => {
      sent = JSON.parse(init.body);
      return json({ answer: 'a' });
    });

    await client.ask({ message: 'Hello' });

    assert.deepEqual(Object.keys(sent), ['message']);
  });

  it('works with no token URL at all, for an unauthenticated deployment', async () => {
    /** @type {any} */
    let headers;
    const client = clientWith((_url, init) => {
      headers = init.headers;
      return json({ answer: 'a' });
    });

    await client.ask({ message: 'Hello' });

    assert.equal(headers.authorization, undefined);
  });

  it('streams events from the SSE endpoint', async () => {
    const client = clientWith(() =>
      Promise.resolve(
        new Response(streamOf(['event: delta\ndata: {"text":"Hi"}\n\n']), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    );

    /** @type {any[]} */
    const events = [];
    for await (const event of client.askStreaming({ message: 'Hello' })) events.push(event);

    assert.deepEqual(events, [{ name: 'delta', data: { text: 'Hi' } }]);
  });

  it('throws rather than streaming when the stream never opened', async () => {
    // Everything that can be a status code is one, because the backend opens the stream
    // lazily. So a failure here is an ordinary error, not an event.
    const client = clientWith(() => json({ error: { code: 'RATE_LIMITED' } }, 429));

    await assert.rejects(async () => {
      for await (const _event of client.askStreaming({ message: 'Hello' })) void _event;
    });
  });
});
