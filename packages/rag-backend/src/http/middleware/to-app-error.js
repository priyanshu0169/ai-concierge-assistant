import { AppError, ERROR_CODES, ValidationError } from '@shopsage/platform';

/**
 * Normalize any thrown value into an `AppError`.
 *
 * Everything crossing the HTTP boundary must be classified, because the status
 * code and the exposure decision both depend on classification. Anything
 * unrecognised becomes a non-exposed 500 - fail closed, never leak.
 *
 * @param {unknown} error
 * @returns {AppError}
 */
export function toAppError(error) {
  if (AppError.is(error)) return error;

  return (
    mapBodyParserError(error) ??
    new AppError('Unhandled error', {
      cause: error,
      code: ERROR_CODES.INTERNAL_ERROR,
      status: 500,
      expose: false,
    })
  );
}

/**
 * Translate `express.json()` failures into client errors.
 *
 * Body parser rejections are the caller's fault, but arrive as generic
 * `SyntaxError`s. Left unmapped they would be reported as 500s and pollute
 * error-rate alerting with what is really a malformed request.
 *
 * @param {unknown} error
 * @returns {AppError | undefined}
 */
function mapBodyParserError(error) {
  if (typeof error !== 'object' || error === null) return undefined;

  const candidate = /** @type {{ type?: string, message?: string }} */ (error);

  if (candidate.type === 'entity.parse.failed') {
    return new ValidationError('Request body is not valid JSON', { cause: error });
  }

  if (candidate.type === 'entity.too.large') {
    return new AppError('Request body is too large', {
      cause: error,
      code: ERROR_CODES.VALIDATION_FAILED,
      status: 413,
      expose: true,
    });
  }

  return undefined;
}
