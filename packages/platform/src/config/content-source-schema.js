import { z } from 'zod';
import { httpUrl, regexPattern, slug } from './zod-helpers.js';

/**
 * Content kinds, duplicated from `@shopsage/content-model` on purpose.
 *
 * `platform` may not depend on a domain package (docs/adr/0009), and this schema
 * has to validate the value. The list is small, stable, and a drift is caught by a
 * test that asserts the two agree - which is a cheaper coupling than inverting the
 * dependency rule for six strings.
 */
const CONTENT_TYPES = ['page', 'faq', 'guide', 'policy', 'blog', 'other'];

/**
 * A crawlable website.
 *
 * Every knob a crawl needs, and nothing about *which* site - that is the whole
 * point of putting this in a site profile. Two stores with completely different URL
 * layouts run the same build.
 */
const websiteSourceSchema = z
  .object({
    type: z.literal('website'),
    id: slug(),
    /**
     * Off switches beat deletions: an operator debugging one source should not have
     * to remove configuration they will want back.
     */
    enabled: z.boolean().default(true),
    /** Classification applied to every document unless a rule below overrides it. */
    contentType: z.enum(/** @type {[string, ...string[]]} */ (CONTENT_TYPES)).default('page'),
    /**
     * Per-path classification, first match wins.
     *
     * Without this a whole site is one content type, which makes `contentType`
     * useless as a retrieval filter for any store that keeps its FAQs, policies and
     * blog on one domain - in other words, every store.
     */
    classify: z
      .array(
        z
          .object({
            pattern: regexPattern(),
            contentType: z.enum(/** @type {[string, ...string[]]} */ (CONTENT_TYPES)),
          })
          .strict(),
      )
      .max(50)
      .default([]),

    startUrls: z.array(httpUrl()).max(200).default([]),
    sitemaps: z.array(httpUrl()).max(50).default([]),

    /** Empty means "no opinion", not "nothing" - exclude still applies. */
    include: z.array(regexPattern()).max(100).default([]),
    exclude: z.array(regexPattern()).max(100).default([]),

    /**
     * Hosts the crawl may visit. Defaults to the hosts of the seeds.
     *
     * A crawler with no host restriction and no include patterns will follow a
     * footer link and try to crawl the internet. The default is a safety net, not a
     * convenience.
     */
    allowedHosts: z.array(z.string().min(1).max(253)).max(50).default([]),

    maxDepth: z.number().int().min(0).max(20).default(3),
    /** A ceiling on cost and blast radius, not a target. */
    maxPages: z.number().int().min(1).max(50_000).default(500),
    requestsPerSecond: z.number().positive().max(50).default(1),
    /** Only ever lowered for a site you own, and even then reluctantly. */
    respectRobotsTxt: z.boolean().default(true),
    maxDocumentCharacters: z.number().int().min(200).max(1_000_000).default(200_000),
  })
  .strict();

/**
 * The discriminated union of source kinds.
 *
 * One member today. It is a union rather than a bare object so adding a kind cannot
 * quietly widen an existing one, and so an unknown `type` fails at boot naming the
 * source rather than at crawl time naming nothing.
 */
export const contentSourceSchema = z.discriminatedUnion('type', [websiteSourceSchema]);

/**
 * Where a store says what to ingest.
 *
 * Lives in the site profile because it is store-identifying, non-secret deployment
 * data that differs for every store and changes without a release - the same test
 * `identity` and `prompts` pass. It is emphatically **not** part of the browser-safe
 * subset served by `GET /v1/config`: a crawl plan is operational detail, and
 * exclude patterns in particular can name paths a store would rather not publish.
 */
export const contentSchema = z
  .object({
    sources: z.array(contentSourceSchema).max(50).default([]).superRefine(validateSources),
  })
  .strict()
  .default({});

/**
 * Cross-cutting checks that a single source's schema cannot express.
 *
 * A `superRefine` rather than a `refine` on the member schema for two reasons. The
 * mechanical one: `z.discriminatedUnion` accepts only plain object schemas, and a
 * `.refine()` wraps its member in a `ZodEffects` the union rejects. The better one:
 * from here an issue can carry a `path`, so an operator is told *which* source in the
 * array is wrong rather than that something in `content.sources` is.
 *
 * Typed structurally rather than with `z.infer`, which would reference the schema
 * this function is attached to and make the type circular.
 *
 * @param {{ id: string, startUrls: string[], sitemaps: string[] }[]} sources
 * @param {import('zod').RefinementCtx} ctx
 */
function validateSources(sources, ctx) {
  /** @type {Map<string, number>} */
  const seen = new Map();

  sources.forEach((source, index) => {
    const firstIndex = seen.get(source.id);

    if (firstIndex === undefined) {
      seen.set(source.id, index);
    } else {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'id'],
        message: `duplicate content source id "${source.id}" (also at index ${firstIndex})`,
      });
    }

    if (source.startUrls.length === 0 && source.sitemaps.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'startUrls'],
        message: 'a website source needs at least one startUrl or sitemap',
      });
    }
  });
}

/** @typedef {z.infer<typeof contentSchema>} ContentConfig */
/** @typedef {z.infer<typeof contentSourceSchema>} ContentSourceConfig */
