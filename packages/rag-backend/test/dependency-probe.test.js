import assert from 'node:assert/strict';
import { ServiceUnavailableError } from '@shopsage/platform';
import { describe, it } from 'node:test';
import { createClientProbe } from '../src/health/dependency-probe.js';

describe('createClientProbe', () => {
  it('reports up when the client is satisfied', async () => {
    const probe = createClientProbe({ name: 'qdrant', check: () => Promise.resolve() });

    const result = await probe.check();

    assert.equal(result.name, 'qdrant');
    assert.equal(result.status, 'up');
    assert.equal(typeof result.latencyMs, 'number');
    assert.equal(result.error, undefined);
  });

  it('never throws, because readiness must report on every dependency', async () => {
    // If probes threw, one dead dependency would break reporting for all the
    // others - and an operator would see nothing rather than see which one failed.
    const probe = createClientProbe({
      name: 'embeddings',
      check: () => Promise.reject(new Error('connect ECONNREFUSED')),
    });

    const result = await probe.check();

    assert.equal(result.status, 'down');
    assert.equal(result.error, 'connect ECONNREFUSED');
  });

  it('surfaces the remediation the client offered', async () => {
    // An operator reading /health/ready should not have to go digging in the logs
    // to learn that EMBEDDING_MODEL disagrees with the running service.
    const probe = createClientProbe({
      name: 'embeddings',
      check: () =>
        Promise.reject(
          new ServiceUnavailableError('Embeddings service is running an unexpected model', {
            details: { remediation: 'align EMBEDDING_MODEL with the running service' },
          }),
        ),
    });

    const result = await probe.check();

    assert.equal(
      result.error,
      'Embeddings service is running an unexpected model (align EMBEDDING_MODEL with the running service)',
    );
  });

  it('copes with a thrown non-error', async () => {
    const probe = createClientProbe({ name: 'odd', check: () => Promise.reject('a string') });

    assert.equal((await probe.check()).error, 'unknown failure');
  });

  it('passes a client health result through without inspecting it', async () => {
    // The probe cares whether the check resolved, not what it returned - which is
    // what lets each client decide for itself what "usable" means.
    const probe = createClientProbe({
      name: 'embeddings',
      check: () => Promise.resolve({ model: 'BAAI/bge-m3', maxInputTokens: 8192 }),
    });

    assert.equal((await probe.check()).status, 'up');
  });
});
