/**
 * The full request path, without the query string.
 *
 * `req.path` is wrong for logging. Express rewrites `req.url` while dispatching
 * into a mounted router and only restores it afterwards, so anything that reads
 * `req.path` *after* routing - a `finish` listener, an error handler - sees the
 * path relative to the mount point: `/` instead of `/health`, `/info` instead
 * of `/health/info`. `req.originalUrl` is never rewritten.
 *
 * The query string is dropped deliberately: on an assistant API it can carry
 * customer text, and access logs are the wrong place for that.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
export function getRequestPath(req) {
  const [pathname] = req.originalUrl.split('?');

  return pathname === '' ? '/' : pathname;
}
