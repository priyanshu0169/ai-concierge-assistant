import { Router } from 'express';
import { ForbiddenError } from '@shopsage/platform';
import { confirmCartProposal } from '@shopsage/assistant-core';
import { z } from 'zod';
import { validateBody } from '../validate-body.js';

/**
 * Proposal ids are `cp_` plus 32 hex characters. Pinned rather than accepting any string, so a
 * malformed id is a 400 here instead of a lookup somewhere else with an attacker-shaped key in it.
 */
const confirmSchema = z.object({ proposalId: z.string().regex(/^cp_[0-9a-f]{32}$/u) }).strict();

/**
 * The confirmation endpoint. **The only way a basket changes.**
 *
 * A separate route from `/v1/chat` rather than another field on it, and that separation is the point
 * rather than tidiness: a cart change must be an act by a customer, and a distinct HTTP request made
 * by a click is what makes it one. Folding confirmation into the chat request would put "did the
 * customer agree?" back into text a model wrote.
 *
 * There is no `POST /v1/cart/items` and no `POST /v1/cart/coupon`. A client cannot ask for a basket
 * change at all — only to confirm one ShopSage already prepared and stored. So the surface a hostile
 * caller sees is "guess a 32-hex id belonging to your own session, within ten minutes", which is a
 * much smaller thing to defend than a general cart API.
 *
 * @param {{
 *   proposals: import('@shopsage/assistant-core').CartProposalStore,
 *   cart: import('@shopsage/assistant-core').CommerceCart,
 *   siteId: string,
 * }} dependencies
 * @returns {import('express').Router}
 */
export function createCartRouter(dependencies) {
  const router = Router();

  router.post('/cart/confirm', async (req, res) => {
    const { proposalId } = validateBody(confirmSchema, req.body);

    // The scope, checked here as well as when the tool was offered. A session that lacked `cart` never
    // saw the tool, so it should hold no proposal - but "should hold none" is an inference about
    // earlier behaviour, and an authorisation gate should not rest on one.
    //
    // `403`, not `404`: unlike a consumed proposal, this says nothing about whether any particular id
    // exists. The session is simply not allowed to confirm carts, which is true regardless of what it
    // asked for and therefore safe to say.
    if (!req.session.scopes.includes('cart')) {
      throw new ForbiddenError('This session may not confirm cart changes');
    }

    const result = await confirmCartProposal({
      proposals: dependencies.proposals,
      cart: dependencies.cart,
      siteId: dependencies.siteId,
      proposalId,
      // From the verified session, never from the body. A `subject` a caller could supply would make
      // the ownership check decorative.
      subject: req.session.subject,
      ...(req.sessionCredential === undefined ? {} : { credential: req.sessionCredential }),
      logger: req.log,
    });

    // `200` for every outcome, including a refusal, and that is deliberate. "Applied", "the store
    // declined it" and "that has expired" are all *answers* to a question the customer asked by
    // clicking; none is an error the client should retry or report as a failure. A `404` for a
    // consumed proposal would also confirm to a stranger that the id was once real.
    res.json({
      status: result.status,
      message: result.message,
      ...(result.outcome === undefined ? {} : { cart: toWireCart(result.outcome) }),
    });
  });

  return router;
}

/**
 * The cart, as a browser may see it.
 *
 * An allow-list. `total` is the connector's formatted string, repeated and never recomputed
 * (docs/adr/0028) — a widget rendering a total it derived from line prices is the same failure as a
 * model doing the arithmetic, one layer further out.
 *
 * @param {import('@shopsage/assistant-core').CartOutcome} outcome
 * @returns {Record<string, unknown>}
 */
function toWireCart(outcome) {
  return {
    ...(outcome.itemCount === undefined ? {} : { itemCount: outcome.itemCount }),
    ...(outcome.total === undefined ? {} : { total: outcome.total.formatted }),
    ...(outcome.cartUrl === undefined ? {} : { cartUrl: outcome.cartUrl }),
  };
}
