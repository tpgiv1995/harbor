'use strict';

// THE PHONE MUST SEE EVERY CODEX HOME THE DESKTOP SEES (2026-10-31).
//
// Pat, with a phone screenshot: "Codex (or any non-Claude) sessions don't show
// up in mobile but I think they show up like as a perpetually 'hung' live
// session." The Sessions list held rows titled only "Live session", a green
// dot, "now", no context. They were live Codex panes. The desktop and the
// phone server both build their rail with createSidebarBridge, but each
// composition root hand-lists the bridge's options, and the phone's list never
// carried `profiles`. Provider history and the provider session linker take
// their Codex homes from `profiles`, and with none they fall back to the single
// default `~/.codex`. Pat has three Codex homes, so the phone saw 435 Codex
// sessions where the desktop saw 4,079, and every session in the other two homes
// was a live pane with no history row behind it: nameless, and with no
// transcript to open.
//
// This drives the REAL composeServer (the real createSidebarBridge, the real
// provider history over real rollout files) against a fake daemon on an
// isolated pipe, with two Codex homes and a session in the second one.
// Nothing here reads or signals the machine's real daemon or homes: HOME and
// USERPROFILE point into the temp root before anything asks for them.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { realTmpDir } = require('../support/real-tmpdir.js');

const ROOT_PREFIX = path.join(realTmpDir(), 'harbor-compose-provider-homes-');
const fsSync = require('node:fs');
const root = fsSync.mkdtempSync(ROOT_PREFIX);
const home = path.join(root, 'home');
fsSync.mkdirSync(home, { recursive: true });
// Before any module asks os.homedir(): the cursor scan and the default Codex
// root both start there, and neither may touch the machine's real home.
process.env.HOME = home;
process.env.USERPROFILE = home;

const { startFakeSessiond } = require('../support/fake-sessiond.js');

// Capture what composeServer hands the REAL bridge. The module object is
// patched before compose.js destructures it, which is the only moment that
// works; node:test gives each file its own process, so nothing else sees it.
const bridgeModule = require('../../src/main/sidebar-bridge.js');
const realCreateSidebarBridge = bridgeModule.createSidebarBridge;
const bridgeCalls = [];
bridgeModule.createSidebarBridge = (options) => { bridgeCalls.push(options); return realCreateSidebarBridge(options); };
const { composeServer } = require('../../src/server/compose.js');

const LIVE_MAIN = '01900000-aaaa-7000-8000-00000000000a';
const LIVE_OTHER = '01900000-bbbb-7000-8000-00000000000b';
const LIVE_THIRD = '01900000-cccc-7000-8000-00000000000c';
const OLD_OTHER = '01900000-dddd-7000-8000-00000000000d';
const WORK = path.join(root, 'work', 'demo-site');

function rollout(id, cwd, prompt) {
  const stamp = '2026-10-31T10:00:00.000Z';
  return [
    JSON.stringify({ timestamp: stamp, type: 'session_meta', payload: { id, session_id: id, cwd, originator: 'codex_cli_rs', source: 'cli' } }),
    JSON.stringify({ timestamp: stamp, type: 'event_msg', payload: { type: 'user_message', message: prompt } }),
  ].join('\n') + '\n';
}

async function writeRollout(codexHome, id, prompt) {
  const day = path.join(codexHome, 'sessions', '2026', '10', '31');
  await fs.mkdir(day, { recursive: true });
  await fs.writeFile(path.join(day, `rollout-2026-10-31T10-00-00-${id}.jsonl`), rollout(id, WORK, prompt));
}

function rowsOf(model) {
  return (model.projects || []).flatMap((project) => project.sessions || []);
}

