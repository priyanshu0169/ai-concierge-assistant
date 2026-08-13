import { UpstreamError } from '../errors/errors.js';

/**
 * Decode a JSON response body.
 *
 * Retryable, and that is the point of having it in one place: the usual cause of
 * an undecodable body is a connection dropped mid-response, which a second
 * attempt normally survives. A caller that hand-rolled this would be as likely
 * to classify it as a permanent failure and give up on a transient one.
 *
 * @param {Response} response
 * @param {string} label Names the dependency in the error message.
 * @returns {Promise<unknown>}
 * @throws {UpstreamError} If the body is not JSON.
 */
export async function readJsonBody(response, label) {
  try {
    return await response.json();
  } catch (cause) {
    throw new UpstreamError(`${label} returned a body that is not JSON`, {
      cause,
      retryable: true,
    });
  }
}
