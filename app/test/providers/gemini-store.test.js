'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  geminiStoresFor, geminiStoreRoot, geminiTranscriptPath, unwrapUserRequest, workspaceFromUri,
  parseHistory, parseLastConversations, readSummaries,
} = require('../../src/main/providers/gemini-store.js');

const ID = '7c1d2e3f-0a1b-4c2d-8e3f-000000000001';

test('unwrapUserRequest keeps the typed words and drops agy\'s own sections', () => {
  const framed = '<USER_REQUEST>\nFix the build.\nIt fails on CI.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal time\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nchanged model\n</USER_SETTINGS_CHANGE>';
  assert.equal(unwrapUserRequest(framed), 'Fix the build.\nIt fails on CI.');
  // A slash-looking prompt is stored verbatim.
  assert.equal(unwrapUserRequest('<USER_REQUEST>\n/m/e/context\n</USER_REQUEST>'), '/m/e/context');
  // No frame: the metadata sections still go, the rest stays.
  assert.equal(unwrapUserRequest('plain text\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>'), 'plain text');
  assert.equal(unwrapUserRequest(null), '');
});

test('workspaceFromUri reads agy\'s file:/// folders and refuses anything else', () => {
  if (process.platform === 'win32') {
    assert.equal(workspaceFromUri('file:///C:/work/my%20site'), 'C:\\work\\my site');
  } else {
    assert.equal(workspaceFromUri('file:///work/my%20site'), '/work/my site');
  }
  assert.equal(workspaceFromUri('https://example.com/x'), null);
  assert.equal(workspaceFromUri(''), null);
  assert.equal(workspaceFromUri('file://%zz'), null);
});

test('history and last-conversation parsers tolerate junk and keep the first folder per id', () => {
  const history = parseHistory([
    'not json',
    JSON.stringify({ display: 'a', workspace: '/one' }),
    JSON.stringify({ display: '/exit', workspace: '/one', conversationId: ID.toUpperCase() }),
    JSON.stringify({ display: 'b', workspace: '/two', conversationId: ID }),
    JSON.stringify({ display: 'c', conversationId: 'not-a-uuid' }),
  ].join('\n'));
  assert.deepEqual([...history], [[ID, '/one']]);
  assert.deepEqual([...parseLastConversations(JSON.stringify({ '/one': ID, '/two': 'nope', '': ID }))], [[ID, '/one']]);
  assert.deepEqual([...parseLastConversations('{broken')], []);
});

test('stores: the real profile first, each Gemini profile once, nothing else; explicit roots win', () => {
  const home = path.join(path.sep, 'users', 'ada');
  const other = path.join(path.sep, 'tools', 'other-profile');
  const stores = geminiStoresFor({ homedir: home, profiles: [
    { id: 'g', provider: 'gemini', configHome: other },
    { id: 'again', provider: 'gemini', configHome: other },
    { id: 'c', provider: 'codex', configHome: path.join(path.sep, 'x') },
    { id: 'nohome', provider: 'gemini' },
  ] });
  assert.deepEqual(stores, [
    { root: geminiStoreRoot(home), profileId: null, configHome: null },
    { root: geminiStoreRoot(other), profileId: 'g', configHome: other },
  ]);
  assert.deepEqual(geminiStoresFor({ homedir: null, profiles: [] }), []);
  assert.deepEqual(geminiStoresFor({ homedir: home, roots: ['/r'] }), [{ root: '/r', profileId: null, configHome: null }]);
  assert.equal(geminiTranscriptPath('/r', ID), path.join('/r', 'brain', ID, '.system_generated', 'logs', 'transcript_full.jsonl'));
});

test('a summaries database that is missing, or no sqlite at all, reads as "not available", never as an error', () => {
  assert.equal(readSummaries(path.join(path.sep, 'definitely', 'absent.db')), null);
  assert.equal(readSummaries('whatever.db', null), null);
});
