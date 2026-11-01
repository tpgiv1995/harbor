'use strict';

// The phone header's two session buttons and the New session sheet's preset
// (2026-10-31): the rules behind "start a new session from this chat" and "copy
// this session's id", which the desktop window header already has.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { canCopySessionId, newSessionHerePreset } = require('../../web/src/shell/session-actions.cjs');
const { presetChoices, withPresetFolder, sameFolder } = require('../../web/src/newsession/preset.cjs');

const REAL_ID = '11111111-1111-4111-8111-111111111111';

test('a real session id can be copied; a provisional pane or unresolved live id cannot', () => {
  assert.equal(canCopySessionId(REAL_ID), true);
  assert.equal(canCopySessionId('rollout-2026-10-31T10-00-00-abc'), true, 'a codex id is real too');
  assert.equal(canCopySessionId('pane:fixture-7'), false);
  assert.equal(canCopySessionId('live:fixture-7'), false);
  assert.equal(canCopySessionId(''), false);
  assert.equal(canCopySessionId('   '), false);
  assert.equal(canCopySessionId(null), false);
  assert.equal(canCopySessionId(undefined), false);
});

test('the same rule as the desktop window header', () => {
  const tile = fs.readFileSync(path.join(__dirname, '../../src/renderer/stage/SessionTile.jsx'), 'utf8');
  assert.match(tile, /!sessionIdStr\.startsWith\('pane:'\) && !sessionIdStr\.startsWith\('live:'\)/);
});

test('new session here carries the chat\'s folder, provider and plan, and nothing else', () => {
  const preset = newSessionHerePreset({
    id: REAL_ID, cwd: '/work/cdt-app', provider: 'claude', home: 'alpha', model: 'claude-opus-5-5', effort: 'high',
  });
  assert.deepEqual(preset, { folder: '/work/cdt-app', provider: 'claude', account: 'alpha', sessionId: REAL_ID });
});

test('new session here: provider defaults to claude, the plan may be a legacy account field', () => {
  assert.deepEqual(newSessionHerePreset({ id: REAL_ID, cwd: '/work/x', account: 'team' }),
    { folder: '/work/x', provider: 'claude', account: 'team', sessionId: REAL_ID });
  assert.deepEqual(newSessionHerePreset({ id: REAL_ID, cwd: '/work/x', provider: 'codex' }),
    { folder: '/work/x', provider: 'codex', account: null, sessionId: REAL_ID });
});

test('new session here needs a folder, and only a real id is sent to the server to look up', () => {
  assert.equal(newSessionHerePreset(null), null);
  assert.equal(newSessionHerePreset({ id: REAL_ID }), null);
  assert.equal(newSessionHerePreset({ id: REAL_ID, cwd: '   ' }), null);
  assert.equal(newSessionHerePreset({ id: 'pane:abc', cwd: '/work/x', home: 'personal' }).sessionId, null);
});

const OPTIONS = {
  defaults: { provider: 'claude', model: 'opus', effort: 'xhigh' },
  providers: { claude: {}, codex: {} },
  profilesByProvider: {
    claude: [
      { id: 'personal', provider: 'claude', isDefault: true, configHome: '/h/p' },
      { id: 'alpha', provider: 'claude', configHome: '/h/s' },
    ],
    codex: [],
  },
};

test('the sheet\'s choices follow the chat, and without a preset are the sheet\'s own defaults', () => {
  assert.deepEqual(presetChoices(OPTIONS, null), { provider: 'claude', account: 'personal' });
  assert.deepEqual(presetChoices(OPTIONS, { provider: 'claude', account: 'alpha' }), { provider: 'claude', account: 'alpha' });
  // The plan may arrive as the config home, as a session row's `home` can.
  assert.deepEqual(presetChoices(OPTIONS, { provider: 'claude', account: '/h/s' }), { provider: 'claude', account: 'alpha' });
  assert.deepEqual(presetChoices(OPTIONS, { provider: 'codex', account: 'alpha' }), { provider: 'codex', account: '' },
    'a provider with no plans of its own carries none');
});

