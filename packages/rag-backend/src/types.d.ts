import type { Logger } from '@shopsage/platform';
import type { AssistantSession } from '@shopsage/session-token';

/**
 * Per-request state attached by ShopSage middleware.
 *
 * Declared here rather than cast at each use site so that every handler sees
 * the same contract and a missing middleware becomes a type error.
 */
declare global {
  namespace Express {
    interface Request {
      /** Correlation id for this request. Echoed in the `x-request-id` header. */
      requestId: string;
      /** Request-scoped logger, pre-bound with `requestId`. */
      log: Logger;
      /**
       * The verified session, present on every `/v1` request.
       *
       * Non-optional deliberately: a handler that could receive `undefined` here would
       * grow a fallback, and a fallback in an authorisation path is how a gate stops
       * gating. If authentication is disabled, a synthetic guest session is supplied
       * instead — so the shape is always the same and the gating code is always
       * exercised.
       */
      session: AssistantSession;
      /**
       * The raw session token, for forwarding to the commerce connector.
       *
       * Kept **off** `session` on purpose. `session` holds only claims that are safe to log — the
       * subject is a pseudonym by contract, and `req.log` is bound with it. The token itself is a
       * bearer credential, so putting it on the same object would put it one careless
       * `log.info({ session })` away from log storage, and a credential in a log is a credential
       * leaked. A separate property means that mistake cannot be made by accident.
       *
       * Absent when authentication is disabled: there is no token to forward.
       */
      sessionCredential?: string;
    }
  }
}

export {};
