import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHealthService } from '../src/health/health-service.js';
import { createStubProbe } from './helpers/test-doubles.js';

/**
 * @param {number[]} readings
 * @returns {() => number}
 */
function createScriptedClock(readings) {
  let index = 0;
  return () => readings[Math.min(index++, readings.length - 1)];
}

describe('createHealthService', () => {
  it('reports liveness without consulting any dependency', async () => {
    let probeCalls = 0;
    const service = createHealthService({
      serviceName: 'shopsage-backend',
      version: '0.1.0',
      probes: [
        {
          name: 'counted',
          check: () => {
            probeCalls += 1;
            return Promise.resolve({ name: 'counted', status: 'up', latencyMs: 0 });
          },
        },
      ],
    });

    const report = service.liveness();

    // A dependency outage must never fail liveness: that turns an outage into
    // an orchestrator-driven restart loop.
    assert.equal(report.status, 'ok');
    assert.equal(probeCalls, 0);

    await service.readiness();
    assert.equal(probeCalls, 1);
  });

  it('computes uptime from the injected clock', () => {
    const service = createHealthService({
      serviceName: 'svc',
      version: '0.1.0',
      clock: createScriptedClock([1_000, 46_000]),
    });

    assert.equal(service.liveness().uptimeSeconds, 45);
  });

  it('is ready when every dependency is up', async () => {
    const service = createHealthService({
      serviceName: 'svc',
      version: '0.1.0',
      probes: [createStubProbe('qdrant', 'up'), createStubProbe('embeddings', 'up')],
    });

    const report = await service.readiness();

    assert.equal(report.status, 'ok');
    assert.equal(report.checks.length, 2);
  });

  it('is degraded when any dependency is down, and still reports the others', async () => {
    const service = createHealthService({
      serviceName: 'svc',
      version: '0.1.0',
      probes: [createStubProbe('qdrant', 'up'), createStubProbe('embeddings', 'down')],
    });

    const report = await service.readiness();

    assert.equal(report.status, 'degraded');
    assert.deepEqual(
      report.checks.map((check) => [check.name, check.status]),
      [
        ['qdrant', 'up'],
        ['embeddings', 'down'],
      ],
    );
  });

  it('is ready when there are no dependencies to check', async () => {
    const service = createHealthService({ serviceName: 'svc', version: '0.1.0' });

    assert.equal((await service.readiness()).status, 'ok');
  });
});
