'use strict';

// Formatted pastes keep their structure (2026-11-21, Pat: a Teams list of two
// bullets, each with a child bullet, pasted as four bare paragraphs). Each
// spec feeds real clipboard HTML shapes through foreignHtmlToSpec, builds the
// composer's nodes from the spec, and checks the markdown the agent receives.

const test = require('node:test');
const assert = require('node:assert/strict');

const { foreignHtmlToSpec, cleanPastedText } = require('../../src/renderer/stage/paste-html.cjs');
const { buildNodes, serializeDoc } = require('../../src/renderer/stage/compose-doc.cjs');
const { parseHtml, fakeDocument } = require('../support/mini-html.cjs');

const ZWSP = String.fromCodePoint(0x200b);
const NBSP = String.fromCodePoint(0xa0);

function pasted(html) {
  const spec = foreignHtmlToSpec(parseHtml(html));
  if (!spec) return null;
  return serializeDoc(buildNodes(spec, fakeDocument()));
}

test('a Teams list with child bullets keeps its bullets, nesting and bold, without invisible characters', () => {
  const html = '<div><ul>'
    + `<li><p><strong>Backup retention.</strong> Deleted data can be restored for 37 days.${ZWSP}</p>`
    + '<ul><li><p>what happened here? keep at 37</p></li></ul></li>'
    + `<li><p><strong>Harbor${ZWSP}'s --help.</strong> Should an agent fix it?</p>`
    + '<ul><li><p>yes, surgically</p></li></ul></li>'
    + '</ul></div>';
  assert.equal(pasted(html), [
    '- **Backup retention.** Deleted data can be restored for 37 days.',
    '  - what happened here? keep at 37',
    "- **Harbor's --help.** Should an agent fix it?",
    '  - yes, surgically',
  ].join('\n'));
});

// The shape Harbor's own conversation window put on the clipboard on
// 2026-11-21 (captured from the real OS clipboard; wording replaced): a
// styled <ol>, a no-break space in its own span, a bold recommendation.
test('a copy out of a Harbor conversation window pastes back as a numbered list with its bold intact', () => {
  const style = 'box-sizing: border-box; margin: 0px 0px 8px; padding-left: 18px; list-style-type: decimal; color: rgb(246, 247, 255); font-weight: 400; background-color: rgb(11, 12, 15); text-decoration-thickness: initial;';
  const html = `<!--StartFragment--><ol class="md-list" style="${style}"><li style="box-sizing: border-box; margin-bottom: 3px;">Reword the instructions, or leave them?<span>&nbsp;</span><strong style="box-sizing: border-box;">Recommend: reword them now.</strong></li></ol><!--EndFragment-->`;
  assert.equal(pasted(html), '1. Reword the instructions, or leave them? **Recommend: reword them now.**');
});

test('Word and Outlook list paragraphs become one nested list, ordered when their markers are numbers', () => {
  const html = [
    "<p class=MsoListParagraph style='mso-list:l0 level1 lfo1'><![if !supportLists]><span style='font-family:Symbol;mso-list:Ignore'>&middot;<span style='font:7.0pt \"Times New Roman\"'>&nbsp;&nbsp;</span></span><![endif]><b>First</b> point</p>",
    "<p class=MsoListParagraph style='mso-list:l0 level2 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>o<span>&nbsp;</span></span><![endif]>its detail</p>",
    "<p class=MsoListParagraph style='mso-list:l0 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>&middot;</span><![endif]>Second point</p>",
    '<p class=MsoNormal>&nbsp;</p>',
    "<p style='mso-list:l1 level1 lfo2'><span style='mso-list:Ignore'>1.<span>&nbsp;</span></span>Step one</p>",
    "<p style='mso-list:l1 level1 lfo2'><span style='mso-list:Ignore'>2.<span>&nbsp;</span></span>Step two</p>",
  ].join('\n');
  assert.equal(pasted(html), [
    '- **First** point',
    '  - its detail',
    '- Second point',
    '',
    '1. Step one',
    '2. Step two',
  ].join('\n'));
});

test('a Google Docs copy is not all bold: its wrapper says font-weight normal', () => {
  const html = '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1234"><ul style="margin-top:0;"><li dir="ltr"><p dir="ltr"><span style="font-weight:700;">Bold lead</span><span style="font-weight:400;"> and the rest</span></p></li><li><p><span style="font-style:italic;">tilted</span></p></li></ul></b>';
  assert.equal(pasted(html), '- **Bold lead** and the rest\n- *tilted*');
});

test('plain paragraphs with no formatting take the plain-text path (null)', () => {
  assert.equal(foreignHtmlToSpec(parseHtml('<p>one line</p><p>another line</p>')), null);
  assert.equal(foreignHtmlToSpec(parseHtml('<span style="color:red">just text</span>')), null);
});

test('a spreadsheet copy (a table) takes the plain-text path, so its tabs reach the agent', () => {
  assert.equal(foreignHtmlToSpec(parseHtml('<table><tr><td><b>Name</b></td><td>Count</td></tr><tr><td>A</td><td>3</td></tr></table>')), null);
});

test('safe links survive as links; a script link is only its words', () => {
  assert.equal(pasted('<p>See <a href="https://example.com/a">the page</a> and <a href="javascript:alert(1)">this</a>.</p>'), 'See [the page](https://example.com/a) and this.');
});

test('a list nested deeper than the composer allows keeps every line, at the fifth level', () => {
  let html = 'level 7';
  for (let level = 6; level >= 1; level -= 1) html = `level ${level}<ul><li>${html}</li></ul>`;
  html = `<ul><li>${html}</li></ul>`;
  const out = pasted(html).split('\n');
  assert.equal(out.length, 7);
  assert.deepEqual(out.map((line) => line.trim()), ['- level 1', '- level 2', '- level 3', '- level 4', '- level 5', '- level 6', '- level 7']);
  assert.equal(out[4].indexOf('-'), 8, 'fifth level');
  assert.equal(out[6].indexOf('-'), 8, 'deeper items join the fifth level');
});

test("Chromium's nested list parked directly inside its parent list attaches to the item before it", () => {
  assert.equal(pasted('<ul><li>parent</li><ul><li>child</li></ul><li>next</li></ul>'), '- parent\n  - child\n- next');
});

test('headings, quotes, code blocks and breaks come through as the composer draws them', () => {
  const html = '<h2>Plan</h2><blockquote><p>quoted line</p></blockquote><pre>const a = 1;\n  b();</pre><p>first<br>second <em>line</em></p>';
  assert.equal(pasted(html), '## Plan\n> quoted line\n```\nconst a = 1;\n  b();\n```\nfirst\nsecond *line*');
});

test('ordered lists keep their numbering style and start', () => {
  assert.equal(pasted('<ol type="a" start="3"><li>c item</li><li>d item</li></ol>'), 'c. c item\nd. d item');
  assert.equal(pasted('<ol style="list-style-type: upper-roman"><li>one</li><li>two</li></ol>'), 'I. one\nII. two');
});

test('emoji drawn as images keep their alt text; other images are dropped', () => {
  assert.equal(pasted('<p><b>Done</b> <img alt="\u{1F44D}" src="x.png"> <img alt="a long description of a chart" src="y.png"></p>'), '**Done** \u{1F44D}');
});

test('the plain-text path drops invisible characters and makes no-break spaces plain spaces', () => {
  assert.equal(cleanPastedText(`one${ZWSP} two${NBSP}three\r\nfour`), 'one two three\nfour');
});
