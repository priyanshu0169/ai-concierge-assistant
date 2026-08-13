import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createConfirmation } from '../src/element/confirmation.js';
import { installDom } from './helpers/dom.js';

/** @type {() => void} */
let restore;

beforeEach(() => {
  restore = installDom();
});

afterEach(() => restore());

/** @param {Partial<any>} [overrides] */
function testProposal(overrides = {}) {
  return {
    id: 'cp_0123456789abcdef0123456789abcdef',
    kind: 'addToCart',
    summary: '2 × Merino wool hoodie, navy, large (HD-MRN-NVY-L) at £89.00 each',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    lines: [
      {
        sku: 'HD-MRN-NVY-L',
        name: 'Merino wool hoodie, navy, large',
        quantity: 2,
        price: { formatted: '£89.00' },
        url: 'https://store.example.com/p/merino-hoodie',
      },
    ],
    ...overrides,
  };
}

/**
 * @param {{
 *   proposal?: any,
 *   result?: any,
 *   failWith?: Error,
 * }} [options]
 */
function build(options = {}) {
  /** @type {string[]} */
  const announced = [];
  /** @type {string[]} */
  const confirmed = [];
  const parent = document.createElement('div');

  const card = createConfirmation({
    proposal: options.proposal ?? testProposal(),
    onConfirm: (/** @type {string} */ id) => {
      confirmed.push(id);

      return options.failWith === undefined
        ? Promise.resolve(options.result ?? { status: 'applied', message: 'Added to your basket.' })
        : Promise.reject(options.failWith);
    },
    announce: (/** @type {string} */ text) => announced.push(text),
  });

  if (card !== undefined) parent.append(card);

  return {
    card: /** @type {any} */ (card),
    parent: /** @type {any} */ (parent),
    announced,
    confirmed,
  };
}

/** @param {any} card */
function buttonOf(card) {
  return card.findAll('button')[0];
}

/** @param {any} card */
function statusOf(card) {
  return card.findAll('p').find((/** @type {any} */ node) => node.className === 'proposal-status');
}

/** Let a resolved promise chain settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('rendering a confirmation', () => {
  it('shows the summary the server composed, as text', () => {
    const { card } = build();
    const summary = card
      .findAll('p')
      .find((/** @type {any} */ node) => node.className === 'proposal-summary');

    // Never through the markdown renderer. This sentence is what consent is given to, so it must appear
    // exactly as the backend wrote it - a renderer could emphasise a price, insert a link, or swallow a
    // line as syntax.
    assert.equal(summary.textContent, testProposal().summary);
  });

  it('does not interpret markdown in the summary', () => {
    const { card } = build({
      proposal: testProposal({ summary: '**£89.00** and [a link](http://x)' }),
    });
    const summary = card
      .findAll('p')
      .find((/** @type {any} */ node) => node.className === 'proposal-summary');

    assert.equal(summary.textContent, '**£89.00** and [a link](http://x)');
    assert.equal(card.findAll('strong').length, 0);
  });

  it('names the action for a coupon differently from an item', () => {
    const items = build().card.textContent;
    const coupon = build({
      proposal: testProposal({ kind: 'applyCoupon', lines: undefined }),
    }).card.textContent;

    assert.match(items, /Add this to your basket\?/u);
    assert.match(coupon, /Apply this discount code\?/u);
  });

  it('says nothing changes until the customer confirms', () => {
    assert.match(build().card.textContent, /Nothing changes until you confirm/u);
  });

  it('links each line, with noopener', () => {
    const link = build().card.findAll('a')[0];

    assert.equal(link.href, 'https://store.example.com/p/merino-hoodie');
    assert.match(link.rel, /noopener/u);
    assert.match(link.textContent, /2 × Merino wool hoodie/u);
  });

  it('refuses to link a URL that is not http', () => {
    const proposal = testProposal({
      lines: [{ sku: 'X', name: 'Thing', quantity: 1, url: 'javascript:alert(1)' }],
    });
    const { card } = build({ proposal });

    // The same check the markdown renderer applies. A URL off the network is a URL off the network
    // wherever it arrives.
    assert.equal(card.findAll('a').length, 0);
    assert.match(card.textContent, /1 × Thing/u);
  });

  it('shows a line price as the connector formatted it, and no subtotal', () => {
    const { card } = build();

    assert.match(card.textContent, /£89\.00 each/u);
    // 2 × 89.00. Its appearance would mean the widget had started doing arithmetic on money.
    assert.ok(!card.textContent.includes('178'));
  });

  it('is a labelled group, for a screen reader', () => {
    const { card } = build();

    assert.equal(card.getAttribute('role'), 'group');
    assert.match(String(card.getAttribute('aria-label')), /basket/u);
  });

  it('renders nothing when there is no id to confirm', () => {
    const { card, parent } = build({ proposal: { summary: 'no id here' } });

    // A dead button reads as the store being broken, and the model has already said something is
    // prepared. Nothing is the better failure.
    assert.equal(card, undefined);
    assert.equal(parent.childElementCount, 0);
  });
});