async function compose(t) {
  const userDataDir = path.join(root, 'user-data');
  const cacheDir = path.join(root, 'cache');
  const configFile = path.join(root, 'config.json');
  // The DEFAULT Codex home: the only one a bridge without profiles ever reads.
  const codexMain = path.join(home, '.codex');
  const codexOther = path.join(root, 'codex-other');
  await Promise.all([userDataDir, cacheDir, path.join(root, 'projects'), path.join(root, 'context'), WORK]
    .map((dir) => fs.mkdir(dir, { recursive: true })));
  await writeRollout(codexMain, LIVE_MAIN, 'Draft the release checklist for the widget');
  await writeRollout(codexOther, LIVE_OTHER, 'Summarize the quarterly widget report');
  await writeRollout(codexOther, OLD_OTHER, 'Archived question about the gadget spec');
  await fs.writeFile(configFile, JSON.stringify({
    version: 1,
    profiles: [
      { id: 'personal', label: 'Personal', letter: 'P', color: '#437FFE', provider: 'claude', configHome: path.join(root, 'claude-personal'), email: null, isDefault: true },
      { id: 'codex-main', label: 'Codex', letter: 'X', color: '#10A37F', provider: 'codex', configHome: codexMain, email: null, isDefault: true },
      { id: 'codex-other', label: 'Codex Other', letter: 'O', color: '#7A5AF8', provider: 'codex', configHome: codexOther, email: null, isDefault: false },
    ],
    paths: { cacheDir, projectsDir: path.join(root, 'projects') },
  }, null, 2));
  const socket = path.join(root, 'sessiond', 'isolated.sock');
  await fs.mkdir(path.dirname(socket), { recursive: true });
  const live = (id, sessionId) => ({
    id, cwd: WORK, pid: 4000 + id.length, agent: 'codex', agent_session: sessionId, argv: ['codex'],
    created_at: '2026-10-31T12:00:00.000Z',
  });
  const daemon = await startFakeSessiond(socket, [
    live('pane-main', LIVE_MAIN),
    live('pane-other', LIVE_OTHER),
    // A live pane whose session has no rollout anywhere: it stays an honest
    // nameless live row, which is what the title fallback is for.
    live('pane-third', LIVE_THIRD),
  ]);
  t.after(() => daemon.shutdown());
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HARBOR_CONFIG_FILE: configFile,
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_NO_USAGE_FETCH: '1',
    HARBOR_NO_MODEL_DISCOVERY: '1',
    HARBOR_NO_TITLER: '1',
    HARBOR_CONTEXT_DIR: path.join(root, 'context'),
    HARBOR_SESSIOND_DIR: path.join(root, 'sessiond'),
    HARBOR_SESSIOND_SOCKET: socket,
    HARBOR_ARTIFACTS_ROOTS: path.join(root, 'artifacts'),
    HARBOR_ARTIFACTS_CACHE: path.join(root, 'artifact-cache.json'),
    HARBOR_TASKS_FILE: path.join(root, 'tasks.json'),
    HARBOR_NOTES_FILE: path.join(root, 'notes.json'),
    HARBOR_PROJECT_ICONS_DIR: path.join(root, 'icons'),
  };
  delete env.HARBOR_PROVIDER_METADATA_FILE;
  bridgeCalls.length = 0;
  const composed = await composeServer({
    userDataDir, configFile, env,
    allowedTailnetLogins: [], selfOriginHosts: ['127.0.0.1'],
    terminalBridge: { emitter: new EventEmitter(), async start() {}, close() {} },
    // Not under test, and composeServer's close() never closes a real icons
    // watcher (the sibling compose specs stub these three the same way). The
    // SIDEBAR BRIDGE stays real: it is the thing being proven.
    artifacts: { async list() { return { ok: true, artifacts: [] }; }, isServable: () => true },
    icons: { async list() { return { icons: {} }; }, watch() {}, async filePathFor() { return null; }, mimeFor() { return null; } },
    tasks: { read: async () => ({}), mutate: async () => ({}), subscribe() {}, close() {} },
  });
  t.after(() => composed.close());
  return { composed, cacheDir, codexMain, codexOther };
}

test.after(() => fs.rm(root, { recursive: true, force: true }));

