import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { installDom } from './helpers/dom.js';

/** @type {() => void} */
let restore;
/** @type {any} */
let renderMarkdown;
/** @type {any} */
let renderInline;

before(async () => {
  restore = installDom();
  // Imported after the DOM globals exist: both modules call `document.createElement` the moment
  // they render, and one of them reads `window.location` to resolve a relative href.
  ({ renderMarkdown } = await import('../src/markdown/render-markdown.js'));
  ({ renderInline } = await import('../src/markdown/render-inline.js'));
});

after(() => restore());

/** @param {string} markdown */
const outline = (markdown) => renderMarkdown(markdown).outline;

describe('rendering a model’s answer', () => {
  describe('the security guarantee', () => {
    // The whole reason this renderer builds nodes instead of assigning innerHTML: the text
    // comes from a language model, so it is untrusted input. A model can be talked into
    // emitting any of the following.

    it('renders a script tag as text, not as an element', () => {
      // Asserted on node *types*, not on serialized output: a serializer prints the characters
      // of a text node either way, so a string check would pass for the wrong reason. What
      // matters is that no element exists — and the fake DOM cannot parse markup, so if this
      // renderer ever reached for `innerHTML` there would be nothing here at all.
      const [paragraph] = renderMarkdown('Hello <script>alert(1)</script> world').children;

      assert.deepEqual(
        paragraph.children.map((/** @type {any} */ child) => child.constructor.name),
        ['FakeText'],
      );
      assert.equal(paragraph.textContent, 'Hello <script>alert(1)</script> world');
      assert.deepEqual(paragraph.findAll('script'), []);
    });

    it('creates no element from an img onerror payload', () => {
      const fragment = renderMarkdown('<img src=x onerror="alert(1)">');
      const [paragraph] = fragment.children;

      assert.equal(paragraph.localName, 'p');
      // One text node, no img.
      assert.deepEqual(
        paragraph.children.map((/** @type {any} */ child) => child.constructor.name),
        ['FakeText'],
      );
    });

    it('refuses a javascript: link, keeping the words', () => {
      const fragment = renderInline('[click me](javascript:alert(1))');

      assert.equal(fragment.textContent, 'click me');
      assert.equal(fragment.children[0].constructor.name, 'FakeText');
    });

    it('refuses a data: link', () => {
      // The one people forget. `data:text/html` opens an attacker-authored page on a blank
      // origin.
      const fragment = renderInline('[open](data:text/html,<script>alert(1)</script>)');

      assert.equal(fragment.children[0].constructor.name, 'FakeText');
    });

    it('refuses a vbscript: link', () => {
      assert.equal(renderInline('[x](vbscript:msgbox)').children[0].constructor.name, 'FakeText');
    });

    it('keeps a URL containing balanced parentheses intact', () => {
      // A real bug this test was written for: `[^)]+` stops at the first bracket, which broke
      // every Wikipedia-style link and left a stray `)` in the prose.
      const [anchor, ...rest] = renderInline(
        '[Ruby](https://en.wikipedia.org/wiki/Ruby_(programming_language))',
      ).children;

      assert.equal(anchor.localName, 'a');
      assert.equal(
        anchor.getAttribute('href'),
        'https://en.wikipedia.org/wiki/Ruby_(programming_language)',
      );
      assert.deepEqual(rest, [], 'nothing should be left over');
    });

    it('allows http and https, with the window opened safely', () => {
      const [anchor] = renderInline('[Returns](https://store.example.com/returns)').children;

      assert.equal(anchor.localName, 'a');
      assert.equal(anchor.getAttribute('href'), 'https://store.example.com/returns');
      // `noopener` denies the opened page a handle on this one; `noreferrer` keeps the
      // customer's current URL out of a third party's logs.
      assert.equal(anchor.getAttribute('rel'), 'noopener noreferrer');
      assert.equal(anchor.getAttribute('target'), '_blank');
    });

    it('shows HTML inside a fence rather than running it', () => {
      const fragment = renderMarkdown('```\n<script>alert(1)</script>\n```');
      const [pre] = fragment.children;

      assert.equal(pre.localName, 'pre');
      assert.equal(pre.textContent, '<script>alert(1)</script>');
      assert.deepEqual(pre.findAll('script'), []);
    });
  });

  describe('inline', () => {
    it('renders bold and italic', () => {
      assert.match(
        outline('**bold** and *italic*'),
        /<strong>bold<\/strong> and <em>italic<\/em>/u,
      );
    });

    it('renders inline code', () => {
      assert.match(outline('use `npm test` first'), /<code>npm test<\/code>/u);
    });

    it('treats a code span as opaque to emphasis', () => {
      // Precedence, not an accident: `**` inside backticks is content.
      const result = outline('`**not bold**`');

      assert.ok(!result.includes('<strong>'), result);
      assert.match(result, /<code>\*\*not bold\*\*<\/code>/u);
    });

    it('leaves an unclosed marker as literal text', () => {
      // The state of every streamed answer mid-delta. Swallowing the rest of the sentence
      // would be the wrong failure mode.
      assert.equal(renderMarkdown('this is **partial').textContent, 'this is **partial');
    });
  });

  describe('blocks', () => {
    it('separates paragraphs on a blank line', () => {
      assert.match(outline('first\n\nsecond'), /<p>first<\/p><p>second<\/p>/u);
    });

    it('keeps a single newline inside a paragraph as a line break', () => {
      assert.match(outline('line one\nline two'), /<br><\/br>|<br>/u);
    });

    it('renders an unordered list', () => {
      const result = outline('- one\n- two');

      assert.match(result, /<ul>/u);
      assert.equal((result.match(/<li>/gu) ?? []).length, 2);
    });

    it('renders an ordered list', () => {
      assert.match(outline('1. first\n2. second'), /<ol>/u);
    });

    it('renders a heading', () => {
      assert.match(outline('## Returns'), /<h2>Returns<\/h2>/u);
    });

    it('labels a code block with its language, for screen readers', () => {
      const [pre] = renderMarkdown('```bash\nnpm test\n```').children;

      assert.equal(pre.getAttribute('aria-label'), 'bash code block');
      assert.equal(pre.findAll('code')[0].getAttribute('data-language'), 'bash');
    });

    it('makes a code block keyboard reachable, because it scrolls', () => {
      // A scroll region a keyboard cannot reach is a region some people cannot read.
      const [pre] = renderMarkdown('```\nx\n```').children;

      assert.equal(pre.getAttribute('tabindex'), '0');
    });

    it('keeps a blank line inside a fence', () => {
      const [pre] = renderMarkdown('```\nfirst\n\nsecond\n```').children;

      assert.equal(pre.textContent, 'first\n\nsecond');
    });

    it('treats an unterminated fence as a code block still arriving', () => {
      // Mid-stream this is the normal state, not an error.
      const [pre] = renderMarkdown('```js\nconst x = 1;').children;

      assert.equal(pre.localName, 'pre');
      assert.equal(pre.textContent, 'const x = 1;');
    });

    it('renders nothing for empty input', () => {
      assert.equal(renderMarkdown('').children.length, 0);
    });

    it('survives a realistic answer', () => {
      const answer = [
        'You have **thirty days** to return unopened items.',
        '',
        'To start a return:',
        '',
        '- Sign in to your account',
        '- Choose `Orders`',
        '',
        'See the [returns policy](https://store.example.com/help/returns).',
      ].join('\n');

      const result = outline(answer);

      assert.match(result, /<strong>thirty days<\/strong>/u);
      assert.match(result, /<ul>/u);
      assert.match(result, /<a href="https:\/\/store\.example\.com\/help\/returns"/u);
    });
  });
});
