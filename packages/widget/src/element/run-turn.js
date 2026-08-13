/**
 * One question, from submitted text to a rendered answer.
 *
 * Streaming when the store has it enabled, buffered when it does not — and the buffered path is
 * a real fallback rather than a formality: `features.streaming` is a per-store flag, and some
 * infrastructure cannot carry an SSE connection cleanly.
 *
 * Nothing here decides *what* the answer is. It sends a message, renders events, and stores the
 * conversation id. The one judgement it makes is which of the API's error codes is worth acting
 * on, and that is a delivery concern.
 *
 * @param {{
 *   message: string,
 *   api: any,
 *   transcript: any,
 *   parts: any,
 *   session: any,
 *   config: any,
 *   signal: AbortSignal,
 * }} input
 * @returns {Promise<void>}
 */
export async function runTurn(input) {
  const { message, transcript, parts, session, signal } = input;

  transcript.add('user', message);
  showStatus(parts, `${assistantName(input.config)} is thinking`);

  try {
    if (input.config?.features?.streaming === false) await runBuffered(input);
    else await runStreaming(input);
  } catch (error) {
    // An abort is the customer closing the panel or leaving the page. Not a failure, and
    // nothing to tell them about.
    if (signal.aborted) transcript.abandonStreaming();
    else handleFailure(input, error);
  } finally {
    hideStatus(parts);
  }

  // Announced separately from the transcript so it is not read as though the assistant had
  // said it. Without this a screen-reader user has no signal that the answer has finished
  // arriving rather than merely paused.
  parts.announcer.textContent = 'Answer complete';
  void session;
}

/**
 * @param {Parameters<typeof runTurn>[0]} input
 */
async function runStreaming(input) {
  const state = { started: false, proposalShown: false };

  for await (const event of input.api.askStreaming({
    message: input.message,
    conversationId: input.session.conversationId(),
    signal: input.signal,
  })) {
    if (handleEvent(input, state, event) === 'finished') return;
  }

  // The stream ended without `done`. A dropped connection, not a refusal.
  if (state.started) input.transcript.abandonStreaming();
}

/**
 * One handler per event name.
 *
 * A table rather than a chain of comparisons, which keeps each case readable and makes the
 * unknown-event case structural: an event this build has never heard of finds no handler and is
 * ignored, so a newer backend talking to an older widget degrades instead of breaking. The
 * terminal `done` still carries the answer.
 *
 * A handler returning `finished` ends the turn.
 *
 * @type {Readonly<Record<string, (
 *   input: Parameters<typeof runTurn>[0],
 *   state: { started: boolean, proposalShown?: boolean },
 *   event: { name: string, data: any },
 * ) => 'finished' | undefined>>}
 */
const HANDLERS = Object.freeze({
  // Remembered immediately, before a single token. If the connection dies now, the next
  // question still continues this conversation rather than starting a new one.
  start: (input, _state, event) => {
    if (typeof event.data?.conversationId === 'string') {
      input.session.remember(event.data.conversationId);
    }

    return undefined;
  },

  // The gap before the first token is a whole retrieval round - several seconds. This is what
  // fills it, and it is why the backend emits these at all.
  tool: (input, _state, event) => {
    if (event.data?.phase === 'started') showStatus(input.parts, 'Searching the help centre');

    return undefined;
  },

  delta: (input, state, event) => {
    openMessage(input, state);
    if (typeof event.data?.text === 'string') input.transcript.appendDelta(event.data.text);

    return undefined;
  },

  // A prepared cart change. Rendered as it arrives rather than waiting for `done`, which is why the
  // backend emits it separately - the confirmation appears while the model is still writing the
  // sentence that explains it.
  //
  // The streamed answer is left open around it: the card is appended to the transcript, not to the
  // bubble, so the deltas still land where they were going.
  proposal: (input, _state, event) => {
    showProposal(input, event.data);

    return undefined;
  },

  // A model that returned no prose sends zero deltas, so the message may not exist yet - and
  // `done.answer` then carries the store's no-answer copy. Opening it here is what stops an
  // empty bubble in exactly the case where saying something matters most.
  done: (input, state, event) => {
    openMessage(input, state);
    input.transcript.completeStreaming(event.data ?? {});
    // `done.proposal` repeats what the `proposal` event carried. Rendering it again would draw a second
    // card, so this only fires when the separate event never arrived - which is what a proxy that
    // buffers or drops an unknown event type looks like. The reply is authoritative for the answer, and
    // for this too.
    if (!state.proposalShown) showProposal(input, event.data?.proposal);

    return 'finished';
  },

  // `error` arrives inside a 200 because the stream's status line was sent long before the
  // failure. Whatever text already arrived stands; it was really said.
  error: (input) => {
    input.transcript.abandonStreaming();
    showFallback(input);

    return 'finished';
  },
});