test('the phone lists a live Codex session from a second Codex home under its real title, never as a nameless "Live session"', async (t) => {
  const { composed } = await compose(t);
  const served = await composed.router.call('sidebar:get-state', {});
  const rows = rowsOf(served.model);
  const other = rows.find((row) => row.id === LIVE_OTHER);
  const main = rows.find((row) => row.id === LIVE_MAIN);
  assert.ok(main, 'the default Codex home session is listed');
  assert.match(main.title, /release checklist/, 'sanity: the home the phone always saw is named');
  assert.ok(other, 'the second Codex home session is listed');
  assert.notEqual(other.title, 'Live session', 'a live Codex pane in a second home must not be nameless');
  assert.match(other.title, /quarterly widget report/, 'it carries the title of its own rollout');
  assert.equal(other.provider, 'codex');
  assert.equal(other.isLive, true);
  assert.equal(other.isHistorical, true, 'the live pane merged onto its history row, so a tap can open its transcript');
  assert.ok(other.firstPrompt, 'the row has the first prompt that search and the window read');
  const meta = await composed.router.call('sidebar:get-state', { query: 'quarterly widget' });
  assert.ok(rowsOf(meta.model).some((row) => row.id === LIVE_OTHER), 'the phone search finds it by what was asked');
});

test('a live pane with no rollout anywhere is still listed, nameless but honest (the fallback is for that case only)', async (t) => {
  const { composed } = await compose(t);
  const rows = rowsOf((await composed.router.call('sidebar:get-state', {})).model);
  const third = rows.find((row) => row.id === LIVE_THIRD);
  assert.ok(third, 'an agent pane with no history row still lists');
  assert.equal(third.title, 'Live session');
  assert.equal(third.isHistorical, false);
});

test('the phone lists FINISHED Codex sessions from every Codex home, not only the default one', async (t) => {
  const { composed } = await compose(t);
  const found = await composed.router.call('sidebar:get-state', { query: 'gadget spec', days: 'all' });
  const old = rowsOf(found.model).find((row) => row.id === OLD_OTHER);
  assert.ok(old, 'a finished session in the second Codex home is reachable from the phone');
  assert.equal(old.provider, 'codex');
  assert.equal(old.isLive, false);
});

test('the phone hands the real bridge every provider option the desktop hands it (the drift that caused this)', async (t) => {
  const { cacheDir, codexMain, codexOther } = await compose(t);
  assert.equal(bridgeCalls.length, 1, 'composeServer built exactly one real bridge');
  const phone = bridgeCalls[0];
  assert.deepEqual(
    phone.profiles.filter((profile) => profile.provider === 'codex').map((profile) => profile.configHome).sort(),
    [codexMain, codexOther].sort(),
    'every configured Codex home reaches provider history and the linker',
  );
  assert.equal(phone.providerMetadataFile, path.join(cacheDir, 'provider-session-metadata.json'),
    'the durable id-to-cwd sidecar is the desktop\'s file, inside the configured cache dir');
  assert.equal(phone.providerFactsCacheFile, path.join(cacheDir, 'provider-row-facts.json'),
    'the provider scan the server waits on before it listens resumes from disk');
  assert.equal(phone.delegationScanCacheFile, path.join(cacheDir, 'background-fold.json'),
    'so does the background-task scan');
  // The desktop composition root is the reference. Source-level on purpose:
  // main/index.js cannot be required without starting Electron.
  const desktop = await fs.readFile(path.join(__dirname, '..', '..', 'src', 'main', 'index.js'), 'utf8');
  const start = desktop.indexOf('sidebarBridge = createSidebarBridge({');
  assert.ok(start > 0, 'found the desktop bridge call');
  const call = desktop.slice(start, desktop.indexOf('\n  });', start));
  for (const key of ['profiles', 'providerMetadataFile', 'providerFactsCacheFile', 'delegationScanCacheFile']) {
    assert.match(call, new RegExp(`\\b${key}:`), `the desktop passes ${key}`);
    assert.ok(Object.hasOwn(phone, key), `and so must the phone server`);
  }
});

test('the persisted scan caches are written where the desktop reads them', async (t) => {
  const { cacheDir } = await compose(t);
  const facts = JSON.parse(await fs.readFile(path.join(cacheDir, 'provider-row-facts.json'), 'utf8'));
  const cached = Object.keys(facts.files || {}).map((file) => path.basename(file));
  assert.ok(cached.some((name) => name.includes(LIVE_OTHER)), 'the second home\'s rollout is in the facts cache');
});
