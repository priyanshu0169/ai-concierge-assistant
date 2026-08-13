import { Router } from 'express';
import { NotFoundError } from '@shopsage/platform';
import { buildChatRequestSchema } from '../chat-request-schema.js';
import { buildErrorEnvelope } from '../error-envelope.js';
import { createConcurrencyGuard } from '../rate-limit/concurrency-guard.js';
import { openSseStream } from '../sse-stream.js';
import { validateBody } from '../validate-body.js';

/**
 * The chat endpoints, buffered and streamed.
 *
 * Both handlers read the same way: validate, delegate, serialize. Every decision - which
 * prompt, whether to search, what to do with an empty answer, which sources to cite -
 * sits behind `assistant-core`'s conversation manager, so the delivery layer has nothing
 * to test beyond the contract.
 *
 * The schema is built once at construction rather than per request: it depends only on
 * the site profile, which is fixed for the process's lifetime.
 *
 * @param {{
 *   assistant: import('@shopsage/assistant-core').ConversationManager,
 *   config: import('@shopsage/platform').AppConfig,
 * }} dependencies
 * @returns {import('express').Router}
 */
export function createChatRouter(dependencies) {
  const { assistant, config } = dependencies;
  const schema = buildChatRequestSchema(config.siteProfile);
  const includeStack = config.env.NODE_ENV !== 'production';
  const streams = createConcurrencyGuard({
    maxPerClient: config.env.MAX_CONCURRENT_STREAMS_PER_CLIENT,
    maxTotal: config.env.MAX_CONCURRENT_STREAMS,
  });
  const router = Router();

  // No `try`/`catch`: Express 5 forwards a rejected handler promise to the error
  // middleware, which owns the response envelope.
  router.post('/chat', async (req, res) => {
    const { message, conversationId } = validateBody(schema, req.body);

    const reply = await assistant.answer({
      message,
      conversationId,
      // The session's capabilities decide which tools the model is offered. A scope the
      // session lacks means the tool is absent, not that the request is refused.
      scopes: req.session.scopes,
      // The pseudonymous subject, recorded on any cart proposal the turn prepares and checked again
      // when the customer confirms it. Without this the domain falls back to the conversation id, and
      // the confirmation endpoint - which compares against `req.session.subject` - refuses every
      // proposal it was handed. Found by confirming one against a running stack.
      subject: req.session.subject,
      ...(req.sessionCredential === undefined ? {} : { credential: req.sessionCredential }),
      metadata: { requestId: req.requestId },
    });

    res.json(toChatResponse(reply));
  });

  router.post('/chat/stream', async (req, res) => {
    // All three must reject *before* the stream opens, while a status code is still
    // negotiable. Order matters: the flag decides whether the endpoint exists for this
    // store, so it is answered first; then whether the request is well-formed; then
    // whether there is capacity to serve it.
    assertStreamingEnabled(config.siteProfile);
    const { message, conversationId } = validateBody(schema, req.body);

    // A rate limit counts requests; this counts the ones still running. A stream holds a
    // connection and an LLM generation for the length of an answer, so a client well
    // inside its rate can still hold many at once.
    const release = streams.acquire(req.session.subject);

    try {
      const signal = abortOnDisconnect(req, res);

      await streamTurn({
        req,
        res,
        signal,
        includeStack,
        turn: assistant.answerStream({
          message,
          conversationId,
          scopes: req.session.scopes,
          // Same as the buffered path. Both must send it or a proposal prepared on one and confirmed
          // after the other would be refused, which is a bug that only shows up for stores with
          // streaming on — that is, almost all of them.
          subject: req.session.subject,
          ...(req.sessionCredential === undefined ? {} : { credential: req.sessionCredential }),
          metadata: { requestId: req.requestId },
          signal,
        }),
      });
    } finally {
      // `finally`, not after the await: an abandoned stream throws out of `streamTurn`
      // only sometimes, and a slot leaked on the other paths would shrink capacity for
      // the life of the process.
      release();
    }
  });

  return router;
}

/**
 * Relay one streamed turn to the client.
 *
 * Two failure paths, and which one applies depends on whether anything has been sent:
 *
 * - **Nothing sent yet** - rethrow, and the error middleware answers with a real status
 *   code and the standard envelope, exactly as it would for `POST /v1/chat`. This is why
 *   the stream opens lazily.
 * - **Mid-stream** - the 200 is already on the wire and no status code can be changed, so
 *   the failure becomes an `error` event. The envelope comes from the same builder the
 *   middleware uses, so a 5xx message is masked identically on both paths.
 *
 * A client that disconnects is neither. Cancelling the turn makes the gateway call reject,
 * and treating that rejection as a failure would file an `error` record with a stack trace
 * every time somebody closes a tab - which is normal behaviour, and which would bury real
 * failures in an error dashboard. There is also nobody left to send an event to.
 *
 * See docs/adr/0023.
 *
 * @param {{
 *   req: import('express').Request,
 *   res: import('express').Response,
 *   signal: AbortSignal,
 *   includeStack: boolean,
 *   turn: AsyncIterable<import('@shopsage/assistant-core').AssistantStreamEvent>,
 * }} input
 * @returns {Promise<void>}
 */
