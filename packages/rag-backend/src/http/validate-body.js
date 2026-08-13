import { ValidationError, formatIssues } from '@shopsage/platform';

/**
 * Validate a request body, or fail with the standard error envelope.
 *
 * `ValidationError` is an exposed error, so the issue list reaches the caller.
 * That is the point: "message must not be empty" tells a client what to fix,
 * while a bare 400 starts a support conversation.
 *
 * Only the *shape* is reported, never the value. Echoing back a rejected field
 * would reflect customer text - and anything an attacker chose to send - into a
 * response body.
 *
 * @template T
 * @param {import('zod').ZodType<T>} schema
 * @param {unknown} body
 * @returns {T}
 * @throws {ValidationError} If the body does not satisfy the schema.
 */
export function validateBody(schema, body) {
  const result = schema.safeParse(body);

  if (result.success) return result.data;

  throw new ValidationError('Request body is invalid', {
    details: { issues: formatIssues(result.error) },
  });
}
