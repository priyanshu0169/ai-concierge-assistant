import { z } from 'zod';
import { ConfigurationError } from '../errors/errors.js';
import { formatIssues } from '../validation/format-issues.js';
import { contentSchema } from './content-source-schema.js';
import { hexColor, httpUrl, slug } from './zod-helpers.js';

/**
 * Who the store and the assistant are. Every customer-visible name comes from
 * here - no company or assistant name may appear in source code.
 */
const identitySchema = z
  .object({
    siteId: slug(),
    companyName: z.string().min(1).max(120),
    assistantName: z.string().min(1).max(60),
    websiteUrl: httpUrl().optional(),
    supportEmail: z.string().email().optional(),
    supportUrl: httpUrl().optional(),
  })
  .strict();

const localizationSchema = z
  .object({
    locale: z.string().min(2).max(35).default('en-US'),
    currency: z.string().length(3).toUpperCase().default('USD'),
    timezone: z.string().min(1).default('UTC'),
  })
  .strict()
  .default({});

/**
 * All model-facing and customer-facing copy. Editing tone of voice must never
 * require a code change.
 */
const promptsSchema = z
  .object({
    systemPrompt: z.string().min(20).max(8000),
    welcomeMessage: z.string().min(1).max(500),
    fallbackMessage: z.string().min(1).max(500),
    noAnswerMessage: z.string().min(1).max(500),
    quickReplies: z.array(z.string().min(1).max(120)).max(8).default([]),
  })
  .strict();

const brandingSchema = z
  .object({
    primaryColor: hexColor().default('#111827'),
    accentColor: hexColor().default('#2563eb'),
    surfaceColor: hexColor().default('#ffffff'),
    position: z.enum(['bottom-right', 'bottom-left']).default('bottom-right'),
    launcherLabel: z.string().min(1).max(40).default('Ask us'),
    avatarUrl: httpUrl().optional(),
  })
  .strict()
  .default({});

/**
 * Retrieval tuning. Exposed as configuration because the right values depend
 * on corpus size and content style, which differ per store.
 */
const retrievalSchema = z
  .object({
    topK: z.number().int().min(1).max(50).default(6),
    minScore: z.number().min(0).max(1).default(0.35),
    maxContextCharacters: z.number().int().min(500).max(60_000).default(8000),
    maxCitations: z.number().int().min(0).max(10).default(3),
    /**
     * How many chunks one document may contribute before others get a turn.
     *
     * Was a constant in `rank-chunks.js`. It became a setting once measurement showed it was the
     * binding constraint on breadth questions: for "what are the different types of caviar" all six
     * retrieved chunks came from the one comprehensive page, and a cap of 2 discarded four of them.
     *
     * The cap still earns its place - a long page can otherwise contribute six near-identical
     * slices and crowd out the page holding the other half of the answer - so this is a dial, not
     * something to remove. Default stays 2 so no existing profile changes behaviour.
     */
    maxPerSource: z.number().int().min(1).max(20).default(2),
  })
  .strict()
  .default({});

/**
 * Chunking. Measured in **characters**, not tokens, and that is deliberate.
 *
 * A token count would need a tokenizer dependency that is specific to one model
 * family, and the default embedding backend publishes no token limit to size
 * against anyway. Characters are model-agnostic and directly observable in the
 * preview CLI. Roughly four characters per token for English prose, fewer for
 * other scripts - so the defaults below sit around 500-700 tokens, which is the
 * range this project's retrieval design targets.
 */
const ingestionSchema = z
  .object({
    /** Hard ceiling per chunk. Oversized blocks are split at sentence boundaries. */
    maxChunkCharacters: z.number().int().min(200).max(20_000).default(2400),
    /**
     * Below this, a trailing fragment is merged backwards instead of standing
     * alone. A 40-character chunk retrieves badly and dilutes its own source.
     */
    minChunkCharacters: z.number().int().min(0).max(4000).default(300),
    /**
     * Carried from the end of one chunk into the start of the next, so an answer
     * spanning a boundary survives in at least one piece.
     */
    overlapCharacters: z.number().int().min(0).max(2000).default(200),
    /**
     * Headings at or above this level force a new chunk. Level 3 keeps an `<h2>`
     * section together while letting `<h4>` subsections share one.
     */
    splitOnHeadingLevel: z.number().int().min(1).max(6).default(3),
    /**
     * Prepend the heading trail to each chunk's embedded text.
     *
     * "Returns policy > International" gives an isolated chunk the context a
     * reader gets from the page around it, and costs a few characters.
     */
    includeHeadingPath: z.boolean().default(true),
  })
  .strict()
  .default({});

