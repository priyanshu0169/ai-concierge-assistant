import { createCallContext } from './call-context.js';
import { createGenerate } from './generate.js';
import { createStream } from './stream.js';

/**
 * Construct the LLM client.
 *
 * The only public entry point of this package. Everything a caller can do is
 * `generate()` and `stream()`; nothing in the returned object reveals the
 * provider, the model or the endpoint.
 *
 * Settings are validated here, so an invalid gateway configuration fails at
 * construction - which the backend performs at boot - rather than on a
 * customer's first question.
 *
 * @param {import('./types.js').LlmClientOptions} options
 * @returns {import('./types.js').LlmClient}
 * @throws {import('@shopsage/platform').ConfigurationError} On invalid settings.
 */
export function createLlmClient(options) {
  const context = createCallContext(options);

  return {
    generate: createGenerate(context),
    stream: createStream(context),
  };
}
