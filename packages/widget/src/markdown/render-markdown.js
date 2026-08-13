import { renderInline } from './render-inline.js';

const FENCE = /^ {0,3}```\s*(?<language>[\w+-]*)\s*$/u;

/**
 * Block-level markdown, rendered as DOM nodes.
 *
 * Called on **every streamed delta** with the whole accumulated answer, not with the new
 * fragment. That is deliberate and it is what makes partial markdown safe: half-arrived
 * syntax like `**bol` simply fails to match, renders as literal text, and becomes bold on the
 * delta that completes it. Rendering incrementally would mean deciding what to do with an
 * unclosed fence, and getting it wrong mid-answer is visible to a customer.
 *
 * Re-parsing a few kilobytes tens of times is cheaper than it sounds and is throttled to a
 * frame by the caller.
 *
 * The subset is what language models emit in answers: paragraphs, fenced code, lists and
 * headings. Tables and block quotes are **not** supported - a model rarely reaches for them
 * unprompted, and each is a parser with its own edge cases. They degrade to literal text.
 *
 * @param {string} markdown
 * @returns {DocumentFragment}
 */
export function renderMarkdown(markdown) {
  const fragment = document.createDocumentFragment();

  for (const block of splitBlocks(markdown)) {
    const node = toBlockNode(block);

    if (node !== undefined) fragment.append(node);
  }

  return fragment;
}

/**
 * @typedef {{ kind: 'code', language: string, lines: string[] }
 *   | { kind: 'text', lines: string[] }} Block
 */

/**
 * Split into blocks, treating a fence as opaque.
 *
 * Fences are handled here rather than by a regex over the whole document because a blank line
 * *inside* a code block must not end it - and an **unterminated** fence is the normal state of
 * a streamed answer, so it has to be treated as a code block that has not finished yet rather
 * than as an error.
 *
 * @param {string} markdown
 * @returns {Block[]}
 */
function splitBlocks(markdown) {
  /** @type {Block[]} */
  const blocks = [];
  /** @type {Block | undefined} */
  let current;

  // A closure rather than a mutated argument, which is what keeps the loop below flat enough
  // to read: every branch either ends the current block or extends it.
  const flush = () => {
    if (current === undefined) return;

    blocks.push(current);
    current = undefined;
  };

  for (const line of markdown.replaceAll('\r\n', '\n').split('\n')) {
    const fence = FENCE.exec(line);

    if (fence !== null) {
      current = afterFence(current, fence, flush);
      continue;
    }

    // Inside a fence, nothing is special - not even a blank line, which is why fences are
    // handled here rather than by a regex over the whole document.
    if (current?.kind === 'code') {
      current.lines.push(line);
      continue;
    }

    if (line.trim().length === 0) {
      flush();
      continue;
    }

    current ??= { kind: 'text', lines: [] };
    current.lines.push(line);
  }

  // Flushed rather than discarded: mid-stream this is the block currently arriving, including
  // an unterminated fence.
  flush();

  return blocks;
}

/**
 * A fence both closes whatever was open and, unless it was closing a code block, opens a new
 * one. Lifted out of the loop because expressing it inline needs a branch inside a branch.
 *
 * @param {Block | undefined} current
 * @param {RegExpExecArray} fence
 * @param {() => void} flush
 * @returns {Block | undefined}
 */
function afterFence(current, fence, flush) {
  const wasCode = current?.kind === 'code';

  flush();

  return wasCode ? undefined : { kind: 'code', language: fence.groups?.language ?? '', lines: [] };
}

/**
 * @param {Block} block
 * @returns {Node | undefined}
 */
function toBlockNode(block) {
  if (block.kind === 'code') return toCodeBlock(block);
  if (isList(block.lines)) return toList(block.lines);

  const heading = /^(?<hashes>#{1,3})\s+(?<text>.+)$/u.exec(block.lines[0] ?? '');

  if (heading !== null && block.lines.length === 1) {
    const element = document.createElement(`h${heading.groups?.hashes.length ?? 1}`);

    element.append(renderInline(heading.groups?.text ?? ''));

    return element;
  }

  return toParagraph(block.lines);
}

/**
 * @param {{ language: string, lines: string[] }} block
 * @returns {HTMLElement}
 */
function toCodeBlock(block) {
  const pre = document.createElement('pre');
  const code = document.createElement('code');

  // `textContent`, never inline rendering: the whole point of a code block is that its
  // contents are not markup. This is also what makes a model emitting HTML inside a fence
  // harmless - it is shown, not run.
  code.textContent = block.lines.join('\n');
  if (block.language.length > 0) code.setAttribute('data-language', block.language);

  pre.append(code);
  // Focusable and labelled, because a code block scrolls horizontally and a keyboard user
  // otherwise has no way to reach that scroll region.
  pre.setAttribute('tabindex', '0');
  pre.setAttribute('role', 'group');
  pre.setAttribute(
    'aria-label',
    block.language.length > 0 ? `${block.language} code block` : 'code block',
  );

  return pre;
}

/**
 * @param {string[]} lines
 * @returns {boolean}
 */
function isList(lines) {
  return lines.every((line) => /^\s*(?:[-*+]|\d+[.)])\s+/u.test(line));
}

/**
 * @param {string[]} lines
 * @returns {HTMLElement}
 */
function toList(lines) {
  const ordered = /^\s*\d+[.)]\s+/u.test(lines[0] ?? '');
  const list = document.createElement(ordered ? 'ol' : 'ul');

  for (const line of lines) {
    const item = document.createElement('li');

    item.append(renderInline(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, '')));
    list.append(item);
  }

  return list;
}

/**
 * @param {string[]} lines
 * @returns {HTMLElement}
 */
function toParagraph(lines) {
  const paragraph = document.createElement('p');

  for (const [index, line] of lines.entries()) {
    if (index > 0) paragraph.append(document.createElement('br'));
    paragraph.append(renderInline(line));
  }

  return paragraph;
}
