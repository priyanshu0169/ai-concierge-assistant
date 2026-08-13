import { z } from 'zod';

/**
 * Opaque, short, and safe in a storage key.
 *
 * A conversation id becomes a cache or database key in Stage 6, and it arrives
 * from a browser. Constraining the character set now costs nothing and closes an
 * injection route into whichever key space it lands in.
 *
 * Permissive enough that a caller may supply its own id - the Magento connector
 * may well want to - as long as it is a plain token.
 */
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Build the `POST /v1/chat` request schema for a store.
 *
 * The message ceiling comes from the site profile rather than a constant: how
 * long a question may be is a store's decision, and it is also a cost control -
 * every character reaches the model's context window.
 *
 * `.strict()` rejects unknown keys. A field the API does not understand is
 * either a client bug or an attempt to smuggle a parameter into the model call,
 * and both deserve a 400 rather than silence.
 *
 * @param {import('@shopsage/platform').SiteProfile} siteProfile
 * @returns {import('zod').ZodType<{ message: string, conversationId?: string }>}
 */
export function buildChatRequestSchema(siteProfile) {
  const { maxUserMessageLength } = siteProfile.conversation;

  return z
    .object({
      conversationId: z
        .string()
        .regex(CONVERSATION_ID_PATTERN, 'must be an opaque identifier of up to 64 characters')
        .optional(),
      message: z
        .string()
        .trim()
        .min(1, 'must not be empty')
        .max(maxUserMessageLength, `must be at most ${maxUserMessageLength} characters`),
    })
    .strict();
}
