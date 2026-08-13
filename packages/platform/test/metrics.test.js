import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMetricsRegistry } from '../src/metrics/create-metrics-registry.js';

/** @param {string} text @param {string} prefix */
function linesStartingWith(text, prefix) {
  return text.split('\n').filter((line) => line.startsWith(prefix));
}

describe('counters', () => {
  it('counts, and renders one series per label set', () => {
    const registry = createMetricsRegistry();
    const requests = registry.counter({ name: 'requests_total', help: 'Requests.' });

    requests.add({ route: '/v1/chat', status: '200' });
    requests.add({ route: '/v1/chat', status: '200' });
    requests.add({ route: '/v1/chat', status: '500' });

    const rendered = registry.render();

    assert.match(rendered, /shopsage_requests_total\{route="\/v1\/chat",status="200"\} 2/u);
    assert.match(rendered, /shopsage_requests_total\{route="\/v1\/chat",status="500"\} 1/u);
  });

  it('adds by an amount, for token counts', () => {
    const registry = createMetricsRegistry();
    const tokens = registry.counter({ name: 'tokens_total', help: 'Tokens.' });

    tokens.add({ kind: 'prompt' }, 238);
    tokens.add({ kind: 'prompt' }, 544);

    assert.match(registry.render(), /shopsage_tokens_total\{kind="prompt"\} 782/u);
  });

  it('treats label order as irrelevant', () => {
    const registry = createMetricsRegistry();
    const counter = registry.counter({ name: 'c_total', help: 'C.' });

    counter.add({ a: '1', b: '2' });
    counter.add({ b: '2', a: '1' });

    // Without sorting the series key these would silently become two series, and a dashboard would be
    // right only if it happened to sum them.
    assert.equal(linesStartingWith(registry.render(), 'shopsage_c_total{').length, 1);
    assert.match(registry.render(), /shopsage_c_total\{a="1",b="2"\} 2/u);
  });

  it('declares a family with no observations', () => {
    const registry = createMetricsRegistry();

    registry.counter({ name: 'never_used_total', help: 'Never used.' });

    // An absent metric and a metric that is zero are different facts, and a panel showing "no data" for
    // a healthy service teaches everybody to ignore it.
    assert.match(registry.render(), /# TYPE shopsage_never_used_total counter/u);
  });

  it('carries constant labels onto every series', () => {
    const registry = createMetricsRegistry({ constantLabels: { site: 'demo-store' } });

    registry.counter({ name: 'c_total', help: 'C.' }).add({ route: '/x' });

    assert.match(registry.render(), /shopsage_c_total\{route="\/x",site="demo-store"\} 1/u);
  });
});

describe('histograms', () => {
  it('renders cumulative buckets, a sum and a count', () => {
    const registry = createMetricsRegistry();
    const duration = registry.histogram({
      name: 'duration_ms',
      help: 'Duration.',
      buckets: [100, 500, 1000],
    });

    duration.observe(50);
    duration.observe(300);
    duration.observe(5000);

    const rendered = registry.render();

    // **Cumulative**: `le="500"` means "at most 500", not "between 100 and 500". Getting this backwards
    // produces a histogram that looks plausible and computes nonsense quantiles.
    assert.match(rendered, /shopsage_duration_ms_bucket\{le="100"\} 1/u);
    assert.match(rendered, /shopsage_duration_ms_bucket\{le="500"\} 2/u);
    assert.match(rendered, /shopsage_duration_ms_bucket\{le="1000"\} 2/u);
    assert.match(rendered, /shopsage_duration_ms_bucket\{le="\+Inf"\} 3/u);
    assert.match(rendered, /shopsage_duration_ms_sum 5350/u);
    assert.match(rendered, /shopsage_duration_ms_count 3/u);
  });

  it('makes the +Inf bucket equal the count', () => {
    const registry = createMetricsRegistry();
    const h = registry.histogram({ name: 'h_ms', help: 'H.', buckets: [10] });

    for (const value of [1, 2, 3, 400, 5000]) h.observe(value);

    const rendered = registry.render();
    const infinite = rendered.match(/_bucket\{le="\+Inf"\} (?<n>\d+)/u)?.groups?.n;
    const count = rendered.match(/_count (?<n>\d+)/u)?.groups?.n;

    // If these ever differ, every quantile computed from this histogram is wrong.
    assert.equal(infinite, count);
  });

  it('sorts buckets given out of order', () => {
    const registry = createMetricsRegistry();

    registry.histogram({ name: 'h_ms', help: 'H.', buckets: [1000, 10, 100] }).observe(50);

    const bounds = [...registry.render().matchAll(/le="(?<b>[\d.]+)"/gu)].map((m) => m.groups?.b);

    assert.deepEqual(bounds, ['10', '100', '1000']);
  });

  it('keeps label sets apart', () => {
    const registry = createMetricsRegistry();
    const h = registry.histogram({ name: 'h_ms', help: 'H.', buckets: [100] });

    h.observe(50, { route: '/a' });
    h.observe(50, { route: '/b' });
    h.observe(50, { route: '/b' });

    assert.match(registry.render(), /shopsage_h_ms_count\{route="\/a"\} 1/u);
    assert.match(registry.render(), /shopsage_h_ms_count\{route="\/b"\} 2/u);
  });

  it('renders an integer bound without a decimal point', () => {
    const registry = createMetricsRegistry();

    registry.histogram({ name: 'h_ms', help: 'H.', buckets: [500] }).observe(1);

    // `le="500"`, not `le="500.0"`. Cosmetic, and it makes a scrape comparable to every other exporter.
    assert.match(registry.render(), /le="500"/u);
  });
});

describe('the exposition format', () => {
  it('ends with a newline', () => {
    const registry = createMetricsRegistry();

    registry.counter({ name: 'c_total', help: 'C.' }).add();

    // Required by the format. A scraper that tolerates its absence is being generous, not correct.
    assert.ok(registry.render().endsWith('\n'));
  });

  it('escapes the characters a label value reserves', () => {
    const registry = createMetricsRegistry();

    registry.counter({ name: 'c_total', help: 'C.' }).add({ odd: 'a"b\\c\nd' });

    // Every label in this codebase comes from a fixed set - that is a property of today's call sites,
    // not of the format, so the escaping is here anyway.
    assert.match(registry.render(), /odd="a\\"b\\\\c\\nd"/u);
  });

  it('keeps a help line on one line', () => {
    const registry = createMetricsRegistry();

    registry.counter({ name: 'c_total', help: 'Line one.\nLine two.' }).add();

    assert.match(registry.render(), /# HELP shopsage_c_total Line one\. Line two\./u);
  });

  it('renders a stable payload between scrapes', () => {
    const registry = createMetricsRegistry();
    const counter = registry.counter({ name: 'c_total', help: 'C.' });

    counter.add({ b: '2', a: '1' });

    // Sorted labels, so a diff of two scrapes is readable — which is how most metric bugs get found.
    assert.equal(registry.render(), registry.render());
  });

  it('returns the same instrument for a repeated registration', () => {
    const registry = createMetricsRegistry();

    registry.counter({ name: 'c_total', help: 'C.' }).add();
    registry.counter({ name: 'c_total', help: 'C.' }).add();

    // A registry that threw here would make a module reload fatal during development, and the second
    // registration is always the same call from the same line.
    assert.equal(linesStartingWith(registry.render(), '# TYPE shopsage_c_total').length, 1);
    assert.match(registry.render(), /shopsage_c_total 2/u);
  });

  it('honours a custom prefix', () => {
    const registry = createMetricsRegistry({ prefix: 'other' });

    registry.counter({ name: 'c_total', help: 'C.' }).add();

    assert.match(registry.render(), /^# HELP other_c_total/mu);
  });
});
