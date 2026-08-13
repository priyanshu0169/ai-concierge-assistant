import { STYLES } from './styles.js';

/**
 * Build the widget's DOM once, and hand back the parts that change.
 *
 * Constructed with `createElement` rather than an HTML template string for the same reason the
 * markdown renderer is: nothing in this widget assigns untrusted text through `innerHTML`, and
 * the way to guarantee that is to have no code path that could. The shell is static, so a
 * template would be safe here — but then the safe habit has an exception, and exceptions are
 * where the next author puts a model's answer.
 *
 * The accessibility structure is not decoration and is easy to get subtly wrong:
 *
 * - The panel is `role="dialog"` with `aria-modal="false"`. Not modal, deliberately: this sits
 *   on somebody's shop and must not trap a customer who wants to keep browsing. `true` would
 *   tell a screen reader the rest of the page no longer exists.
 * - The transcript is `role="log"` with `aria-live="polite"`, which is what makes an arriving
 *   answer announced without interrupting. `assertive` would talk over the customer.
 * - The transcript is `tabindex="0"` because it scrolls; a scroll region a keyboard cannot
 *   reach is a scroll region some people cannot read.
 * - The status line is a separate `role="status"`, so "searching the help centre" is announced
 *   without being read as part of the answer.
 *
 * @param {ShadowRoot} root
 */
export function buildShell(root) {
  const style = document.createElement('style');

  style.textContent = STYLES;

  // A second sheet, filled in from `GET /v1/config`, holding the store's brand as `:host`
  // custom properties.
  //
  // Separate from the first so the cascade lands the right way round. Rules in the *host
  // document* that match the element beat `:host` rules inside the shadow tree, whatever their
  // specificity — so a page author's `shopsage-widget { --shopsage-accent: … }` overrides the
  // store's brand, and the brand still overrides the built-in defaults above. Writing these as
  // inline styles on the element instead would invert that and make the profile unoverridable,
  // which is what happened before a browser test caught it.
  const theme = document.createElement('style');

  const launcher = element('button', { class: 'launcher', type: 'button' });
  const launcherText = document.createElement('span');

  launcher.append(icon('chat'), launcherText);

  const panel = element('div', {
    class: 'panel',
    role: 'dialog',
    'aria-modal': 'false',
    tabindex: '-1',
  });
  panel.hidden = true;

  const heading = element('h2', { id: 'shopsage-title' });
  const avatar = element('img', { class: 'avatar', alt: '' });

  avatar.hidden = true;

  const close = element('button', { class: 'close', type: 'button', 'aria-label': 'Close chat' });

  close.append(icon('close'));

  const header = element('div', { class: 'header' });

  header.append(avatar, heading, element('div', { class: 'spacer' }), close);
  // Names the dialog from its own heading rather than repeating the text in an attribute,
  // which would then be able to disagree with what is on screen.
  panel.setAttribute('aria-labelledby', 'shopsage-title');

  const body = buildBody();

  // A polite live region of its own, for things that are announcements rather than content:
  // "answer complete", or an error. Kept out of the transcript so it is never read as if the
  // assistant had said it.
  const announcer = element('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });

  panel.append(header, body.transcript, body.status, body.prompts, body.composer, body.counter);
  root.append(style, theme, launcher, panel, announcer);

  return { launcher, launcherText, panel, heading, avatar, close, announcer, theme, ...body };
}

/**
 * The transcript, status line, suggestions and composer.
 *
 * Split from the chrome above purely to keep each function readable; the grouping is the panel's
 * scrolling body versus its fixed frame.
 */
function buildBody() {
  const transcript = element('div', {
    class: 'transcript',
    role: 'log',
    'aria-live': 'polite',
    'aria-relevant': 'additions text',
    'aria-label': 'Conversation',
    tabindex: '0',
  });

  const status = element('div', { class: 'status', role: 'status', 'aria-live': 'polite' });

  status.hidden = true;

  const prompts = element('div', { class: 'prompts', role: 'group', 'aria-label': 'Suggestions' });

  prompts.hidden = true;

  const input = element('textarea', {
    rows: '1',
    'aria-label': 'Type your question',
    autocomplete: 'off',
  });
  const send = element('button', { type: 'submit' });

  send.textContent = 'Send';

  const composer = element('form', { class: 'composer' });

  composer.append(input, send);

  const counter = element('div', { class: 'counter', 'aria-hidden': 'true' });

  counter.hidden = true;

  return { transcript, status, prompts, composer, input, send, counter };
}

/**
 * @param {string} tag
 * @param {Record<string, string>} attributes
 * @returns {any}
 */
function element(tag, attributes = {}) {
  const node = document.createElement(tag);

  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);

  return node;
}

/**
 * Inline SVG, because an icon font or an external file would be a second request the host page
 * has to allow — and a widget that has to be added to a content-security policy twice is a
 * widget nobody installs.
 *
 * `aria-hidden`: each icon sits next to a real label, so announcing it would repeat.
 *
 * @param {'chat' | 'close'} name
 * @returns {SVGElement}
 */
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');

  path.setAttribute(
    'd',
    name === 'chat' ? 'M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-5A8 8 0 1 1 21 12z' : 'M6 6l12 12M18 6L6 18',
  );

  svg.append(path);

  return svg;
}
