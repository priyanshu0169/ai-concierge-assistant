import { createHealthService } from '../health/health-service.js';
import { createClientProbe } from '../health/dependency-probe.js';
import { ServiceUnavailableError } from '@shopsage/platform';
import packageJson from '../../package.json' with { type: 'json' };

/**
 * Assemble readiness, which is where this deployment's failure policy is actually written.
 *
 * Lifted out of `buildApplication` because the probe list is the most opinionated thing in the file and
 * every entry carries a reason - three of them the reason for *not* being here. Read together they say
 * what ShopSage considers worth taking an instance out of rotation for, which is worth being able to
 * read in one place.
 *
 * @param {{
 *   config: Readonly<import('@shopsage/platform').AppConfig>,
 *   vectorRepository: import('@shopsage/vector-repository').VectorRepository,
 *   embeddingsClient: import('@shopsage/embeddings-client').EmbeddingsClient,
 *   conversations: { health?: () => Promise<void> },
 *   cart: { health?: () => Promise<void> } | undefined,
 *   auth: { health?: () => Promise<void> },
 * }} input
 * @returns {import('../health/health-service.js').HealthService}
 */
export function buildHealthService(input) {
  const { config, vectorRepository, conversations, cart, auth } = input;

  return createHealthService({
    serviceName: config.env.SERVICE_NAME,
    version: packageJson.version,
    probes: [
      createClientProbe({ name: 'qdrant', check: () => vectorRepository.health() }),
      // The result is discarded rather than reported: the probe's contract is "it threw or it did
      // not", and `health()` returns the model it found so a caller *can* check. The client already
      // compares that against the configured model and throws on a mismatch.
      createClientProbe({
        name: 'embeddings',
        check: async () => {
          await input.embeddingsClient.health();
        },
      }),
      // Joins readiness now, and only now: retrieval depends on the collection from this stage onward,
      // so its absence means the assistant cannot answer from store content. Before Stage 6 a missing
      // collection was the correct pre-ingestion state and failing on it would have deadlocked a fresh
      // deployment - it could never have become ready enough to be ingested into (docs/adr/0014).
      createClientProbe({
        name: 'knowledge-collection',
        check: () => assertCollectionExists(vectorRepository, config.env.QDRANT_COLLECTION),
      }),
      // Only when there is a network dependency to probe. An in-memory store cannot be down, and a
      // probe that always passes teaches an operator to ignore it.
      ...(conversations.health === undefined
        ? []
        : [createClientProbe({ name: 'conversations', check: conversations.health })]),
      // The proposal store **is** a readiness dependency, unlike the commerce connector, and the
      // difference is what a failure costs. A connector outage degrades commerce answers while
      // knowledge answers keep working. An unreachable proposal store means every confirmation button
      // in flight is dead and the assistant will keep cheerfully preparing more - which is worth taking
      // an instance out of rotation for. It shares the conversation store's connection, so this probe
      // costs almost nothing.
      ...(cart === undefined || cart.health === undefined
        ? []
        : [createClientProbe({ name: 'cart-proposals', check: cart.health })]),
      // Fails only when **no** usable key set is held. An instance still verifying tokens from a cached
      // set is ready, whatever the issuer is doing - see the contract, §9.
      ...(auth.health === undefined
        ? []
        : [createClientProbe({ name: 'session-keys', check: auth.health })]),
    ],
  });
}

/**
 * Fail readiness when the knowledge collection does not exist.
 *
 * The remediation is the important part: a missing collection almost always means
 * ingestion has never run, and that is a job an operator runs rather than something the
 * backend can fix for itself. The backend deliberately does not create it — a read path
 * that silently provisions storage hides the fact that there is nothing in it.
 *
 * @param {import('@shopsage/vector-repository').VectorRepository} store
 * @param {string} collection
 * @returns {Promise<void>}
 */
async function assertCollectionExists(store, collection) {
  if (await store.collectionExists()) return;

  throw new ServiceUnavailableError('Knowledge collection does not exist', {
    details: {
      collection,
      remediation: 'run ingestion: node packages/ingestion/src/cli/ingest.js',
    },
  });
}
