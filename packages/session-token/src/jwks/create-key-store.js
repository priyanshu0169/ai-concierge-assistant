import {
  ServiceUnavailableError,
  UnauthorizedError,
  readJsonBody,
  sendRequest,
} from '@shopsage/platform';
import { importJwk, supportedAlgorithms } from '../verify-signature.js';

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * The floor between refetches triggered by an unrecognised `kid`.
 *
 * This is a security control, not a performance one. Without it, a stream of tokens carrying
 * random `kid` values makes this service fetch the JWKS once per request — turning
 * ShopSage's authentication into a denial-of-service amplifier pointed at the storefront it
 * depends on. The contract calls for at most one refetch a minute, and this is it.
 */
const MIN_REFETCH_INTERVAL_MS = 60_000;

/**
 * A cache of Magento's public keys.
 *
 * Holds public keys only, and never a private one — Magento is the sole issuer
 * (contract, decision 4), so there is nothing here worth stealing to mint a token with.
 *
 * Fetching is lazy, following the same rule as every other dependency: the service starts
 * without waiting and reports readiness honestly (docs/adr/0008, docs/adr/0014).
 *
 * @param {{
 *   url: string,
 *   cacheTtlMs?: number,
 *   timeoutMs?: number,
 *   logger?: import('@shopsage/platform').Logger,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 * }} options
 */
export function createKeyStore(options) {
  const { logger, now = Date.now } = options;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  /** @type {Map<string, import('node:crypto').KeyObject>} */
  let keys = new Map();
  let fetchedAt = 0;
  let lastAttemptAt = 0;
  /** @type {Promise<void> | undefined} */
  let inFlight;

  const isStale = () => now() - fetchedAt >= cacheTtlMs;

  /**
   * One fetch at a time. Without this, a burst of requests arriving on a cold cache each
   * start their own fetch of the same document.
   *
   * @returns {Promise<void>}
   */
  const load = () => {
    inFlight ??= fetchKeys(options)
      .then((fetched) => {
        keys = fetched;
        fetchedAt = now();
        logger?.debug('session key set refreshed', { keys: fetched.size });
      })
      .finally(() => {
        lastAttemptAt = now();
        inFlight = undefined;
      });

    return inFlight;
  };

  /**
   * Guarantee a usable key set, or fail with the right status.
   *
   * Two rules meet here, and the second is easy to get wrong. A refresh that fails while a
   * previous set is still held is **not** an error: those keys verify perfectly well, and
   * treating a cache miss as an outage manufactures one. But holding *no* keys is a `503`
   * and not a `401` — the caller's token may be entirely valid; we simply cannot check it,
   * and answering "your credentials are bad" sends an operator looking in the wrong place.
   *
   * @returns {Promise<void>}
   */
  const ensureKeys = async () => {
    if (isStale()) {
      try {
        await load();
      } catch (error) {
        if (keys.size === 0) throw unavailable(error);

        logger?.warn('serving a stale session key set', {
          err: error instanceof Error ? error : new Error(String(error)),
          ageMs: now() - fetchedAt,
          remediation: 'tokens still verify; check the issuer is reachable',
        });
      }
    }

    if (keys.size === 0) throw unavailable();
  };

  return {
    /**
     * Resolve a key by id, refetching once for an unrecognised one.
     *
     * @param {string} kid
     * @returns {Promise<import('node:crypto').KeyObject>}
     */
    async resolveKey(kid) {
      await ensureKeys();

      const cached = keys.get(kid);
      if (cached !== undefined) return cached;

      // An unknown `kid` is the ordinary signature of a rotation that happened inside the
      // cache window, so it is worth one look - bounded, for the reason above. The interval
      // also means a lookup immediately after a fetch does not fetch again: the document
      // cannot have changed in the meantime.
      if (now() - lastAttemptAt >= MIN_REFETCH_INTERVAL_MS) {
        await load().catch(() => {});
      }

      const refreshed = keys.get(kid);

      // `ensureKeys` has already guaranteed a non-empty set, so reaching here means the key
      // genuinely is not published - the caller's problem, not ours.
      if (refreshed === undefined) {
        throw new UnauthorizedError('Invalid session token', {
          details: { reason: 'unknown_kid' },
        });
      }

      return refreshed;
    },

    /**
     * For readiness. Fails only when **no** usable key set is held, so an issuer outage
     * cannot pull an instance that is still verifying tokens correctly out of the load
     * balancer.
     *
     * @returns {Promise<void>}
     */
    health: () => ensureKeys(),

    /** Visible for tests and the boot record. */
    size: () => keys.size,
  };
}

/**
 * One JWKS entry, if this build can verify with it.
 *
 * Unusable entries are **skipped rather than fatal**. A key set legitimately carries keys for
 * other purposes and other algorithms, and one entry this build does not understand must not
 * make every token unverifiable.
 *
 * @param {unknown} jwk
 * @param {Set<string>} algorithms
 * @returns {{ kid: string, value: import('node:crypto').KeyObject } | undefined}
 */
function toSigningKey(jwk, algorithms) {
  const { kid, alg, use } = /** @type {Record<string, unknown>} */ (jwk);

  if (typeof kid !== 'string') return undefined;
  if (use !== undefined && use !== 'sig') return undefined;
  if (typeof alg === 'string' && !algorithms.has(alg)) return undefined;

  try {
    return { kid, value: importJwk(/** @type {Record<string, unknown>} */ (jwk)) };
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} [cause]
 * @returns {ServiceUnavailableError}
 */
function unavailable(cause) {
  return new ServiceUnavailableError('Session keys are unavailable', {
    ...(cause === undefined ? {} : { cause }),
    details: { remediation: "the issuer's JWKS endpoint could not be reached" },
    retryAfterSeconds: 5,
  });
}

/**
 * @param {{ url: string, timeoutMs?: number, fetchImpl?: typeof fetch }} options
 * @returns {Promise<Map<string, import('node:crypto').KeyObject>>}
 */
async function fetchKeys(options) {
  const response = await sendRequest({
    url: options.url,
    method: 'GET',
    headers: { accept: 'application/json' },
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    label: 'session keys',
    fetchImpl: options.fetchImpl,
  });

  // `sendRequest` deliberately does not interpret a status code - what one means is the
  // dependency's semantics, which live here. Any non-2xx from a JWKS endpoint means the same
  // thing: no keys.
  if (!response.ok) {
    throw new ServiceUnavailableError('Session key set could not be fetched', {
      details: { upstreamStatus: response.status },
    });
  }

  return toKeyMap(await readJsonBody(response, 'session keys'));
}

/**
 * @param {unknown} body
 * @returns {Map<string, import('node:crypto').KeyObject>}
 */
function toKeyMap(body) {
  const entries = /** @type {{ keys?: unknown }} */ (body)?.keys;

  if (!Array.isArray(entries)) {
    throw new ServiceUnavailableError('Session key set is not a JWKS document', {
      details: { remediation: 'expected a JSON object with a "keys" array' },
    });
  }

  /** @type {Map<string, import('node:crypto').KeyObject>} */
  const map = new Map();
  const algorithms = new Set(supportedAlgorithms());

  for (const jwk of entries) {
    const key = toSigningKey(jwk, algorithms);

    if (key !== undefined) map.set(key.kid, key.value);
  }

  if (map.size === 0) {
    throw new ServiceUnavailableError('Session key set contains no usable keys', {
      details: {
        remediation: `expected at least one signing key using ${[...algorithms].join(' or ')}`,
      },
    });
  }

  return map;
}
