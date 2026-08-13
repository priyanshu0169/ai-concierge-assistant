/**
 * The conversation manager, decorated where the **quality** signal is.
 *
 * `grounded` is deliberately absent from the API response — publishing it would invite a client to
 * branch on it and make it a contract (docs/API.md) — and until now it has only existed in a log line.
 * As an aggregate it is the most useful number about this service: an assistant returning the store's
 * no-answer message to every question is indistinguishable from a healthy one if all you have is HTTP
 * status codes, and that is precisely the failure this stage exists to make visible.
 *
 * Decorated here rather than instrumented inside `assistant-core`, so the domain still imports nothing
 * about metrics. The manager is a port-shaped thing like any other, and the composition root is where a
 * port gets wrapped.
 */

/**
 * The outcome of a turn, from what a customer received.
 *
 * Three states, and the distinction between the last two is the point. `grounded` means retrieved
 * content supported the answer. `ungrounded` means the model answered from somewhere else — legitimate
 * for "hello", worrying at volume. `no_answer` means the store's own no-answer copy went out, which is
 * the honest failure and the one worth alerting on when its rate moves.
 *
 * @param {import('@shopsage/assistant-core').AssistantReply} reply
 * @param {string} noAnswerMessage
 * @returns {string}
 */
function outcomeOf(reply, noAnswerMessage) {
  if (reply.answer === noAnswerMessage) return 'no_answer';

  return reply.grounded ? 'grounded' : 'ungrounded';
}

/**
 * @param {{
 *   assistant: import('@shopsage/assistant-core').ConversationManager,
 *   instruments: import('./create-instruments.js').Instruments,
 *   noAnswerMessage: string,
 * }} input
 * @returns {import('@shopsage/assistant-core').ConversationManager}
 */
export function instrumentAssistant(input) {
  const { assistant, instruments, noAnswerMessage } = input;

  /**
   * @param {import('@shopsage/assistant-core').AssistantReply} reply
   * @param {string} mode
   * @param {number} startedAt
   */
  const recordTurn = (reply, mode, startedAt) => {
    instruments.assistantTurns.add({ mode, outcome: outcomeOf(reply, noAnswerMessage) });
    instruments.assistantDuration.observe(Date.now() - startedAt, { mode });

    if (reply.proposal !== undefined) {
      instruments.cartProposals.add({ kind: reply.proposal.kind, stage: 'prepared' });
    }
  };

  return {
    async answer(request) {
      const startedAt = Date.now();

      try {
        const reply = await assistant.answer(request);

        recordTurn(reply, 'buffered', startedAt);

        return reply;
      } catch (error) {
        // A failed turn is counted, and separately from an unanswered one. Without this a gateway outage
        // shows up as a hole in the turn count rather than as a number, and a hole is not something an
        // alert can be written against.
        instruments.assistantTurns.add({ mode: 'buffered', outcome: 'failed' });
        instruments.assistantDuration.observe(Date.now() - startedAt, { mode: 'buffered' });

        throw error;
      }
    },

    async *answerStream(request) {
      const startedAt = Date.now();
      let firstToken = false;
      let completed = false;

      try {
        for await (const event of assistant.answerStream(request)) {
          // The first `delta`, not the first event. `start` arrives before any model call, so timing to
          // it would measure nothing; the first delta is the moment the customer stops looking at a
          // spinner, which is the latency they actually experience.
          if (event.type === 'delta' && !firstToken) {
            firstToken = true;
            instruments.timeToFirstToken.observe(Date.now() - startedAt);
          }

          if (event.type === 'tool') {
            instruments.toolRounds.add({ tool: event.name, phase: event.phase });
          }

          if (event.type === 'done') {
            completed = true;
            recordTurn(event.reply, 'streamed', startedAt);
          }

          yield event;
        }
      } finally {
        // An abandoned stream is its own outcome. It is ordinary behaviour once — a closed tab — and a
        // signal at volume: either customers are giving up on the wait or a proxy is cutting
        // connections, and `abandoned` over `streamed` is the ratio that says which.
        if (!completed) {
          instruments.assistantTurns.add({ mode: 'streamed', outcome: 'abandoned' });
          instruments.assistantDuration.observe(Date.now() - startedAt, { mode: 'streamed' });
        }
      }
    },
  };
}
