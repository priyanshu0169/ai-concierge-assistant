/**
 * Flatten a zod error into log- and operator-friendly issues.
 *
 * Lives outside `config/` because it now has three kinds of caller -
 * configuration loading, outbound-client construction, and HTTP request
 * validation - and all three want the same one-line-per-problem shape.
 *
 * @param {import('zod').ZodError} error
 * @returns {{ path: string, message: string }[]}
 */
export function formatIssues(error) {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
}
