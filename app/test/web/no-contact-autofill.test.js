'use strict';

// Every text field on the phone states its autofill purpose (2026-11-01).
// A field that says nothing is classified by Safari's heuristics, and iOS
// guessed the message box was a contact field: every tap into it raised the
// "AutoFill Contact" bar and offered home and work addresses as suggestions.
// Free text says autoComplete="off"; a field that really wants autofill (the
// server URL on the setup screen) names its token instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB_SRC = path.join(__dirname, '../../web/src');
const NO_AUTOFILL_TYPES = new Set(['file', 'checkbox', 'radio', 'hidden', 'range', 'color', 'button', 'submit', 'reset', 'image']);

function jsxFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsxFiles(full);
    return entry.name.endsWith('.jsx') ? [full] : [];
  });
}

// The opening tag ends at the first '>' outside braces and quotes, so an
// arrow function inside onChange={...} does not end it early.
function openingTags(source) {
  const tags = [];
  const re = /<(input|textarea)\b/g;
  let match;
  while ((match = re.exec(source))) {
    let depth = 0;
    let quote = null;
    let i = match.index + match[0].length;
    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (quote) { if (ch === quote && source[i - 1] !== '\\') quote = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) break;
    }
    const text = source.slice(match.index, i + 1);
    const line = source.slice(0, match.index).split('\n').length;
    tags.push({ text, line });
  }
  return tags;
}

test('every phone text field declares its autofill purpose', () => {
  const missing = [];
  let checked = 0;
  for (const file of jsxFiles(WEB_SRC)) {
    for (const tag of openingTags(fs.readFileSync(file, 'utf8'))) {
      const type = /\btype="([^"]+)"/.exec(tag.text)?.[1];
      if (type && NO_AUTOFILL_TYPES.has(type)) continue;
      checked += 1;
      if (!/\bautoComplete=/.test(tag.text)) missing.push(`${path.relative(WEB_SRC, file)}:${tag.line}`);
    }
  }
  assert.ok(checked >= 10, `expected to find the phone's text fields, found ${checked}`);
  assert.deepEqual(missing, [], 'these fields let iOS guess, and it guesses contact info');
});

test('the message box is an editable element, which Safari never autofills', () => {
  // autoComplete="off" (c862829) and then a label plus a name (df53d18) did not
  // stop Safari raising "AutoFill Contact" on the message box in a busy session:
  // it classifies input, textarea and select by its own heuristics whatever
  // they say. An editable element is outside its AutoFill entirely, which is
  // what Claude, ChatGPT and Slack type into on the phone.
  const composer = fs.readFileSync(path.join(WEB_SRC, 'composer/Composer.jsx'), 'utf8');
  assert.equal(openingTags(composer).filter((tag) => tag.text.startsWith('<textarea')).length, 0,
    'the message box must not be a textarea');
  assert.match(composer, /className="composer-input"/);
  assert.match(composer, /contentEditable=\{disabled \? 'false' : 'plaintext-only'\}/,
    'plain text only, so a paste never brings formatting into the draft');
  assert.match(composer, /role="textbox"/);
  assert.match(composer, /aria-multiline="true"/);
});

test('the typing layout recognises the message box as a field', () => {
  // use-typing.js hides the tabs while a field has focus and the keyboard is up.
  // Its selector named textarea and contenteditable="true" only, so the new box
  // would have kept the tabs on screen while typing.
  const typing = fs.readFileSync(path.join(WEB_SRC, 'shell/use-typing.js'), 'utf8');
  assert.match(typing, /\[contenteditable="plaintext-only"\]/);
});
