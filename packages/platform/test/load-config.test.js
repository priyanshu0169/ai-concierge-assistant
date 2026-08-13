import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ConfigurationError } from '../src/errors/errors.js';
import { loadConfig } from '../src/config/load-config.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

/**
 * @param {string} contents
 * @returns {Promise<{ cwd: string, relativePath: string }>}
 */
async function writeTempProfile(contents) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'shopsage-config-'));
  await writeFile(path.join(cwd, 'profile.json'), contents, 'utf8');

  return { cwd, relativePath: './profile.json' };
}

describe('loadConfig', () => {
  it('loads the site profile committed to this repository', async () => {
    // Guards the shipped default: if config/site-profile.json ever drifts from
    // the schema, this fails here rather than at a customer's first request.
    const config = await loadConfig({ env: {}, cwd: REPO_ROOT });

    assert.equal(config.siteProfile.identity.siteId, 'demo-store');
    assert.ok(config.siteProfile.prompts.systemPrompt.length > 20);
    assert.equal(config.env.PORT, 3000);
    assert.equal(config.siteProfilePath, path.join(REPO_ROOT, 'config', 'site-profile.json'));
  });

  it('resolves a relative profile path against the supplied working directory', async () => {
    const { cwd, relativePath } = await writeTempProfile(
      JSON.stringify({
        identity: { siteId: 'temp-store', companyName: 'Temp', assistantName: 'Tempo' },
        prompts: {
          systemPrompt: 'You are a helpful shopping assistant for this store.',
          welcomeMessage: 'Hi.',
          fallbackMessage: 'Oops.',
          noAnswerMessage: 'Not found.',
        },
        integrations: { backendUrl: 'https://assistant.example.com' },
      }),
    );

    const config = await loadConfig({ env: { SITE_PROFILE_PATH: relativePath }, cwd });

    assert.equal(config.siteProfile.identity.assistantName, 'Tempo');
    assert.equal(config.siteProfilePath, path.join(cwd, 'profile.json'));
  });

  it('returns a frozen object so configuration cannot be mutated at runtime', async () => {
    const config = await loadConfig({ env: {}, cwd: REPO_ROOT });

    assert.equal(Object.isFrozen(config), true);
  });

  it('fails with a configuration error when the profile is missing', async () => {
    await assert.rejects(
      () => loadConfig({ env: { SITE_PROFILE_PATH: './nope.json' }, cwd: REPO_ROOT }),
      (error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /Unable to read configuration file/);
        return true;
      },
    );
  });

  it('fails with a configuration error when the profile is not valid JSON', async () => {
    const { cwd, relativePath } = await writeTempProfile('{ not json ');

    await assert.rejects(
      () => loadConfig({ env: { SITE_PROFILE_PATH: relativePath }, cwd }),
      (error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /not valid JSON/);
        return true;
      },
    );
  });

  it('fails before the profile is read when the environment is invalid', async () => {
    await assert.rejects(
      () => loadConfig({ env: { PORT: 'abc' }, cwd: REPO_ROOT }),
      (error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /Environment configuration is invalid/);
        return true;
      },
    );
  });
});
