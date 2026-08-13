/**
 * @shopsage/magento-client - the commerce connector, behind a port.
 *
 * The **only** package that knows the wire format in
 * `docs/proposals/0002-commerce-connector-contract.md`. Everything above it - the tools, the
 * conversation loop, the domain - sees the `CommerceCatalogue` port that `assistant-core` declared,
 * and cannot tell that a Magento module is answering.
 *
 * `reference/server.js` runs the contract as a stand-in connector: a runnable specification for the
 * module's author, and what ShopSage's own end-to-end verification runs against. Keeping both in
 * one package is deliberate - an adapter and the thing it is written against should not drift.
 */

export { createMagentoClient } from './create-magento-client.js';
export { createMagentoCart } from './create-magento-cart.js';
export { toOrder, toPrice, toProduct } from './wire/to-product.js';

/**
 * @typedef {import('./create-magento-client.js').MagentoClientOptions} MagentoClientOptions
 */