/**
 * Retention and prompt size were one setting until a live conversation forgot a name.
 *
 * `maxHistoryMessages` drove both the Redis `lTrim` and the prompt's history limit, so 12 meant
 * *six turns* of memory - measured in messages, and a turn writes two. A tester who introduced
 * themselves on turn 2 was remembered at turn 8 and forgotten by turn 18, because the message had
 * been deleted from Redis six turns earlier.
 *
 * They are separated because they trade off against opposite things, at wildly different prices:
 *
 * - **Storage** costs ~310 bytes per message (measured). Keeping more is close to free, and
 *   `lTrim` is *irreversible* - anything not stored can never be recovered by a later feature
 *   (fact memory, summarisation, quality review, building an eval set from real conversations).
 * - **Prompt** costs ~64 tokens per message on every model call, and a long history carries a real
 *   quality risk: more prior text means more distraction and a greater chance the model answers
 *   from history instead of calling a tool.
 *
 * Coupling them let the prompt budget dictate permanent deletion, which is the wrong direction of
 * control - the same reasoning that keeps prices in the corpus and masks them on the way out
 * (sanitize-knowledge-context.js).
 *
 * `maxHistoryMessages` is kept as a **fallback**, so a profile written before the split keeps
 * working unchanged and means exactly what it used to.
 */
const conversationSchema = z
  .object({
    /** Deprecated. The default for both values below when neither is given. */
    maxHistoryMessages: z.number().int().min(2).max(50).default(12),
    /**
     * Messages Redis keeps. Bounded well above the prompt because storage is cheap and the
     * discard is permanent; the sliding idle TTL is what actually limits a conversation's life.
     */
    maxStoredMessages: z.number().int().min(2).max(1000).optional(),
    /**
     * Messages replayed to the model. Two per turn, so 50 is 25 turns - the point where a fact
     * stated at the start of a session survives to the end of a long one.
     */
    maxPromptMessages: z.number().int().min(2).max(200).optional(),
    maxUserMessageLength: z.number().int().min(50).max(8000).default(2000),
    sessionIdleTimeoutMinutes: z.number().int().min(1).max(1440).default(60),
  })
  .strict()
  .default({})
  .transform((conversation) => ({
    ...conversation,
    maxStoredMessages: conversation.maxStoredMessages ?? conversation.maxHistoryMessages,
    maxPromptMessages: conversation.maxPromptMessages ?? conversation.maxHistoryMessages,
  }))
  // Replaying more than is stored is not an error worth failing a boot over - it just silently
  // caps at whatever Redis held. Clamped so the effective value is the honest one.
  .transform((conversation) => ({
    ...conversation,
    maxPromptMessages: Math.min(conversation.maxPromptMessages, conversation.maxStoredMessages),
  }));

/**
 * Capability switches. Every future tool ships behind a flag that defaults to
 * off, so adding a capability to the platform never changes the behaviour of
 * an existing store until its profile opts in.
 */
const featuresSchema = z
  .object({
    knowledgeSearch: z.boolean().default(true),
    streaming: z.boolean().default(true),
    productSearch: z.boolean().default(false),
    productComparison: z.boolean().default(false),
    recommendations: z.boolean().default(false),
    cart: z.boolean().default(false),
    coupons: z.boolean().default(false),
    orderTracking: z.boolean().default(false),
    recipes: z.boolean().default(false),
    winePairings: z.boolean().default(false),
  })
  .strict()
  .default({});

const integrationsSchema = z
  .object({
    backendUrl: httpUrl(),
    magentoApiUrl: httpUrl().optional(),
  })
  .strict();

/**
 * The complete site profile: everything that makes a deployment belong to a
 * particular store. Unknown keys are rejected so that a typo fails at boot
 * rather than silently reverting to a default.
 */
export const siteProfileSchema = z
  .object({
    identity: identitySchema,
    localization: localizationSchema,
    prompts: promptsSchema,
    branding: brandingSchema,
    retrieval: retrievalSchema,
    ingestion: ingestionSchema,
    conversation: conversationSchema,
    features: featuresSchema,
    integrations: integrationsSchema,
    content: contentSchema,
  })
  .strict();

/** @typedef {z.infer<typeof siteProfileSchema>} SiteProfile */

/**
 * Validate a site profile document.
 *
 * @param {unknown} document Parsed JSON.
 * @param {string} [sourcePath] Included in the error for operator diagnostics.
 * @returns {SiteProfile}
 * @throws {ConfigurationError} If the profile is invalid.
 */
export function parseSiteProfile(document, sourcePath) {
  const result = siteProfileSchema.safeParse(document);

  if (!result.success) {
    throw new ConfigurationError('Site profile is invalid', {
      details: { sourcePath, issues: formatIssues(result.error) },
    });
  }

  return result.data;
}
