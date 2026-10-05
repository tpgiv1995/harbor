'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  parseSlashTokens,
  activeSlashToken,
  slashMatchesFor,
  classifySlashTokens,
  slashChrome,
} = require('../../src/renderer/stage/slash-tokens.cjs');

const COMMANDS = [
  { name: '/compact' },
  { name: '/config' },
  { name: '/quality' },
  { name: '/quality-plus' },
  { name: '/vera' },
  { name: '/vera-lint' },
];
const KNOWN = new Set(COMMANDS.map((c) => c.name));

test('parseSlashTokens finds the leading token', () => {
  assert.deepStrictEqual(parseSlashTokens('/compact now'), [{ start: 0, token: '/compact' }]);
});

test('parseSlashTokens finds a token after text (the long-message shape)', () => {
  const text = 'please work the whole backlog carefully /quality';
  assert.deepStrictEqual(parseSlashTokens(text), [{ start: 40, token: '/quality' }]);
});

test('parseSlashTokens finds tokens on later lines and multiples', () => {
  const tokens = parseSlashTokens('/vera first\nthen also /quality later');
  assert.deepStrictEqual(tokens.map((t) => t.token), ['/vera', '/quality']);
});

test('parseSlashTokens ignores slashes inside words and URLs', () => {
  assert.deepStrictEqual(parseSlashTokens('see https://x.com/foo and a/b'), []);
});

test('activeSlashToken is only the token running to the end of the draft', () => {
  const trailing = 'fix this /qual';
  assert.deepStrictEqual(
    activeSlashToken(trailing, parseSlashTokens(trailing)),
    { start: 9, token: '/qual' },
  );
  const committed = 'fix this /quality now';
  assert.strictEqual(activeSlashToken(committed, parseSlashTokens(committed)), null);
  const spaceAfter = '/compact ';
  assert.strictEqual(activeSlashToken(spaceAfter, parseSlashTokens(spaceAfter)), null);
});

test('leading matches keep prefix plus substring behavior', () => {
  const active = { start: 0, token: '/qual' };
  assert.deepStrictEqual(slashMatchesFor(active, COMMANDS).map((c) => c.name), ['/quality', '/quality-plus']);
  const bare = { start: 0, token: '/' };
  assert.strictEqual(slashMatchesFor(bare, COMMANDS).length, COMMANDS.length);
});

test('non-leading matches are prefix-only and need a character after the slash', () => {
  assert.deepStrictEqual(
    slashMatchesFor({ start: 9, token: '/qual' }, COMMANDS).map((c) => c.name),
    ['/quality', '/quality-plus'],
  );
  // A bare "/" mid-draft is how every typed path starts; no popup.
  assert.deepStrictEqual(slashMatchesFor({ start: 9, token: '/' }, COMMANDS), []);
  // Substring matching would light up paths; prefix-only must not.
  assert.deepStrictEqual(slashMatchesFor({ start: 9, token: '/ompac' }, COMMANDS), []);
});

test('classifySlashTokens colors known tokens and never reddens a non-leading path', () => {
  const text = 'report at /tmp/out.html then /quality';
  assert.deepStrictEqual(classifySlashTokens(parseSlashTokens(text), KNOWN), [
    { start: 10, token: '/tmp/out.html', kind: 'plain' },
    { start: 29, token: '/quality', kind: 'ok' },
  ]);
  // Offsets must land on the token exactly, since the composer turns them into
  // DOM Ranges to paint.
  assert.strictEqual(text.slice(29, 29 + '/quality'.length), '/quality');
});

test('classifySlashTokens marks an unknown LEADING token bad', () => {
  const [first] = classifySlashTokens(parseSlashTokens('/nope stuff'), KNOWN);
  assert.deepStrictEqual(first, { start: 0, token: '/nope', kind: 'bad' });
});

test('slashChrome: leading verdict wins; otherwise any known token reads valid', () => {
  assert.deepStrictEqual(slashChrome(parseSlashTokens('/compact go'), KNOWN), { active: true, valid: true });
  assert.deepStrictEqual(slashChrome(parseSlashTokens('/nope go'), KNOWN), { active: true, valid: false });
  assert.deepStrictEqual(
    slashChrome(parseSlashTokens('long message /quality'), KNOWN),
    { active: true, valid: true },
  );
  // Only paths in the draft: no slash chrome at all.
  assert.deepStrictEqual(
    slashChrome(parseSlashTokens('look at /home/you/dev'), KNOWN),
    { active: false, valid: null },
  );
  assert.deepStrictEqual(slashChrome([], KNOWN), { active: false, valid: null });
});
