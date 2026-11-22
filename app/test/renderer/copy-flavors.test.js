'use strict';

// Copying out of Harbor (2026-11-21): the clipboard gets semantic HTML with no
// dark-theme colours, and plain text with real bullets and table rows.

const test = require('node:test');
const assert = require('node:assert/strict');

const { selectionFlavors } = require('../../src/renderer/stage/copy-flavors.cjs');
const { foreignHtmlToSpec } = require('../../src/renderer/stage/paste-html.cjs');
const { specToHtml, specToPlainText } = require('../../src/shared/markdown-html.cjs');
const { parseHtml, fakeDocument } = require('../support/mini-html.cjs');

// What md.jsx draws for an agent reply, with the window chrome around it.
const REPLY = [
  '<div class="conv-body">',
  '<p class="md-p" style="color: rgb(246, 247, 255)">Intro with <strong>bold</strong> words.</p>',
  '<ul class="md-list" style="color: rgb(246, 247, 255); background-color: rgb(11, 12, 15)"><li>one<ul class="md-list"><li>child</li></ul></li><li>two</li></ul>',
  '<p class="md-h">Totals</p>',
  '<table class="md-table"><thead><tr><th>Name</th><th>Count</th></tr></thead><tbody><tr><td>A</td><td>3</td></tr></tbody></table>',
  '<div class="md-code-wrap"><button type="button">Copy</button><pre class="md-code">x = 1</pre></div>',
  '<span class="conv-act-k" aria-hidden="true">o</span>',
  '<time class="conv-time conv-time-reply" data-copy="skip">9:22 PM</time>',
  '</div>',
].join('');

test('a copied reply becomes clean HTML: lists, bold, a table grid, no colours, no button text', () => {
  const spec = foreignHtmlToSpec(parseHtml(REPLY), { copy: true });
  const html = specToHtml(spec);
  assert.doesNotMatch(html, /rgb\(|background|font-family|class=/);
  assert.match(html, /<ul[^>]*><li[^>]*>one<ul[^>]*><li[^>]*>child<\/li><\/ul><\/li><li[^>]*>two<\/li><\/ul>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<strong>Totals<\/strong>/);
  assert.match(html, /<table[^>]*><tr><th[^>]*>Name<\/th><th[^>]*>Count<\/th><\/tr><tr><td[^>]*>A<\/td><td[^>]*>3<\/td><\/tr><\/table>/);
  assert.doesNotMatch(html, />Copy</);
  assert.doesNotMatch(html, /9:22 PM/, 'the reply time is window chrome, not content');
});

test('the plain-text flavor has bullets, indented children, a blank line between blocks and tab-separated rows', () => {
  const spec = foreignHtmlToSpec(parseHtml(REPLY), { copy: true });
  assert.equal(specToPlainText(spec), [
    'Intro with bold words.',
    '',
    '- one',
    '  - child',
    '- two',
    '',
    'Totals',
    '',
    'Name\tCount',
    'A\t3',
    '',
    'x = 1',
  ].join('\n'));
});

function fakeSelection(container, commonAncestor, nodes, text) {
  return {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => ({
      commonAncestorContainer: commonAncestor,
      cloneContents: () => {
        const fragment = fakeDocument().createDocumentFragment();
        for (const node of nodes) fragment.appendChild(node.cloneNode(true));
        return fragment;
      },
    }),
  };
}

test('a selection across two list items is copied as a list, not loose lines', () => {
  const root = parseHtml('<div class="conv"><ul class="md-list"><li>alpha</li><li><b>beta</b></li></ul></div>');
  const container = root.childNodes[0];
  const list = container.childNodes[0];
  const flavors = selectionFlavors(fakeSelection(container, list, list.childNodes, 'alpha\nbeta'), container, fakeDocument());
  assert.match(flavors.html, /<ul[^>]*><li[^>]*>alpha<\/li><li[^>]*><strong>beta<\/strong><\/li><\/ul>/);
  assert.equal(flavors.text, '- alpha\n- beta');
});

test('a selection inside code is copied as its text only, so it pastes as code', () => {
  const root = parseHtml('<div class="conv"><pre class="md-code">npm test -- main</pre></div>');
  const container = root.childNodes[0];
  const pre = container.childNodes[0];
  const flavors = selectionFlavors(fakeSelection(container, pre.childNodes[0], [], 'npm test'), container, fakeDocument());
  assert.deepEqual(flavors, { html: null, text: 'npm test' });
});

test('nothing selected, or a selection reaching outside the window, is left to the browser', () => {
  const root = parseHtml('<div class="conv"><p>inside</p></div><p>outside</p>');
  const container = root.childNodes[0];
  assert.equal(selectionFlavors({ isCollapsed: true, rangeCount: 1 }, container, fakeDocument()), null);
  assert.equal(selectionFlavors(fakeSelection(container, root, [], 'inside outside'), container, fakeDocument()), null);
});
