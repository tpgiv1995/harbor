'use strict';

// The WYSIWYG composer's two conversions. Everything typed in the composer
// leaves Harbor as markdown typed into a terminal, so a bug here is not a
// cosmetic one: it is wrong text delivered to an agent.
//
// The DOM side is exercised with literal objects rather than jsdom, because
// serializeDoc deliberately reads only nodeType / nodeName / childNodes /
// textContent (plus href on a link).

const test = require('node:test');
const assert = require('node:assert');
const {
  serializeDoc, markdownToSpec, inlineToSpec, buildNodes,
} = require('../../src/renderer/stage/compose-doc.cjs');

// ── fake DOM ────────────────────────────────────────────────────────────────

function txt(text) {
  return { nodeType: 3, nodeName: '#text', childNodes: [], textContent: text };
}

function el(tag, ...children) {
  return {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    childNodes: children,
    get textContent() {
      return this.childNodes.map((child) => child.textContent).join('');
    },
  };
}

function link(href, ...children) {
  return { ...el('a', ...children), getAttribute: (key) => (key === 'href' ? href : null) };
}

function fakeDocument() {
  const create = (tag) => ({
    nodeType: 1,
    nodeName: String(tag).toUpperCase(),
    childNodes: [],
    attributes: {},
    appendChild(child) { this.childNodes.push(child); return child; },
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key] ?? null; },
    get textContent() { return this.childNodes.map((child) => child.textContent).join(''); },
  });
  return {
    createElement: create,
    createTextNode: (text) => txt(text),
    createDocumentFragment: () => create('#fragment'),
  };
}

// ── DOM -> markdown ─────────────────────────────────────────────────────────

test('plain typing serializes to plain text', () => {
  assert.equal(serializeDoc(el('div', txt('just a message'))), 'just a message');
});

test('each mark emits the markdown that actually reaches Claude', () => {
  assert.equal(serializeDoc(el('div', el('strong', txt('b')))), '**b**');
  assert.equal(serializeDoc(el('div', el('em', txt('i')))), '*i*');
  assert.equal(serializeDoc(el('div', el('s', txt('s')))), '~~s~~');
  assert.equal(serializeDoc(el('div', el('code', txt('c')))), '`c`');
  // Markdown has no underline; inline HTML is the only faithful form.
  assert.equal(serializeDoc(el('div', el('u', txt('u')))), '<u>u</u>');
  // Chromium emits B/I for its own execCommand output, not just STRONG/EM.
  assert.equal(serializeDoc(el('div', el('b', txt('b')))), '**b**');
  assert.equal(serializeDoc(el('div', el('i', txt('i')))), '*i*');
});

test('whitespace is pulled outside the delimiters, or markdown renders literal asterisks', () => {
  // `**bold **next` does not render. `**bold** next` does.
  const root = el('div', el('strong', txt('bold ')), txt('next'));
  assert.equal(serializeDoc(root), '**bold** next');

  const leading = el('div', txt('say '), el('strong', txt(' loud ')));
  assert.equal(serializeDoc(leading), 'say  **loud** ');
});

test('adjacent identical marks merge instead of emitting four asterisks', () => {
  // Chromium splits marks constantly while typing. `**a****b**` renders as
  // literal text, so this is a correctness rule, not a tidiness one.
  const root = el('div', el('strong', txt('a')), el('strong', txt('b')));
  assert.equal(serializeDoc(root), '**ab**');
});

test('an emptied mark emits nothing rather than a bare delimiter', () => {
  assert.equal(serializeDoc(el('div', el('strong'))), '');
  assert.equal(serializeDoc(el('div', el('strong', txt('')))), '');
  // A document of nothing but whitespace is an empty message, not a message
  // made of spaces; submit() trims anyway, so this agrees with the send path.
  assert.equal(serializeDoc(el('div', el('strong', txt('   ')))), '');
  // Inside a document that DOES have text, the whitespace-vs-delimiter rule
  // still applies and the padding stays outside the marks.
  assert.equal(serializeDoc(el('div', txt('a'), el('strong', txt('   ')))), 'a   ');
});

