import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

/**
 * The reference connector — a runnable specification of
 * `docs/proposals/0002-commerce-connector-contract.md`.
 *
 * ```
 * node packages/magento-client/reference/server.js --port 8750
 * ```
 *
 * Binds **loopback only** unless told otherwise (`--host`). See the note on `host` below: that
 * default is a security control, not a convenience.
 *
 * **Not a mock.** A mock exists to make a test pass; this exists so the Magento module's author
 * has something to run and compare against, rather than prose to interpret — the same job the
 * shared JWT vectors do for Proposal 0001, one step larger. If the real module disagrees with
 * this, the disagreement is visible immediately instead of at integration.
 *
 * It is also what ShopSage's own end-to-end verification runs against, which keeps the two
 * honest: the adapter cannot quietly grow an assumption this does not satisfy.
 *
 * Three properties are deliberate rather than convenient, because they are contract terms:
 *
 * - **Prices are pre-formatted.** The connector renders money in the store's locale; ShopSage
 *   only ever repeats the string. It does not know a store's conventions and must not learn them.
 * - **Orders are keyed by the token's pseudonymous `sub`.** The connector resolves identity
 *   because it minted the token. ShopSage never holds a customer id.
 * - **Cursor pagination, not offset.** An offset shifts under a catalogue that is being edited.
 */

const HERE = new URL('.', import.meta.url);
const CATALOGUE = JSON.parse(readFileSync(new URL('catalogue.json', HERE), 'utf8'));
const MAX_LIMIT = 10;

const port = Number(readFlag('--port') ?? 8750);
/**
 * Loopback by default, and that default is the security control.
 *
 * `listen(port)` with no host binds **every** interface, which for this particular server means
 * publishing a connector that does not verify token signatures to the local network. Running it bare
 * during Stage 9a did exactly that. Inside Compose the port mapping is loopback-only, so the
 * container is fine either way — but a developer running `node reference/server.js` is not, and the
 * safe behaviour should not depend on remembering which way you started it.
 *
 * `--host 0.0.0.0` is available for the case that genuinely needs it: another machine on a trusted
 * network comparing the real Magento module against this. It warns on startup when used.
 */
const host = readFlag('--host') ?? '127.0.0.1';

