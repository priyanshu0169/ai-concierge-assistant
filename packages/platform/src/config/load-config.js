import path from 'node:path';
import { parseEnv } from './env-schema.js';
import { readJsonFile } from './read-json-file.js';
import { parseSiteProfile } from './site-profile-schema.js';

/**
 * @typedef {object} AppConfig
 * @property {import('./env-schema.js').EnvConfig} env Infrastructure and secrets.
 * @property {import('./site-profile-schema.js').SiteProfile} siteProfile Store behaviour and branding.
 * @property {string} siteProfilePath Resolved absolute path the profile was loaded from.
 */

/**
 * Load and validate the full application configuration.
 *
 * Called exactly once, from the composition root, before any dependency is
 * constructed. Configuration is validated eagerly and the process is expected
 * to exit on failure: a store running with a half-valid assistant profile
 * gives customers wrong answers, which is worse than downtime.
 *
 * @param {{ env?: Record<string, string | undefined>, cwd?: string }} [options]
 * @returns {Promise<Readonly<AppConfig>>}
 * @throws {import('../errors/errors.js').ConfigurationError} On any invalid value.
 */
export async function loadConfig(options = {}) {
  const { env = process.env, cwd = process.cwd() } = options;

  const parsedEnv = parseEnv(env);
  const siteProfilePath = path.resolve(cwd, parsedEnv.SITE_PROFILE_PATH);
  const document = await readJsonFile(siteProfilePath);
  const siteProfile = parseSiteProfile(document, siteProfilePath);

  return Object.freeze({ env: parsedEnv, siteProfile, siteProfilePath });
}