describe('confirming', () => {
  it('sends the proposal id once', async () => {
    const { card, confirmed } = build();

    buttonOf(card).dispatch('click');
    await settle();

    assert.deepEqual(confirmed, ['cp_0123456789abcdef0123456789abcdef']);
  });

  it('disarms on the first click, so a double-tap cannot send twice', async () => {
    const { card, confirmed } = build();
    const button = buttonOf(card);

    button.dispatch('click');
    button.dispatch('click');
    await settle();

    // The server's take-once consume would refuse the second anyway. A UI that lets somebody press a
    // buy-shaped button twice and says nothing has already failed them.
    assert.deepEqual(confirmed, ['cp_0123456789abcdef0123456789abcdef']);
  });

  it('removes the button once settled, rather than only disabling it', async () => {
    const { card } = build();

    buttonOf(card).dispatch('click');
    await settle();

    // A disabled button stays focusable in some browsers and keeps announcing itself.
    assert.equal(buttonOf(card), undefined);
  });

  it("shows and announces the store's own message", async () => {
    const { card, announced } = build({
      result: { status: 'applied', message: 'Added to your basket.', cart: { total: '£178.00' } },
    });

    buttonOf(card).dispatch('click');
    await settle();

    assert.match(statusOf(card).textContent, /Added to your basket\./u);
    // The connector's own total string, repeated. Never one the widget worked out.
    assert.match(statusOf(card).textContent, /Basket total: £178\.00\./u);
    assert.equal(announced.length, 1);
  });

  it('shows a refusal without dressing it up as success', async () => {
    const { card } = build({ result: { status: 'rejected', message: 'That code has expired.' } });

    buttonOf(card).dispatch('click');
    await settle();

    assert.equal(statusOf(card).textContent, 'That code has expired.');
  });

  it('says it could not tell when the request failed', async () => {
    const { card } = build({ failWith: new Error('network') });

    buttonOf(card).dispatch('click');
    await settle();

    // Deliberately non-committal: a failed request may have arrived and been applied, so "it did not
    // work" would be a guess. Sending them to their basket is the only honest instruction.
    assert.match(statusOf(card).textContent, /could not tell whether that worked/u);
    assert.match(statusOf(card).textContent, /check your basket/u);
  });

  it('has a live region for the outcome', () => {
    const { card } = build();

    // Polite rather than assertive: the outcome matters but it is not an alert, and assertive would cut
    // across a screen reader mid-sentence.
    assert.equal(statusOf(card).getAttribute('aria-live'), 'polite');
  });
});

describe('expiry', () => {
  it('disarms immediately when the proposal has already expired', () => {
    const { card } = build({
      proposal: testProposal({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
    });

    // A card that still looks live invites a click whose only possible outcome is a refusal.
    assert.equal(buttonOf(card), undefined);
    assert.match(statusOf(card).textContent, /expired before it was confirmed/u);
  });

  it('shows the expiry time when there is one', () => {
    assert.match(build().card.textContent, /Expires \d/u);
  });

  it('still renders without a usable expiry', () => {
    const { card } = build({ proposal: testProposal({ expiresAt: 'not a date' }) });

    assert.ok(buttonOf(card));
    assert.match(card.textContent, /Nothing changes until you confirm\./u);
  });
});