/** @param {string} flag */
function readFlag(flag) {
  const index = process.argv.indexOf(flag);

  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * Read the token's `sub` **without verifying the signature**.
 *
 * Correct for a reference implementation and wrong for a real one, which is why it says so here:
 * the real module must verify, because it holds the signing key. A stand-in that verified would
 * need that key, which would make it a second issuer.
 *
 * @param {import('node:http').IncomingMessage} request
 */
function subjectOf(request) {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer (?<token>[\w-]+\.[\w-]+\.[\w-]*)$/u.exec(header);

  if (match?.groups === undefined) return undefined;

  try {
    const claims = JSON.parse(
      Buffer.from(match.groups.token.split('.')[1], 'base64url').toString('utf8'),
    );

    return {
      sub: claims.sub,
      scopes: String(claims.scope ?? '')
        .split(' ')
        .filter(Boolean),
    };
  } catch {
    return undefined;
  }
}

/**
 * Keyword match over the fixture. A real connector uses Magento's own search, which is the point
 * of asking Magento rather than embedding the catalogue.
 *
 * **The sku is part of what a query matches**, which is a fidelity fix rather than a convenience: a
 * real store's search finds a product by its code, because customers paste codes from emails and
 * from the assistant's own earlier answers. Without it this stand-in answered "we do not sell that"
 * for a product it was serving one endpoint away — a wrong specification, not just an inconvenient
 * one. Found by asking a live model about a sku it had just been shown.
 *
 * @param {string} query
 */
function searchProducts(query) {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((term) => term.length > 2);

  if (terms.length === 0) return [];

  return CATALOGUE.products
    .map((/** @type {any} */ product) => {
      const haystack = [product.sku, product.name, product.summary ?? '', ...product.keywords]
        .join(' ')
        .toLowerCase();
      const score = terms.filter((term) => haystack.includes(term)).length;

      return { product, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => publicProduct(entry.product));
}

/**
 * One basket per pseudonymous subject, and a ledger of idempotency keys already honoured.
 *
 * In memory, so it resets on restart. That is right for a stand-in: nothing here should look durable
 * enough to be relied on, and a real module writes to Magento's own quote.
 *
 * **The ledger is the part worth copying.** The contract says a repeated `idempotency-key` must not
 * apply a change twice, and the reference implementation of that promise is this map: the first request
 * for a key does the work and records its outcome, and every later request replays the recorded
 * outcome without touching the cart. Returning the *same* answer matters as much as not repeating the
 * work — a caller whose response was lost must be able to retry and learn what happened.
 *
 * @type {Map<string, { items: { sku: string, name: string, quantity: number }[], coupon?: string }>}
 */
const CARTS = new Map();

/** @type {Map<string, any>} */
const HONOURED_KEYS = new Map();

/**
 * @param {{ session?: { sub: string } | undefined }} context
 * @returns {string}
 */
function subject(context) {
  return context.session?.sub ?? 'anonymous';
}

/** @param {string} owner */
function cartFor(owner) {
  const existing = CARTS.get(owner);

  if (existing !== undefined) return existing;

  const fresh = { items: [] };

  CARTS.set(owner, fresh);

  return fresh;
}

/**
 * Money, formatted by the connector because that is the contract: ShopSage repeats this string and
 * never renders or computes money itself. A real module uses Magento's own price rendering.
 *
 * @param {{ items: { sku: string, quantity: number }[], coupon?: string }} cart
 */
function cartTotal(cart) {
  // Pennies as integers, so the fixture never does float arithmetic on money either. A stand-in that
  // demonstrated the wrong habit would be a poor specification.
  const pence = cart.items.reduce((sum, line) => {
    const product = CATALOGUE.products.find((/** @type {any} */ p) => p.sku === line.sku);
    const amount = product?.price?.amount ?? '0';
    const [whole, fraction = '0'] = String(amount).split('.');

    return (
      sum + (Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2))) * line.quantity
    );
  }, 0);
  // A flat 10% stands in for Magento's promotion rules. Deliberately crude: the point of the contract
  // is that ShopSage never learns how a discount is computed, only what the connector says it costs.
  const discounted = cart.coupon === undefined ? pence : Math.round(pence * 0.9);

  return {
    formatted: `£${(discounted / 100).toFixed(2)}`,
    amount: (discounted / 100).toFixed(2),
    currency: 'GBP',
    taxIncluded: true,
  };
}

/**
 * @param {{ items: { sku: string, quantity: number }[], coupon?: string }} cart
 * @param {boolean} applied
 * @param {string} message
 */
function cartOutcome(cart, applied, message) {
  return {
    applied,
    message,
    itemCount: cart.items.reduce((sum, line) => sum + line.quantity, 0),
    total: cartTotal(cart),
    cartUrl: 'https://store.example.com/checkout/cart',
  };
}

/**
 * Read a JSON body. No size guard, because this is a development stand-in on loopback - a real module
 * has a framework doing it, and pretending otherwise here would be theatre.
 *
 * @param {import('node:http').IncomingMessage} request
 */
async function readBody(request) {
  /** @type {Buffer[]} */
  const chunks = [];

  for await (const chunk of request) chunks.push(chunk);

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return undefined;
  }
}

/** @param {any} product */
function publicProduct(product) {
  // `keywords` is a fixture implementation detail and is not part of the contract.
  const { keywords: _keywords, ...rest } = product;

  return rest;
}

/**
 * @param {any[]} items
 * @param {URL} url
 */
function paginate(items, url) {
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 5) || 5, MAX_LIMIT);
  // An opaque cursor by contract. It happens to be an index here; a caller that decodes it has
  // coupled itself to this implementation, which is exactly what "opaque" forbids.
  const from = Number(
    Buffer.from(url.searchParams.get('cursor') ?? '', 'base64url').toString() || 0,
  );
  const page = items.slice(from, from + limit);
  const next = from + limit;

  return {
    items: page,
    ...(next < items.length ? { nextCursor: Buffer.from(String(next)).toString('base64url') } : {}),
  };
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} body
 */
