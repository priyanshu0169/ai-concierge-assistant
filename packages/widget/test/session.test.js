import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSessionStore } from '../src/session/create-session-store.js';

/** A `Storage`-shaped object under test control. */
function fakeStorage(initial = {}) {
  /** @type {Record<string, string>} */
  const data = { ...initial };

  return {
    /** @param {string} key */
    getItem: (key) => data[key] ?? null,
    /**
     * @param {string} key
     * @param {string} value
     */
    setItem: (key, value) => {
      data[key] = value;
    },
    /** @param {string} key */
    removeItem: (key) => {
      delete data[key];
    },
    data,
  };
}

/** Storage that throws on every access: private browsing, or a sandboxed frame. */
const hostileStorage = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
  removeItem: () => {
    throw new Error('denied');
  },
};

describe('createSessionStore', () => {
  it('has no conversation before one starts', () => {
    const store = createSessionStore({ storage: /** @type {any} */ (fakeStorage()) });

    assert.equal(store.conversationId(), undefined);
  });

  it('remembers and returns a conversation id', () => {
    const store = createSessionStore({ storage: /** @type {any} */ (fakeStorage()) });

    store.remember('c_a1b2c3');

    assert.equal(store.conversationId(), 'c_a1b2c3');
  });

  it('forgets on request, so a dead conversation does not persist', () => {
    const storage = fakeStorage();
    const store = createSessionStore({ storage: /** @type {any} */ (storage) });

    store.remember('c_a1b2c3');
    store.forget();

    assert.equal(store.conversationId(), undefined);
  });

  describe('validating what it reads back', () => {
    // This is a storage key on the server, and any script on the origin can write to
    // sessionStorage. A value that would not be accepted by the API is discarded here rather
    // than sent — the same reasoning that makes the API validate it as an opaque token.

    it('rejects a path traversal attempt', () => {
      const store = createSessionStore({
        storage: /** @type {any} */ (fakeStorage({ 'shopsage:conversation': '../../etc/passwd' })),
      });

      assert.equal(store.conversationId(), undefined);
    });

    it('rejects an over-long value', () => {
      const store = createSessionStore({
        storage: /** @type {any} */ (
          fakeStorage({ 'shopsage:conversation': 'c_'.padEnd(200, 'x') })
        ),
      });

      assert.equal(store.conversationId(), undefined);
    });

    it('rejects one containing a space or a quote', () => {
      for (const bad of ['c_ 1', 'c_"1', 'c_<script>']) {
        const store = createSessionStore({
          storage: /** @type {any} */ (fakeStorage({ 'shopsage:conversation': bad })),
        });

        assert.equal(store.conversationId(), undefined, bad);
      }
    });

    it('accepts what the API would accept', () => {
      const store = createSessionStore({
        storage: /** @type {any} */ (
          fakeStorage({ 'shopsage:conversation': 'c_0e05d1cdcbeb473daf7f54e795b708de' })
        ),
      });

      assert.equal(store.conversationId(), 'c_0e05d1cdcbeb473daf7f54e795b708de');
    });
  });

  describe('when storage is unavailable', () => {
    // `sessionStorage` throws rather than returning null in private browsing modes and inside a
    // sandboxed frame. A widget must not fail to load because of it; it degrades to a
    // conversation that does not survive a refresh.

    it('reads as empty rather than throwing', () => {
      const store = createSessionStore({ storage: /** @type {any} */ (hostileStorage) });

      assert.equal(store.conversationId(), undefined);
    });

    it('swallows a failed write', () => {
      const store = createSessionStore({ storage: /** @type {any} */ (hostileStorage) });

      assert.doesNotThrow(() => store.remember('c_1'));
    });

    it('swallows a failed clear', () => {
      const store = createSessionStore({ storage: /** @type {any} */ (hostileStorage) });

      assert.doesNotThrow(() => store.forget());
    });

    it('works with no storage object at all', () => {
      const store = createSessionStore({ storage: undefined });

      assert.doesNotThrow(() => store.remember('c_1'));
      assert.equal(store.conversationId(), undefined);
    });
  });

  it('never stores a session token', () => {
    // A credential in storage is readable by every script on the origin for the life of the
    // tab, and this one is cheap to re-mint. It lives in a closure in the API client instead.
    const storage = fakeStorage();
    const store = createSessionStore({ storage: /** @type {any} */ (storage) });

    store.remember('c_1');

    assert.deepEqual(Object.keys(storage.data), ['shopsage:conversation']);
    assert.ok(!JSON.stringify(storage.data).toLowerCase().includes('token'));
  });
});
