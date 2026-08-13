import { createApiClient } from '../client/create-api-client.js';
import { createSessionStore } from '../session/create-session-store.js';
import { buildShell } from './build-shell.js';
import { createTranscript } from './transcript.js';
import { applyConfig } from './apply-config.js';
import { runTurn } from './run-turn.js';

/**
 * `<shopsage-widget>` — the whole public surface of this bundle.
 *
 * A custom element and nothing more: no framework, no global, no build step required of the
 * host. A page adds one script tag and one element, or lets the script add the element for it.
 *
 * **Contains no business logic**, and the boundary is worth stating precisely. It does not
 * build prompts, decide whether to retrieve, judge whether an answer is grounded, or know what
 * a tool is. It renders what three public endpoints return. Everything it knows about the
 * store — name, greeting, colours, suggestions, the message ceiling — arrives from
 * `GET /v1/config` at runtime, so the same bytes serve any store and any future platform.
 *
 * Attributes, all optional except the first:
 *
 * | Attribute    | Meaning                                                        |
 * | ------------ | -------------------------------------------------------------- |
 * | `backend-url`| Where ShopSage is. Required                                     |
 * | `token-url`  | Where the host mints a session token. Omit to run unauthenticated |
 * | `open`       | Present to start with the panel open                            |
 */
export class ShopsageWidget extends HTMLElement {
  /** @type {any} */
  #parts;
  /** @type {ReturnType<typeof createTranscript> | undefined} */
  #transcript;
  /** @type {ReturnType<typeof createApiClient> | undefined} */
  #api;
  #session = createSessionStore();
  /** @type {any} */
  #config;
  /** @type {AbortController | undefined} */
  #inFlight;
  /** @type {Element | null} */
  #returnFocusTo = null;
  #busy = false;

  connectedCallback() {
    if (this.#parts !== undefined) return;

    const backendUrl = this.getAttribute('backend-url');

    if (backendUrl === null) {
      // The console is the only correct channel here. This is an integration mistake on the
      // host page, made by whoever is looking at the console; painting an error box onto a
      // live shop would tell a customer about somebody else's bug.
      // eslint-disable-next-line no-console
      console.error('<shopsage-widget> needs a backend-url attribute');

      return;
    }

    const tokenUrl = this.getAttribute('token-url');

    this.#api = createApiClient({
      backendUrl,
      ...(tokenUrl === null ? {} : { tokenUrl }),
    });

    this.#parts = buildShell(this.attachShadow({ mode: 'open' }));
    this.#transcript = createTranscript(this.#parts);
    this.#wire();

    // Config is fetched now rather than on first open, so the launcher carries the store's own
    // label and colours immediately. A failure leaves the built-in defaults in place — a
    // working assistant with generic wording beats no assistant.
    void this.#loadConfig();
  }

  disconnectedCallback() {
    // Cancels the gateway call as well as the fetch: an answer nobody will read is still
    // billed. Same reasoning as the backend aborting on client disconnect.
    this.#inFlight?.abort();
  }

  /** Open the panel. Idempotent. */
  open() {
    if (!this.#parts.panel.hidden) return;

    this.#returnFocusTo = document.activeElement;
    this.#parts.panel.hidden = false;
    this.#parts.launcher.hidden = true;
    this.#parts.input.focus();
  }

  /** Close the panel, returning focus where it came from. */
  close() {
    if (this.#parts.panel.hidden) return;

    this.#parts.panel.hidden = true;
    this.#parts.launcher.hidden = false;

    // Focus goes back to whatever opened the panel — but never to `document.body`, which is
    // where `activeElement` points when the panel was opened programmatically rather than by a
    // click. Focusing the body loses focus entirely: a keyboard user is returned to the top of
    // the page and a screen reader announces nothing. Caught in a real browser, where the
    // synthetic open made exactly that happen.
    const target = /** @type {HTMLElement | null} */ (this.#returnFocusTo);
    const usable =
      target !== null &&
      target !== document.body &&
      target !== document.documentElement &&
      typeof target.focus === 'function' &&
      target.isConnected;

    if (usable) target.focus();
    else this.#parts.launcher.focus();
  }

  #wire() {
    const { launcher, close, composer, input, panel, prompts } = this.#parts;

    launcher.addEventListener('click', () => this.open());
    close.addEventListener('click', () => this.close());

    composer.addEventListener('submit', (/** @type {any} */ event) => {
      event.preventDefault();
      void this.#send(input.value);
    });

    input.addEventListener('keydown', (/** @type {any} */ event) => {
      // Enter sends; Shift+Enter is a newline. The convention every chat interface uses, and
      // getting it backwards makes multi-line questions impossible.
      if (event.key !== 'Enter' || event.shiftKey) return;

      event.preventDefault();
      void this.#send(input.value);
    });

    input.addEventListener('input', () => this.#onInput());

    // Escape closes from anywhere inside the panel, which is what a dialog is expected to do.
    panel.addEventListener('keydown', (/** @type {any} */ event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.close();
      }
    });

    prompts.addEventListener('click', (/** @type {any} */ event) => {
      const button = /** @type {HTMLElement} */ (event.target).closest('button');

      if (button !== null) void this.#send(button.textContent ?? '');
    });

    if (this.hasAttribute('open')) this.open();
  }

  #onInput() {
    const { input, counter, send } = this.#parts;
    const limit = this.#config?.limits?.maxUserMessageLength;

    // Grows with the text up to the CSS ceiling, so a long question is readable while it is
    // being written.
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 96)}px`;

    if (typeof limit !== 'number') return;

    const remaining = limit - input.value.length;

    // Shown only when it starts to matter. A counter present from the first keystroke reads as
    // a warning about nothing.
    counter.hidden = remaining > 200;
    counter.textContent = `${remaining} characters left`;
    send.disabled = this.#busy || remaining < 0;
  }

  async #loadConfig() {
    try {
      this.#config = await this.#api?.config();
      applyConfig(this, this.#parts, this.#config);
    } catch {
      // Deliberately silent to the customer. The defaults in `build-shell` and `styles` are
      // usable, and a store whose config endpoint is briefly unreachable should still be able
      // to answer questions.
      applyConfig(this, this.#parts, undefined);
    }
  }

  /** @param {string} raw */
  async #send(raw) {
    const message = raw.trim();
    const limit = this.#config?.limits?.maxUserMessageLength;

    if (message.length === 0 || this.#busy) return;
    // Enforced here as well as by the API, so a customer is stopped before spending a request
    // on a 400 they could have been warned about.
    if (typeof limit === 'number' && message.length > limit) return;

    this.#setBusy(true);
    this.#parts.input.value = '';
    this.#onInput();
    // Suggestions are a first-turn affordance. Leaving them up implies they are still the
    // useful next thing to ask, which after one answer they are not.
    this.#parts.prompts.hidden = true;

    this.#inFlight = new AbortController();

    await runTurn({
      message,
      api: /** @type {any} */ (this.#api),
      transcript: /** @type {any} */ (this.#transcript),
      parts: this.#parts,
      session: this.#session,
      config: this.#config,
      signal: this.#inFlight.signal,
    });

    this.#setBusy(false);
    this.#parts.input.focus();
  }

  /** @param {boolean} busy */
  #setBusy(busy) {
    this.#busy = busy;
    this.#parts.send.disabled = busy;
    // `aria-busy` on the log tells assistive technology that this region is mid-update, which
    // stops a partial answer being announced as though it were finished.
    this.#parts.transcript.setAttribute('aria-busy', String(busy));
  }
}
