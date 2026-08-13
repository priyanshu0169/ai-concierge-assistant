import { asObject } from './as-object.js';
import { parseToolCalls } from './parse-tool-calls.js';

/**
 * @typedef {object} ToolCallFragment
 * @property {string} id
 * @property {string} name
 * @property {string} argumentsText
 */

/**
 * @typedef {object} ToolCallAccumulator
 * @property {(rawDeltas: unknown) => void} accept
 * @property {() => import('../types.js').LlmToolCall[]} toToolCalls
 */

/**
 * Reassemble streamed tool calls.
 *
 * A streamed tool call arrives as fragments keyed by position: the first
 * carries the id and name, and the arguments accrue one JSON fragment at a
 * time across many events. Nothing is parsable until the last fragment lands.
 *
 * This is the messiest part of the OpenAI streaming format, and containing it
 * here is deliberate - the alternative is every caller reimplementing it, which
 * is how a provider detail becomes load-bearing across a codebase.
 *
 * @returns {ToolCallAccumulator}
 */
export function createToolCallAccumulator() {
  /** @type {Map<number, ToolCallFragment>} */
  const fragments = new Map();

  /** @param {unknown} raw */
  function merge(raw) {
    const delta = asObject(raw);
    const fn = asObject(delta.function);
    const index = typeof delta.index === 'number' ? delta.index : 0;
    const previous = fragments.get(index) ?? { id: '', name: '', argumentsText: '' };

    fragments.set(index, {
      // First non-empty wins for id and name. They arrive whole in the opening
      // fragment, and some gateways repeat them in every subsequent one -
      // concatenating would produce `searchKnowledgesearchKnowledge`.
      id: firstNonEmpty(delta.id, previous.id),
      name: firstNonEmpty(fn.name, previous.name),
      argumentsText:
        previous.argumentsText + (typeof fn.arguments === 'string' ? fn.arguments : ''),
    });
  }

  return {
    accept(rawDeltas) {
      if (Array.isArray(rawDeltas)) rawDeltas.forEach(merge);
    },

    toToolCalls() {
      // Reassembled into the wire shape and handed to the shared parser, so
      // streamed and non-streamed tool calls cannot drift apart.
      const assembled = [...fragments.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, fragment]) => ({
          id: fragment.id,
          function: { name: fragment.name, arguments: fragment.argumentsText },
        }));

      return parseToolCalls(assembled);
    },
  };
}

/**
 * @param {unknown} candidate
 * @param {string} fallback
 * @returns {string}
 */
function firstNonEmpty(candidate, fallback) {
  return typeof candidate === 'string' && candidate !== '' ? candidate : fallback;
}
