'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { markdownToHtml, markdownToPlainText } = require('../../src/shared/markdown-html.cjs');

test('clipboard HTML preserves Teams reply paragraphs, nested bullets, emphasis, links, and escaping', () => {
  const markdown = [
    'Hi Alex,',
    '',
    'Here is the **plan**:',
    '',
    '- First item',
    '  - Nested <script>alert("x")</script>',
    '- Read the [guide](https://example.com/?a=1&b=2)',
    '',
    'Thanks,',
    'Pat',
  ].join('\n');
  assert.equal(markdownToHtml(markdown), '<div><p>Hi Alex,</p><p>Here is the <strong>plan</strong>:</p><ul><li>First item<ul><li>Nested &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</li></ul></li><li>Read the <a href="https://example.com/?a=1&amp;b=2">guide</a></li></ul><p>Thanks,<br>Pat</p></div>');
  assert.equal(markdownToPlainText(markdown), [
    'Hi Alex,',
    '',
    'Here is the plan:',
    '',
    '- First item',
    '  - Nested <script>alert("x")</script>',
    '- Read the guide',
    '',
    'Thanks,',
    'Pat',
  ].join('\n'));
});

test('clipboard HTML supports semantic blocks and inline marks and refuses script links', () => {
  const markdown = '# Heading\n\n> Quote with *care*\n\n1. **Bold** and `code` and ~~gone~~ and <u>under</u>\n\n[bad](javascript:alert)\n\n```\n<a>&"\'\n```';
  assert.equal(markdownToHtml(markdown), '<div><h1>Heading</h1><blockquote>Quote with <em>care</em></blockquote><ol><li><strong>Bold</strong> and <code>code</code> and <s>gone</s> and <u>under</u></li></ol><p><a href="#">bad</a></p><pre>&lt;a&gt;&amp;&quot;&#39;</pre></div>');
});

test('markdown HTML is CommonJS only under the explicit cjs extension', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const shared = path.join(__dirname, '../../src/shared');
  assert.equal(fs.existsSync(path.join(shared, 'markdown-html.cjs')), true);
  assert.equal(fs.existsSync(path.join(shared, 'markdown-html.js')), false);
});

test('hrefs are allowlisted: only http, https, mailto, and scheme-less survive', () => {
  assert.match(markdownToHtml('[x](https://a.b)'), /href="https:\/\/a\.b"/);
  assert.match(markdownToHtml('[x](mailto:a@b.c)'), /href="mailto:a@b\.c"/);
  assert.match(markdownToHtml('[x](#anchor)'), /href="#anchor"/);
  assert.match(markdownToHtml('[share](file://server/share/doc.docx)'), /href="file:/, 'intranet share links are draft content');
  for (const bad of ['data:text/html;base64,AAAA', 'vbscript:msgbox', 'tel:+15551234', 'javascript:alert(1)']) {
    assert.match(markdownToHtml(`[x](${bad})`), /href="#"/, `${bad} must not survive`);
  }
});
