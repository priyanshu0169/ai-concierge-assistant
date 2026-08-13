import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactPersonalData, redactTurn } from '../src/privacy/redact-personal-data.js';

describe('removing personal data before it is stored', () => {
  it('removes an email address', () => {
    const { text, removed } = redactPersonalData('write to me at sam.taylor@example.com please');

    assert.equal(text, 'write to me at [removed] please');
    assert.deepEqual(removed, ['email']);
  });

  it('removes a payment card number, however it was spaced', () => {
    // A Visa test number, which is what a customer pastes when an assistant mentions payment.
    for (const typed of ['4242424242424242', '4242 4242 4242 4242', '4242-4242-4242-4242']) {
      const { text, removed } = redactPersonalData(`my card is ${typed}`);

      assert.equal(text, 'my card is [removed]', typed);
      assert.deepEqual(removed, ['payment card'], typed);
    }
  });

  it('removes a phone number in national and international form', () => {
    for (const typed of ['07700 900123', '+44 7700 900123', '07700900123']) {
      const { removed } = redactPersonalData(`call me on ${typed}`);

      assert.deepEqual(removed, ['phone number'], typed);
    }
  });

  it('leaves an order reference alone', () => {
    // The whole risk of a redactor is the false positive: a customer whose order number gets eaten
    // watches the assistant lose the thread of their own question.
    const { text, removed } = redactPersonalData('where is order ORD-100482?');

    assert.equal(text, 'where is order ORD-100482?');
    assert.deepEqual(removed, []);
  });

  it('leaves a long digit run that is not card-shaped', () => {
    // 16 digits, and deliberately failing the Luhn check. Without that check this would be redacted
    // and a legitimate reference would be destroyed.
    const { text, removed } = redactPersonalData('the reference is 1234567890123456');

    assert.equal(text, 'the reference is 1234567890123456');
    assert.deepEqual(removed, []);
  });

  it('leaves prices, quantities and skus alone', () => {
    const original = 'is the HD-MRN-NVY-L still £120.00, and can I have 2 of them by 31/07/2026?';

    assert.equal(redactPersonalData(original).text, original);
  });

  it('does not damage a tracking URL that contains a long number', () => {
    // Roughly one in ten arbitrary digit runs passes a Luhn check, so a URL is excluded from
    // redaction outright: breaking a link a customer needs is a worse outcome than the risk.
    const original = 'track it at https://example.com/track/4242424242424242 for updates';

    assert.equal(redactPersonalData(original).text, original);
  });

  it('removes several kinds at once and reports each', () => {
    const { text, removed } = redactPersonalData(
      'sam@example.com, 07700 900123, card 4242 4242 4242 4242',
    );

    assert.equal(text, '[removed], [removed], card [removed]');
    assert.deepEqual(removed.sort(), ['email', 'payment card', 'phone number']);
  });

  it('leaves ordinary text untouched and reports nothing', () => {
    const original = 'do you have the navy hoodie in a large, and what is your returns policy?';
    const { text, removed } = redactPersonalData(original);

    assert.equal(text, original);
    assert.deepEqual(removed, []);
  });

  it('is idempotent, so a placeholder is never redacted again', () => {
    const once = redactPersonalData('email sam@example.com');
    const twice = redactPersonalData(once.text);

    assert.equal(twice.text, once.text);
    assert.deepEqual(twice.removed, []);
  });
});

describe('what this deliberately does not catch', () => {
  it('does not detect a free-text address, and does not pretend to', () => {
    // Documented rather than fixed. "34 Bridge Street, flat 2" has no structure that "34 pairs,
    // size 2" lacks, so a detector aggressive enough to catch it would shred ordinary product
    // questions. The real control is structural: no tool fetches an address, the order type has no
    // field for one, and trackOrder tells the model never to ask.
    const { removed } = redactPersonalData('deliver to 34 Bridge Street, flat 2, SW1A 1AA');

    assert.deepEqual(removed, []);
  });

  it('does not detect a postcode on its own', () => {
    assert.deepEqual(redactPersonalData('I am in SW1A 1AA').removed, []);
  });
});

describe('redacting a stored turn', () => {
  it('rewrites the content and keeps the rest of the turn intact', () => {
    const { turn, removed } = redactTurn({
      role: 'user',
      content: 'my email is sam@example.com',
      at: '2026-07-30T10:00:00.000Z',
    });

    assert.deepEqual(turn, {
      role: 'user',
      content: 'my email is [removed]',
      at: '2026-07-30T10:00:00.000Z',
    });
    assert.deepEqual(removed, ['email']);
  });

  it('returns the same object when there was nothing to remove', () => {
    const original = { role: 'assistant', content: 'Your order shipped.', at: 'now' };
    const { turn } = redactTurn(/** @type {any} */ (original));

    // Identity, not just equality: no allocation on the overwhelmingly common path.
    assert.equal(turn, original);
  });
});
