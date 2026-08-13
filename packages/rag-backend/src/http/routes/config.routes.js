import { Router } from 'express';
import { identityValues, renderTemplate } from '@shopsage/assistant-core';

/**
 * The widget's bootstrap.
 *
 * **Deliberately unauthenticated**, and the only route under `/v1` that is. Two reasons, and
 * the second is the decisive one:
 *
 * 1. The widget needs this before it can render anything, and it has no session token until
 *    the customer opens the panel. Requiring a token to learn the assistant's *name* would
 *    mean minting a credential on every page view of every page.
 * 2. **Every field here is already public.** The widget paints it into a page any visitor can
 *    read - the launcher label, the welcome message, the brand colours. Authenticating data
 *    that is about to be published protects nothing.
 *
 * It is still rate limited, keyed by address rather than by session, because it is the one
 * `/v1` route reachable without a token.
 *
 * The **exclusions** are the part worth reviewing. This is browser-facing, so it carries no
 * secret, no dependency address, and above all **no system prompt**: a store's prompt is how
 * it constrains the model, and publishing it hands anyone trying to talk the assistant out of
 * its instructions the exact text to work around. A test asserts each of those stays out.
 *
 * @param {{ config: import('@shopsage/platform').AppConfig }} dependencies
 * @returns {import('express').Router}
 */
export function createConfigRouter(dependencies) {
  const body = toWidgetConfig(dependencies.config.siteProfile);
  const router = Router();

  router.get('/', (_req, res) => {
    // Short and public. The values change only on a deployment, so a browser may hold them
    // for a few minutes; `must-revalidate` keeps a stale panel from surviving a rebrand.
    res.setHeader('cache-control', 'public, max-age=300, must-revalidate');
    res.json(body);
  });

  return router;
}

/**
 * The browser-safe subset of a site profile.
 *
 * Built once at construction: the profile is fixed for the process's lifetime, and rebuilding
 * per request would invite somebody to make it depend on the request.
 *
 * Assembled by naming each field rather than by deleting the unsafe ones from a copy. A
 * deny-list silently publishes whatever is added to the profile next; an allow-list makes a
 * new field invisible until somebody decides it belongs here.
 *
 * Customer-facing copy has its `{{assistantName}}` and `{{companyName}}` placeholders resolved
 * here, by the same function the domain uses on the system prompt. Publishing the raw template
 * would put the braces in front of a customer.
 *
 * @param {import('@shopsage/platform').SiteProfile} siteProfile
 */
function toWidgetConfig(siteProfile) {
  const { identity, localization, prompts, branding, conversation, features } = siteProfile;
  // The same substitution the domain applies to the system prompt, using the same function.
  // Without it a store writing "Hi! I'm {{assistantName}}." would have a customer greeted with
  // the braces - found exactly that way, by reading the response rather than the schema.
  const copy = (/** @type {string} */ value) => renderTemplate(value, identityValues(siteProfile));

  return {
    assistantName: identity.assistantName,
    companyName: identity.companyName,
    locale: localization.locale,
    // The copy the widget needs to render on its own: a greeting before the first question,
    // and something to say when a request fails. `noAnswerMessage` is absent on purpose - the
    // backend applies that one, because deciding an answer is empty is not the widget's job.
    welcomeMessage: copy(prompts.welcomeMessage),
    fallbackMessage: copy(prompts.fallbackMessage),
    quickReplies: prompts.quickReplies.map(copy),
    branding: {
      primaryColor: branding.primaryColor,
      accentColor: branding.accentColor,
      surfaceColor: branding.surfaceColor,
      position: branding.position,
      launcherLabel: branding.launcherLabel,
      ...(branding.avatarUrl === undefined ? {} : { avatarUrl: branding.avatarUrl }),
    },
    limits: { maxUserMessageLength: conversation.maxUserMessageLength },
    // Only the flags a browser can act on. `knowledgeSearch` is deliberately absent: whether
    // the assistant retrieves is not something a widget renders differently.
    features: { streaming: features.streaming },
  };
}
