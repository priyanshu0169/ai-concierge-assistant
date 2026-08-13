import { renderMarkdown } from '../markdown/render-markdown.js';
import { isSafeHref } from '../markdown/render-inline.js';
import { createConfirmation } from './confirmation.js';

/**
 * Renders the conversation, and owns the one piece of state a streamed answer needs: the
 * message currently arriving.
 *
 * @param {{ transcript: HTMLElement }} parts
 */
export function createTranscript(parts) {
  const { transcript } = parts;

  /** @type {{ bubble: HTMLElement, container: HTMLElement, text: string } | undefined} */
  let streaming;
  /** @type {number | undefined} */
  let frame;

  /**
   * Re-render the whole accumulated answer, at most once a frame.
   *
   * Whole rather than appended, because markdown is not incrementally parseable: `**bol` is
   * literal asterisks until the closing pair arrives, and appending would leave the earlier
   * half rendered wrongly for ever. Throttling to a frame means forty-eight deltas cost
   * roughly the number of paints the display can show rather than forty-eight re-layouts.
   */
  const paint = () => {
    frame = undefined;

    if (streaming === undefined) return;

    streaming.bubble.replaceChildren(renderMarkdown(streaming.text));
    scrollIfAtBottom();
  };

  const scrollIfAtBottom = () => followIfAtBottom(transcript);

  return {
    /**
     * @param {'user' | 'assistant'} role
     * @param {string} text
     */
    add(role, text) {
      const { container, bubble } = message(role);

      bubble.append(renderMarkdown(text));
      transcript.append(container);
      transcript.scrollTop = transcript.scrollHeight;
    },

    /** Open an empty assistant message for a streamed answer to fill. */
    beginStreaming() {
      const { container, bubble } = message('assistant');

      streaming = { container, bubble, text: '' };
      transcript.append(container);
      transcript.scrollTop = transcript.scrollHeight;
    },

    /** @param {string} delta */
    appendDelta(delta) {
      if (streaming === undefined) return;

      streaming.text += delta;
      frame ??= requestAnimationFrame(paint);
    },

    /**
     * Settle the message on the authoritative answer, then attach citations.
     *
     * `done.answer` wins over the deltas, per the streaming contract: a model that returned no
     * prose sends zero deltas and the store's no-answer copy arrives only here. A renderer
     * trusting deltas alone shows an empty bubble in exactly the case where saying something
     * matters most.
     *
     * @param {{ answer?: string, sources?: { title: string, url?: string }[] }} reply
     */
    completeStreaming(reply) {
      if (streaming === undefined) return;

      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;

      const authoritative = typeof reply.answer === 'string' ? reply.answer : streaming.text;

      streaming.bubble.replaceChildren(renderMarkdown(authoritative));
      appendSources(streaming.container, reply.sources);

      streaming = undefined;
      scrollIfAtBottom();
    },

    /** Abandon a partially streamed message, leaving whatever arrived. */
    abandonStreaming() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      streaming = undefined;
    },

    /**
     * @param {string} answer
     * @param {{ title: string, url?: string }[]} [sources]
     */
    addAnswer(answer, sources) {
      const { container, bubble } = message('assistant');

      bubble.append(renderMarkdown(answer));
      appendSources(container, sources);
      transcript.append(container);
      scrollIfAtBottom();
    },

    addProposal: (input) => appendProposal(transcript, input),

    clear() {
      transcript.replaceChildren();
      streaming = undefined;
    },
  };
}

/**
 * Follow the answer only while the customer has not scrolled away.
 *
 * Pinning unconditionally yanks the view out from under somebody reading the middle of a long answer,
 * which is worse than not following at all.
 *
 * @param {HTMLElement} transcript
 */
function followIfAtBottom(transcript) {
  const distance = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;

  if (distance < 80) transcript.scrollTop = transcript.scrollHeight;
}

/**
 * Show a prepared cart change, with its confirmation.
 *
 * Appended as its own block rather than inside the assistant's bubble, and the reason is the same one
 * that keeps the summary out of the markdown renderer: the model's prose and the button must be visibly
 * different things. A confirmation nested in a sentence a model wrote reads as part of the sentence, and
 * this is the one element where a customer needs to know exactly what they are agreeing to.
 *
 * @param {HTMLElement} transcript
 * @param {{
 *   proposal: any,
 *   onConfirm: (proposalId: string) => Promise<any>,
 *   announce: (text: string) => void,
 * }} input
 */
function appendProposal(transcript, input) {
  const card = createConfirmation(input);

  if (card === undefined) return;

  transcript.append(card);
  // Scrolled unconditionally, unlike an answer's deltas: a button the customer cannot see is a button
  // they will not press, and this arrived because they asked for it.
  transcript.scrollTop = transcript.scrollHeight;
}

/**
 * @param {'user' | 'assistant'} role
 */
function message(role) {
  const container = document.createElement('div');
  const bubble = document.createElement('div');

  container.className = 'message';
  container.setAttribute('data-role', role);
  bubble.className = 'bubble';
  container.append(bubble);

  return { container, bubble };
}

/**
 * Citations, when there are any.
 *
 * An empty list means the answer was not grounded in store content, and the widget renders
 * nothing rather than an empty heading — the absence is the signal, and labelling it would
 * invite a customer to think something failed.
 *
 * Hrefs are re-checked here even though they came from the backend. Defence in depth is cheap,
 * and the alternative is a widget whose safety depends on a service it does not control.
 *
 * @param {HTMLElement} container
 * @param {{ title: string, url?: string }[]} [sources]
 */
function appendSources(container, sources) {
  const usable = (sources ?? []).filter((source) => typeof source?.title === 'string');

  if (usable.length === 0) return;

  const list = document.createElement('div');

  list.className = 'sources';
  list.setAttribute('aria-label', 'Sources');

  for (const source of usable) {
    const linkable = typeof source.url === 'string' && isSafeHref(source.url);
    const node = document.createElement(linkable ? 'a' : 'span');

    node.textContent = source.title;

    if (linkable) {
      node.setAttribute('href', /** @type {string} */ (source.url));
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }

    list.append(node);
  }

  container.append(list);
}
