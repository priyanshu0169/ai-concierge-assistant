/**
 * Where a conversation id lives between page loads.
 *
 * **`sessionStorage`, not `localStorage`.** The distinction is the point: a conversation is
 * session-scoped, so it should survive a page navigation and a refresh, and end when the tab
 * does. `localStorage` would resurrect a conversation from last Tuesday — long after the
 * server's own idle timeout dropped it, so the id would be accepted and answer with no
 * history, which is worse than starting fresh.
 *
 * The **session token is deliberately not stored here.** It is a credential; it is cheap to
 * re-mint; and anything in storage is readable by every script on the origin for the life of
 * the tab. It lives in a closure in the API client instead.
 *
 * Every access is guarded. `sessionStorage` throws rather than returning null in private
 * browsing modes and when a page is sandboxed, and a widget must not fail to load because
 * storage is unavailable — it degrades to a conversation that does not survive a refresh.
 *
 * @param {{ key?: string, storage?: Storage }} [options]
 */
export function createSessionStore(options = {}) {
  const key = options.key ?? 'shopsage:conversation';
  const storage = options.storage ?? safeStorage();

  return {
    /** @returns {string | undefined} */
    conversationId() {
      const stored = read(storage, key);

      // Validated on the way out, not merely read. This is a storage key on the server, and
      // another script on the origin can write anything here — so a value that does not look
      // like an id the API would accept is discarded rather than sent.
      return stored !== undefined && /^[A-Za-z0-9_-]{1,64}$/u.test(stored) ? stored : undefined;
    },

    /** @param {string} conversationId */
    remember(conversationId) {
      write(storage, key, conversationId);
    },

    forget() {
      remove(storage, key);
    },
  };
}

/**
 * @returns {Storage | undefined}
 */
function safeStorage() {
  try {
    // Touching it is the only reliable test: it exists and throws on access when a page is
    // sandboxed without `allow-same-origin`.
    const probe = globalThis.sessionStorage;

    probe.getItem('shopsage:probe');

    return probe;
  } catch {
    return undefined;
  }
}

/**
 * @param {Storage | undefined} storage
 * @param {string} key
 * @returns {string | undefined}
 */
function read(storage, key) {
  try {
    return storage?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {Storage | undefined} storage
 * @param {string} key
 * @param {string} value
 */
function write(storage, key, value) {
  try {
    storage?.setItem(key, value);
  } catch {
    // Full, or denied. A conversation that does not survive a refresh is a small loss; a
    // widget that throws while answering is not.
  }
}

/**
 * @param {Storage | undefined} storage
 * @param {string} key
 */
function remove(storage, key) {
  try {
    storage?.removeItem(key);
  } catch {
    // As above.
  }
}
