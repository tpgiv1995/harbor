'use strict';

// Label -> icon slug, and which source wins. This is the half of the icon
// feature that replaced a hardcoded map of 26 real project names, so the specs
// are the labels that map used to carry: if any of these stops deriving, an icon
// silently becomes a coloured dot and nothing else notices.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  iconSlugCandidates,
  resolveIconUrl,
  slugifyLabel,
} = require('../../src/renderer/stage/project-icon-slug.cjs');

test('slugifyLabel derives every label shape the deleted name map covered', () => {
  const cases = [
    ['harbor', 'harbor'],
    ['dev', 'dev'],
    ['example-app', 'example-app'],
    ['Data-Pipeline', 'data-pipeline'],
    ['Team Tools', 'team-tools'],
    ['Project Sweep', 'project-sweep'],
    ['Ref Images', 'ref-images'],
    ['Example Reporting', 'example-reporting'],
    ['MDM', 'mdm'],
    // Capitals mid-word: the icon filename is the flattened lowercase form.
    ['workGPT', 'workgpt'],
    // An ampersand is a word, not punctuation to drop: 'R&D' must not become 'rd'.
    ['R&D', 'randd'],
    // A nested label flattens rather than losing a segment.
    ['Notes/Wiki', 'notes-wiki'],
    ['example-chatbot/example-chatbot', 'example-chatbot-example-chatbot'],
    // Leading underscore and shouty suffix: no leading or doubled hyphens.
    ['_ARCHIVED-Report-Tool-standalone-DO-NOT-EDIT', 'archived-report-tool-standalone-do-not-edit'],
  ];
  for (const [label, expected] of cases) {
    assert.equal(slugifyLabel(label), expected, `${label} should slugify to ${expected}`);
  }
});

test('a slug can never address anything outside the icons directory', () => {
  // A label is attacker-shaped only in theory (it comes from a real folder path),
  // but it is the one value that turns into a filename, so the invariant is
  // stated here rather than assumed: joined to a directory, a slug stays inside
  // it. '..' surviving as TEXT ('a/../b' -> 'a-..-b') is fine and deliberate;
  // what must never survive is a separator or a leading dot, which is what makes
  // '..' a parent hop instead of two characters in a filename.
  for (const hostile of ['../../etc/passwd', '..', '.', '/etc/passwd', 'a/../../b', '....//x', 'C:\\Windows']) {
    const slug = slugifyLabel(hostile);
    assert.ok(!slug.includes('/') && !slug.includes('\\'), `${hostile} -> ${slug} kept a separator`);
    assert.ok(!slug.startsWith('.'), `${hostile} -> ${slug} started with a dot`);
    const joined = path.posix.normalize(path.posix.join('/icons', `${slug}.png`));
    assert.ok(joined.startsWith('/icons/'), `${hostile} -> ${joined} escaped /icons`);
  }
});

test('the home directory label has a slug, because there is no name to derive', () => {
  assert.equal(slugifyLabel('~'), '');
  assert.deepEqual(iconSlugCandidates('~'), ['home', '~']);
});

test('candidates are ordered most specific first', () => {
  // The raw label comes before the slugified one so an icon set built against
  // the old exact-match behaviour keeps resolving.
  assert.deepEqual(iconSlugCandidates('Team Tools'), ['Team Tools', 'team-tools']);
  // A nested label tries the whole thing, then its leaf, then its parent, so a
  // full-label icon always wins and a subfolder can still find its project.
  assert.deepEqual(
    iconSlugCandidates('Notes/Wiki'),
    ['Notes/Wiki', 'notes-wiki', 'wiki', 'notes'],
  );
});

test('a subfolder session inherits its parent project icon', () => {
  // Labels shaped like real rail entries that drew a bare dot before: the leaf
  // is a subfolder nobody drew an icon for, but the project above it has one.
  const userIcons = { surveys: 'u://surveys', harbor: 'u://harbor', 'client-records': 'u://pn' };
  assert.equal(resolveIconUrl('Surveys/Intake', { userIcons }), 'u://surveys');
  assert.equal(resolveIconUrl('harbor/app', { userIcons }), 'u://harbor');
  assert.equal(resolveIconUrl('Client Records/Discovery & Background Docs', { userIcons }), 'u://pn');
});

test('the leaf still outranks the parent, where the parent means nothing', () => {
  const userIcons = { photobook: 'u://photobook', documents: 'u://documents' };
  assert.equal(resolveIconUrl('Documents/Photobook', { userIcons }), 'u://photobook');
});

test('empty and non-string labels produce no candidates', () => {
  for (const label of ['', null, undefined, 42, {}]) {
    assert.deepEqual(iconSlugCandidates(label), []);
    assert.equal(resolveIconUrl(label, { userIcons: { x: 'u' } }), null);
  }
});

test('a full-label icon beats the nested leaf fallback', () => {
  const userIcons = { 'notes-wiki': 'user://notes-wiki', wiki: 'user://wiki' };
  assert.equal(resolveIconUrl('Notes/Wiki', { userIcons }), 'user://notes-wiki');
});

test('the nested leaf still resolves when the full label has no icon', () => {
  const userIcons = { 'example-chatbot': 'user://leaf' };
  assert.equal(
    resolveIconUrl('example-chatbot/example-chatbot', { userIcons }),
    'user://leaf',
  );
});

test('the user directory outranks the bundled assets for the same label', () => {
  const url = resolveIconUrl('harbor', {
    userIcons: { harbor: 'user://harbor' },
    bundledIcons: { harbor: 'bundled://harbor' },
  });
  assert.equal(url, 'user://harbor');
});

test('bundled icons still resolve when the user has none, so a fork can ship a set', () => {
  const url = resolveIconUrl('Team Tools', {
    userIcons: {},
    bundledIcons: { 'team-tools': 'bundled://tt' },
  });
  assert.equal(url, 'bundled://tt');
});

test('no icon in either source is null, which is the coloured dot', () => {
  assert.equal(resolveIconUrl('Report-Builder', { userIcons: {}, bundledIcons: {} }), null);
  assert.equal(resolveIconUrl('harbor', {}), null);
});