/**
 * @param {Parameters<typeof runTurn>[0]} input
 * @param {{ started: boolean, proposalShown?: boolean }} state
 * @param {{ name: string, data: any }} event
 * @returns {'finished' | undefined}
 */
function handleEvent(input, state, event) {
  const outcome = HANDLERS[event.name]?.(input, state, event);

  if (event.name === 'proposal') state.proposalShown = true;

  return outcome;
}

/**
 * Draw a confirmation card, wired to the one mutating call the widget can make.
 *
 * The status is announced rather than only shown, because the outcome of a confirmation is exactly the
 * kind of change a screen-reader user must not have to go looking for.
 *
 * @param {Parameters<typeof runTurn>[0]} input
 * @param {any} proposal
 */
function showProposal(input, proposal) {
  if (proposal === undefined || proposal === null) return;

  input.transcript.addProposal({
    proposal,
    onConfirm: (/** @type {string} */ proposalId) => input.api.confirm({ proposalId }),
    announce: (/** @type {string} */ text) => {
      input.parts.announcer.textContent = text;
    },
  });
}

/**
 * @param {Parameters<typeof runTurn>[0]} input
 * @param {{ started: boolean }} state
 */
function openMessage(input, state) {
  if (state.started) return;

  state.started = true;
  hideStatus(input.parts);
  input.transcript.beginStreaming();
}

/**
 * @param {Parameters<typeof runTurn>[0]} input
 */
async function runBuffered(input) {
  const reply = await input.api.ask({
    message: input.message,
    conversationId: input.session.conversationId(),
    signal: input.signal,
  });

  if (typeof reply?.conversationId === 'string') input.session.remember(reply.conversationId);

  input.transcript.addAnswer(reply?.answer ?? '', reply?.sources);
  // The buffered path has no `proposal` event to receive, so the reply is the only carrier. Both paths
  // must offer the confirmation or a store with streaming disabled would have an assistant that
  // prepares changes nobody can accept.
  showProposal(input, reply?.proposal);
}

/**
 * @param {Parameters<typeof runTurn>[0]} input
 * @param {any} error
 */
function handleFailure(input, error) {
  input.transcript.abandonStreaming();

  // A conversation the server has forgotten — its idle timeout passed while the tab sat open.
  // Dropping the id means the next question starts cleanly instead of failing for ever.
  if (error?.status === 404 || error?.code === 'NOT_FOUND') input.session.forget();

  showFallback(input);
}

/**
 * The store's own words, never the server's.
 *
 * A 5xx message is masked to something generic by design, and a 4xx message is written for a
 * developer. `fallbackMessage` is copy the store wrote for this moment, so it is the only thing
 * worth showing — and it goes in the transcript so the failure is part of the conversation
 * rather than a toast that vanishes.
 *
 * @param {Parameters<typeof runTurn>[0]} input
 */
function showFallback(input) {
  const fallback =
    typeof input.config?.fallbackMessage === 'string'
      ? input.config.fallbackMessage
      : 'Something went wrong. Please try again.';

  input.transcript.add('assistant', fallback);
  input.parts.announcer.textContent = fallback;
}

/**
 * @param {any} parts
 * @param {string} label
 */
function showStatus(parts, label) {
  parts.status.replaceChildren(document.createTextNode(`${label}`), dots());
  parts.status.hidden = false;
}

/** @param {any} parts */
function hideStatus(parts) {
  parts.status.hidden = true;
  parts.status.replaceChildren();
}

/** @returns {HTMLElement} */
function dots() {
  const wrapper = document.createElement('span');

  wrapper.className = 'dots';
  wrapper.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i += 1) wrapper.append(document.createElement('i'));

  return wrapper;
}

/** @param {any} config */
function assistantName(config) {
  return typeof config?.assistantName === 'string' ? config.assistantName : 'The assistant';
}
