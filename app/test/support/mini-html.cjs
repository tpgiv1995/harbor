'use strict';

// A small HTML reader for specs that need real clipboard HTML (Teams, Word,
// Google Docs, Harbor's own copy) as the literal-object DOM the composer
// modules read: nodeType / nodeName / childNodes / textContent / getAttribute.
// Not a conforming parser: it reads well-formed markup, void elements,
// comments (Word's <![if ...]> included) and character references, which is
// what clipboard HTML is.

const VOID = new Set(['br', 'img', 'hr', 'meta', 'link', 'input', 'col', 'wbr', 'source', 'area', 'base']);
const NAMED = { nbsp: 160, amp: 38, lt: 60, gt: 62, quot: 34, apos: 39, middot: 183, bull: 8226, hellip: 8230, mdash: 8212, ndash: 8211, rsquo: 8217, lsquo: 8216, rdquo: 8221, ldquo: 8220, zwj: 8205, zwnj: 8204, shy: 173 };

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref) => {
    if (ref[0] === '#') return String.fromCodePoint(ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10));
    const code = NAMED[ref.toLowerCase()];
    return code ? String.fromCodePoint(code) : whole;
  });
}

function textNode(text) {
  return { nodeType: 3, nodeName: '#text', childNodes: [], textContent: text };
}

function element(tag, attrs) {
  return {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    childNodes: [],
    attrs,
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name.toLowerCase()) ? this.attrs[name.toLowerCase()] : null; },
    get textContent() { return this.childNodes.map((child) => child.textContent).join(''); },
    setAttribute(name, value) { this.attrs[name.toLowerCase()] = String(value); },
    appendChild(child) {
      // A document fragment hands over its children, as in a real DOM.
      if (child.nodeType === 11) { for (const inner of [...child.childNodes]) this.appendChild(inner); child.childNodes = []; return child; }
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    },
    cloneNode(deep) { const copy = element(this.nodeName.toLowerCase(), { ...this.attrs }); if (deep) for (const child of this.childNodes) copy.appendChild(child.nodeType === 1 ? child.cloneNode(true) : { ...child }); return copy; },
    contains(node) { for (let current = node; current; current = current.parentNode) if (current === this) return true; return false; },
  };
}

function parseAttrs(source) {
  const attrs = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = re.exec(source))) attrs[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4] ?? '');
  return attrs;
}

function parseHtml(html) {
  const root = element('body', {});
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<![^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|[^<]+|</g;
  let match;
  while ((match = re.exec(html))) {
    const [whole, closing, opening, attrSource, selfClose] = match;
    const top = stack[stack.length - 1];
    if (whole.startsWith('<!')) { top.childNodes.push({ nodeType: 8, nodeName: '#comment', childNodes: [], textContent: '' }); continue; }
    if (closing) {
      const name = closing.toUpperCase();
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].nodeName === name) { stack.length = i; break; }
      }
      continue;
    }
    if (opening) {
      const tag = opening.toLowerCase();
      if (tag === 'html' || tag === 'body') continue;
      const node = element(tag, parseAttrs(attrSource || ''));
      top.appendChild(node);
      if (!VOID.has(tag) && !selfClose) stack.push(node);
      continue;
    }
    top.appendChild(textNode(decode(whole)));
  }
  return root;
}

// buildNodes needs a document; this one makes the same literal shapes.
function fakeDocument() {
  return {
    createDocumentFragment: () => Object.assign(element('#document-fragment', {}), { nodeType: 11 }),
    createTextNode: (text) => textNode(text),
    createElement: (tag) => element(tag, {}),
  };
}

module.exports = { parseHtml, fakeDocument };