function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {string} code
 */
function fail(response, status, code) {
  json(response, status, { error: { code, message: `${code} — for the log, not a customer` } });
}

/**
 * The routes, as a table rather than a chain of ifs.
 *
 * Each entry is `[matcher, handler]`, and the order is the contract's own: specific paths before the
 * catch-all. Written this way so the shape of the API is readable in one place - somebody porting
 * this to Magento should be able to see every endpoint without following control flow.
 *
 * @type {readonly [(path: string) => any, (found: any, context: {
 *   url: URL,
 *   request: import('node:http').IncomingMessage,
 *   response: import('node:http').ServerResponse,
 *   session: { sub: string, scopes: string[] } | undefined,
 * }) => unknown][]}
 */
const ROUTES = Object.freeze([
  [
    (path) => path === '/assistant/v1/categories' || undefined,
    (_found, { response }) => json(response, 200, { items: CATALOGUE.categories }),
  ],
  [
    (path) => path === '/assistant/v1/products' || undefined,
    (_found, { url, response }) =>
      json(response, 200, paginate(searchProducts(url.searchParams.get('q') ?? ''), url)),
  ],
  [
    (path) => /^\/assistant\/v1\/products\/(?<sku>[\w-]+)$/u.exec(path)?.groups?.sku,
    (sku, { response }) => {
      const found = CATALOGUE.products.find((/** @type {any} */ p) => p.sku === sku);

      // 404 for a missing product is an empty result, not an error — the contract says so, because
      // "we do not sell that" is an answer.
      if (found === undefined) return fail(response, 404, 'PRODUCT_NOT_FOUND');

      json(response, 200, publicProduct(found));
    },
  ],
  [
    (path) => path === '/assistant/v1/orders' || undefined,
    (_found, { response, session }) => {
      // Both checks belong here even though ShopSage withholds the tool from a session lacking the
      // scope. The connector is the thing holding the data; it does not get to assume its caller
      // filtered correctly.
      if (session === undefined) return fail(response, 401, 'TOKEN_REQUIRED');
      if (!session.scopes.includes('orders')) return fail(response, 403, 'SCOPE_REQUIRED');

      json(response, 200, { items: CATALOGUE.orders[session.sub] ?? [] });
    },
  ],
  [
    (path) => path === '/assistant/v1/cart/items' || undefined,
    async (_found, context) => {
      const { response, session } = context;

      if (session === undefined) return fail(response, 401, 'TOKEN_REQUIRED');
      // Checked here as well as in ShopSage, for the reason `/orders` gives: the thing holding the data
      // does not get to assume its caller filtered correctly.
      if (!session.scopes.includes('cart')) return fail(response, 403, 'SCOPE_REQUIRED');

      await mutate(context, (cart, body) => {
        const requested = Array.isArray(body?.items) ? body.items : [];
        const resolved = requested
          .map((/** @type {any} */ line) => ({
            product: CATALOGUE.products.find((/** @type {any} */ p) => p.sku === line?.sku),
            quantity: Number.isInteger(line?.quantity) && line.quantity > 0 ? line.quantity : 1,
          }))
          .filter((/** @type {any} */ entry) => entry.product !== undefined);

        if (resolved.length === 0) return cartOutcome(cart, false, 'None of those products exist.');

        for (const entry of resolved) {
          // Out of stock is refused **here**, at the moment of the change, not at proposal time. That
          // gap is real and unavoidable: stock moves between a customer reading a summary and clicking
          // confirm, so the connector is the last and only word on it.
          if (entry.product.availability === 'out_of_stock') continue;

          const line = cart.items.find((/** @type {any} */ held) => held.sku === entry.product.sku);

          if (line === undefined) {
            cart.items.push({
              sku: entry.product.sku,
              name: entry.product.name,
              quantity: entry.quantity,
            });
          } else {
            line.quantity += entry.quantity;
          }
        }

        if (cart.items.length === 0) {
          return cartOutcome(cart, false, 'Sorry, that is out of stock.');
        }

        return cartOutcome(cart, true, 'Added to your basket.');
      });
    },
  ],
  [
    (path) => path === '/assistant/v1/cart/coupon' || undefined,
    async (_found, context) => {
      const { response, session } = context;

      if (session === undefined) return fail(response, 401, 'TOKEN_REQUIRED');
      if (!session.scopes.includes('cart')) return fail(response, 403, 'SCOPE_REQUIRED');

      await mutate(context, (cart, body) => {
        const code = typeof body?.code === 'string' ? body.code.toUpperCase() : '';

        // One valid code in the fixture. Whether a code works is the connector's to decide and
        // ShopSage's to repeat - the message below is what a customer is shown, wording and all.
        if (code !== 'SAGE10') {
          return cartOutcome(
            cart,
            false,
            `We could not apply ${code || 'that code'} to your basket.`,
          );
        }

        if (cart.items.length === 0) {
          return cartOutcome(cart, false, 'Add something to your basket before applying a code.');
        }

        // Written through the map rather than onto the parameter. The lint rule that forces this is
        // the same one that keeps ShopSage's own code from mutating what it was handed - and a stand-in
        // held to a lower standard than the thing it specifies is not much of a specification.
        CARTS.set(subject(context), { ...cart, coupon: code });

        return cartOutcome(
          { ...cart, coupon: code },
          true,
          `${code} applied — 10% off this order.`,
        );
      });
    },
  ],
]);

