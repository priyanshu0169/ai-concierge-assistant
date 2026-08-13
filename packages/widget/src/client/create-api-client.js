import { readSse } from './read-sse.js';

/**
 * The widget's only contact with a server.
 *
 * Three public endpoints, and **nothing else**: `GET /v1/config`, `POST /v1/chat`,
 * `POST /v1/chat/stream`. There is no Magento in here, no prompt, no retrieval and no
 * knowledge of what an answer is made of — which is what lets the same bundle sit in front of
 * a different platform later. The widget renders what the API says.
 *
 * The session token is fetched from a URL supplied by the host page, never from a hardcoded
 * path. That is the one seam that keeps this platform-agnostic: any host able to mint a token
 * the backend accepts can serve this bundle unchanged.
 *
 * **The token is held in memory only.** Not `sessionStorage`, not a cookie. It is a
 * credential, it is cheap to re-mint from a same-origin endpoint that already holds the host's
 * session, and anything persisted is readable by every script on the origin for the life of
 * the tab. Keeping it in a closure means it dies with the page.
 *
 * @param {{
 *   backendUrl: string,
 *   tokenUrl?: string,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
export function createApiClient(options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = options.backendUrl.replace(/\/+$/u, '');

  const tokens = createTokenHolder({ url: options.tokenUrl, fetchImpl });
  const sessionToken = tokens.current;

  /**
   * @param {string} path
   * @param {{ body?: unknown, signal?: AbortSignal, accept?: string, retried?: boolean }} init
   * @returns {Promise<Response>}
   */
  const send = async (path, init) => {
    const bearer = await sessionToken();
    const response = await fetchImpl(`${base}${path}`, {
      method: init.body === undefined ? 'GET' : 'POST',
      headers: {
        accept: init.accept ?? 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });

    // A 401 is expected roughly every fifteen minutes: the backend distinguishes an expiry
    // from a rejection precisely so a client can do this rather than give up. Once only -
    // retrying a genuine rejection forever would hammer both services.
    if (response.status === 401 && init.retried !== true && options.tokenUrl !== undefined) {
      await sessionToken({ force: true });

      return send(path, { ...init, retried: true });
    }

    return response;
  };

  return {
    /** @returns {Promise<any>} */
    async config() {
      // No token: this route is public by design, and the widget needs it before a customer
      // has interacted with anything.
      const response = await fetchImpl(`${base}/v1/config`, {
        headers: { accept: 'application/json' },
      });

      if (!response.ok) throw new Error(`config request failed with ${response.status}`);

      return response.json();
    },

    /**
     * @param {{ message: string, conversationId?: string, signal?: AbortSignal }} input
     * @returns {Promise<any>}
     */
    async ask(input) {
      const response = await send('/v1/chat', {
        body: toRequestBody(input),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });

      if (!response.ok) throw await toError(response);

      return response.json();
    },

    /**
     * Confirm a prepared cart change.
     *
     * The **only** mutating call this client can make, and it takes no cart contents — just the id of
     * something the backend already prepared and stored. There is deliberately no `addToCart` here: a
     * page cannot ask for a basket change, only agree to one (docs/adr/0029).
     *
     * A failure is thrown rather than swallowed, because the caller has to say something careful: a
     * request that failed *may* have arrived and been applied, so the customer is sent to their basket
     * rather than told either way.
     *
     * @param {{ proposalId: string, signal?: AbortSignal }} input
     * @returns {Promise<any>}
     */
    async confirm(input) {
      const response = await send('/v1/cart/confirm', {
        body: JSON.stringify({ proposalId: input.proposalId }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });

      if (!response.ok) throw await toError(response);

      return response.json();
    },

    /**
     * @param {{ message: string, conversationId?: string, signal?: AbortSignal }} input
     * @returns {AsyncGenerator<{ name: string, data: any }>}
     */
    async *askStreaming(input) {
      const response = await send('/v1/chat/stream', {
        body: toRequestBody(input),
        accept: 'text/event-stream',
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });

      // Everything that can be a status code is one, because the backend opens the stream
      // lazily (docs/adr/0023). So a failure here is an ordinary error, not an event.
      if (!response.ok) throw await toError(response);
      if (response.body === null) throw new Error('the stream had no body');

      yield* readSse(response.body);
    },
  };
}

/**
 * The session token, held in a closure and nowhere else.
 *
 * Extracted so the two concerns stay apart: this owns *having* a credential, the client above
 * owns *using* one.
 *
 * Concurrent requests share one mint. Without that, opening the panel and immediately asking a
 * question starts two token requests, and whichever settles second overwrites the other — the
 * race `require-atomic-updates` warns about, and the reason the in-flight promise is what is
 * stored rather than the string.
 *
 * @param {{ url?: string, fetchImpl: typeof fetch }} options
 */
function createTokenHolder(options) {
  /** @type {Promise<string> | undefined} */
  let pending;

  const mint = async () => {
    const response = await options.fetchImpl(/** @type {string} */ (options.url), {
      // The host's own session cookie is what authorises this, so credentials must be sent -
      // the one request in the widget that needs them. Every call to ShopSage itself is
      // deliberately cookie-free, which is what keeps the API immune to CSRF.
      credentials: 'include',
      headers: { accept: 'application/json' },
    });

    if (!response.ok) throw new Error(`session token request failed with ${response.status}`);

    const body = /** @type {{ token?: unknown }} */ (await response.json());

    if (typeof body.token !== 'string') throw new Error('session token response had no token');

    return body.token;
  };

  return {
    /**
     * @param {{ force?: boolean }} [refresh]
     * @returns {Promise<string | undefined>}
     */
    current(refresh = {}) {
      if (options.url === undefined) return Promise.resolve(undefined);
      if (refresh.force === true) pending = undefined;

      // A failed mint clears the memo, so one network blip does not leave the widget
      // permanently unable to authenticate.
      pending ??= mint().catch((error) => {
        pending = undefined;
        throw error;
      });

      return pending;
    },
  };
}

/**
 * @param {{ message: string, conversationId?: string }} input
 */
function toRequestBody(input) {
  // Only the two fields the API accepts. It rejects unknown ones, deliberately, so sending a
  // stray field would turn a working widget into a 400 after a backend upgrade.
  return {
    message: input.message,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
  };
}

/**
 * Turn an error response into an `Error` carrying the API's own code.
 *
 * The **code** is what a caller branches on; the message is for a log, never for a customer.
 * The widget shows the store's `fallbackMessage` instead, because a server's phrasing is not
 * the store's voice and a masked 5xx message says nothing useful anyway.
 *
 * @param {Response} response
 * @returns {Promise<Error & { code?: string, status?: number }>}
 */
async function toError(response) {
  let code;

  try {
    code = /** @type {{ error?: { code?: string } }} */ (await response.json())?.error?.code;
  } catch {
    code = undefined;
  }

  return Object.assign(new Error(`request failed with ${response.status}`), {
    status: response.status,
    ...(code === undefined ? {} : { code }),
  });
}