async function streamTurn(input) {
  const { req, res, turn } = input;
  const stream = openSseStream(res);

  try {
    for await (const event of turn) {
      stream.send(event.type, toWireEvent(event));
    }
  } catch (error) {
    if (!stream.started()) throw error;
    // Already recorded once, by whoever aborted. A second record adds nothing.
    if (input.signal.aborted) return;

    req.log.error('stream failed after the response began', { err: toError(error) });

    stream.send(
      'error',
      buildErrorEnvelope({ error, requestId: req.requestId, includeStack: input.includeStack }),
    );
  } finally {
    stream.close();
  }
}

/**
 * The buffered response body, and the `done` event's payload.
 *
 * Deliberately one function for both. A client that reads only `done` then sees exactly
 * what `POST /v1/chat` would have returned, so the two endpoints cannot drift into
 * different shapes for the same answer.
 *
 * `grounded` is **not** serialized on either path. It is an operational signal, logged for
 * whoever watches how often answers rest on retrieved content, and a browser has no use
 * for it - publishing it invites a client to branch on it and makes an internal metric a
 * contract.
 *
 * @param {import('@shopsage/assistant-core').AssistantReply} reply
 */
function toChatResponse(reply) {
  return {
    conversationId: reply.conversationId,
    messageId: reply.messageId,
    answer: reply.answer,
    sources: reply.sources,
    finishReason: reply.finishReason,
    ...(reply.proposal === undefined ? {} : { proposal: toWireProposal(reply.proposal) }),
  };
}

/**
 * A proposal, narrowed to what a browser needs to render a confirmation.
 *
 * An allow-list, like `/v1/config`, and three fields are withheld on purpose:
 *
 * - `subject` is the session pseudonym. The client already knows whose session it is, and publishing
 *   an identifier that gates confirmation gives a page no capability it lacked and one more thing to
 *   leak.
 * - `siteId` is internal. A client talks to one store by construction.
 * - `code` is redundant: the customer typed it and it is already in `summary`. A working discount code
 *   duplicated into a JSON payload ends up in browser history and console logs for no gain.
 *
 * `id` is published because it *is* the confirmation token — that is the point of it.
 *
 * @param {import('@shopsage/assistant-core').CartProposal} proposal
 * @returns {Record<string, unknown>}
 */
function toWireProposal(proposal) {
  return {
    id: proposal.id,
    kind: proposal.kind,
    // What the customer reads before agreeing, built by ShopSage from connector data rather than by
    // the model (docs/adr/0029).
    summary: proposal.summary,
    expiresAt: proposal.expiresAt,
    ...(proposal.lines === undefined ? {} : { lines: proposal.lines }),
  };
}

/**
 * Domain event to wire payload. The event *name* carries the type, so it is not repeated
 * in the data.
 *
 * @param {import('@shopsage/assistant-core').AssistantStreamEvent} event
 * @returns {Record<string, unknown>}
 */
function toWireEvent(event) {
  switch (event.type) {
    case 'start':
      return { conversationId: event.conversationId, messageId: event.messageId };
    case 'tool':
      return { name: event.name, phase: event.phase };
    case 'delta':
      return { text: event.text };
    case 'proposal':
      return toWireProposal(event.proposal);
    case 'done':
      return toChatResponse(event.reply);
    default:
      // Every case named, no `default` that quietly accepts a new one. The previous version routed
      // `done` through a `default`, and adding the `proposal` event sent it there too - it typechecked
      // as a union member and would have serialized a proposal as if it were a finished reply. Named
      // cases turn the next such addition into a type error, which is where it belongs.
      throw new Error(`unhandled stream event: ${JSON.stringify(event)}`);
  }
}

/**
 * Cancel the turn when the client goes away.
 *
 * Without this, closing a tab leaves the gateway generating an answer nobody will read,
 * billed in full. The signal reaches the LLM client, which cancels the request rather
 * than merely ignoring the result.
 *
 * `close` rather than `aborted`: it fires for a client that disconnects *and* for a
 * response that ended normally, and aborting an already-finished turn is a no-op.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {AbortSignal}
 */
function abortOnDisconnect(req, res) {
  const controller = new AbortController();

  res.on('close', () => {
    if (!res.writableEnded) {
      // `info`, not `warn`: closing a tab mid-answer is ordinary customer behaviour. The
      // signal worth acting on is the *rate*, which is an alerting question rather than a
      // reason to mark one request suspicious.
      req.log.info('client disconnected mid-stream', { path: req.originalUrl });
      controller.abort();
    }
  });

  return controller.signal;
}

/**
 * @param {import('@shopsage/platform').SiteProfile} siteProfile
 */
function assertStreamingEnabled(siteProfile) {
  if (siteProfile.features.streaming) return;

  // 404 rather than 403: a capability the store has not enabled does not exist for this
  // store. The alternative advertises a feature the caller cannot use.
  throw new NotFoundError('Streaming is not enabled for this store');
}

/**
 * @param {unknown} error
 * @returns {Error}
 */
function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
