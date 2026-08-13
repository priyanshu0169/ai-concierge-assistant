import { ShopsageWidget } from './element/shopsage-widget.js';

/**
 * @shopsage/widget — the embeddable assistant.
 *
 * One script tag is the whole integration:
 *
 * ```html
 * <script src="https://cdn.example.com/shopsage.js"
 *         data-backend-url="https://assistant.example.com"
 *         data-token-url="/assistant/session"
 *         defer></script>
 * ```
 *
 * The element is registered, and mounted automatically from the script tag's own attributes so
 * a host does not have to write markup at all. A page that wants control over placement can
 * skip the data attributes and write `<shopsage-widget backend-url="…">` itself.
 *
 * **Framework-agnostic by construction.** A custom element is the browser's own component
 * model: no runtime, no adapter, and nothing to reconcile with React, Vue or a server-rendered
 * page. `defer` rather than `async` in the example because registration should not race the
 * host's own scripts for no reason.
 *
 * **Platform-agnostic too.** Nothing here mentions Magento. The only host-specific value is
 * `token-url`, which is wherever *this* platform mints a session token — so the same bytes work
 * anywhere that can issue one the backend accepts.
 */

const TAG = 'shopsage-widget';

// Guarded, because a page that includes the bundle twice — two tag managers, or a partial
// hydration — would otherwise throw on the second registration and take the first one down
// with it.
if (globalThis.customElements !== undefined && customElements.get(TAG) === undefined) {
  customElements.define(TAG, ShopsageWidget);
}

autoMount();

/**
 * Mount from the script tag's data attributes, if it carries them.
 *
 * `document.currentScript` is only readable while the script is executing, which is why this
 * runs at module scope rather than on `DOMContentLoaded`.
 */
function autoMount() {
  const script = document.currentScript;

  if (!(script instanceof HTMLScriptElement)) return;

  const backendUrl = script.dataset.backendUrl;

  if (backendUrl === undefined) return;
  // Already present in the markup: respect it rather than adding a second panel.
  if (document.querySelector(TAG) !== null) return;

  const element = document.createElement(TAG);

  element.setAttribute('backend-url', backendUrl);
  if (script.dataset.tokenUrl !== undefined) {
    element.setAttribute('token-url', script.dataset.tokenUrl);
  }
  if (script.dataset.open !== undefined) element.setAttribute('open', '');

  // Appended to `body` so the widget's `position: fixed` is relative to the viewport. Inside a
  // transformed or `contain`-ed ancestor it would be positioned against that instead, and land
  // somewhere in the middle of the page.
  const mount = () => document.body.append(element);

  if (document.body === null) document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}

export { ShopsageWidget };
