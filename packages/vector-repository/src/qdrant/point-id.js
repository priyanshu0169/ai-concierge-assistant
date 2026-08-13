import { createHash } from 'node:crypto';

/**
 * Reserved payload key holding the caller's own id.
 *
 * Underscore-prefixed and documented as reserved: `insert` rejects a payload that
 * sets it, so a collision is a loud error rather than a corrupted round trip.
 */
export const RESERVED_ID_KEY = '_pointId';

/** Fixed namespace, so the same id always derives the same UUID, forever. */
const NAMESPACE = 'f7a1c6d2-9b3e-4a58-8d1f-6e2b0c4a7d93';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Convert a caller's id into one the store will accept.
 *
 * Qdrant accepts only unsigned integers and UUIDs as point ids. The natural key
 * for a chunk is a content hash, which is neither. Rather than push that
 * constraint onto callers - which would be exactly the kind of leak this port
 * exists to prevent - the adapter derives a **deterministic** UUID (RFC 4122
 * version 5) from the id.
 *
 * Determinism is what makes re-ingestion idempotent: the same chunk maps to the
 * same point on every run, so an unchanged corpus produces upserts that overwrite
 * rather than duplicates that accumulate.
 *
 * A caller that already supplies a UUID keeps it, so nothing is derived twice.
 *
 * @param {string} id
 * @returns {string} A UUID.
 */
export function toStoreId(id) {
  if (UUID_PATTERN.test(id)) return id.toLowerCase();

  const hash = createHash('sha1')
    .update(uuidToBytes(NAMESPACE))
    .update(Buffer.from(id, 'utf8'))
    .digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  return formatUuid(bytes);
}

/**
 * @param {string} uuid
 * @returns {Buffer}
 */
function uuidToBytes(uuid) {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex');
}

/**
 * @param {Buffer} bytes
 * @returns {string}
 */
function formatUuid(bytes) {
  const hex = bytes.toString('hex');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
