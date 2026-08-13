/**
 * Split a list into fixed-size batches, preserving order.
 *
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {Generator<T[], void, void>}
 */
export function* intoBatches(items, size) {
  for (let start = 0; start < items.length; start += size) {
    yield items.slice(start, start + size);
  }
}
