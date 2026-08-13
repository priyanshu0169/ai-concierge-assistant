import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatAnswer } from '../src/answer/format-answer.js';
import { buildMessages } from '../src/prompt/build-messages.js';
import { identityValues, renderTemplate } from '../src/prompt/render-template.js';
import { createToolRegistry } from '../src/tools/tool-registry.js';
import { testChunk, testProfile } from './helpers/domain-doubles.js';

describe('renderTemplate', () => {
  it('substitutes a placeholder', () => {
    assert.equal(
      renderTemplate('I am {{assistantName}}.', { assistantName: 'Sage' }),
      'I am Sage.',
    );
  });

  it('substitutes every occurrence', () => {
    assert.equal(renderTemplate('{{a}} and {{a}}', { a: 'x' }), 'x and x');
  });

  it('tolerates whitespace inside the braces', () => {
    assert.equal(renderTemplate('{{ companyName }}', { companyName: 'Demo' }), 'Demo');
  });

  it('leaves an unknown placeholder exactly as written', () => {
    // Deleting it would silently change a prompt's meaning; leaving it visible makes
    // the typo obvious the first time anyone reads the output.
    assert.equal(renderTemplate('Ask {{nobody}}.', { assistantName: 'Sage' }), 'Ask {{nobody}}.');
  });

  it('does not treat inherited object properties as values', () => {
    assert.equal(renderTemplate('{{toString}}', {}), '{{toString}}');
  });

  it('does not re-scan a substituted value', () => {
    // A store's own copy must not be able to expand into another placeholder.
    assert.equal(renderTemplate('{{a}}', { a: '{{b}}', b: 'expanded' }), '{{b}}');
  });
});

describe('identityValues', () => {
  it('exposes only the identity a store may interpolate', () => {
    assert.deepEqual(identityValues(testProfile()), {
      assistantName: 'Sage',
      companyName: 'Demo Store',
    });
  });
});

describe('buildMessages', () => {
  const siteProfile = testProfile();

  it('leads with the store system prompt, placeholders resolved', () => {
    const messages = buildMessages({
      siteProfile,
      history: [],
      message: 'Hi.',
      toolNames: [],
    });

    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].content ?? '', /^You are Sage for Demo Store/);
  });

  it('adds no tool protocol when there are no tools', () => {
    const messages = buildMessages({ siteProfile, history: [], message: 'Hi.', toolNames: [] });

    assert.ok(!(messages[0].content ?? '').includes('You have tools available'));
  });

  it('names the available tools when there are some', () => {
    const messages = buildMessages({
      siteProfile,
      history: [],
      message: 'Hi.',
      toolNames: ['searchKnowledge'],
    });

    assert.match(messages[0].content ?? '', /available tools: searchKnowledge/);
  });

  it('places history between the system prompt and the question', () => {
    const messages = buildMessages({
      siteProfile,
      history: [
        { role: 'user', content: 'Earlier question', at: '2026-01-01T00:00:00.000Z' },
        { role: 'assistant', content: 'Earlier answer', at: '2026-01-01T00:00:01.000Z' },
      ],
      message: 'Follow-up',
      toolNames: [],
    });

    assert.deepEqual(
      messages.map((message) => message.role),
      ['system', 'user', 'assistant', 'user'],
    );
    assert.equal(messages.at(-1)?.content, 'Follow-up');
  });

  it('does not place retrieved context here', () => {
    // Context arrives as a tool result inside the loop, which is what lets the model
    // ask a second, better question when the first search misses.
    const messages = buildMessages({
      siteProfile,
      history: [],
      message: 'Hi.',
      toolNames: ['searchKnowledge'],
    });

    assert.equal(messages.length, 2);
  });
});

