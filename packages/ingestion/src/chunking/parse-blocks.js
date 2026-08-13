/**
 * @typedef {object} Block
 * @property {'heading' | 'text'} kind
 * @property {number} level Heading level; 0 for text.
 * @property {string} text
 */

/** `## Heading` — the convention `Document.text` preserves structure with. */
const HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * Parse canonical document text into headings and prose blocks.
 *
 * This is the whole reason `Document.text` keeps Markdown heading markers rather
 * than being flattened to prose. Structure is what lets a chunker cut where a human
 * would - the classic failure being a returns policy split so that one chunk holds
 * the conditions and another holds the time window, leaving neither able to answer
 * "how long do I have?".
 *
 * Consecutive prose lines are joined into one block, but a blank line starts a new
 * one: paragraph boundaries are the finest safe place to cut when a section is too
 * long for a single chunk.
 *
 * @param {string} text
 * @returns {Block[]}
 */
export function parseBlocks(text) {
  /** @type {Block[]} */
  const blocks = [];
  /** @type {string[]} */
  let pending = [];

  const flush = () => {
    const joined = pending.join('\n').trim();
    if (joined !== '') blocks.push({ kind: 'text', level: 0, text: joined });
    pending = [];
  };

  for (const line of text.split('\n')) {
    const heading = HEADING.exec(line);

    if (heading !== null) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    if (line.trim() === '') {
      flush();
      continue;
    }

    pending.push(line);
  }

  flush();

  return blocks;
}

/**
 * Track the trail of headings above the current position.
 *
 * A chunk from deep in a page carries "Returns policy > International" with it,
 * which is context a reader gets from the page around them and an isolated chunk
 * otherwise loses entirely.
 *
 * @returns {{
 *   enter: (level: number, text: string) => void,
 *   path: () => string[],
 * }}
 */
export function createHeadingTrail() {
  /** @type {{ level: number, text: string }[]} */
  const stack = [];

  return {
    enter(level, text) {
      // Pop siblings and deeper headings; what remains is this heading's ancestry.
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text });
    },

    path: () => stack.map((entry) => entry.text),
  };
}
