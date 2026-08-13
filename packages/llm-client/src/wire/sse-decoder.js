import { UpstreamError } from '@shopsage/platform';

const EVENT_SEPARATOR = /\r?\n\r?\n/;
const DATA_PREFIX = 'data:';

/**
 * A single event must never be allowed to grow without bound. A gateway that
 * streams bytes but never a blank line would otherwise consume the heap.
 */
const MAX_EVENT_BYTES = 1_000_000;

/**
 * Decode a byte stream of Server-Sent Events into its `data` payloads.
 *
 * Generic SSE only: `[DONE]` is an OpenAI convention and is handled by the
 * caller, so this stays reusable and separately testable.
 *
 * Handles the two things that break naive implementations: an event split
 * across chunk boundaries (a token frequently arrives in two TCP reads), and
 * multi-line `data:` fields, which the specification says to join with newlines.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {AsyncGenerator<string, void, void>}
 */
export async function* decodeSseData(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    let chunk = await reader.read();

    while (chunk.done === false) {
      buffer = ensureWithinLimit(buffer + decoder.decode(chunk.value, { stream: true }));

      const { events, rest } = splitEvents(buffer);
      buffer = rest;
      yield* dataPayloads(events);

      chunk = await reader.read();
    }

    // A well-behaved gateway ends with a blank line; not all of them do.
    yield* dataPayloads([buffer]);
  } finally {
    // Cancel rather than merely release: a caller that stops iterating early
    // (an aborted request, a `break`) would otherwise leave the connection open.
    await reader.cancel().catch(() => {});
  }
}

/**
 * @param {string} buffer
 * @returns {{ events: string[], rest: string }}
 */
function splitEvents(buffer) {
  const parts = buffer.split(EVENT_SEPARATOR);

  return { events: parts.slice(0, -1), rest: parts.at(-1) ?? '' };
}

/**
 * @param {string[]} events
 * @returns {Generator<string, void, void>}
 */
function* dataPayloads(events) {
  for (const event of events) {
    const data = extractData(event);
    if (data !== undefined) yield data;
  }
}

/**
 * @param {string} event
 * @returns {string | undefined} Undefined for comments, keep-alives and blanks.
 */
function extractData(event) {
  const lines = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith(DATA_PREFIX))
    .map((line) => line.slice(DATA_PREFIX.length).trimStart());

  return lines.length === 0 ? undefined : lines.join('\n');
}

/**
 * @param {string} buffer
 * @returns {string}
 */
function ensureWithinLimit(buffer) {
  if (buffer.length > MAX_EVENT_BYTES) {
    throw new UpstreamError('LLM gateway sent an oversized stream event', { retryable: false });
  }

  return buffer;
}
