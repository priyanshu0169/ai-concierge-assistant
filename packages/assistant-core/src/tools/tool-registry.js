import { createAddToCartTool } from './add-to-cart-tool.js';
import { createApplyCouponTool } from './apply-coupon-tool.js';
import { createCompareProductsTool } from './compare-products-tool.js';
import { createRecommendProductsTool } from './recommend-products-tool.js';
import { createSearchKnowledgeTool } from './search-knowledge-tool.js';
import { createSearchProductsTool } from './search-products-tool.js';
import { createTrackOrderTool } from './track-order-tool.js';

/**
 * Maps a site-profile feature flag onto the tool it enables.
 *
 * Every capability ships behind a flag that defaults to off, so adding a tool to the
 * platform cannot change an existing store's behaviour until that store opts in. A
 * shared platform where a release silently changes what a customer's assistant can do
 * is not safely upgradable.
 *
 * Stage 9a was the first test of that claim and it passed: four commerce tools arrived as four
 * entries in this table and the loop below did not change.
 *
 * Stage 9b was the harder test, and the prediction held. `addToCart` and `applyCoupon` are two more
 * entries here - but the loop *did* change, because a proposal is a third kind of thing a tool can
 * return alongside text and chunks, and only one may survive a turn. The table absorbed the tools;
 * it could not absorb a new outcome. That is the honest boundary of this pattern.
 *
 * Each entry also declares the **session capability** it requires, which is a different
 * question from the feature flag: the flag asks what this store turned on, the scope asks
 * what this customer may do. A guest and a signed-in customer meet the same deployment with
 * the same flags and must not get the same tool set. `trackOrder` is the first entry where
 * the two genuinely differ - a store can enable order tracking for everyone while a guest
 * session still never sees the tool.
 *
 * @type {Readonly<Record<string, {
 *   create: (siteProfile: import('@shopsage/platform').SiteProfile) => import('../types.js').AssistantTool,
 *   scope: string,
 * }>>}
 */
const TOOL_FACTORIES = Object.freeze({
  knowledgeSearch: { create: createSearchKnowledgeTool, scope: 'chat' },
  productSearch: { create: createSearchProductsTool, scope: 'chat' },
  productComparison: { create: createCompareProductsTool, scope: 'chat' },
  recommendations: { create: createRecommendProductsTool, scope: 'chat' },
  orderTracking: { create: createTrackOrderTool, scope: 'orders' },
  // Both **propose**; neither can execute. The write port is not in a tool's reach, so "the model
  // must not commit" is a property of what is reachable rather than a rule to be trusted with
  // (docs/adr/0029).
  cart: { create: createAddToCartTool, scope: 'cart' },
  coupons: { create: createApplyCouponTool, scope: 'cart' },
});

/**
 * @typedef {object} ToolRegistry
 * @property {import('../types.js').AssistantTool[]} tools
 * @property {import('@shopsage/llm-client').LlmToolDefinition[]} definitions
 * @property {(name: string) => import('../types.js').AssistantTool | undefined} find
 */

/**
 * Build the tools available to this store **and this session**.
 *
 * A tool the session lacks the scope for is simply **absent**, and that is the whole design.
 * Offering it and refusing the call would have the model promise something it cannot
 * deliver, leaving a customer waiting for an answer that never comes. Absent, the model says
 * it cannot look that up - which is true, and already how a disabled feature behaves
 * (docs/adr/0022, and §9 of the session-token contract).
 *
 * `scopes` is optional, and omitting it grants everything the store has enabled. That suits
 * a caller with no session concept - a test, or a future batch entry point - and means the
 * domain does not have to know whether authentication exists.
 *
 * @param {import('@shopsage/platform').SiteProfile} siteProfile
 * @param {string[]} [scopes] Capabilities this session holds.
 * @returns {ToolRegistry}
 */
export function createToolRegistry(siteProfile, scopes) {
  const granted = scopes === undefined ? undefined : new Set(scopes);

  const tools = Object.entries(TOOL_FACTORIES)
    .filter(
      ([flag]) => siteProfile.features[/** @type {keyof typeof siteProfile.features} */ (flag)],
    )
    .filter(([, entry]) => granted === undefined || granted.has(entry.scope))
    .map(([, entry]) => entry.create(siteProfile));

  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    tools,
    // The wire shape the model is offered. Kept derived rather than hand-written, so a
    // tool cannot be executable but undeclared, or declared but unexecutable.
    definitions: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    find: (name) => byName.get(name),
  };
}
