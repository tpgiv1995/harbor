'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { registerSetupIpc, setupState } = require('../../src/main/setup/ipc.js');
const { createConfigStore } = require('../../src/main/config/store.js');
const { validateConfig } = require('../../src/main/config/schema.js');

// A stand-in ipcMain that keeps the handlers so a test can invoke them the way
// the renderer would.
function fakeIpc() {
  const handlers = new Map();
  return {
    handlers,
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
    invoke: (channel, payload) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler for ${channel}`);
      return handler({}, payload);
    },
  };
}

// The store is pointed at a throwaway file, and the runtime it derives from is
// hermetic: a test that writes into the real userData is a test that edits the
// machine it runs on.
async function harness(overrides = {}) {
  const { seed, ...deps } = overrides;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-setup-ipc-'));
  const file = path.join(dir, 'config.json');
  // A config that has NOT run setup is written explicitly, because the store's
  // no-file path does not produce one. See the legacyConfig test below.
  if (seed) await fsp.writeFile(file, JSON.stringify(seed));
  const store = createConfigStore({
    file,
    runtime: {
      env: { PATH: '', SHELL: '/bin/bash' },
      homedir: dir,
      platform: 'linux',
      findBinary: (name) => name,
      herdrSocket: () => path.join(dir, 'herdr.sock'),
    },
  });
  let config = await store.load();
  const ipc = fakeIpc();
  const registered = registerSetupIpc({
    ipcMain: ipc,
    app: { getVersion: () => '9.9.9' },
    getConfig: () => config,
    saveConfig: async (next) => { config = await store.save(next); return config; },
    ...deps,
  });
  return { dir, ipc, store, registered, getConfig: () => config, file: store.file };
}

// A config that has explicitly not run setup. This is what the wizard opens on.
function notYetSetUp(dir) {
  return {
    version: 1,
    setup: { completed: false, completedAt: null, appVersion: null },
    profiles: [{
      id: 'personal',
      label: 'Personal',
      letter: 'P',
      color: '#6fa8d8',
      provider: 'claude',
      configHome: path.join(dir, '.claude'),
      email: null,
      isDefault: true,
    }],
  };
}

test('setup:state answers from the config the app already loaded', async () => {
  const dir0 = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-setup-seed-'));
  const { dir, ipc, getConfig } = await harness({ seed: notYetSetUp(dir0) });
  const first = await ipc.invoke('setup:state');
  assert.equal(first.completed, false, 'setup has not run, so the wizard opens');
  assert.deepEqual(setupState(getConfig()), first, 'one answer, not two sources');
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rm(dir0, { recursive: true, force: true });
});

// This was PINNED as a KNOWN GAP by batch-12, which found that the config
// store's no-file path seeded legacyConfig and so marked setup ALREADY
// COMPLETED: right for migrating Pat's running install, wrong for a fresh
// machine, which would never be offered the wizard at all. That batch
// deliberately documented it instead of altering migrate.js from a wizard
// batch, and left it to whoever owned the migration.
//
// Batch-13 closed it, because the ship gate is where that bill comes due: the
// cold-start drive launched Harbor against an empty HOME and got no wizard at
// all, plus a config carrying Pat's three plans. `store.load` now migrates only
// when there is a prior Harbor install to migrate FROM (its cache directory),
// and falls to schema defaults otherwise. The gap is closed in both directions
// by the two specs at the end of test/main/config-migrate.test.js.
test('a config-less install opens the wizard instead of pretending it ran', async () => {
  const { dir, ipc } = await harness();
  const state = await ipc.invoke('setup:state');
  assert.equal(state.completed, false, 'a machine that never ran Harbor has not completed setup');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('setup:save writes a valid config, stamps it, and flips completed', async () => {
  const dir0 = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-setup-seed-'));
  const { dir, ipc, file } = await harness({ seed: notYetSetUp(dir0) });
  const base = await ipc.invoke('setup:state');
  assert.equal(base.completed, false);
  await fsp.rm(dir0, { recursive: true, force: true });

  const result = await ipc.invoke('setup:save', {
    config: {
      version: 1,
      setup: { completed: false, completedAt: null, appVersion: null },
      platform: { os: 'linux', herdrBin: '/bin/herdr', herdrSocket: '/tmp/h.sock', shell: '/bin/bash' },
      profiles: [{
        id: 'personal',
        label: 'Personal',
        letter: 'P',
        color: '#6fa8d8',
        provider: 'claude',
        configHome: path.join(dir, '.claude'),
        email: 'a@example.com',
        isDefault: true,
      }],
      providers: {
        claude: { enabled: true, bin: 'claude' },
        codex: { enabled: false, bin: 'codex' },
        cursor: { enabled: false, bin: 'cursor-agent' },
      },
      workflows: [],
      orchestration: { enabled: false, launcher: null, researchCommand: '/r', executionCommand: '/e', stateDir: null },
      newSessionDefaults: { provider: 'claude', model: 'opus', effort: 'xhigh' },
    },
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.config.setup.completed, true);
  assert.equal(result.config.setup.appVersion, '9.9.9');
  assert.ok(result.config.setup.completedAt, 'the completion is stamped');

  // It really reached disk, and it really validates.
  const onDisk = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(onDisk.setup.completed, true);
  assert.doesNotThrow(() => validateConfig(onDisk));

  // And the app now boots past the wizard.
  assert.equal((await ipc.invoke('setup:state')).completed, true);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('an INVALID config is refused with the schema’s own reason, not written', async () => {
  const { dir, ipc, file } = await harness();
  const before = await fsp.readFile(file, 'utf8');

  const result = await ipc.invoke('setup:save', {
    config: { version: 1, profiles: [] },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /non-empty/);
  assert.equal(await fsp.readFile(file, 'utf8'), before, 'nothing was written');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('setup:preview runs the SAME derive the save runs, so the review cannot lie', async () => {
  const { dir, ipc } = await harness();
  const config = {
    version: 1,
    profiles: [{
      id: 'personal', label: 'P', letter: 'P', color: '#6fa8d8',
      provider: 'claude', configHome: '/h/.claude', email: null, isDefault: true,
    }],
  };
  const preview = await ipc.invoke('setup:preview', { config });
  assert.equal(preview.ok, true);
  // Defaults the wizard never asked about are filled in and SHOWN, so the user
  // reviews the real file rather than the subset the screens covered.
  assert.ok(preview.config.paths.cacheDir);
  assert.ok(preview.config.paths.projectsDir);
  assert.doesNotThrow(() => validateConfig(preview.config));

  const bad = await ipc.invoke('setup:preview', { config: { version: 1, profiles: [] } });
  assert.equal(bad.ok, false, 'a config the schema would reject is reported BEFORE the button');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('setup:detect hands back the CURRENT config, so a re-run can merge onto it', async () => {
  // Without this the wizard rebuilt the config from wizard state alone, and
  // re-opening it from the app menu to change one launcher would have reset
  // every field the seven screens never ask about.
  const dir0 = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-setup-seed-'));
  const { dir, ipc } = await harness({
    seed: notYetSetUp(dir0),
    detectEnvironment: async () => ({ os: 'linux', claudeHomes: [] }),
  });
  const result = await ipc.invoke('setup:detect');
  assert.equal(result.ok, true);
  assert.ok(result.config, 'the current config rides along');
  assert.ok(result.config.paths.cacheDir, 'including the fields no screen asks about');

  // And it is still handed back when detection FAILS, because that is exactly
  // when the wizard falls back to manual entry and still has to merge.
  const broken = await harness({
    seed: notYetSetUp(dir0),
    detectEnvironment: async () => { throw new Error('nope'); },
  });
  const failed = await broken.ipc.invoke('setup:detect');
  assert.equal(failed.ok, false);
  assert.ok(failed.config, 'a failed detection still carries the base config');

  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rm(broken.dir, { recursive: true, force: true });
  await fsp.rm(dir0, { recursive: true, force: true });
});

test('the folder picker goes through the SAME dialog guard as the rest of the app', async () => {
  // The wizard is the first surface a drive walks through, so an unguarded
  // picker here is how a harness opens a chooser on the real desktop.
  let asked = null;
  const { dir, ipc } = await harness({
    assertDialogAllowed: (what) => {
      asked = what;
      const error = new Error('refusing to open a native file dialog: isolated profile');
      error.code = 'DIALOG_BLOCKED';
      throw error;
    },
    dialog: { showOpenDialog: async () => { throw new Error('the guard must run first'); } },
  });
  await assert.rejects(() => ipc.invoke('setup:pick-folder', {}), /refusing to open a native file dialog/);
  assert.equal(asked, 'setup folder picker', 'the guard names the caller');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('HARBOR_E2E_FAKE_DIALOG answers before the guard, so the proof is two-sided', async () => {
  // With an answer in hand no portal call happens at all. Without this branch a
  // refusal would pass just as well if the click never reached a picker.
  const previous = process.env.HARBOR_E2E_FAKE_DIALOG;
  process.env.HARBOR_E2E_FAKE_DIALOG = '/tmp/chosen-home';
  try {
    const { dir, ipc } = await harness({
      assertDialogAllowed: () => { throw new Error('must not be reached'); },
      dialog: { showOpenDialog: async () => { throw new Error('must not be reached'); } },
    });
    const result = await ipc.invoke('setup:pick-folder', {});
    assert.deepEqual(result, { ok: true, path: '/tmp/chosen-home' });
    await fsp.rm(dir, { recursive: true, force: true });
  } finally {
    if (previous === undefined) delete process.env.HARBOR_E2E_FAKE_DIALOG;
    else process.env.HARBOR_E2E_FAKE_DIALOG = previous;
  }
});

test('a sign-in from an isolated profile is refused, and hands back the command', async () => {
  const { dir, ipc } = await harness({
    launchPolicy: { allowed: false, reason: 'refusing to launch a real session: isolated profile' },
  });
  const result = await ipc.invoke('setup:login', { provider: 'claude', configHome: '/h/.claude' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LAUNCH_BLOCKED');
  assert.equal(result.manualCommand, 'CLAUDE_CONFIG_DIR=/h/.claude claude auth login');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('detection failing is survivable: the wizard is told, not crashed', async () => {
  const { dir, ipc } = await harness({
    detectEnvironment: async () => { throw new Error('no /proc on this machine'); },
  });
  const result = await ipc.invoke('setup:detect');
  assert.equal(result.ok, false);
  assert.equal(result.detected, null);
  assert.match(result.reason, /no \/proc/);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('re-check reads the home from disk rather than trusting the login window', async () => {
  const { dir, ipc } = await harness();
  const home = path.join(dir, '.claude-team');
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 't@example.com' } }));

  const result = await ipc.invoke('setup:read-home', { home });
  assert.equal(result.ok, true);
  assert.equal(result.home.email, 't@example.com');
  assert.equal(result.home.authed, true);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('every channel the preload exposes is actually registered', async () => {
  const { dir, ipc, registered } = await harness();
  const preload = await fsp.readFile(path.join(__dirname, '../../src/preload/index.js'), 'utf8');
  const exposed = [...preload.matchAll(/invoke\('(setup:[^']+)'/g)].map((match) => match[1]);
  assert.ok(exposed.length >= 9, `expected the setup surface, found ${exposed.length}`);
  for (const channel of exposed) {
    assert.ok(ipc.handlers.has(channel), `preload calls ${channel} but nothing handles it`);
    assert.ok(registered.channels.includes(channel), `${channel} is missing from the dispose list`);
  }
  // And dispose really removes them, so a re-register cannot leak handlers.
  registered.dispose();
  assert.equal(ipc.handlers.size, 0);
  await fsp.rm(dir, { recursive: true, force: true });
});

// FINISHING THE WIZARD HAS TO CHANGE THE RUNNING APP, and until 2026-08-07 it
// changed only the file on disk and one variable in the main process.
//
// `launchActions`, `orchActions`, the history provider, the usage provider and
// the capabilities provider are each constructed ONCE, from a snapshot of the
// config taken before the window exists. Nothing subscribed to the config
// store's own `change` event, and this hook was accepted here but never supplied
// at the composition root, so the modules that launch a session and kick off
// orchestration kept the pre-wizard profile list until the user happened to quit
// and reopen. On a FIRST run that is every one of them, because the wizard is
// what created the profiles in the first place. The renderer's own reload could
// never fix it: the stale state is in the other process.
test('setup:save calls the completion hook with the saved config', async () => {
  const dir0 = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-setup-hook-'));
  const completions = [];
  const { dir, ipc } = await harness({
    seed: notYetSetUp(dir0),
    onCompleted: (saved) => completions.push(saved),
  });
  await fsp.rm(dir0, { recursive: true, force: true });

  const result = await ipc.invoke('setup:save', {
    config: {
      version: 1,
      setup: { completed: false, completedAt: null, appVersion: null },
      platform: { os: 'linux', herdrBin: '/bin/herdr', herdrSocket: '/tmp/h.sock', shell: '/bin/bash' },
      profiles: [{
        id: 'personal',
        label: 'Personal',
        letter: 'P',
        color: '#6fa8d8',
        provider: 'claude',
        configHome: path.join(dir, '.claude'),
        email: null,
        isDefault: true,
      }],
      providers: {
        claude: { enabled: true, bin: 'claude' },
        codex: { enabled: false, bin: 'codex' },
        cursor: { enabled: false, bin: 'cursor-agent' },
      },
      workflows: [],
      orchestration: { enabled: false, launcher: '', researchCommand: '/r', executionCommand: '/e', stateDir: null },
      newSessionDefaults: { provider: 'claude', model: 'opus', effort: 'xhigh' },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(completions.length, 1, 'the hook fires exactly once per save');
  assert.equal(completions[0].setup.completed, true, 'and receives the config that was actually written');
  assert.equal(completions[0].profiles[0].id, 'personal');
  await fsp.rm(dir, { recursive: true, force: true });
});

// A save that FAILS validation must not tell the app to reload onto it. This is
// the other half: the hook is not "the user pressed Finish", it is "a valid
// config reached disk".
test('a rejected save never calls the completion hook', async () => {
  const dir0 = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-setup-hook-bad-'));
  const completions = [];
  const { dir, ipc } = await harness({
    seed: notYetSetUp(dir0),
    onCompleted: (saved) => completions.push(saved),
  });
  await fsp.rm(dir0, { recursive: true, force: true });

  const result = await ipc.invoke('setup:save', { config: { version: 1, profiles: [] } });
  assert.equal(result.ok, false);
  assert.equal(completions.length, 0);
  await fsp.rm(dir, { recursive: true, force: true });
});

// The hook is only useful if the composition root passes one, and that is the
// exact line that was missing. It cannot be proven by booting Electron here (the
// real handler relaunches the app, which no in-process harness survives), so the
// wiring is asserted structurally, deliberately and with its reason written
// down, rather than left as the one link in the chain nothing checks.
test('the composition root supplies the completion hook', () => {
  const source = require('node:fs').readFileSync(
    path.join(__dirname, '../../src/main/index.js'),
    'utf8',
  );
  const call = source.slice(source.indexOf('registerSetupIpc({'));
  assert.ok(call.startsWith('registerSetupIpc({'), 'registerSetupIpc must be called from main/index.js');
  const body = call.slice(0, call.indexOf('\n  });'));
  assert.match(body, /onCompleted:/, 'main/index.js must pass onCompleted to registerSetupIpc');
  assert.match(body, /app\.relaunch\(/, 'and the hook must relaunch onto the config just written');
  // ...and must not do it to a harness. Every real effect in this file refuses
  // under the E2E marker rather than requiring an opt-out, because a relaunch
  // exits the process a Playwright drive is attached to.
  assert.match(body, /if \(e2eMode\) return;/, 'the relaunch must fail closed under HARBOR_E2E');
});
