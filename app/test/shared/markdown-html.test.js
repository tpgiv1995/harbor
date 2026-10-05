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
  assert.equal(markdownToHtml(markdown), '<div><p style="margin:0; line-height:1.15">Hi Alex,</p><p style="margin:0; line-height:1.15"><br></p><p style="margin:0; line-height:1.15">Here is the <strong>plan</strong>:</p><p style="margin:0; line-height:1.15"><br></p><ul style="margin:0; padding-left:24px"><li style="margin:0; line-height:1.15">First item<ul style="margin:0; padding-left:24px"><li style="margin:0; line-height:1.15">Nested &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</li></ul></li><li style="margin:0; line-height:1.15">Read the <a href="https://example.com/?a=1&amp;b=2">guide</a></li></ul><p style="margin:0; line-height:1.15"><br></p><p style="margin:0; line-height:1.15">Thanks,<br>Pat</p></div>');
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
  assert.equal(markdownToHtml(markdown), '<div><h1 style="margin:0; line-height:1.15">Heading</h1><p style="margin:0; line-height:1.15"><br></p><blockquote style="margin:0 0 0 24px; line-height:1.15">Quote with <em>care</em></blockquote><p style="margin:0; line-height:1.15"><br></p><ol style="margin:0; padding-left:24px"><li style="margin:0; line-height:1.15"><strong>Bold</strong> and <code>code</code> and <s>gone</s> and <u>under</u></li></ol><p style="margin:0; line-height:1.15"><br></p><p style="margin:0; line-height:1.15"><a href="#">bad</a></p><p style="margin:0; line-height:1.15"><br></p><pre style="margin:0; line-height:1.15">&lt;a&gt;&amp;&quot;&#39;</pre></div>');
});

test('clipboard uses real empty paragraphs, not margins, for the gap between paragraphs', () => {
  const html = markdownToHtml('Hi all,\n\nSecond paragraph.\n\n- one\n- two');
  // Every block zeroes space before and after and sets 1.15 line spacing: Pat's
  // manual cleanup, done for him, so there is nothing left to strip.
  assert.doesNotMatch(html, /<(p|ul|ol|li|blockquote|pre|h[1-6])>/, 'no unstyled block tags');
  assert.doesNotMatch(html, /margin:0 0 \d/, 'no paragraph bottom-margin fake line skips');
  assert.match(html, /line-height:1\.15/);
  // The gap between paragraphs is a genuine empty paragraph, not paragraph spacing.
  assert.match(
    html,
    /<p style="margin:0; line-height:1\.15">Hi all,<\/p><p style="margin:0; line-height:1\.15"><br><\/p><p style="margin:0; line-height:1\.15">Second paragraph\.<\/p>/,
  );
  // Bullets stay tight: no empty paragraph is injected between list items.
  assert.match(html, /<li[^>]*>one<\/li><li[^>]*>two<\/li>/);
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
