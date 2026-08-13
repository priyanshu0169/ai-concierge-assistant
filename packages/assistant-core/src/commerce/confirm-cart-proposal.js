import { createHash } from 'node:crypto';
import { isLive } from './create-cart-proposal.js';

/**
 * Executing a confirmed proposal. The only place in ShopSage that changes a basket.
 *
 * Reached by a customer clicking a button, never by a model calling a tool. The ordering below is the
 * whole safety argument and every step is load-bearing:
 *
 * 1. **Consume** — take-once and atomic, so a double-tapped button has exactly one winner. This comes
 *    first, before any check, because a proposal that has been offered up is spent whatever happens
 *    next. Validating first and consuming after would leave the window open for the second tap.
 * 2. **Check ownership** — the confirming session must be the session that was offered it. A proposal
 *    id in a screenshot or a log must not let anybody else alter that cart.
 * 3. **Check expiry** — again, having also been a storage TTL. An expiry a customer can act on should
 *    not depend on how promptly a store reclaims memory.
 * 4. **Execute**, once, with an idempotency key derived from the proposal.
 *
 * Steps 2 and 3 return the same refusal, deliberately. A stranger holding a guessed id learns only
 * that it did not work, not whether it ever existed, whose it was, or when it expired.
 */

/**
 * @typedef {object} ConfirmationResult
 * @property {'applied' | 'rejected' | 'gone'} status
 * @property {string} message What the customer is told. From the connector where there is one.
 * @property {import('../types.js').CartOutcome} [outcome]
 */

/**
 * @param {{
 *   proposals: import('../types.js').CartProposalStore,
 *   cart: import('../types.js').CommerceCart,
 *   siteId: string,
 *   proposalId: string,
 *   subject: string,
 *   credential?: string,
 *   now?: number,
 *   logger?: import('@shopsage/platform').Logger,
 * }} input
 * @returns {Promise<ConfirmationResult>}
 */
export async function confirmCartProposal(input) {
  const now = input.now ?? Date.now();
  const proposal = await input.proposals.consume({ siteId: input.siteId, id: input.proposalId });

  if (proposal === undefined || !usable(proposal, input.subject, now)) {
    input.logger?.info('a cart confirmation was refused', {
      proposalId: input.proposalId,
      // Enough to diagnose, and nothing that identifies whose proposal it was. `subject mismatch` is
      // the one worth alerting on: a run of them is somebody trying ids, not a customer being slow.
      reason: proposal === undefined ? 'absent' : reasonFor(proposal, input.subject, now),
    });

    await restoreIfSomebodyElses({
      proposals: input.proposals,
      proposal,
      subject: input.subject,
      now,
    });

    return {
      status: 'gone',
      message:
        'That is no longer available to confirm. Ask the assistant again and it will prepare it.',
    };
  }

  const outcome = await execute({ proposal, cart: input.cart, credential: input.credential });

  input.logger?.info('a cart confirmation was executed', {
    proposalId: proposal.id,
    kind: proposal.kind,
    applied: outcome.applied,
  });

  return {
    status: outcome.applied ? 'applied' : 'rejected',
    // The connector's wording wherever it gave one - only the store knows how it says "that code has
    // expired". The fallbacks are neutral because ShopSage must not guess at a reason: "it did not
    // apply" is true, and "the code is invalid" might not be.
    message:
      outcome.message ??
      (outcome.applied
        ? 'Done — your basket has been updated.'
        : 'That could not be applied to your basket.'),
    outcome,
  };
}

/**
 * Put a proposal back when the caller was not its owner.
 *
 * The consume above is unconditional, which is what makes a double-tapped button safe — and left alone
 * it hands anybody who obtains a proposal id the power to **destroy** it without being able to use it.
 * Found by running two sessions against the stack: the wrong session's refused attempt left the right
 * one unable to confirm its own change. A narrow denial of service, since an id is 128 random bits and
 * an attacker holding one has already seen the customer's traffic or screen, but it costs nothing to
 * close and it is a bad shape to leave in a payment path.
 *
 * Only for a subject mismatch. An **expired** proposal is not restored: it is finished either way, and
 * writing it back would be storing something already dead.
 *
 * `save` recomputes the TTL from `expiresAt`, so the remaining life is preserved exactly rather than
 * reset. A restore failure is deliberately swallowed - the caller is already being refused, and the
 * owner's own retry is a better place to surface a store outage than somebody else's rejected attempt.
 *
 * @param {{
 *   proposals: import('../types.js').CartProposalStore,
 *   proposal: import('../types.js').CartProposal | undefined,
 *   subject: string,
 *   now: number,
 * }} input
 * @returns {Promise<void>}
 */
async function restoreIfSomebodyElses(input) {
  const { proposal } = input;

  if (proposal === undefined) return;
  if (proposal.subject === input.subject) return;
  if (!isLive(proposal, input.now)) return;

  try {
    await input.proposals.save(proposal);
  } catch {
    // Left alone on purpose. See above.
  }
}

/**
 * @param {{
 *   proposal: import('../types.js').CartProposal,
 *   cart: import('../types.js').CommerceCart,
 *   credential?: string,
 * }} input
 * @returns {Promise<import('../types.js').CartOutcome>}
 */
function execute(input) {
  const { proposal, cart } = input;
  const idempotencyKey = keyFor(proposal);
  const credential = input.credential;

  if (proposal.kind === 'applyCoupon' && proposal.code !== undefined) {
    return cart.applyCoupon({ code: proposal.code, idempotencyKey, credential });
  }

  if (proposal.kind === 'addToCart' && proposal.lines !== undefined) {
    return cart.addToCart({ lines: proposal.lines, idempotencyKey, credential });
  }

  // A stored proposal whose kind and payload disagree. Unreachable through the tools, so reaching it
  // means a storage format changed or an entry was tampered with - and doing *something* with a
  // half-understood basket instruction is the one option that is worse than doing nothing.
  throw new Error(`proposal ${proposal.id} has no payload for kind ${proposal.kind}`);
}

/**
 * The idempotency key, derived rather than random.
 *
 * A random key on each attempt would defeat the purpose: two attempts at the same confirmation must
 * carry the *same* key for a connector to recognise the repeat. Derived from the proposal id, which is
 * already unique and already single-use.
 *
 * Hashed rather than sent raw, because the id is a bearer token: whoever holds it can confirm the
 * proposal. A connector logging its idempotency keys - which is a normal thing to do - would otherwise
 * be writing confirmation tokens into its logs.
 *
 * @param {import('../types.js').CartProposal} proposal
 * @returns {string}
 */
function keyFor(proposal) {
  return createHash('sha256').update(`shopsage:${proposal.id}`).digest('hex').slice(0, 32);
}

/**
 * @param {import('../types.js').CartProposal} proposal
 * @param {string} subject
 * @param {number} now
 * @returns {boolean}
 */
function usable(proposal, subject, now) {
  return proposal.subject === subject && isLive(proposal, now);
}

/**
 * @param {import('../types.js').CartProposal} proposal
 * @param {string} subject
 * @param {number} now
 * @returns {string}
 */
function reasonFor(proposal, subject, now) {
  if (proposal.subject !== subject) return 'subject mismatch';

  return isLive(proposal, now) ? 'unknown' : 'expired';
}
