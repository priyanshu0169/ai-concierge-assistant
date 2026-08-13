import { isSafeHref } from '../markdown/render-inline.js';

/**
 * The confirmation card: the one thing this widget does that is not rendering what the API returned.
 *
 * Everything else here is a view. This is an **affordance** — the button that turns a prepared change
 * into a real one — and that makes it the highest-consequence code in the package. Four rules follow
 * from that, and none of them is styling:
 *
 * 1. **The summary comes from the server and is rendered as text, not markdown.** The rest of the
 *    transcript is markdown because a model wrote it. This sentence is what consent is given to, so it
 *    must appear exactly as the backend composed it — a summary passed through a markdown renderer
 *    could have `**£89.00**` emphasised, a link inserted, or a line silently swallowed as syntax.
 * 2. **It disarms on the first click.** Not "shows a spinner": the button is removed from the
 *    accessibility tree and cannot be activated again. A double-tap on a phone is one gesture, and the
 *    server's take-once consume would refuse the second — but a UI that lets somebody press a
 *    buy-shaped button twice and says nothing has already failed them.
 * 3. **It expires visibly.** A proposal has ten minutes. A card that still looks live after that
 *    invites a click whose only possible outcome is a refusal.
 * 4. **It never states a total it computed.** The confirmed response carries the connector's own
 *    total, and that string is repeated verbatim (docs/adr/0028) — the same rule as the assistant's
 *    prose, one layer out.
 */

/**
 * @param {{
 *   proposal: any,
 *   onConfirm: (proposalId: string) => Promise<{ status: string, message: string, cart?: any }>,
 *   announce: (text: string) => void,
 * }} input
 * @returns {HTMLElement | undefined}
 */
export function createConfirmation(input) {
  const { proposal } = input;

  // A proposal with no id cannot be confirmed, so no card is drawn. Rendering a dead button because
  // the payload was odd would be worse than rendering nothing: the model has already said something is
  // prepared, and a button that fails silently reads as the store being broken.
  if (typeof proposal?.id !== 'string' || typeof proposal.summary !== 'string') return undefined;

  const card = element('div', 'proposal');

  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', 'Confirm this change to your basket');

  card.append(
    heading(proposal.kind),
    // `textContent`, never markdown. See rule 1 above.
    summary(proposal.summary),
    ...lines(proposal.lines),
  );

  const actions = element('div', 'proposal-actions');
  const confirm = element('button', 'proposal-confirm');
  const status = element('p', 'proposal-status');

  confirm.type = 'button';
  confirm.textContent = 'Confirm';
  status.hidden = true;
  // Polite rather than assertive: the outcome matters but it is not an alert, and assertive would cut
  // across a screen reader mid-sentence.
  status.setAttribute('aria-live', 'polite');

  const settle = (/** @type {string} */ text) => {
    // Removed, not disabled. A disabled button stays focusable in some browsers and keeps announcing
    // itself; removing it means the decision is visibly over.
    confirm.remove();
    status.textContent = text;
    status.hidden = false;
    input.announce(text);
  };

  confirm.addEventListener('click', () => {
    if (confirm.disabled) return;

    // Checked here as well as by the timer below, and this is the check that matters. A tab suspended
    // by a phone locking, a laptop sleeping, or a browser throttling background timers can all leave
    // the visual disarm unfired - so correctness cannot rest on a timer having run. The server would
    // refuse an expired proposal anyway; this saves the customer a round trip to be told so.
    if (!isLive(proposal.expiresAt)) {
      settle('This expired before it was confirmed. Just ask again.');

      return;
    }

    // Set before the `await`, so a second click in the same tick finds it already true. The server
    // would refuse the duplicate anyway; this is about the customer not being able to press it twice.
    confirm.disabled = true;
    confirm.textContent = 'Confirming…';

    input
      .onConfirm(proposal.id)
      .then((result) => settle(describe(result)))
      .catch(() =>
        // Deliberately non-committal. A failed request may have arrived and been applied, so "it did
        // not work" would be a guess. Sending them to their basket is the only honest instruction.
        settle('We could not tell whether that worked. Please check your basket.'),
      );
  });

  actions.append(confirm, expiryNote(proposal.expiresAt));
  card.append(actions, status);

  scheduleExpiry(proposal.expiresAt, () => {
    if (confirm.isConnected) settle('This expired before it was confirmed. Just ask again.');
  });

  return card;
}

/**
 * @param {{ status: string, message: string, cart?: any }} result
 * @returns {string}
 */
