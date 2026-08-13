/**
 * The Prometheus text exposition format, written out by hand.
 *
 * The format is deliberately simple — that is its point, and why a client library is not needed to emit
 * it. What a library *would* give is the escaping rules and the `_bucket`/`_sum`/`_count` conventions,
 * and both are short enough to get right here with the reasoning visible.
 *
 * Reference: the exposition format is stable and versioned separately from Prometheus itself. Nothing
 * below uses OpenMetrics-only syntax, so this is readable by Prometheus, VictoriaMetrics, Grafana Agent
 * and anything else that scrapes.
 */

/**
 * @typedef {object} Series
 * @property {Record<string, string>} labels
 * @property {number} count
 * @property {number} sum
 * @property {number[]} [buckets] Per-bucket counts, non-cumulative. Made cumulative here.
 */

/**
 * @typedef {object} MetricFamily
 * @property {string} name
 * @property {string} help
 * @property {'counter' | 'histogram'} type
 * @property {Map<string, Series>} series
 * @property {number[]} [buckets] Upper bounds, ascending.
 */

/**
 * @param {MetricFamily[]} families
 * @returns {string}
 */
export function renderPrometheus(families) {
  const lines = [];

  for (const held of families) {
    // A family with no observations is still declared. An absent metric and a metric that is zero are
    // different facts, and a dashboard panel that shows "no data" for a healthy service teaches
    // everybody to ignore it.
    lines.push(`# HELP ${held.name} ${escapeHelp(held.help)}`);
    lines.push(`# TYPE ${held.name} ${held.type}`);

    for (const series of held.series.values()) {
      lines.push(
        ...(held.type === 'counter' ? counterLines(held, series) : histogramLines(held, series)),
      );
    }
  }

  // A trailing newline is required by the format, and a scraper that tolerates its absence is being
  // generous rather than correct.
  return `${lines.join('\n')}\n`;
}

/**
 * @param {MetricFamily} held
 * @param {Series} series
 * @returns {string[]}
 */
function counterLines(held, series) {
  return [`${held.name}${renderLabels(series.labels)} ${series.count}`];
}

/**
 * @param {MetricFamily} held
 * @param {Series} series
 * @returns {string[]}
 */
function histogramLines(held, series) {
  const bounds = held.buckets ?? [];
  const counts = series.buckets ?? [];
  const lines = [];
  let cumulative = 0;

  // Prometheus histogram buckets are **cumulative**: `le="500"` means "at most 500ms", not "between 250
  // and 500". Storing them non-cumulatively and summing here keeps `observe` to one increment; getting
  // this backwards produces a histogram that looks plausible and computes nonsense quantiles.
  bounds.forEach((bound, index) => {
    cumulative += counts[index] ?? 0;
    lines.push(
      `${held.name}_bucket${renderLabels({ ...series.labels, le: formatNumber(bound) })} ${cumulative}`,
    );
  });

  // The `+Inf` bucket must equal the count, or every quantile calculation is wrong. Derived from
  // `series.count` rather than from summing the buckets, so the two cannot drift.
  lines.push(
    `${held.name}_bucket${renderLabels({ ...series.labels, le: '+Inf' })} ${series.count}`,
  );
  lines.push(`${held.name}_sum${renderLabels(series.labels)} ${formatNumber(series.sum)}`);
  lines.push(`${held.name}_count${renderLabels(series.labels)} ${series.count}`);

  return lines;
}

/**
 * @param {Record<string, string>} labels
 * @returns {string}
 */
function renderLabels(labels) {
  const entries = Object.entries(labels);

  if (entries.length === 0) return '';

  // Sorted, so a scraped payload is stable between requests. Not required by the format, and it makes a
  // diff of two scrapes readable, which is how most metric bugs get found.
  const rendered = entries
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([name, value]) => `${name}="${escapeLabelValue(value)}"`)
    .join(',');

  return `{${rendered}}`;
}

/**
 * The three characters the format reserves inside a label value.
 *
 * A label value is the one place a string from outside could reach the output, so it is escaped rather
 * than trusted - even though every label in this codebase comes from a fixed set. That is a property of
 * today's call sites, not of the format, and the escaping is four lines.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeLabelValue(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

/**
 * @param {string} help
 * @returns {string}
 */
function escapeHelp(help) {
  return help.replaceAll('\\', '\\\\').replaceAll('\n', ' ');
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatNumber(value) {
  // Integers stay integers, so `le="500"` rather than `le="500.0"`. Cosmetic, and it makes a scrape
  // comparable to what every other exporter emits.
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}
