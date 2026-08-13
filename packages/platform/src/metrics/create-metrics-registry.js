import { renderPrometheus } from './render-prometheus.js';

/**
 * A metrics registry, with no dependency at all.
 *
 * The same reasoning as the logger (docs/adr/0007): the Prometheus exposition format is a text format,
 * and a counter is a number. A client library would bring a dependency tree to do arithmetic and string
 * concatenation, and this project's one durable advantage is that its production dependencies are
 * `express`, `zod` and a Redis client.
 *
 * **Cardinality is bounded by construction, not by care.** Every label value comes from a fixed set - a
 * route from an allow-list, a status code, a model name, an outcome - because the classic way to lose a
 * monitoring system is one series per conversation id. Nothing here accepts a caller's string as a label
 * without that being a deliberate decision at the call site, and every call site is in this repository.
 *
 * **Counters and histograms only.** No gauges: a gauge is a value at scrape time, which needs something
 * to sample it, and everything worth knowing here is either cumulative or a distribution. No summaries:
 * quantiles computed per-process cannot be aggregated across replicas, so they lie exactly when it
 * matters. Histogram buckets aggregate correctly, which is the whole reason they exist.
 */

/**
 * @typedef {Record<string, string>} Labels
 */

/**
 * @typedef {object} Counter
 * @property {(labels?: Labels, by?: number) => void} add
 */

/**
 * @typedef {object} Histogram
 * @property {(value: number, labels?: Labels) => void} observe
 */

/**
 * @typedef {object} MetricsRegistry
 * @property {(spec: { name: string, help: string }) => Counter} counter
 * @property {(spec: {
 *   name: string,
 *   help: string,
 *   buckets: readonly number[],
 * }) => Histogram} histogram Buckets are read `readonly`, so the frozen defaults below can be passed
 *   directly rather than copied at every call site.
 * @property {() => string} render The Prometheus text exposition format.
 */

/**
 * @param {{ prefix?: string, constantLabels?: Labels }} [options]
 * @returns {MetricsRegistry}
 */
export function createMetricsRegistry(options = {}) {
  const prefix = options.prefix ?? 'shopsage';
  const constant = options.constantLabels ?? {};

  /** @type {Map<string, import('./render-prometheus.js').MetricFamily>} */
  const families = new Map();

  /**
   * @param {'counter' | 'histogram'} type
   * @param {{ name: string, help: string, buckets?: readonly number[] }} spec
   */
  const family = (type, spec) => {
    const name = `${prefix}_${spec.name}`;
    const existing = families.get(name);

    // Returning the existing family rather than throwing on a duplicate registration. A registry that
    // throws makes a module reload during development fatal, and the second registration is always the
    // same call from the same line.
    if (existing !== undefined) return existing;

    /** @type {import('./render-prometheus.js').MetricFamily} */
    const created = {
      name,
      help: spec.help,
      type,
      series: new Map(),
      ...(spec.buckets === undefined ? {} : { buckets: [...spec.buckets].sort((a, b) => a - b) }),
    };

    families.set(name, created);

    return created;
  };

  /**
   * The series key, and the reason it is sorted.
   *
   * Two calls with the same labels in a different order must land on the same series. Without sorting
   * they would silently become two, and the sum would be right only if a dashboard happened to add
   * them.
   *
   * @param {Labels} labels
   * @returns {string}
   */
  const keyFor = (labels) =>
    Object.entries({ ...constant, ...labels })
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([name, value]) => `${name}=${value}`)
      .join(',');

  return {
    counter(spec) {
      const held = family('counter', spec);

      return {
        add(labels = {}, by = 1) {
          const key = keyFor(labels);
          const series = held.series.get(key);

          if (series === undefined) {
            held.series.set(key, { labels: { ...constant, ...labels }, count: by, sum: by });

            return;
          }

          series.count += by;
          series.sum += by;
        },
      };
    },

    histogram(spec) {
      const held = family('histogram', spec);

      return {
        observe(value, labels = {}) {
          const key = keyFor(labels);
          const series = held.series.get(key) ?? emptySeries(held, { ...constant, ...labels });

          series.count += 1;
          series.sum += value;
          /** @type {number[]} */ (series.buckets)[bucketFor(held.buckets ?? [], value)] += 1;

          held.series.set(key, series);
        },
      };
    },

    render: () => renderPrometheus([...families.values()]),
  };
}

/**
 * A fresh histogram series.
 *
 * Bucket counts are stored raw and made cumulative at render time, which keeps `observe` to one
 * increment - it runs on every request, so the arithmetic belongs on the scrape rather than the path.
 *
 * @param {import('./render-prometheus.js').MetricFamily} held
 * @param {Labels} labels
 * @returns {import('./render-prometheus.js').Series}
 */
function emptySeries(held, labels) {
  return { labels, count: 0, sum: 0, buckets: new Array((held.buckets ?? []).length + 1).fill(0) };
}

/**
 * Which bucket a value lands in.
 *
 * A linear scan. With eleven bounds a binary search costs more in branches than it saves in
 * comparisons, and this is the honest expression of "the first bucket it fits in".
 *
 * @param {readonly number[]} bounds Ascending.
 * @param {number} value
 * @returns {number} The bucket index, or `bounds.length` for the `+Inf` bucket.
 */
function bucketFor(bounds, value) {
  const index = bounds.findIndex((bound) => value <= bound);

  return index === -1 ? bounds.length : index;
}

/**
 * Latency buckets, in **milliseconds**.
 *
 * Chosen against measured behaviour rather than picked from a tutorial: a short LLM answer is 1.1–1.5s,
 * a grounded one about 5s, and a retrieval round 1.8–2.9s (see docs/Testing.md). So the interesting
 * resolution is between 250ms and 10s, and the buckets are dense there. The 25ms and 50ms buckets exist
 * for `/v1/config` and the health routes, which should never be near a second and are worth noticing
 * when they are.
 */
export const LATENCY_BUCKETS_MS = Object.freeze([
  25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000,
]);

/**
 * Token-count buckets, for cost.
 *
 * A grounded turn measured 238 tokens on the first round and 544 on the second, so the useful range is
 * hundreds to low thousands. The top buckets exist to make a runaway prompt visible: a conversation
 * whose history has grown past 8k tokens is costing real money per turn and nothing else would say so.
 */
export const TOKEN_BUCKETS = Object.freeze([
  100, 250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000,
]);
