import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseHtmlPage } from '../src/website/html-document.js';

/**
 * @param {string} body
 * @param {string} [head]
 * @returns {string}
 */
function page(body, head = '') {
  return `<!doctype html><html lang="en-GB"><head><title>Site</title>${head}</head><body>${body}</body></html>`;
}

describe('parseHtmlPage', () => {
  describe('chrome removal', () => {
    it('removes navigation, header, footer and aside', () => {
      // The highest-impact behaviour in the scraper: a nav repeated across 300 pages
      // makes 300 chunks that are largely identical, and an embedding model cannot
      // tell them apart.
      const html = page(`
        <nav>Home Products Basket</nav>
        <header>Store header</header>
        <main><p>Unopened items may be returned within thirty days.</p></main>
        <aside>Related links</aside>
        <footer>Copyright notice</footer>
      `);

      const { text } = parseHtmlPage(html);

      assert.match(text, /Unopened items/);
      for (const chrome of ['Basket', 'Store header', 'Related links', 'Copyright']) {
        assert.ok(!text.includes(chrome), `${chrome} should have been removed`);
      }
    });

    it('removes scripts, styles and forms', () => {
      const html = page(`
        <main>
          <script>var tracking = 1;</script>
          <style>.a { color: red }</style>
          <form><input name="q"></form>
          <p>Real content lives here.</p>
        </main>
      `);

      const { text } = parseHtmlPage(html);

      assert.equal(text.includes('tracking'), false);
      assert.equal(text.includes('color'), false);
      assert.match(text, /Real content/);
    });

    it('removes the per-product trust-badge strip, which poisoned delivery retrieval', () => {
      // Measured defect, not a tidiness preference: this strip is identical on 724 product pages,
      // and once heading paths were restored its "DELIVERY & RETURNS" heading made all 724 look
      // like delivery policy - taking five of six result slots for "how long does delivery take?"
      // and burying the FAQ's real answers. See docs/evaluation/README.md runs 003-007.
      const html = page(
        '<main><p>Beluga caviar has large, delicate pearls and a buttery flavour.</p>' +
          '<section class="delivery-returns"><h3>DELIVERY &amp; RETURNS</h3>' +
          '<h6>NEXT DAY DELIVERY</h6><p>PRIORITY DELIVERY OPTIONS AVAILABLE FOR ALL ORDERS</p>' +
          '<h6>QUALITY GUARANTEE</h6><p>GUARANTEED FRESHNESS AND QUALITY OF PRODUCTS</p>' +
          '</section></main>',
      );

      const { text } = parseHtmlPage(html);

      assert.match(text, /large, delicate pearls/u, 'real product prose must survive');
      for (const slogan of ['DELIVERY & RETURNS', 'NEXT DAY DELIVERY', 'QUALITY GUARANTEE']) {
        assert.ok(!text.includes(slogan), `${slogan} should have been removed`);
      }
    });

    it('keeps delivery wording that is real content rather than a badge strip', () => {
      // The selector is deliberately narrow. A page genuinely explaining delivery - the FAQ does,
      // at /faq-s - must be untouched, or this fix would destroy the answers it exists to surface.
      const html = page(
        '<main><h3>Do you offer Saturday delivery?</h3>' +
          '<p>Yes, we offer Saturday delivery for an additional charge of $16.</p></main>',
      );

      const { text } = parseHtmlPage(html);

      assert.match(text, /Saturday delivery for an additional charge/u);
    });

    it('removes elements hidden from assistive technology', () => {
      const html = page('<main><p aria-hidden="true">Decorative</p><p>Substance</p></main>');

      const { text } = parseHtmlPage(html);

      assert.equal(text.includes('Decorative'), false);
      assert.match(text, /Substance/);
    });
  });

  describe('structure', () => {
    it('preserves headings as Markdown, so chunking can respect them', () => {
      const html = page('<main><h2>Returns</h2><p>Within thirty days.</p></main>');

      assert.match(parseHtmlPage(html).text, /## Returns/);
    });

    it('preserves heading level', () => {
      const html = page('<main><h1>A</h1><h3>B</h3></main>');
      const { text } = parseHtmlPage(html);

      assert.match(text, /# A/);
      assert.match(text, /### B/);
    });

    it('preserves list items', () => {
      const html = page('<main><ul><li>Unopened</li><li>Within thirty days</li></ul></main>');
      const { text } = parseHtmlPage(html);

      assert.match(text, /- Unopened/);
      assert.match(text, /- Within thirty days/);
    });

    it('keeps a sentence whole across inline markup', () => {
      // Breaking on every <strong> or <a> shatters a paragraph into unchunkable slivers.
      const html = page(
        '<main><p>Return <strong>unopened</strong> items <em>only</em>.</p></main>',
      );

      assert.match(parseHtmlPage(html).text, /Return unopened items only\./);
    });

    it('separates paragraphs with a blank line', () => {
      const html = page('<main><p>First.</p><p>Second.</p></main>');

      assert.match(parseHtmlPage(html).text, /First\.\s*\n\s*\n?\s*Second\./);
    });
  });

  describe('content container', () => {
    it('prefers main', () => {
      const html = page('<div>Outside</div><main><p>Inside the main element.</p></main>');
      const { text } = parseHtmlPage(html);

      assert.equal(text.includes('Outside'), false);
      assert.match(text, /Inside the main/);
    });

    it('falls back to article', () => {
      const html = page('<article><p>Article body content here.</p></article>');

      assert.match(parseHtmlPage(html).text, /Article body/);
    });

    it('falls back to body when a page marks up nothing', () => {
      const html = page('<p>Unstructured but real content.</p>');

      assert.match(parseHtmlPage(html).text, /Unstructured but real/);
    });
  });

  describe('metadata', () => {
    it('prefers the visible h1 over the title tag', () => {
      // A <title> carries a suffix - "Returns | Store" - that would end up in every
      // citation. The h1 is what the page calls itself.
      const html = page('<main><h1>Returns policy</h1><p>Text.</p></main>');

      assert.equal(parseHtmlPage(html).title, 'Returns policy');
    });

    it('falls back to og:title, then to title', () => {
      const withOg = page('<main><p>x</p></main>', '<meta property="og:title" content="Social">');
      assert.equal(parseHtmlPage(withOg).title, 'Social');

      assert.equal(parseHtmlPage(page('<main><p>x</p></main>')).title, 'Site');
    });

    it('reads the canonical URL', () => {
      const html = page('<main><p>x</p></main>', '<link rel="canonical" href="/help/returns">');

      assert.equal(parseHtmlPage(html).canonicalUrl, '/help/returns');
    });

    it('reads the document language', () => {
      assert.equal(parseHtmlPage(page('<main><p>x</p></main>')).locale, 'en-GB');
    });

    it('reads the description', () => {
      const html = page(
        '<main><p>x</p></main>',
        '<meta name="description" content="How returns work">',
      );

      assert.equal(parseHtmlPage(html).description, 'How returns work');
    });

    it('detects noindex, including on googlebot', () => {
      const robots = page('<main><p>x</p></main>', '<meta name="robots" content="noindex,follow">');
      assert.equal(parseHtmlPage(robots).noindex, true);

      const googlebot = page('<main><p>x</p></main>', '<meta name="googlebot" content="NOINDEX">');
      assert.equal(parseHtmlPage(googlebot).noindex, true);

      assert.equal(parseHtmlPage(page('<main><p>x</p></main>')).noindex, false);
    });
  });

  describe('links', () => {
    it('collects hrefs for the crawl frontier', () => {
      const html = page('<main><a href="/a">A</a><a href="https://x.test/b">B</a></main>');

      assert.deepEqual(parseHtmlPage(html).links, ['/a', 'https://x.test/b']);
    });

    it('collects links from removed chrome, because navigation is how sites link', () => {
      // Chrome is stripped from the *text* but its links are still the site's map.
      const html = page('<nav><a href="/help">Help</a></nav><main><p>Body.</p></main>');

      assert.deepEqual(parseHtmlPage(html).links, ['/help']);
    });

    it('ignores anchors with no href', () => {
      const html = page('<main><a>No target</a><a href="/x">Target</a></main>');

      assert.deepEqual(parseHtmlPage(html).links, ['/x']);
    });
  });

  it('survives malformed HTML rather than throwing', () => {
    const html = '<html><body><main><p>Unclosed paragraph<div>Nested oddly</main>';

    assert.doesNotThrow(() => parseHtmlPage(html));
  });

  it('extracts real content past a head heavy with scripts and Knockout bindings', () => {
    // Reconstructs the shape of markup that made a previous parser (node-html-parser)
    // silently lose a real, present <main> element on a real production category
    // page: a great many inline <script> tags, one with an HTML-entity-encoded
    // attribute value, a self-duplicating <link rel="canonical">, and Knockout.js
    // comment bindings (`<!-- ko if -->`) - all before the actual content. See
    // ADR 0032. This does not reproduce that library's specific failure (it is no
    // longer a dependency), but pins that today's parser keeps extracting real text
    // from realistically noisy input like it, rather than silently returning none.
    const scripts = Array.from(
      { length: 120 },
      (_, i) => `<script>var x${i} = ${i};</script>`,
    ).join('\n');
    const html = `<html><head><title>Category</title>
      <link rel="canonical" href="https://example.test/categoryhttps://example.test/category"/>
      ${scripts}
      <script type="text&#x2F;javascript">document.querySelector("#x").style.display = "none";</script>
      </head><body>
      <div data-bind="scope: 'messages'">
        <!-- ko if: cookieMessages && cookieMessages.length > 0 -->
        <div data-bind="foreach: { data: cookieMessages, as: 'message' }"></div>
        <!-- /ko -->
      </div>
      <main><p>Real product listing copy lives here, well past the noisy head section.</p></main>
      </body></html>`;

    const { text } = parseHtmlPage(html);

    assert.match(text, /Real product listing copy/);
  });
});
