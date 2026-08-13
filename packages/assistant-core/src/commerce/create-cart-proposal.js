import { randomUUID } from 'node:crypto';

/**
 * Building a proposal, including the sentence the customer consents to.
 */

const PREFIX = 'cp_';

/**
 * How long a customer has to agree.
 *
 * Ten minutes. Long enough to read a summary, think, and click; short enough that the price shown was
 * the price a moment ago. An expiry measured in hours would let a customer confirm a figure the store
 * had since changed, which is the surprise the whole workflow exists to prevent - and the assistant
 * would have shown them that figure in good faith, which makes it worse rather than better.
 */
const LIFETIME_MS = 10 * 60_000;

/**
 * @param {{
 *   kind: 'addToCart' | 'applyCoupon',
 *   siteId: string,
 *   conversationId: string,
 *   subject: string,
 *   summary: string,
 *   now: number,
 *   lines?: import('../types.js').CartProposalLine[],
 *   code?: string,
 * }} input
 * @returns {import('../types.js').CartProposal}
 */
export function createCartProposal(input) {
  return {
    // Random, not sequential, because this id **is** the confirmation token. A guessable id would let
    // somebody confirm a proposal they were never shown; `subject` is the second lock on that door.
    id: `${PREFIX}${randomUUID().replaceAll('-', '')}`,
    kind: input.kind,
    siteId: input.siteId,
    conversationId: input.conversationId,
    subject: input.subject,
    summary: input.summary,
    expiresAt: new Date(input.now + LIFETIME_MS).toISOString(),
    ...(input.lines === undefined ? {} : { lines: input.lines }),
    ...(input.code === undefined ? {} : { code: input.code }),
  };
}

/**
 * Whether a proposal is still good.
 *
 * Checked at confirmation as well as being a storage TTL, and the duplication is deliberate: a TTL is
 * the backend's best effort, and an expiry a customer can act on should not depend on how promptly a
 * store reclaims memory.
 *
 * Takes only what it reads. A full `CartProposal` would be the obvious signature and asks for six
 * fields to look at one - which makes it awkward to call from a store that holds a decoded entry, and
 * impossible to call from a test without building a whole proposal to check a date.
 *
 * @param {{ expiresAt: string }} proposal
 * @param {number} now
 * @returns {boolean}
 */
export function isLive(proposal, now) {
  return Date.parse(proposal.expiresAt) > now;
}

/**
 * The sentence the customer agrees to, written by ShopSage.
 *
 * **Not written by the model**, and that is the point rather than a style preference. The model's
 * prose is what persuaded the customer; this is what the button does. If the two disagree - because a
 * model embellished, or misread which product was meant - the customer must be reading the one that
 * is true.
 *
 * Prices are repeated exactly as the connector formatted them and never totalled (docs/adr/0028).
 *
 * @param {import('../types.js').CartProposalLine[]} lines
 * @returns {string}
 */
export function summariseLines(lines) {
  return lines
    .map((line) => {
      const price = line.price === undefined ? '' : ` at ${line.price.formatted} each`;

      return `${line.quantity} × ${line.name} (${line.sku})${price}`;
    })
    .join('\n');
}
