import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UpstreamError } from '../src/errors/errors.js';
import { createLogger } from '../src/logger/create-logger.js';
import { REDACTED } from '../src/logger/redact.js';

/**
 * @returns {{ sink: { write: (chunk: string) => void }, lines: string[], records: () => Record<string, unknown>[] }}
 */
function createCapturingSink() {
  /** @type {string[]} */
  const lines = [];

  return {
    lines,
    sink: {
      write(chunk) {
        lines.push(chunk);
      },
    },
    records: () => lines.map((line) => JSON.parse(line)),
  };
}

const FIXED_TIME = new Date('2026-01-01T00:00:00.000Z');

describe('createLogger', () => {
  it('writes one line of JSON per record', () => {
    const { sink, lines, records } = createCapturingSink();
    const logger = createLogger({ sink, name: 'test', clock: () => FIXED_TIME });

    logger.info('hello', { siteId: 'demo-store' });

    assert.equal(lines.length, 1);
    assert.ok(lines[0].endsWith('\n'));
    assert.deepEqual(records()[0], {
      time: '2026-01-01T00:00:00.000Z',
      level: 'info',
      name: 'test',
      msg: 'hello',
      siteId: 'demo-store',
    });
  });

  it('suppresses records below the configured level', () => {
    const { sink, lines } = createCapturingSink();
    const logger = createLogger({ sink, level: 'warn' });

    logger.trace('no');
    logger.debug('no');
    logger.info('no');
    logger.warn('yes');
    logger.error('yes');

    assert.equal(lines.length, 2);
  });

  it('reports which levels are enabled', () => {
    const logger = createLogger({ level: 'warn', sink: { write: () => {} } });

    assert.equal(logger.isLevelEnabled('info'), false);
    assert.equal(logger.isLevelEnabled('warn'), true);
    assert.equal(logger.isLevelEnabled('fatal'), true);
  });

  it('inherits bindings through child loggers, with the child winning', () => {
    const { sink, records } = createCapturingSink();
    const parent = createLogger({ sink, bindings: { service: 'backend', siteId: 'demo' } });

    parent.child({ requestId: 'req-1', siteId: 'other' }).info('scoped');

    const record = records()[0];
    assert.equal(record.service, 'backend');
    assert.equal(record.requestId, 'req-1');
    assert.equal(record.siteId, 'other');
  });

  it('serializes errors instead of emitting an empty object', () => {
    const { sink, records } = createCapturingSink();
    const logger = createLogger({ sink });

    logger.error('upstream died', {
      err: new UpstreamError('gateway refused', { details: { status: 502 } }),
    });

    const err = /** @type {Record<string, unknown>} */ (records()[0].err);
    assert.equal(err.name, 'UpstreamError');
    assert.equal(err.code, 'UPSTREAM_FAILURE');
    assert.equal(err.message, 'gateway refused');
    assert.equal(err.retryable, true);
    assert.ok(typeof err.stack === 'string');
  });

  it('redacts secrets that arrive inside a field bag', () => {
    const { sink, records } = createCapturingSink();
    const logger = createLogger({ sink });

    logger.info('config loaded', { config: { LLM_API_KEY: 'sk-live-secret', PORT: 3000 } });

    const config = /** @type {Record<string, unknown>} */ (records()[0].config);
    assert.equal(config.LLM_API_KEY, REDACTED);
    assert.equal(config.PORT, 3000);
  });

  it('falls back to info when handed an unknown level', () => {
    const { sink, lines } = createCapturingSink();
    const logger = createLogger({
      sink,
      level: /** @type {import('../src/logger/levels.js').LogLevel} */ ('nonsense'),
    });

    assert.equal(logger.level, 'info');
    logger.info('emitted');
    assert.equal(lines.length, 1);
  });

  it('renders a human readable line in pretty mode', () => {
    const { sink, lines } = createCapturingSink();
    const logger = createLogger({ sink, format: 'pretty', name: 'svc', clock: () => FIXED_TIME });

    logger.warn('careful', { attempt: 2 });

    assert.equal(lines[0], '2026-01-01T00:00:00.000Z WARN  [svc] careful {"attempt":2}\n');
  });
});
