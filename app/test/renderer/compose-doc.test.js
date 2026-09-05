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
  const root = el('div', el('ul',
    el('li', txt('outer'), el('ul', el('li', txt('inner'))))));
  assert.equal(serializeDoc(root), '- outer\n  - inner');
});

test('mixed nested list DOM serializes with continuation indentation at three depths', () => {
  const unorderedThenOrdered = el('div', el('ul',
    el('li', txt('outer'), el('ol',
      el('li', txt('one'), el('ul', el('li', txt('deep')))),
      el('li', txt('two')))),
    el('li', txt('after'))));
  assert.equal(serializeDoc(unorderedThenOrdered), [
    '- outer',
    '  1. one',
    '     - deep',
    '  2. two',
    '- after',
  ].join('\n'));

  const orderedThenUnordered = el('div', el('ol',
    el('li', txt('outer'), el('ul',
      el('li', txt('inner'), el('ol', el('li', txt('deep'))))))));
  assert.equal(serializeDoc(orderedThenUnordered), [
    '1. outer',
    '   - inner',
    '     1. deep',
  ].join('\n'));
});

test('Chromium direct-child lists survive at three levels', () => {
  const root = el('div', el('ul',
    el('li', txt('a')),
    el('ul',
      el('li', txt('b')),
      el('ul', el('li', txt('c'))))));
  assert.equal(serializeDoc(root), '- a\n  - b\n    - c');
});

test('Chromium mixed direct-child list keeps ordered items inside bullets', () => {
  const root = el('div', el('ul',
    el('li', txt('outer')),
    el('ol', el('li', txt('one')), el('li', txt('two'))),
    el('li', txt('after'))));
  assert.equal(serializeDoc(root), '- outer\n  1. one\n  2. two\n- after');
});

test('list items preserve preformatted blocks and blockquotes', () => {
  const root = el('div', el('ul',
    el('li', txt('inspect'), el('pre', txt('line one\nline two'))),
    el('li', txt('remember'), el('blockquote', txt('every word')))));
  assert.equal(serializeDoc(root), [
    '- inspect',
    '  ```',
    '  line one',
    '  line two',
    '  ```',
    '- remember',
    '  > every word',
  ].join('\n'));
});

test('lists inside blockquotes retain every nesting level', () => {
  const root = el('div', el('blockquote', el('ul',
    el('li', txt('outer'), el('ol',
      el('li', txt('middle'), el('ul', el('li', txt('deep')))))))));
  assert.equal(serializeDoc(root), '> - outer\n>   1. middle\n>      - deep');
});

test('an unrecognized node inside a list emits its text instead of vanishing', () => {
  const mystery = { nodeType: 99, nodeName: 'MYSTERY', childNodes: [], textContent: 'still here' };
  const root = el('div', el('ul', el('li', txt('known')), mystery));
  assert.equal(serializeDoc(root), '- known\n  still here');
});

