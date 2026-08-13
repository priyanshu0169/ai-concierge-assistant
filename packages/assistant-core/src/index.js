/**
 * @shopsage/assistant-core - the domain.
 *
 * Conversation management, retrieval orchestration, context building, prompt building,
 * the tool registry, source ranking and answer formatting. Contains **no HTTP, no
 * framework, no Magento, no vendor SDK**, and imports no factory function from any
 * outbound adapter.
 *
 * Everything it needs arrives as a port it declared itself (`src/types.js`), at the
 * narrowest useful width. `KnowledgeRetriever` is the one worth noticing: the domain
 * asks for "content relevant to this question" and is told nothing about embeddings or
 * vectors, so swapping to a keyword index or a hybrid retriever is an adapter change.
 * See docs/adr/0003 and docs/adr/0021.
 *
 * Each responsibility is a separate unit because an LLM makes end-to-end assertions
 * weak: the same input can produce different output. The deterministic parts - what got
 * ranked, how context was truncated, how sources were deduplicated, what the prompt
 * contained - are individually testable without a model in the loop, and that is where
 * most of this package's tests live.
 */

export { createConversationManager } from './conversation/create-conversation-manager.js';
export { createMemoryConversationStore } from './conversation/memory-conversation-store.js';
export { createMemoryProposalStore } from './conversation/memory-proposal-store.js';
export { bufferedRounds, streamedRounds } from './conversation/model-rounds.js';
export { runToolLoop } from './conversation/run-tool-loop.js';
export { formatAnswer } from './answer/format-answer.js';
export { buildMessages } from './prompt/build-messages.js';
export { identityValues, renderTemplate } from './prompt/render-template.js';
export { buildContext } from './retrieval/build-context.js';
export { rankChunks, toSources } from './retrieval/rank-chunks.js';
export { sanitizeKnowledgeContext } from './retrieval/sanitize-knowledge-context.js';
export { createToolRegistry } from './tools/tool-registry.js';
export { createSearchKnowledgeTool } from './tools/search-knowledge-tool.js';
export { createSearchProductsTool } from './tools/search-products-tool.js';
export { createCompareProductsTool } from './tools/compare-products-tool.js';
export { createRecommendProductsTool } from './tools/recommend-products-tool.js';
export { createTrackOrderTool } from './tools/track-order-tool.js';
export { compareProducts } from './commerce/compare-products.js';
export { confirmCartProposal } from './commerce/confirm-cart-proposal.js';
export { createCartProposal, isLive, summariseLines } from './commerce/create-cart-proposal.js';
export { rankRecommendations } from './commerce/rank-recommendations.js';
export { redactPersonalData, redactTurn } from './privacy/redact-personal-data.js';

/**
 * @typedef {import('./types.js').AssistantReply} AssistantReply
 * @typedef {import('./types.js').AssistantStreamEvent} AssistantStreamEvent
 * @typedef {import('./types.js').AnswerSource} AnswerSource
 * @typedef {import('./types.js').AssistantTool} AssistantTool
 * @typedef {import('./types.js').CartOutcome} CartOutcome
 * @typedef {import('./types.js').CartProposal} CartProposal
 * @typedef {import('./types.js').CartProposalLine} CartProposalLine
 * @typedef {import('./types.js').CartProposalStore} CartProposalStore
 * @typedef {import('./types.js').CommerceCart} CommerceCart
 * @typedef {import('./types.js').CommerceCatalogue} CommerceCatalogue
 * @typedef {import('./types.js').ConversationStore} ConversationStore
 * @typedef {import('./types.js').ConversationTurn} ConversationTurn
 * @typedef {import('./types.js').KnowledgeRetriever} KnowledgeRetriever
 * @typedef {import('./types.js').LanguageModel} LanguageModel
 * @typedef {import('./types.js').Money} Money
 * @typedef {import('./types.js').Order} Order
 * @typedef {import('./types.js').Product} Product
 * @typedef {import('./types.js').RetrievedChunk} RetrievedChunk
 * @typedef {import('./types.js').ToolContext} ToolContext
 * @typedef {import('./types.js').ToolResult} ToolResult
 * @typedef {import('./conversation/create-conversation-manager.js').AssistantRequest} AssistantRequest
 * @typedef {import('./conversation/create-conversation-manager.js').ConversationManager} ConversationManager
 */
