import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static server for the demo page.
 *
 * The widget is a static bundle with no server of its own, and it is deliberately not part of the
 * Docker stack - it represents the customer's website, not our infrastructure. But it cannot be
 * opened as a `file://` URL either: the demo loads `/dist/shopsage.js` by absolute path, and the
 * widget then calls the backend, which a `file://` origin cannot do. So a static server is the
 * minimum needed to see the thing run, and it lives here so that `npm run demo` is the answer
 * rather than an ad-hoc command somebody has to remember.
 *
 * The web root is the package, not `demo/`, because the page requests `/dist/shopsage.js`.
 */
const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Deliberately **not** 5500: that is VS Code Live Server's default, and Windows will let a second
 * process bind a port an Electron utility process already holds without raising `EADDRINUSE`.
 * Connections are then dispatched to whichever listener wins the race, so the page loads or 404s at
 * random - which looks like a broken server rather than a port clash, and cost real time to find.
 */
const PORT = Number(process.env.PORT ?? 4180);

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
});

/**
 * Resolve a request path to a file inside the web root, or `undefined` if it escapes.
 *
 * Traversal is checked after resolving rather than by pattern-matching the request, because
 * `%2e%2e` and backslashes on Windows both survive a naive `..` filter. Comparing the resolved
 * path against the root is the check that actually holds.
 *
 * @param {string} requestPath
 * @returns {string | undefined}
 */
function resolveFile(requestPath) {
  const target = requestPath === '/' ? '/demo/index.html' : requestPath;
  const file = resolve(join(ROOT, normalize(decodeURIComponent(target))));

  return file === ROOT || file.startsWith(ROOT + (process.platform === 'win32' ? '\\' : '/'))
    ? file
    : undefined;
}

const server = http.createServer((request, response) => {
  const requestPath = (request.url ?? '/').split('?')[0];
  const file = resolveFile(requestPath);

  if (file === undefined) {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('forbidden\n');
    return;
  }

  readFile(file).then(
    (body) => {
      response.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        // No caching. A rebuilt bundle must be picked up on reload: serving a stale widget while
        // the developer wonders why their change did nothing is a genuinely expensive failure.
        'cache-control': 'no-store',
      });
      response.end(body);
    },
    () => {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`not found: ${requestPath}\n`);
    },
  );
});

server.listen(PORT, () => {
  process.stdout.write(`widget demo:  http://localhost:${PORT}/demo/index.html\n`);
  process.stdout.write('the backend must also be running: docker compose up -d\n');
});

server.on('error', (/** @type {NodeJS.ErrnoException} */ error) => {
  if (error.code === 'EADDRINUSE') {
    process.stderr.write(
      `port ${PORT} is already in use - retry with PORT=${PORT + 1} npm run demo\n`,
    );
    process.exit(1);
  }

  throw error;
});