test('a preset the server no longer offers falls back to the default rather than launching somewhere unseen', () => {
  assert.deepEqual(presetChoices(OPTIONS, { provider: 'cursor', account: 'alpha' }), { provider: 'claude', account: 'alpha' });
  assert.deepEqual(presetChoices(OPTIONS, { provider: 'claude', account: 'gone' }), { provider: 'claude', account: 'personal' });
  assert.deepEqual(presetChoices({ providers: { claude: {} }, profilesByProvider: { claude: [] } }, { provider: 'claude' }), { provider: 'claude', account: '' });
});

test('the chat\'s folder is offered first and once, even when the server\'s list left it out', () => {
  assert.deepEqual(withPresetFolder(['/a', '/b'], '/work/wt'), ['/work/wt', '/a', '/b']);
  assert.deepEqual(withPresetFolder(['/a', '/work/wt', '/b'], '/work/wt'), ['/work/wt', '/a', '/b'], 'already listed: moved to the front, not doubled');
  assert.deepEqual(withPresetFolder(['/a'], null), ['/a'], 'no preset: the list is untouched');
  assert.deepEqual(withPresetFolder(undefined, '/work/wt'), ['/work/wt']);
  assert.deepEqual(withPresetFolder(null, ''), []);
});

test('folders compare across separator styles and a trailing separator', () => {
  assert.equal(sameFolder('C:\\dev\\app', 'C:/dev/app'), true);
  assert.equal(sameFolder('C:\\dev\\app\\', 'C:\\dev\\app'), true);
  assert.equal(sameFolder('C:\\dev\\app', 'C:\\dev\\app2'), false);
  assert.deepEqual(withPresetFolder(['C:\\dev\\app', 'C:\\dev\\b'], 'C:/dev/app'), ['C:/dev/app', 'C:\\dev\\b']);
});

test('the sheet asks the server for the chat\'s folder by its session, and starts with the same hint', () => {
  const sheet = fs.readFileSync(path.join(__dirname, '../../web/src/newsession/NewSessionSheet.jsx'), 'utf8');
  assert.match(sheet, /client\.call\('new-session:folder', preset\?\.sessionId \? \{ sessionId: preset\.sessionId \} : undefined\)/);
  assert.match(sheet, /\.\.\.\(preset\?\.sessionId \? \{ sessionId: preset\.sessionId \} : \{\}\)/);
  // Without a preset the sheet is what it was: the folder picker is open, nothing is folded.
  assert.match(sheet, /setPickerOpen\(!preset\?\.folder\)/);
});