function describe(result) {
  const total =
    typeof result.cart?.total === 'string' ? ` Basket total: ${result.cart.total}.` : '';

  // `message` is the store's own wording wherever the connector gave one, so it is shown as-is. The
  // total is a string the connector formatted; nothing here adds anything up.
  return result.status === 'applied' ? `${result.message}${total}` : result.message;
}

/**
 * @param {string} kind
 * @returns {HTMLElement}
 */
function heading(kind) {
  const node = element('p', 'proposal-heading');

  node.textContent =
    kind === 'applyCoupon' ? 'Apply this discount code?' : 'Add this to your basket?';

  return node;
}

/**
 * @param {string} text
 * @returns {HTMLElement}
 */
function summary(text) {
  const node = element('p', 'proposal-summary');

  node.textContent = text;

  return node;
}

/**
 * The lines, when the proposal carried them.
 *
 * Redundant with the summary on purpose: the summary is the authoritative sentence, and this is the
 * scannable version with a link per product so a customer can open the page they are agreeing to buy
 * from. `isSafeHref` is the same check the markdown renderer applies — a URL from the network is a URL
 * from the network wherever it arrives.
 *
 * @param {any} value
 * @returns {HTMLElement[]}
 */
function lines(value) {
  if (!Array.isArray(value) || value.length === 0) return [];

  const list = element('ul', 'proposal-lines');

  for (const line of value) {
    if (typeof line?.name === 'string') list.append(lineItem(line));
  }

  return list.childElementCount === 0 ? [] : [list];
}

/**
 * @param {any} line
 * @returns {HTMLElement}
 */
function lineItem(line) {
  const item = document.createElement('li');
  const label = `${line.quantity ?? 1} × ${line.name}`;

  item.append(labelNode(label, line.url));

  // The price as the connector formatted it, per line. Never a subtotal.
  if (typeof line.price?.formatted === 'string') {
    const price = element('span', 'proposal-price');

    price.textContent = ` ${line.price.formatted} each`;
    item.append(price);
  }

  return item;
}

/**
 * A link when the URL is one a customer can safely open, plain text otherwise.
 *
 * @param {string} label
 * @param {unknown} url
 * @returns {Node}
 */
function labelNode(label, url) {
  if (typeof url !== 'string' || !isSafeHref(url)) return document.createTextNode(label);

  const link = document.createElement('a');

  link.href = url;
  link.target = '_blank';
  // `noopener` is the one that matters: without it the opened page can reach back through
  // `window.opener`, and this link came off the network.
  link.rel = 'noopener noreferrer';
  link.textContent = label;

  return link;
}

/**
 * @param {unknown} expiresAt
 * @returns {HTMLElement}
 */
function expiryNote(expiresAt) {
  const node = element('span', 'proposal-expiry');
  const at = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;

  node.textContent = Number.isNaN(at)
    ? 'Nothing changes until you confirm.'
    : `Nothing changes until you confirm. Expires ${timeOf(at)}.`;

  return node;
}

/**
 * @param {number} at
 * @returns {string}
 */
function timeOf(at) {
  // The browser's locale, not the store's. This is a clock time for the person reading it.
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * @param {unknown} expiresAt
 * @param {() => void} onExpiry
 */
function scheduleExpiry(expiresAt, onExpiry) {
  const at = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;

  if (Number.isNaN(at)) return;

  const delay = at - Date.now();

  // Already stale, so disarm now rather than waiting for a timer to fire immediately.
  if (delay <= 0) {
    onExpiry();

    return;
  }

  const timer = setTimeout(onExpiry, delay);

  // `unref` where it exists, which is Node and not a browser. A ten-minute timer is nothing to a page
  // that is already alive, and everything to a process waiting to exit - without this the widget's own
  // test run hangs for ten minutes per card. Optional-called rather than feature-detected because the
  // absence in a browser is the normal case, not an error.
  /** @type {any} */ (timer)?.unref?.();
}

/**
 * @param {unknown} expiresAt
 * @returns {boolean}
 */
function isLive(expiresAt) {
  const at = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;

  // An unparseable expiry is treated as live. The server holds the real one and will refuse if it has
  // passed; refusing here on a field this code could not read would break a working confirmation over a
  // formatting difference.
  return Number.isNaN(at) || at > Date.now();
}

/**
 * @param {string} tag
 * @param {string} className
 * @returns {any}
 */
function element(tag, className) {
  const node = document.createElement(tag);

  node.className = className;

  return node;
}