/**
 * The idempotency contract, in one place.
 *
 * A missing key is refused with `400` rather than tolerated. The header is mandatory in the contract,
 * and a stand-in that quietly accepted a request without one would let ShopSage ship a bug that only
 * appears against the real module.
 *
 * @param {{
 *   request: import('node:http').IncomingMessage,
 *   response: import('node:http').ServerResponse,
 *   session: { sub: string, scopes: string[] } | undefined,
 * }} context
 * @param {(cart: any, body: any) => any} apply
 */
async function mutate(context, apply) {
  const key = context.request.headers['idempotency-key'];

  if (typeof key !== 'string' || key.length === 0) {
    return fail(context.response, 400, 'IDEMPOTENCY_KEY_REQUIRED');
  }

  const owner = subject(context);
  const ledgerKey = `${owner} ${key}`;
  const alreadyDone = HONOURED_KEYS.get(ledgerKey);

  // Replayed, not re-applied, and the *same* answer returned. A caller whose response was lost retries
  // with the same key and learns what happened, without a second charge.
  if (alreadyDone !== undefined) return json(context.response, 200, alreadyDone);

  const body = await readBody(context.request);
  const outcome = apply(cartFor(owner), body ?? {});

  HONOURED_KEYS.set(ledgerKey, outcome);
  json(context.response, 200, outcome);
}

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://connector.local');
  // `request` is in the context from Stage 9b: the cart handlers read a body and an idempotency
  // header, which the read handlers never needed.
  const context = { url, request, response, session: subjectOf(request) };

  for (const [match, handle] of ROUTES) {
    const found = match(url.pathname);

    if (found !== undefined && found !== false) {
      // A handler may be async now. Rejections are answered with a 500 rather than left to crash the
      // process - a stand-in that dies on a malformed request is a poor thing to develop against.
      Promise.resolve(handle(found, context)).catch(() => {
        if (!response.writableEnded) fail(response, 500, 'REFERENCE_CONNECTOR_ERROR');
      });

      return;
    }
  }

  fail(response, 404, 'NOT_FOUND');
}).listen(port, host, () => {
  process.stdout.write(`reference connector listening on ${host}:${port}\n`);
  process.stdout.write(
    `  ${CATALOGUE.products.length} products, ${CATALOGUE.categories.length} categories\n`,
  );
  if (host !== '127.0.0.1') {
    // Deliberately states the fact rather than predicting the consequence. Bound to every interface
    // inside a container whose host mapping is loopback-only, "reachable beyond this machine" would
    // be false — and a warning that is wrong in the common case is a warning people learn to ignore.
    process.stdout.write(
      `  NOTE: bound to every interface on ${host}, not just loopback. This server does not verify\n` +
        "  token signatures, so whatever can reach this port can read any session's orders.\n",
    );
  }
});
