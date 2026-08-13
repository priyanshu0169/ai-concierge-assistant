const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Substitute `{{name}}` placeholders in site-profile copy.
 *
 * Placeholders exist so a store states its own name once, in `identity`, instead of
 * repeating it through the system prompt and the welcome message where the two can
 * drift apart.
 *
 * An unknown placeholder is left **as written**. Deleting it would silently change the
 * meaning of a prompt; leaving `{{assistantNmae}}` visible makes the typo obvious the
 * first time anyone reads the output.
 *
 * A substituted value is not re-scanned, so a store's own copy cannot expand into
 * another placeholder.
 *
 * @param {string} template
 * @param {Record<string, string>} values
 * @returns {string}
 */
export function renderTemplate(template, values) {
  return template.replace(PLACEHOLDER, (match, key) =>
    Object.hasOwn(values, key) ? values[key] : match,
  );
}

/**
 * The values every piece of store copy may interpolate.
 *
 * @param {import('@shopsage/platform').SiteProfile} siteProfile
 * @returns {Record<string, string>}
 */
export function identityValues(siteProfile) {
  const { identity } = siteProfile;

  return {
    assistantName: identity.assistantName,
    companyName: identity.companyName,
  };
}
