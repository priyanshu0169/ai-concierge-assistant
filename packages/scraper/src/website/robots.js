/**
 * @typedef {object} RobotsRules
 * @property {(pathname: string) => boolean} isAllowed
 * @property {number | undefined} crawlDelaySeconds
 * @property {string[]} sitemaps
 */

/** Applies when robots.txt is missing, empty, or unreadable. */
const ALLOW_EVERYTHING = Object.freeze({
  isAllowed: () => true,
  crawlDelaySeconds: undefined,
  sitemaps: /** @type {string[]} */ ([]),
});

/**
 * Parse robots.txt into a decision function.
 *
 * A deliberately small subset of a specification with no formal standard: user-agent
 * groups, `Allow`, `Disallow`, `Crawl-delay` and `Sitemap`. No wildcard extensions
 * beyond `*` and `$`, which are the two every major crawler honours.
 *
 * Two rules that are easy to get wrong and matter:
 *
 * - **The longest matching rule wins, and `Allow` beats `Disallow` on a tie.** That
 *   is how a site says "none of /admin except /admin/help". Implementing
 *   first-match-wins instead makes a crawler ignore exactly the exceptions a site
 *   went out of its way to grant.
 * - **A group for a specific user-agent replaces the `*` group, it does not add to
 *   it.** Merging them would apply rules a site aimed at someone else.
 *
 * An empty `Disallow:` means "allow everything" and is not a prefix match on the
 * empty string, which would otherwise block the entire site.
 *
 * @param {string} contents
 * @param {string} userAgent Matched case-insensitively as a prefix.
 * @returns {RobotsRules}
 */
export function parseRobots(contents, userAgent) {
  if (typeof contents !== 'string' || contents.trim() === '') return ALLOW_EVERYTHING;

  const groups = collectGroups(contents);
  const sitemaps = collectSitemaps(contents);
  const group = selectGroup(groups, userAgent);

  if (group === undefined) return { ...ALLOW_EVERYTHING, sitemaps };

  return {
    isAllowed: (pathname) => decide(group.rules, pathname),
    // Last directive wins, which is how every crawler treats a repeated field.
    crawlDelaySeconds: group.delays.at(-1),
    sitemaps,
  };
}

/**
 * @typedef {object} RobotsRule
 * @property {string} pattern
 * @property {boolean} allow
 */

/**
 * A group under construction.
 *
 * `delays` is a list rather than a scalar so directives can be appended rather than
 * assigned - the coding standard forbids writing to a parameter's properties, and
 * the semantics are identical because a later `Crawl-delay` overrides an earlier one.
 *
 * @typedef {object} RobotsGroup
 * @property {string[]} agents
 * @property {RobotsRule[]} rules
 * @property {number[]} delays
 */

/**
 * @param {string} contents
 * @returns {RobotsGroup[]}
 */
function collectGroups(contents) {
  /** @type {RobotsGroup[]} */
  const groups = [];
  /** @type {RobotsGroup | undefined} */
  let current;
  let expectingAgents = false;

  for (const { field, value } of directives(contents)) {
    if (field === 'user-agent') {
      // Consecutive User-agent lines share one group of rules.
      if (current === undefined || !expectingAgents) {
        current = { agents: [], rules: [], delays: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      expectingAgents = true;
      continue;
    }

    if (current === undefined) continue;
    expectingAgents = false;
    applyDirective(current, field, value);
  }

  return groups;
}

/**
 * @param {RobotsGroup} group
 * @param {string} field
 * @param {string} value
 */
function applyDirective(group, field, value) {
  if (field === 'disallow') {
    // An empty Disallow is an explicit "allow everything", not a match on "".
    if (value !== '') group.rules.push({ pattern: value, allow: false });
    return;
  }

  if (field === 'allow' && value !== '') {
    group.rules.push({ pattern: value, allow: true });
    return;
  }

  if (field === 'crawl-delay') {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) group.delays.push(seconds);
  }
}

/**
 * @param {string} contents
 * @returns {string[]}
 */
function collectSitemaps(contents) {
  return [...directives(contents)]
    .filter(({ field }) => field === 'sitemap')
    .map(({ value }) => value)
    .filter((value) => value !== '');
}

/**
 * @param {string} contents
 * @returns {Generator<{ field: string, value: string }, void, void>}
 */
function* directives(contents) {
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    const separator = line.indexOf(':');
    if (separator === -1) continue;

    yield {
      field: line.slice(0, separator).trim().toLowerCase(),
      value: line.slice(separator + 1).trim(),
    };
  }
}

/**
 * Pick the group that applies to us: the most specific agent match, else `*`.
 *
 * @param {RobotsGroup[]} groups
 * @param {string} userAgent
 * @returns {RobotsGroup | undefined}
 */
function selectGroup(groups, userAgent) {
  const agent = userAgent.toLowerCase();

  const specific = groups.filter((group) =>
    group.agents.some((candidate) => candidate !== '*' && agent.startsWith(candidate)),
  );

  if (specific.length > 0) return specific[0];

  return groups.find((group) => group.agents.includes('*'));
}

/**
 * @param {RobotsRule[]} rules
 * @param {string} pathname
 * @returns {boolean}
 */
function decide(rules, pathname) {
  /** @type {RobotsRule | undefined} */
  let best;

  for (const rule of rules) {
    if (!matches(rule.pattern, pathname)) continue;

    // Longest pattern wins; on equal length, Allow wins.
    const better =
      best === undefined ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow);

    if (better) best = rule;
  }

  return best === undefined ? true : best.allow;
}

/**
 * @param {string} pattern Supports `*` as a wildcard and `$` as an end anchor.
 * @param {string} pathname
 * @returns {boolean}
 */
function matches(pattern, pathname) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;

  const source = body
    .split('*')
    .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');

  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(pathname);
}