test("Chromium's filler <br> does not become a phantom newline", () => {
  // An emptied editor holds a lone <br>; sending that as "\n" would break the
  // empty-composer no-op rule on outside sessions.
  assert.equal(serializeDoc(el('div', el('br'))), '');
  assert.equal(serializeDoc(el('div', txt('one'), el('br'))), 'one');
  // A br BETWEEN content is a real line break and survives.
  assert.equal(serializeDoc(el('div', txt('one'), el('br'), txt('two'))), 'one\ntwo');
});

test('nested marks nest as markdown, not as sibling delimiters', () => {
  const root = el('div', el('strong', el('em', txt('x'))));
  assert.equal(serializeDoc(root), '***x***');
});

test('bulleted and numbered lists serialize to their markdown markers', () => {
  const bullets = el('div', el('ul', el('li', txt('first')), el('li', txt('second'))));
  assert.equal(serializeDoc(bullets), '- first\n- second');

  const numbers = el('div', el('ol', el('li', txt('one')), el('li', txt('two')), el('li', txt('three'))));
  assert.equal(serializeDoc(numbers), '1. one\n2. two\n3. three');
});

test('a formatted list item keeps its formatting inside the marker', () => {
  const root = el('div', el('ul', el('li', txt('resolve the '), el('strong', txt('pane')))));
  assert.equal(serializeDoc(root), '- resolve the **pane**');
});

test('a nested list indents rather than corrupting the outer list', () => {
  // Tab is slash-completion so the UI cannot make these, but a reload from
  // markdown or a stray execCommand can; flattening them would silently move
  // an item to the wrong level.
  const root = el('div', el('ul',
    el('li', txt('outer'), el('ul', el('li', txt('inner'))))));
  assert.equal(serializeDoc(root), '- outer\n  - inner');
});

test('code blocks, quotes, and headings serialize to their block markdown', () => {
  assert.equal(serializeDoc(el('div', el('pre', txt('npm test\nnpm run build')))), '```\nnpm test\nnpm run build\n```');
  assert.equal(serializeDoc(el('div', el('blockquote', txt('quoted')))), '> quoted');
  assert.equal(serializeDoc(el('div', el('h1', txt('Title')))), '# Title');
  assert.equal(serializeDoc(el('div', el('h3', txt('Sub')))), '### Sub');
});

test('links serialize with their href', () => {
  const root = el('div', txt('see '), link('https://example.com', txt('the docs')));
  assert.equal(serializeDoc(root), 'see [the docs](https://example.com)');
});

test('separate blocks become separate lines, and an empty block is a blank line', () => {
  const root = el('div', txt('first'), el('div', txt('second')));
  assert.equal(serializeDoc(root), 'first\nsecond');

  const withGap = el('div', txt('first'), el('div'), el('div', txt('third')));
  assert.equal(serializeDoc(withGap), 'first\n\nthird');
});

test('an empty editor serializes to the empty string', () => {
  assert.equal(serializeDoc(el('div')), '');
  assert.equal(serializeDoc(null), '');
});

test('structure left behind by an emptied editor does not become a stray marker', () => {
  // Clearing a bulleted list leaves Chromium's scaffolding in place. Serializing
  // that as "- " would send a lone dash to the agent and defeat the
  // empty-composer no-op on an outside session.
  assert.equal(serializeDoc(el('div', el('ul', el('li', el('br'))))), '');
  assert.equal(serializeDoc(el('div', el('ol', el('li', txt(''))))), '');
  assert.equal(serializeDoc(el('div', el('blockquote', el('br')))), '');
  assert.equal(serializeDoc(el('div', el('div', el('br')), el('div', el('br')))), '');
  // A list with real content is of course untouched.
  assert.equal(serializeDoc(el('div', el('ul', el('li', txt('real'))))), '- real');
});

// ── markdown -> spec ────────────────────────────────────────────────────────

