import { createLogger, parseEnv, parseSiteProfile } from '@shopsage/platform';

/**
 * A logger that validates like the real one but writes nowhere, so test output
 * stays readable.
 *
 * @returns {import('@shopsage/platform').Logger}
 */
export function createSilentLogger() {
  return createLogger({ sink: { write: () => {} } });
}

/**
 * Build an `AppConfig` without touching the filesystem.
 *
 * Uses the real parsers rather than a hand-written object literal: a test that
 * fabricates config can drift from the schema and hide a genuine break.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   features?: Record<string, unknown>,
 *   integrations?: Record<string, unknown>,
 *   conversation?: Record<string, unknown>,
 * }} [overrides]
 * @returns {Readonly<import('@shopsage/platform').AppConfig>}
 */
export function buildTestConfig(overrides = {}) {
  const env = parseEnv({ NODE_ENV: 'test', ...overrides.env });

  const siteProfile = parseSiteProfile({
    identity: {
      siteId: 'test-store',
      companyName: 'Test Store',
      assistantName: 'Helper',
    },
    localization: { locale: 'en-GB', currency: 'gbp', timezone: 'Europe/London' },
    prompts: {
      systemPrompt: 'You are a helpful shopping assistant for this store.',
      welcomeMessage: 'Hello there.',
      fallbackMessage: 'Something went wrong.',
      noAnswerMessage: 'I could not find that.',
    },
    features: { productSearch: true, ...overrides.features },
    integrations: { backendUrl: 'https://assistant.example.com', ...overrides.integrations },
    ...(overrides.conversation === undefined ? {} : { conversation: overrides.conversation }),
  });

  return Object.freeze({ env, siteProfile, siteProfilePath: '/test/site-profile.json' });
}

/**
 * An LLM client that records what it was asked and answers from a script.
 *
 * Recording the messages is the point: the assertions that matter are about what
 * ShopSage *sent* - that the system prompt came from the site profile and had its
 * placeholders resolved - and those are invisible in the response.
 *
 * @param {{
 *   content?: string,
 *   finishReason?: import('@shopsage/llm-client').LlmFinishReason,
 *   error?: Error,
 * }} [script]
 * @returns {import('@shopsage/llm-client').LlmClient & {
 *   calls: { messages: import('@shopsage/llm-client').LlmMessage[], options: object }[],
 * }}
 */
export function createStubLlmClient(script = {}) {
  const { content = 'A scripted answer.', finishReason = 'stop', error } = script;

  /** @type {{ messages: import('@shopsage/llm-client').LlmMessage[], options: object }[]} */
  const calls = [];

  return {
    calls,

    generate(messages, options = {}) {
      calls.push({ messages, options });

      if (error) return Promise.reject(error);

      return Promise.resolve({
        content,
        toolCalls: [],
        finishReason,
        usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
      });
    },

    async *stream(messages, options = {}) {
      calls.push({ messages, options });

      if (error) throw error;

      yield { type: 'delta', text: content };
      yield {
        type: 'end',
        completion: {
          content,
          toolCalls: [],
          finishReason,
          usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
        },
      };
    },
  };
}

/**
 * A conversation manager that answers without a model or a retriever.
 *
 * For tests about the HTTP surface — routing, validation, error envelopes, SSE framing —
 * which have no business exercising the domain.
 *
 * `deltas` scripts the streamed path. `errorAfter` makes the stream fail *mid-flight*,
 * which is the case the buffered path cannot have: a status code has already been sent.
 *
 * `holdMs` keeps a stream open, which is the only way to have two of them in flight at
 * once — and concurrency limits are meaningless without that.
 *
 * @param {{
 *   answer?: string,
 *   sources?: { title: string, url?: string }[],
 *   error?: Error,
 *   deltas?: string[],
 *   errorAfter?: number,
 *   holdMs?: number,
 * }} [script]
 * @returns {import('@shopsage/assistant-core').ConversationManager & {
 *   requests: import('@shopsage/assistant-core').AssistantRequest[],
 * }}
 */
export function createStubAssistant(script = {}) {
  /** @type {import('@shopsage/assistant-core').AssistantRequest[]} */
  const requests = [];

  /** @param {import('@shopsage/assistant-core').AssistantRequest} request */
  const replyTo = (request) => ({
    conversationId: request.conversationId ?? 'c_stub',
    messageId: 'm_stub',
    answer: script.answer ?? 'A stubbed answer.',
    sources: script.sources ?? [],
    finishReason: /** @type {const} */ ('stop'),
    grounded: (script.sources ?? []).length > 0,
  });

  return {
    requests,

    answer(request) {
      requests.push(request);

      if (script.error) return Promise.reject(script.error);

      return Promise.resolve(replyTo(request));
    },

    async *answerStream(request) {
      requests.push(request);

      if (script.error) throw script.error;

      const reply = replyTo(request);
      yield { type: 'start', conversationId: reply.conversationId, messageId: reply.messageId };

      const deltas = script.deltas ?? [reply.answer];

      for (const [index, text] of deltas.entries()) {
        if (index === script.errorAfter) throw new Error('gateway died mid-stream');
        yield { type: 'delta', text };
      }

      if (script.holdMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, script.holdMs));
      }

      yield { type: 'done', reply };
    },
  };
}

/**
 * A dependency probe with a fixed outcome.
 *
 * @param {string} name
 * @param {'up' | 'down'} status
 * @returns {import('../../src/health/dependency-probe.js').DependencyProbe}
 */
export function createStubProbe(name, status) {
  return {
    name,
    check: () =>
      Promise.resolve({
        name,
        status,
        latencyMs: 1,
        ...(status === 'down' ? { error: 'stub failure' } : {}),
      }),
  };
}

/**
 * A middleware that supplies a session without verifying anything.
 *
 * Most HTTP tests are about routing, validation and envelopes, and threading a real token
 * through every one of them would test the verifier repeatedly and the route incidentally.
 * The verifier has its own suite, driven by the shared contract vectors.
 *
 * Defaults to a guest — `chat` and nothing else — so a test that assumes broader capability
 * has to say so, rather than inheriting it silently.
 *
 * @param {Partial<import('@shopsage/session-token').AssistantSession>} [session]
 * @returns {import('express').RequestHandler}
 */
export function createStubAuthentication(session = {}) {
  return function stubAuthentication(req, _res, next) {
    // Decorating `req` is how middleware publishes per-request state. The project scopes
    // that exception to `src/http/middleware/**`, deliberately, so this stand-in has to say
    // so explicitly rather than have the rule relaxed for every test helper.
    // eslint-disable-next-line no-param-reassign
    req.session = {
      subject: 'ps_test',
      siteId: 'test-store',
      scopes: ['chat'],
      tokenId: 'jti_test',
      expiresAt: 4_000_000_000,
      ...session,
    };

    next();
  };
}