test('unrecognized nodes at top level and inside blockquotes emit plain text', () => {
  const mystery = (text) => ({ nodeType: 99, nodeName: 'MYSTERY', childNodes: [], textContent: text });
  assert.equal(serializeDoc(el('div', mystery('top-level text'))), 'top-level text');
  assert.equal(serializeDoc(el('div', el('blockquote', mystery('quoted text')))), '> quoted text');
  const unknownElement = { nodeType: 1, nodeName: 'WIDGET', childNodes: [], textContent: 'widget text' };
  assert.equal(serializeDoc(el('div', unknownElement)), 'widget text');
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

test('nested list markdown parses into nested list-item specs in both type directions', () => {
  assert.deepEqual(markdownToSpec('- outer\n  1. one\n  2. two\n- after'), [{
    tag: 'ul',
    children: [
      { tag: 'li', children: ['outer', { tag: 'ol', children: [
        { tag: 'li', children: ['one'] },
        { tag: 'li', children: ['two'] },
      ] }] },
      { tag: 'li', children: ['after'] },
    ],
  }]);
  assert.deepEqual(markdownToSpec('1. outer\n   - inner\n     1. deep'), [{
    tag: 'ol',
    children: [{ tag: 'li', children: ['outer', { tag: 'ul', children: [
      { tag: 'li', children: ['inner', { tag: 'ol', children: [
        { tag: 'li', children: ['deep'] },
      ] }] },
    ] }] }],
  }]);
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
    '- outer\n  1. one\n     - deep\n  2. two\n- after',
    '1. outer\n   - inner\n     1. deep',
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

test('three-level mixed list round trips through literal buildNodes objects', () => {
  const markdown = [
    '- alpha',
    '  1. alpha-one',
    '     - alpha-one-deep',
    '  2. alpha-two',
    '- beta',
  ].join('\n');
  assert.equal(roundTrip(markdown), markdown);
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

// ── typed ordered lists and quote lines (2026-09-03) ────────────────────────

const { orderedMarker, orderedListShape } = require('../../src/renderer/stage/compose-doc.cjs');

test('ordered lists keep their numbering style and start on the wire', () => {
  const ol = (attrs, ...items) => ({ ...el('ol', ...items.map((text) => el('li', txt(text)))), ...attrs });
  assert.equal(serializeDoc(el('div', ol({ type: 'I' }, 'one', 'two', 'three', 'four'))), 'I. one\nII. two\nIII. three\nIV. four');
  assert.equal(serializeDoc(el('div', ol({ type: 'i' }, 'one', 'two'))), 'i. one\nii. two');
  assert.equal(serializeDoc(el('div', ol({ type: 'A' }, 'one', 'two'))), 'A. one\nB. two');
  assert.equal(serializeDoc(el('div', ol({ type: 'a' }, 'one', 'two'))), 'a. one\nb. two');
  assert.equal(serializeDoc(el('div', ol({ start: 3 }, 'three', 'four'))), '3. three\n4. four');
  assert.equal(serializeDoc(el('div', ol({ type: 'a', start: 27 }, 'x'))), 'aa. x');
  // An unknown type is a plain numbered list, never a dropped list.
  assert.equal(serializeDoc(el('div', ol({ type: 'zzz' }, 'one'))), '1. one');
});

test('a list started at zero keeps its zero on the round trip', () => {
  // start="0" is not the default 1, so it must survive a restore; a truthiness
  // test used to drop it and renumber the list from one (2026-09-03).
  assert.equal(markdownToSpec('0. zero\n1. one')[0].start, 0);
  assert.equal(roundTrip('0. zero\n1. one'), '0. zero\n1. one');
});

test('the markers a typed list reads back into the same list', () => {
  assert.deepEqual(markdownToSpec('I. one\nII. two'), [{
    tag: 'ol', type: 'I', children: [{ tag: 'li', children: ['one'] }, { tag: 'li', children: ['two'] }],
  }]);
  assert.equal(markdownToSpec('a. x\nb. y')[0].type, 'a');
  // A roman/letter list is accepted only when it starts NATURALLY (I, i, A, a),
  // which is the only shape auto-format can create; a run starting mid-sequence
  // ("ii.", "C.") is prose, because two consecutive "X." lines are far more often
  // initials or headings than a list the user built at that offset (2026-09-03).
  assert.equal(markdownToSpec('A. x\nB. y')[0].type, 'A');
  assert.equal(markdownToSpec('A. x\nB. y')[0].start ?? 1, 1);
  assert.equal(markdownToSpec('3. three\n4. four')[0].start, 3);
  // A plain list spec carries no type or start at all.
  assert.deepEqual(markdownToSpec('1. one'), [{ tag: 'ol', children: [{ tag: 'li', children: ['one'] }] }]);
  assert.deepEqual(markdownToSpec('• dot'), [{ tag: 'ul', children: [{ tag: 'li', children: ['dot'] }] }]);
});

// The 2026-09-03 data-loss fix. A single line that merely OPENS with a roman or
// letter marker ("v. Smith", "C. Everett", "I. am here") is ordinary prose, and
// on a draft restore it must come back byte for byte, never rewritten into a
// list. A real ordered list still forms when a canonical successor follows.
test('ambiguous ordered-looking prose stays literal, never a list', () => {
  assert.deepEqual(markdownToSpec('v. x'), [{ tag: 'div', children: ['v. x'] }]);
  assert.deepEqual(markdownToSpec('C. Everett'), [{ tag: 'div', children: ['C. Everett'] }]);
  assert.deepEqual(markdownToSpec('i. x'), [{ tag: 'div', children: ['i. x'] }]);
  assert.deepEqual(markdownToSpec('ii. x'), [{ tag: 'div', children: ['ii. x'] }]);
  // Two ordered-looking lines whose markers are not a sequence are two prose
  // lines, not a two-item list (the "v. Smith / a. m." report).
  assert.deepEqual(markdownToSpec('v. Smith\na. m.'), [
    { tag: 'div', children: ['v. Smith'] },
    { tag: 'div', children: ['a. m.'] },
  ]);
  // Every one of these round-trips unchanged; an empty "I. " especially must not
  // become an empty item that re-serializes as "i. " and drops the letter's case.
  for (const prose of ['v. Smith', 'a. m.', 'C. Everett', 'I. am here', 'i.e. this one', 'v. x']) {
    assert.equal(roundTrip(prose), prose, `prose changed: ${JSON.stringify(prose)}`);
  }
  // A plain digit marker stays lenient: a single "1." has always been a list.
  assert.equal(markdownToSpec('1. one')[0].tag, 'ol');
  // A stray non-digit line does not join a plain digit list and get renumbered.
  assert.deepEqual(markdownToSpec('1. a\nv. b'), [
    { tag: 'ol', children: [{ tag: 'li', children: ['a'] }] },
    { tag: 'div', children: ['v. b'] },
  ]);
});

// Round-2 review regressions (2026-09-03). Each of these was a real defect the
// second codex pass found in the first fix.
test('ordered-looking prose that a naive canonical check would accept stays prose', () => {
  // Two consecutive canonical initials/headings must NOT become a list just
  // because the markers happen to run in sequence; the natural-start rule keeps
  // them prose, and they round-trip byte for byte.
  for (const prose of ['C. Everett\nD. Eisenhower', 'IV. Background\nV. Smith', 'ii. x\niii. y']) {
    for (const spec of markdownToSpec(prose)) assert.equal(spec.tag, 'div', `not prose: ${JSON.stringify(prose)}`);
    assert.equal(roundTrip(prose), prose, `changed: ${JSON.stringify(prose)}`);
  }
});

test('a non-canonical roman run terminates instead of freezing the parser', () => {
  // "IIII" evaluates to four so "V" looked like its successor, but the strict
  // per-item check rejected "IIII", consuming no lines: markdownToSpec used to
  // loop forever. It must terminate and leave the lines as prose.
  assert.deepEqual(markdownToSpec('IIII. four\nV. five'), [
    { tag: 'div', children: ['IIII. four'] },
    { tag: 'div', children: ['V. five'] },
  ]);
  assert.equal(roundTrip('IIII. four\nV. five'), 'IIII. four\nV. five');
});

test('a parenthesized non-digit marker stays prose so its delimiter survives', () => {
  // "I) x" cannot round-trip as a list (the DOM ol keeps no delimiter, so it
  // would serialize back as "I. x"), so it stays prose and keeps its ")".
  assert.deepEqual(markdownToSpec('I) one\nII) two'), [
    { tag: 'div', children: ['I) one'] },
    { tag: 'div', children: ['II) two'] },
  ]);
  assert.equal(roundTrip('I) one\nII) two'), 'I) one\nII) two');
  assert.equal(roundTrip('C) Everett\nD) Eisenhower'), 'C) Everett\nD) Eisenhower');
});

test('typed lists survive the round trip, nested too', () => {
  for (const markdown of [
    'I. one\nII. two',
    'a. x\nb. y',
    'A. x\nB. y',
    '3. three\n4. four',
    '- outer\n  I. one\n  II. two\n- after',
    'I. one\n   - a\n   - b\nII. two',
  ]) {
    assert.equal(roundTrip(markdown), markdown, `round trip changed: ${JSON.stringify(markdown)}`);
  }
});

test('a quote reads back as one div per line, and serializes the same', () => {
  assert.deepEqual(markdownToSpec('> a\n> b'), [{
    tag: 'blockquote',
    children: [{ tag: 'div', children: ['a'] }, { tag: 'div', children: ['b'] }],
  }]);
  assert.equal(roundTrip('> a\n> b'), '> a\n> b');
  assert.equal(roundTrip('> only'), '> only');
  assert.equal(serializeDoc(el('div', el('blockquote', el('div', txt('a')), el('div', el('br')), el('div', txt('c'))))), '> a\n>\n> c');
});

test('ordered marker and shape helpers', () => {
  assert.equal(orderedMarker(4, 'I'), 'IV. ');
  assert.equal(orderedMarker(9, 'i'), 'ix. ');
  assert.equal(orderedMarker(28, 'a'), 'ab. ');
  assert.equal(orderedMarker(2, 'A'), 'B. ');
  assert.equal(orderedMarker(12, null), '12. ');
  assert.deepEqual(orderedListShape('12'), { type: null, start: 12 });
  assert.deepEqual(orderedListShape('IV'), { type: 'I', start: 4 });
  assert.deepEqual(orderedListShape('x'), { type: 'a', start: 24 });
});