test('the server accepts a chat\'s own folder when it names the chat (what the phone sends)', async (t) => {
  // The real handlers, with a sidebar whose model does not list the worktree: the
  // session hint alone makes it a candidate, and without the hint it is refused.
  const os = require('node:os');
  const { EventEmitter } = require('node:events');
  const { composeServer } = require('../../src/server/compose.js');
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'harbor-preset-folder-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const listed = path.join(root, 'listed');
  const worktree = path.join(root, 'worktree');
  await Promise.all([listed, worktree].map((folder) => fs.promises.mkdir(folder, { recursive: true })));
  const launches = [];
  const sidebar = {
    emitter: new EventEmitter(), async start() {}, close() {},
    getState: () => ({ model: { projects: [{ label: 'p', sessions: [{ id: 'listed-1', cwd: listed, lastActiveMs: 1 }] }] } }),
    getSessionMeta: async (id) => (id === REAL_ID ? { cwd: worktree } : null),
    getSessionPreview: async () => null,
  };
  const env = {
    ...process.env,
    HARBOR_NO_DAEMON_START: '1', HARBOR_NO_USAGE_FETCH: '1', HARBOR_TAILNET_LOGINS: 'none', HARBOR_E2E_FAKE_LAUNCH: '1',
    HARBOR_CONTEXT_DIR: path.join(root, 'context'), HARBOR_SESSIOND_DIR: path.join(root, 'sessiond'),
    HARBOR_ARTIFACTS_ROOTS: path.join(root, 'artifacts'), HARBOR_ARTIFACTS_CACHE: path.join(root, 'artifacts-index.json'),
    HARBOR_TASKS_FILE: path.join(root, 'tasks.json'),
  };
  await fs.promises.mkdir(env.HARBOR_CONTEXT_DIR, { recursive: true });
  const composed = await composeServer({
    userDataDir: path.join(root, 'user-data'), env, sidebar,
    artifacts: { async list() { return { ok: true, artifacts: [] }; }, isServable() { return false; } },
    icons: { async list() { return { icons: {} }; }, watch() {}, async filePathFor() { return null; }, mimeFor() { return null; } },
    tasks: { read: async () => ({}), mutate: async () => ({}), subscribe() {}, close() {} },
    terminalBridge: { emitter: new EventEmitter(), async start() {}, close() {}, sendInput: async () => ({ ok: true }) },
    sessionSend: { emitter: new EventEmitter(), send: async () => ({ ok: true }), getMenu: async () => null, getQueueState: () => ({ count: 0 }) },
    onFakeLaunch: (record) => launches.push(record),
  });
  t.after(() => composed.close());
  const call = (method, payload) => composed.router.call(method, payload);
  const same = (left, right) => path.normalize(left) === path.normalize(right);
  const withoutHint = await call('new-session:folder', {});
  assert.ok(!withoutHint.some((folder) => same(folder, worktree)), 'the model does not list the worktree');
  const withHint = await call('new-session:folder', { sessionId: REAL_ID });
  assert.ok(same(withHint[0], worktree), 'the hint makes the chat\'s folder the first candidate');
  await assert.rejects(() => call('new-session', { folder: worktree, provider: 'claude', model: 'opus', effort: 'high' }), /not a candidate/);
  assert.equal(launches.length, 0);
  await call('new-session', { folder: worktree, provider: 'claude', model: 'opus', effort: 'high', sessionId: REAL_ID });
  assert.equal(launches.length, 1);
  assert.ok(same(launches[0].options.cwd, worktree));
});

// The 2026-10-31 review's fixes, pinned on the source: the drive proves them in a
// browser (copyId, headerOffline, sheetFirstOpen, sheetSecondOpen).
const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '../../web/src', rel), 'utf8');

test('the copy button announces its result in a polite live region that is always in the page', () => {
  const source = readSrc('shell/SessionActions.jsx');
  assert.match(source, /className="hdr-live" role="status" aria-live="polite"/);
  assert.match(source, /'Session id copied'/);
  assert.match(source, /'Could not copy the session id'/);
  assert.match(readSrc('shell/shell.css'), /\.hdr-live\s*\{[^}]*position:\s*absolute/, 'visually hidden, not display:none (a hidden region is not announced)');
});

test('while disconnected both session buttons step aside for the connection pill', () => {
  const source = readSrc('shell/AppShell.jsx');
  assert.match(source, /\{disconnected \? null : <NewSessionHereButton/);
  assert.match(source, /\{disconnected \? null : <CopySessionIdButton/);
  assert.match(readSrc('shell/shell.css'), /\.hdr-kicker \.hdr-project \{ flex: 0 0\.25 auto/, 'squeezed, the status loses characters before the project name');
});

test('the New session sheet belongs to one open: cleared on close and preset change, Start waits for this open\'s list', () => {
  const source = readSrc('newsession/NewSessionSheet.jsx');
  assert.match(source, /const clearFolderState = useCallback/);
  assert.match(source, /if \(!open\) clearFolderState\(\)/, 'closing clears the folder state');
  assert.match(source, /if \(!open\) return undefined;\s*clearFolderState\(\);/, 'every open and every preset change starts blank');
  assert.match(source, /setLoaded\(true\)/);
  assert.match(source, /disabled=\{!loaded \|\| !folder \|\| !providerOptions \|\| starting \|\| !connected\}/, 'Start stays off until this open\'s list has resolved');
  assert.match(source, /!client \|\| !connected \|\| !loaded \|\| !folder/, 'and submit refuses too');
  assert.match(source, /\) : loaded \? \(\s*<p className="newsession-empty">No candidate folders from the server\.<\/p>/, 'the empty message only after the list came back');
  assert.match(source, /Loading folders/);
});
