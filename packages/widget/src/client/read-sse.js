/**
 * Decode a server-sent-event stream from a `fetch` response body.
 *
 * `EventSource` is not usable here: it only issues GET requests with no body, and the chat
 * endpoint is a POST with JSON and an `Authorization` header. So the framing is decoded by
 * hand — which also means reassembling events split across network chunks, the failure that
 * passes every local test and drops tokens against a real gateway. The backend's own SSE
 * decoder was written against the same hazard (docs/adr/0011).
 *
 * Comment lines are skipped, which is how the backend's 15-second keepalive stays invisible.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<{ name: string, data: unknown }>}
 */
export async function* readSse(body) {
  const reader = body.getReader();
  // `stream: true` matters: a multi-byte character can straddle a chunk boundary, and decoding
  // each chunk independently would corrupt it.
  const decoder = new TextDecoder();
  let buffered = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      buffered += decoder.decode(value, { stream: true });

      // Events are separated by a blank line. Everything up to the last separator is
      // complete; whatever follows is a partial event and stays buffered.
      const blocks = buffered.split('\n\n');
      buffered = blocks.pop() ?? '';

      yield* parseEvents(blocks);
    }
  } finally {
    // Releasing matters on the abort path: an unreleased reader keeps the connection open
    // after the customer has closed the panel, and the answer keeps being billed.
    reader.releaseLock();
  }
}

/**
 * @param {string[]} blocks
 * @returns {Generator<{ name: string, data: unknown }>}
 */
function* parseEvents(blocks) {
  for (const block of blocks) {
    const event = parseEvent(block);

    if (event !== undefined) yield event;
  }
}

/**
 * @param {string} block
 * @returns {{ name: string, data: unknown } | undefined}
 */
function parseEvent(block) {
  /** @type {string | undefined} */
  let name;
  /** @type {string[]} */
  const data = [];

  for (const line of block.split('\n')) {
    // A comment. The keepalive arrives as one.
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) name = line.slice('event:'.length).trim();
    // Multiple `data:` lines in one event concatenate, per the spec.
    else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
  }

  if (name === undefined || data.length === 0) return undefined;

  try {
    return { name, data: JSON.parse(data.join('\n')) };
  } catch {
    // A malformed payload must not kill the stream: the events around it are still good, and
    // the terminal `done` carries the authoritative answer.
    return undefined;
  }
}
