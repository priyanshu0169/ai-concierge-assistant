/**
 * Paint the store's own identity onto the widget.
 *
 * Everything here comes from `GET /v1/config` at runtime, which is what makes one bundle serve
 * every store: no build step per customer, no rebuild to change a greeting. A missing or
 * unreachable config leaves the built-in defaults, so the assistant still works — generically —
 * rather than not at all.
 *
 * Brand colours go into a dedicated `:host` stylesheet inside the shadow root, which is what
 * puts them at the right precedence: above the built-in defaults, below anything the host page
 * says. A store's brand is a default, not a decree. See `applyColors` for why the obvious
 * implementation gets this backwards.
 *
 * @param {HTMLElement} host
 * @param {any} parts
 * @param {any} config
 */
export function applyConfig(host, parts, config) {
  const assistantName = text(config?.assistantName) ?? 'Assistant';

  parts.heading.textContent = assistantName;
  parts.launcherText.textContent = text(config?.branding?.launcherLabel) ?? 'Ask us';
  // The launcher is an icon plus a short label, so the accessible name has to say what opening
  // it actually does — "Ask us" alone tells a screen-reader user nothing about the assistant.
  parts.launcher.setAttribute('aria-label', `Open chat with ${assistantName}`);
  parts.close.setAttribute('aria-label', `Close chat with ${assistantName}`);
  parts.input.setAttribute('aria-label', `Ask ${assistantName} a question`);

  applyLocale(host, parts, config);
  applyBranding(host, parts, config?.branding);
  applyWelcome(parts, config);
  applyQuickReplies(parts, config?.quickReplies);
}

/**
 * @param {HTMLElement} host
 * @param {any} parts
 * @param {any} config
 */
function applyLocale(host, parts, config) {
  const locale = text(config?.locale);

  // `lang` on the host so a screen reader pronounces the assistant's words with the right voice
  // and a browser hyphenates correctly. It is the store's language, not the page's, and those
  // genuinely differ on multilingual storefronts.
  if (locale !== undefined) {
    host.setAttribute('lang', locale);
    parts.panel.setAttribute('lang', locale);
  }
}

/**
 * @param {HTMLElement} host
 * @param {any} parts
 * @param {any} branding
 */
function applyBranding(host, parts, branding) {
  applyColors(parts, branding);

  if (branding?.position === 'bottom-left') host.setAttribute('data-position', 'bottom-left');

  const avatarUrl = text(branding?.avatarUrl);

  if (avatarUrl !== undefined && /^https?:\/\//iu.test(avatarUrl)) {
    parts.avatar.setAttribute('src', avatarUrl);
    parts.avatar.hidden = false;
  }
}

/**
 * @param {any} parts
 * @param {any} config
 */
function applyWelcome(parts, config) {
  const welcome = text(config?.welcomeMessage);

  if (welcome === undefined || parts.transcript.childElementCount > 0) return;

  const container = document.createElement('div');
  const bubble = document.createElement('div');

  container.className = 'message';
  container.setAttribute('data-role', 'assistant');
  bubble.className = 'bubble';
  // `textContent`, not markdown: a greeting is a single sentence a store wrote, and rendering
  // it as markup would mean an apostrophe or an asterisk in the copy changing the layout.
  bubble.textContent = welcome;
  container.append(bubble);
  parts.transcript.append(container);
}

/**
 * Brand colours, written into the shadow root's theme stylesheet as `:host` properties.
 *
 * **Not** as inline styles on the element, which is where they started. Inline styles beat any
 * stylesheet, so the store's brand became unoverridable and a page author's
 * `shopsage-widget { --shopsage-accent: … }` did nothing — the opposite of the documented
 * behaviour, and caught by driving a real browser rather than by reading the code.
 *
 * As `:host` rules the cascade lands correctly: host-document rules matching the element beat
 * `:host` rules in the shadow tree whatever their specificity, and `:host` beats the built-in
 * defaults. A store's brand is a default, not a decree.
 *
 * Each value is validated **before** it is interpolated into CSS text. That check is
 * load-bearing here in a way it was not before: a value containing `}` or `;` could otherwise
 * close the rule and inject arbitrary CSS. The hex pattern admits neither.
 *
 * @param {any} parts
 * @param {any} branding
 */
function applyColors(parts, branding) {
  const colors = {
    '--shopsage-primary': text(branding?.primaryColor),
    '--shopsage-accent': text(branding?.accentColor),
    '--shopsage-surface': text(branding?.surfaceColor),
  };

  const declarations = Object.entries(colors)
    .filter(([, value]) => value !== undefined && /^#[0-9a-f]{3,8}$/iu.test(value))
    .map(([property, value]) => `  ${property}: ${value};`);

  if (declarations.length === 0) return;

  parts.theme.textContent = `:host {\n${declarations.join('\n')}\n}`;
}

/**
 * Suggested prompts, as real buttons.
 *
 * Buttons rather than styled divs so they are reachable by Tab, activated by Enter and Space,
 * and announced as buttons — all of which come free from the element and none of which come
 * free from a click handler on a div.
 *
 * @param {any} parts
 * @param {unknown} quickReplies
 */
function applyQuickReplies(parts, quickReplies) {
  const usable = Array.isArray(quickReplies)
    ? quickReplies.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    : [];

  if (usable.length === 0) return;

  for (const reply of usable.slice(0, 8)) {
    const button = document.createElement('button');

    button.type = 'button';
    button.textContent = reply;
    parts.prompts.append(button);
  }

  parts.prompts.hidden = false;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function text(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