test('inline markdown parses back into nested specs', () => {
  assert.deepEqual(inlineToSpec('a **b** c'), [
    'a ', { tag: 'strong', children: ['b'] }, ' c',
  ]);
  assert.deepEqual(inlineToSpec('***both***'), [
    { tag: 'strong', children: [{ tag: 'em', children: ['both'] }] },
  ]);
  assert.deepEqual(inlineToSpec('<u>under</u>'), [{ tag: 'u', children: ['under'] }]);
  assert.deepEqual(inlineToSpec('`code`'), [{ tag: 'code', children: ['code'] }]);
  assert.deepEqual(inlineToSpec('[t](u)'), [{ tag: 'a', href: 'u', children: ['t'] }]);
});

test('markdown inside a code span stays literal', () => {
  assert.deepEqual(inlineToSpec('`**not bold**`'), [
    { tag: 'code', children: ['**not bold**'] },
  ]);
});

test('block markdown parses into the right containers', () => {
  assert.deepEqual(markdownToSpec('- a\n- b'), [
    { tag: 'ul', children: [{ tag: 'li', children: ['a'] }, { tag: 'li', children: ['b'] }] },
  ]);
  assert.deepEqual(markdownToSpec('1. a\n2. b'), [
    { tag: 'ol', children: [{ tag: 'li', children: ['a'] }, { tag: 'li', children: ['b'] }] },
  ]);
  assert.deepEqual(markdownToSpec('## Head'), [{ tag: 'h2', children: ['Head'] }]);
  assert.deepEqual(markdownToSpec('```\nx\n```'), [{ tag: 'pre', children: ['x'] }]);
});

test('an empty draft parses to nothing', () => {
  assert.deepEqual(markdownToSpec(''), []);
  assert.deepEqual(markdownToSpec(null), []);
});

// ── round trip ──────────────────────────────────────────────────────────────

// The two directions have to compose, because every external write to the
// draft (voice, a slash insert, a dropped file, switching sessions) reloads the
// editor from markdown that serializeDoc produced moments earlier. A lossy
// round trip would silently rewrite Pat's message.
function roundTrip(markdown) {
  const doc = fakeDocument();
  const root = doc.createElement('div');
  const fragment = buildNodes(markdownToSpec(markdown), doc);
  for (const child of fragment.childNodes) root.appendChild(child);
  return serializeDoc(root);
}

test('markdown survives a trip through the editor unchanged', () => {
  const cases = [
    'plain text',
    'has **bold** in it',
    'has *italic* in it',
    'has ~~strike~~ in it',
    'has `code` in it',
    'has <u>underline</u> in it',
    'has ***both*** in it',
    'see [the docs](https://example.com)',
    '- first\n- second',
    '1. one\n2. two',
    '- resolve the **pane** first',
    '## A heading',
    '> a quote',
    '```\nnpm test\n```',
    'first\nsecond\nthird',
    'para one\n\npara two',
    '/compact and then some prose',
    'a path like /home/you/dev/harbor stays intact',
  ];
  for (const markdown of cases) {
    assert.equal(roundTrip(markdown), markdown, `round trip changed: ${JSON.stringify(markdown)}`);
  }
});

test('a mixed real message round trips', () => {
  const message = [
    'Refactor the **send path** so it:',
    '',
    '- resolves the pane first',
    '- falls back to *resume-then-send*',
    '',
    'See `runSend` and then run /compact',
  ].join('\n');
  assert.equal(roundTrip(message), message);
});

test('draft text that looks like markup can never become markup', () => {
  // The spec carries text as strings and the editor builds real nodes from it,
  // so an <img onerror> in a draft stays characters rather than an element.
  const spec = markdownToSpec('<img src=x onerror=alert(1)>');
  const doc = fakeDocument();
  const root = doc.createElement('div');
  const fragment = buildNodes(spec, doc);
  for (const child of fragment.childNodes) root.appendChild(child);
  assert.equal(root.childNodes.length, 1);
  const block = root.childNodes[0];
  assert.equal(block.nodeName, 'DIV');
  assert.equal(block.childNodes.every((child) => child.nodeType === 3), true, 'stayed text nodes');
  assert.equal(serializeDoc(root), '<img src=x onerror=alert(1)>');
});
