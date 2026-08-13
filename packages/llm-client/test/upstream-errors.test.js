import assert from 'node:assert/strict';
import { REDACTED, UpstreamError, sanitizeUpstreamText } from '@shopsage/platform';
import { describe, it } from 'node:test';
import { mapUpstreamError } from '../src/transport/map-upstream-error.js';
import { TEST_API_KEY } from './helpers/fake-gateway.js';

/**
 * @param {{ status: number, body?: string, headers?: Record<string, string> }} input
 * @returns {Promise<UpstreamError>}
 */
function mapStatus(input) {
  const response = new Response(input.body ?? '{"error":{"message":"nope"}}', {
    status: input.status,
    headers: input.headers,
  });

  return mapUpstreamError({ response, apiKey: TEST_API_KEY });
}

describe('sanitizeUpstreamText', () => {
  it('removes the credential the client presented', () => {
    // OpenAI's own 401 body quotes the key back. Logging it verbatim writes the
    // credential into log storage, which is retained longer and read wider than
    // anything else in the system.
    const body = `Incorrect API key provided: ${TEST_API_KEY}. Check your keys.`;

    const sanitized = sanitizeUpstreamText(body, TEST_API_KEY);

    assert.ok(!sanitized.includes(TEST_API_KEY));
    assert.match(sanitized, /Incorrect API key provided: \[redacted\]/);
  });

  it('masks credential-shaped tokens it was not given', () => {
    const sanitized = sanitizeUpstreamText('key sk-live-9f8e7d6c5b4a rejected', 'other-secret');

    assert.ok(!sanitized.includes('sk-live-9f8e7d6c5b4a'));
    assert.equal(sanitized, `key ${REDACTED} rejected`);
  });

  it('masks an echoed Authorization header', () => {
    const sanitized = sanitizeUpstreamText('sent Bearer abcdef1234567890 which failed', undefined);

    assert.ok(!sanitized.includes('abcdef1234567890'));
  });

  it('collapses whitespace so a body cannot forge a second log record', () => {
    const sanitized = sanitizeUpstreamText(
      'line one\n{"level":"info","msg":"forged"}\n',
      undefined,
    );

    assert.ok(!sanitized.includes('\n'));
  });

  it('truncates a long body', () => {
    const sanitized = sanitizeUpstreamText('x'.repeat(2000), undefined);

    assert.ok(sanitized.length < 600);
    assert.ok(sanitized.endsWith('…'));
  });

  it('ignores a secret too short to search for safely', () => {
    // Replacing a 3-character "secret" would shred an unrelated message.
    const sanitized = sanitizeUpstreamText('the model was not found', 'the');

    assert.equal(sanitized, 'the model was not found');
  });

  it('handles an empty body', () => {
    assert.equal(sanitizeUpstreamText('', TEST_API_KEY), '');
  });
});

describe('mapUpstreamError', () => {
  it('treats 5xx as transient', async () => {
    const error = await mapStatus({ status: 503 });

    assert.ok(error instanceof UpstreamError);
    assert.equal(error.retryable, true);
    assert.equal(error.status, 502);
    assert.equal(error.details?.upstreamStatus, 503);
  });

  it('treats 4xx as final, because the same request will fail again', async () => {
    const error = await mapStatus({ status: 400 });

    assert.equal(error.retryable, false);
  });

  it('treats an upstream 408 as transient', async () => {
    const error = await mapStatus({ status: 408 });

    assert.equal(error.retryable, true);
  });

  it('masks its message, so a gateway hostname never reaches a customer', async () => {
    const error = await mapStatus({ status: 500 });

    assert.equal(error.expose, false);
  });

  describe('rate limiting', () => {
    it('reports an upstream 429 as a masked upstream failure, not a customer 429', async () => {
      // Telling a customer they are rate limited when the *gateway* is would be
      // wrong, and an exposed error publishes its details to the browser.
      const error = await mapStatus({ status: 429, headers: { 'retry-after': '3' } });

      assert.equal(error.status, 502);
      assert.equal(error.expose, false);
      assert.equal(error.retryable, true);
      assert.equal(error.retryAfterSeconds, 3);
    });

    it('accepts Retry-After as an HTTP date', async () => {
      const future = new Date(Date.now() + 5000).toUTCString();

      const error = await mapStatus({ status: 429, headers: { 'retry-after': future } });

      assert.ok((error.retryAfterSeconds ?? 0) > 0);
      assert.ok((error.retryAfterSeconds ?? 0) <= 6);
    });

    it('ignores an unparsable Retry-After', async () => {
      const error = await mapStatus({ status: 429, headers: { 'retry-after': 'soon' } });

      assert.equal(error.retryAfterSeconds, undefined);
    });

    it('copes with no Retry-After at all', async () => {
      const error = await mapStatus({ status: 429 });

      assert.equal(error.retryAfterSeconds, undefined);
      assert.equal(error.retryable, true);
    });
  });

  describe('operator guidance', () => {
    it('points at the credential on 401', async () => {
      const error = await mapStatus({ status: 401 });

      assert.match(String(error.details?.remediation), /LLM_API_KEY/);
    });

    it('also points at the model on 401, because gateways answer 401 for a forbidden model', async () => {
      // Verified against LiteLLM: requesting a model the key is not entitled to
      // use returns 401 `team not allowed to access model`, not 403 or 404.
      // Naming only the credential sends an operator to rotate a working key.
      const error = await mapStatus({
        status: 401,
        body: '{"error":{"message":"team not allowed to access model","code":"401"}}',
      });

      assert.match(String(error.details?.remediation), /LLM_MODEL/);
    });

    it('points at the base URL and model on 404', async () => {
      // The most common misconfiguration, and the least self-explanatory.
      const error = await mapStatus({ status: 404 });

      assert.match(String(error.details?.remediation), /LLM_BASE_URL/);
      assert.match(String(error.details?.remediation), /LLM_MODEL/);
    });

    it('offers no guidance where there is none to give', async () => {
      const error = await mapStatus({ status: 500 });

      assert.equal(error.details?.remediation, undefined);
    });
  });

  it('sanitizes the upstream body before it reaches the details', async () => {
    const error = await mapStatus({
      status: 401,
      body: `Incorrect API key provided: ${TEST_API_KEY}`,
    });

    assert.ok(!JSON.stringify(error.details).includes(TEST_API_KEY));
  });
});
