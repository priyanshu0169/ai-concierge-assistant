import { identityValues, renderTemplate } from '../prompt/render-template.js';
import { toSources } from '../retrieval/rank-chunks.js';

/**
 * Turn a completion into what the customer receives.
 *
 * Two substitutions happen here, both using the store's own copy rather than any
 * hard-coded string:
 *
 * - **An empty answer becomes `noAnswerMessage`.** A model can return nothing at all -
 *   content filtering, an unlucky stop sequence, a gateway quirk - and an empty chat
 *   bubble reads as broken software.
 * - **A truncated answer is reported as such** through `finishReason`, not silently
 *   presented as complete.
 *
 * Sources are attached **only when the answer was grounded**. Citing a page the model
 * did not use is worse than citing nothing: it lends borrowed authority to an answer
 * that came from the model's own knowledge, which is precisely the failure retrieval
 * exists to prevent.
 *
 * @param {{
 *   completion: import('@shopsage/llm-client').LlmCompletion,
 *   chunks: import('../types.js').RetrievedChunk[],
 *   siteProfile: import('@shopsage/platform').SiteProfile,
 *   conversationId: string,
 *   messageId: string,
 * }} input
 * @returns {import('../types.js').AssistantReply}
 */
export function formatAnswer(input) {
  const { completion, chunks, siteProfile, conversationId, messageId } = input;

  const grounded = chunks.length > 0;
  const spoken = completion.content.trim();

  const answer =
    spoken === ''
      ? renderTemplate(siteProfile.prompts.noAnswerMessage, identityValues(siteProfile))
      : spoken;

  return {
    conversationId,
    messageId,
    answer,
    sources: grounded
      ? toSources({ chunks, maxCitations: siteProfile.retrieval.maxCitations })
      : [],
    finishReason: completion.finishReason,
    grounded,
  };
}