describe('createToolRegistry', () => {
  it('enables searchKnowledge when the store opted in', () => {
    const registry = createToolRegistry(testProfile());

    assert.deepEqual(
      registry.tools.map((tool) => tool.name),
      ['searchKnowledge'],
    );
  });

  it('enables nothing when the store opted out', () => {
    // Every capability ships behind a flag, so adding a tool to the platform cannot
    // change an existing store's behaviour until its profile opts in.
    const registry = createToolRegistry(testProfile({ features: { knowledgeSearch: false } }));

    assert.deepEqual(registry.tools, []);
    assert.deepEqual(registry.definitions, []);
  });

  it('derives the wire definitions from the tools themselves', () => {
    // A tool cannot be executable but undeclared, or declared but unexecutable.
    const registry = createToolRegistry(testProfile());
    const [definition] = registry.definitions;

    assert.equal(definition.name, 'searchKnowledge');
    assert.ok(definition.description.length > 0);
    assert.equal(definition.parameters.type, 'object');
  });

  it('forbids quoting prices and stock, without claiming the corpus holds no products', () => {
    // This assertion used to require the description to say the corpus "does not contain product
    // listings, prices or stock". Half of that was a real rule and half was false: a crawled
    // storefront is mostly category and product pages. The false half made the model refuse to
    // search 887 such pages for "what kinds of caviar do you sell". The rule that survives is the
    // one about freshness - never quote a figure from an indexed page.
    const [tool] = createToolRegistry(testProfile()).tools;

    assert.match(tool.description, /never quote a price or a stock level/iu);
    assert.doesNotMatch(tool.description, /does not contain product listings/iu);
  });

  it('tells the model the corpus covers what the store sells, so discovery questions reach it', () => {
    // The routing defect this pins: a model that does not believe category pages are searchable
    // sends "what types of X do you sell" to the live catalogue instead, and answers nothing at
    // all when that is unavailable.
    const [tool] = createToolRegistry(testProfile()).tools;

    assert.match(tool.description, /what kinds of products|what types of X do you sell/iu);
  });

  it('finds a tool by name, and reports an unknown one as absent', () => {
    const registry = createToolRegistry(testProfile());

    assert.equal(registry.find('searchKnowledge')?.name, 'searchKnowledge');
    assert.equal(registry.find('searchProducts'), undefined);
  });
});

describe('formatAnswer', () => {
  const siteProfile = testProfile();

  /**
   * @param {Partial<import('@shopsage/llm-client').LlmCompletion>} completion
   * @param {import('../src/types.js').RetrievedChunk[]} [chunks]
   */
  const format = (completion, chunks = []) =>
    formatAnswer({
      completion: {
        content: completion.content ?? '',
        toolCalls: completion.toolCalls ?? [],
        finishReason: completion.finishReason ?? 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
      chunks,
      siteProfile,
      conversationId: 'c_1',
      messageId: 'm_1',
    });

  it('passes a real answer through, trimmed', () => {
    assert.equal(format({ content: '  Thirty days.  ' }).answer, 'Thirty days.');
  });

  it('substitutes the store no-answer copy for an empty answer', () => {
    // An empty chat bubble reads as broken software.
    assert.equal(format({ content: '' }).answer, 'I could not find that in our store information.');
  });

  it('resolves placeholders in the no-answer copy', () => {
    const withPlaceholder = testProfile({
      prompts: {
        systemPrompt: 'You are {{assistantName}} for {{companyName}}. Answer only from context.',
        welcomeMessage: 'Hi.',
        fallbackMessage: 'Oops.',
        noAnswerMessage: '{{assistantName}} could not find that.',
      },
    });

    const reply = formatAnswer({
      completion: {
        content: '',
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
      chunks: [],
      siteProfile: withPlaceholder,
      conversationId: 'c_1',
      messageId: 'm_1',
    });

    assert.equal(reply.answer, 'Sage could not find that.');
  });

  it('attaches sources only when the answer was grounded', () => {
    assert.deepEqual(format({ content: 'Guessed.' }).sources, []);
    assert.equal(format({ content: 'Guessed.' }).grounded, false);

    const grounded = format({ content: 'From the docs.' }, [testChunk()]);
    assert.equal(grounded.grounded, true);
    assert.equal(grounded.sources.length, 1);
  });

  it('carries the identifiers and finish reason through', () => {
    const reply = format({ content: 'Truncated', finishReason: 'length' });

    assert.equal(reply.conversationId, 'c_1');
    assert.equal(reply.messageId, 'm_1');
    assert.equal(reply.finishReason, 'length');
  });
});
