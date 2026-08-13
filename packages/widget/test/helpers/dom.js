/**
 * The smallest DOM this widget's rendering actually touches.
 *
 * Hand-written rather than `jsdom`, for the reason every other test double here is: the project
 * ships no test framework and no transpiler, and a full DOM implementation would be its largest
 * dependency by an order of magnitude — added to test roughly a dozen methods.
 *
 * It is deliberately **not** an HTML parser. It cannot interpret a string as markup, which means
 * a test cannot accidentally prove that `innerHTML` is safe by using an implementation that
 * ignores it. If production code ever reaches for `innerHTML`, these tests fail rather than pass
 * quietly — which is exactly the guarantee the markdown renderer needs.
 */

class FakeNode {
  /** @type {FakeNode[]} */
  children = [];
  /** @type {FakeNode | undefined} */
  parent;

  /** @param {(FakeNode | string)[]} nodes */
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new FakeText(node) : node;

      if (child instanceof FakeFragment) {
        this.append(...child.children.splice(0));
        continue;
      }

      child.parent = this;
      this.children.push(child);
    }
  }

  /** @param {(FakeNode | string)[]} nodes */
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  /** @returns {string} */
  get textContent() {
    return this.children.map((/** @type {any} */ child) => child.textContent).join('');
  }

  set textContent(value) {
    this.children = [new FakeText(String(value))];
  }

  /**
   * The serialized shape, for asserting structure without an HTML serializer.
   *
   * @returns {string}
   */
  get outline() {
    return this.children.map((/** @type {any} */ child) => child.outline).join('');
  }
}

class FakeText extends FakeNode {
  /** @param {string} value */
  constructor(value) {
    super();
    this.value = value;
  }

  /**
   * @override
   * @returns {string}
   */
  get textContent() {
    return this.value;
  }

  /**
   * @override
   * @returns {string}
   */
  get outline() {
    return this.value;
  }
}

class FakeFragment extends FakeNode {}

class FakeElement extends FakeNode {
  /** @type {Map<string, string>} */
  attributes = new Map();
  hidden = false;
  /** @type {Record<string, string>} */
  style = {};
  /**
   * Enough of a button and a link to test the confirmation card.
   *
   * Plain properties rather than attributes, matching how the DOM treats them - the confirmation code
   * sets `disabled` and reads it back to guard a second click, so a fake where that round trip does not
   * work would pass a test the real thing fails.
   */
  disabled = false;
  type = '';
  href = '';
  target = '';
  rel = '';
  /** @type {Map<string, ((event?: any) => void)[]>} */
  listeners = new Map();

  /** @param {string} tag */
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.localName = tag;
  }

  /**
   * @param {string} name
   * @param {(event?: any) => void} handler
   */
  addEventListener(name, handler) {
    const held = this.listeners.get(name) ?? [];

    held.push(handler);
    this.listeners.set(name, held);
  }

  /**
   * Dispatch, for a test to press a button with.
   *
   * @param {string} name
   */
  dispatch(name) {
    for (const handler of this.listeners.get(name) ?? []) handler({ type: name });
  }

  /** Detach from the parent, which is what the confirmation does to disarm itself. */
  remove() {
    if (this.parent === undefined) return;

    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = undefined;
  }

  /**
   * Walks to a root, like the real property. The confirmation reads it to decide whether an expiry
   * timer still has a button to act on.
   *
   * @returns {boolean}
   */
  get isConnected() {
    return this.parent !== undefined;
  }

  /** @returns {number} */
  get childElementCount() {
    return this.children.filter((child) => child instanceof FakeElement).length;
  }

  /**
   * @param {string} name
   * @param {string} value
   */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  /** @param {string} name */
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  get className() {
    return this.getAttribute('class') ?? '';
  }

  set className(value) {
    this.setAttribute('class', value);
  }

  /**
   * @override
   * @returns {string}
   */
  get outline() {
    const attributes = [...this.attributes.entries()]
      .filter(([name]) => name !== 'class')
      .map(([name, value]) => ` ${name}="${value}"`)
      .join('');

    return `<${this.localName}${attributes}>${super.outline}</${this.localName}>`;
  }

  /** @param {string} selector */
  findAll(selector) {
    /** @type {FakeElement[]} */
    const found = [];

    for (const child of this.children) {
      if (!(child instanceof FakeElement)) continue;
      if (child.localName === selector) found.push(child);
      found.push(...child.findAll(selector));
    }

    return found;
  }
}

/**
 * Install the globals the renderer uses, and return a restore function.
 *
 * @param {{ href?: string }} [options]
 */
export function installDom(options = {}) {
  const scope = /** @type {any} */ (globalThis);
  const previous = { document: scope.document, window: scope.window };

  const fakeDocument = {
    /** @param {string} tag */
    createElement: (tag) => new FakeElement(tag),
    /** @param {string} value */
    createTextNode: (value) => new FakeText(value),
    createDocumentFragment: () => new FakeFragment(),
  };

  Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true });
  Object.defineProperty(globalThis, 'window', {
    value: { location: { href: options.href ?? 'https://store.example.com/help' } },
    configurable: true,
  });

  return () => {
    Object.defineProperty(globalThis, 'document', { value: previous.document, configurable: true });
    Object.defineProperty(globalThis, 'window', { value: previous.window, configurable: true });
  };
}

export { FakeElement, FakeText, FakeFragment };
