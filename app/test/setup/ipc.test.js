'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { registerSetupIpc, setupState } = require('../../src/main/setup/ipc.js');
const { createConfigStore } = require('../../src/main/config/store.js');
const { validateConfig } = require('../../src/main/config/schema.js');
const { realTmpDir } = require('../support/real-tmpdir.js');

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
    validateProviderExecutables: async () => {},
    // Same "home directory" the config store itself was built against, so
    // setup:login's configHome check has a coherent answer for "is
    // this under the user's home" without depending on the real machine's
    // homedir or on os.tmpdir() happening to nest under it.
    homedir: () => dir,
    detectEnvironment: async () => ({ claudeHomes: [], providers: {} }),
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

for (const platform of ['linux', 'darwin', 'win32']) {
test(`${platform}: a sign-in from an isolated profile is refused, and hands back the command`, async () => {
  let configHome;
  const { dir, ipc } = await harness({
    platform,
    detectEnvironment: async () => ({ claudeHomes: [{ path: configHome }], providers: {} }),
    launchPolicy: { allowed: false, reason: 'refusing to launch a real session: isolated profile' },
  });
  // Under the harness's own homedir (see the `homedir` default in harness()
  // above), so this exercises LAUNCH_BLOCKED specifically rather than tripping
  // the configHome safety check the launch policy check runs after.
  configHome = path.join(dir, 'home with spaces', '.claude');
  const result = await ipc.invoke('setup:login', { provider: 'claude', configHome });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LAUNCH_BLOCKED');
  // loginPlan's own shellQuote (auth.js) quotes this value because a real
  // Windows path contains backslashes, outside its "safe bare word" charset;
  // that quoting is unrelated to the sign-in safety checks and predates this test.
  if (platform === 'win32') {
    assert.match(result.manualCommand, /^\$env:CLAUDE_CONFIG_DIR = '.*\.claude'; claude auth login$/);
    assert.equal(result.manualCommandLabel, 'PowerShell command');
  } else {
    assert.match(result.manualCommand, /^CLAUDE_CONFIG_DIR='.*\.claude' claude auth login$/);
    assert.equal(result.manualCommandLabel, 'Shell command');
  }
  assert.ok(result.manualCommand.includes(configHome), 'the real configHome is still in the command');
  await fsp.rm(dir, { recursive: true, force: true });
});
}

// 2026-09-19: setup:login hands bin/configHome from the renderer
// straight to a real spawn on win32. Two-sided per this repo's standard:
// each refusal below is paired with the SAME shape actually reaching the
// login function once the input is legitimate, so a refusal cannot be
// passing merely because the whole path is dead.
test('a bin carrying a cmd.exe metacharacter is refused before any launch is attempted', async () => {
  let launched = false;
  const { dir, ipc } = await harness({
    launchLogin: async () => { launched = true; return { ok: true, launched: true }; },
  });
  const result = await ipc.invoke('setup:login', { provider: 'claude', bin: 'claude & calc.exe' });
  assert.equal(launched, false, 'a malicious bin must never reach launchLogin');
  assert.equal(result.ok, false);
  assert.match(result.reason, /shell would interpret/);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a bin that is neither a bare command nor an existing absolute path is refused', async () => {
  let launched = false;
  const { dir, ipc } = await harness({
    launchLogin: async () => { launched = true; return { ok: true, launched: true }; },
  });
  const result = await ipc.invoke('setup:login', { provider: 'claude', bin: 'relative/path/claude' });
  assert.equal(launched, false);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not a plain command name or an absolute path/);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a bare command name (the common case) still launches', async () => {
  const calls = [];
  const { dir, ipc } = await harness({
    launchLogin: async (provider, options) => { calls.push(options); return { ok: true, launched: true, pid: 1 }; },
  });
  const result = await ipc.invoke('setup:login', { provider: 'claude', bin: 'claude' });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'claude');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('an absolute bin path to a REAL file on this machine still launches', async () => {
  const calls = [];
  // node.exe (or whatever this test runner's own executable is) is
  // guaranteed to exist, so this proves the "existing file" branch without
  // depending on any specific install.
  const realExe = process.execPath;
  const { dir, ipc } = await harness({
    launchLogin: async (provider, options) => { calls.push(options); return { ok: true, launched: true, pid: 1 }; },
  });
  const result = await ipc.invoke('setup:login', { provider: 'claude', bin: realExe });
  assert.equal(result.ok, true, result.reason);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, realExe);
  await fsp.rm(dir, { recursive: true, force: true });
});

// 2026-09-19: executablePath (what setup:preview / setup:save use) and
// validateBin (what setup:login used, unresolved) disagreed about whether an
// explicit path existed, because validateBin's own existsSync check has no
// extension resolution. A path typed WITHOUT its extension previewed and
// saved fine but dead-ended sign-in. Two-sided per this repo's standard: the
// resolved path really launches, and it launches WITH the resolved path, not
// the typed one.
test('an extensionless bin whose .exe exists resolves and launches with the RESOLVED path', async () => {
  const fixtureDir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-setup-login-bin-'));
  const exePath = path.join(fixtureDir, 'claude.exe');
  await fsp.writeFile(exePath, 'not really an executable, never run');
  const typed = path.join(fixtureDir, 'claude');

  const calls = [];
  const { dir, ipc } = await harness({
    launchLogin: async (provider, options) => { calls.push(options); return { ok: true, launched: true, pid: 1 }; },
  });
  const result = await ipc.invoke('setup:login', { provider: 'claude', bin: typed });
  assert.equal(result.ok, true, result.reason);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, exePath, 'launches with the RESOLVED absolute path, not the typed one');
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rm(fixtureDir, { recursive: true, force: true });
});

test('an absolute bin path to nothing is refused with BIN_NOT_FOUND and a non-null manual command', async () => {
  const fixtureDir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-setup-login-bin-'));
  const missing = path.join(fixtureDir, 'does-not-exist.exe');
  let launched = false;
  const { dir, ipc } = await harness({
    launchLogin: async () => { launched = true; return { ok: true, launched: true }; },
  });
  const result = await ipc.invoke('setup:login', { provider: 'claude', bin: missing });
  assert.equal(launched, false, 'a bin Harbor cannot find must never reach launchLogin');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BIN_NOT_FOUND');
  assert.equal(typeof result.manualCommand, 'string', 'never a dead end');
  assert.ok(result.manualCommand.length > 0);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rm(fixtureDir, { recursive: true, force: true });
});

// An approval (DefaultsStep.jsx "Use this path anyway", config.setup.
// executableApprovals) is a statement about SAVING the config, not a licence
// to spawn a path main cannot find, so it must not auto-launch; but it should
// no longer be told the flat "does not exist" a normal unresolved path gets.
test('an approved-but-unresolvable bin is not auto-launched, and still gets a manual command', async () => {
  const fixtureDir = await fsp.mkdtemp(path.join(realTmpDir(), 'harbor-setup-login-bin-'));
  const approvedButMissing = path.join(fixtureDir, 'moved-away.exe');
  let launched = false;
  const seed = notYetSetUp(fixtureDir);
  seed.setup.executableApprovals = { claude: approvedButMissing };
  const { dir, ipc } = await harness({
    seed,
    launchLogin: async () => { launched = true; return { ok: true, launched: true }; },
  });
  const result = await ipc.invoke('setup:login', { provider: 'claude', bin: approvedButMissing });
  assert.equal(launched, false, 'an approval to SAVE is not a licence to spawn a path main cannot find');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BIN_NOT_FOUND');
  assert.match(result.reason, /approved/i);
  assert.equal(typeof result.manualCommand, 'string');
  assert.ok(result.manualCommand.length > 0);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rm(fixtureDir, { recursive: true, force: true });
});

// 2026-09-19: a real folder can be named `R&D`. Refusing that bin stays
// correct (escaping cmd.exe correctly is how this class of bug happens), but
// the refusal must now be the helpful BIN_UNSAFE shape, not a dead end.
test('a bin with & is refused as BIN_UNSAFE, names the character, and the manual command omits the unsafe path', async () => {
  let launched = false;
  const { dir, ipc } = await harness({
    launchLogin: async () => { launched = true; return { ok: true, launched: true }; },
  });
  const unsafe = 'C:\\Users\\pat\\R&D\\claude.exe';
  const result = await ipc.invoke('setup:login', { provider: 'claude', bin: unsafe });
  assert.equal(launched, false);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BIN_UNSAFE');
  assert.ok(result.reason.includes('&'), 'the reason names the offending character');
  assert.equal(typeof result.manualCommand, 'string');
  assert.ok(!result.manualCommand.includes(unsafe), 'the manual command must not carry the unsafe path');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a UNC configHome is refused, never exported to a real spawn', async () => {
  let launched = false;
  const { dir, ipc } = await harness({
    launchLogin: async () => { launched = true; return { ok: true, launched: true }; },
  });
  const result = await ipc.invoke('setup:login', { provider: 'claude', configHome: '\\\\attacker-host\\share\\claude' });
  assert.equal(launched, false, 'a UNC configHome must never reach launchLogin');
  assert.equal(result.ok, false);
  assert.match(result.reason, /network or device path/);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a configHome outside both the home directory and the known homes is refused', async () => {
  let launched = false;
  const { dir, ipc } = await harness({
    launchLogin: async () => { launched = true; return { ok: true, launched: true }; },
  });
  // An absolute, non-UNC path that is structurally fine but has nothing to
  // do with this "user"'s home or any home Harbor detected/configured.
  const stranger = path.win32.resolve('C:\\Windows\\System32\\some-unrelated-folder');
  const result = await ipc.invoke('setup:login', { provider: 'claude', configHome: stranger });
  assert.equal(launched, false);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not one of Harbor's known config homes/);
  await fsp.rm(dir, { recursive: true, force: true });
});

// A refusal to LAUNCH is not a refusal to help. A config home on another drive
// that is not saved yet is an ordinary thing for a real user to have, and the
// first cut of this check answered it with manualCommand: null, a dead end with
// no way forward, the same shape as the executable check that could never be
// satisfied (both 2026-09-19). Main still will not spawn a login aimed at a
// folder it has no reason to trust on the renderer's word alone; the user can
// run the command themselves, which is exactly what the isolated-profile
// refusal above already does.
test('an unknown but local configHome is refused AND hands back the command to run by hand', async () => {
  let launched = false;
  const { dir, ipc } = await harness({
    launchLogin: async () => { launched = true; return { ok: true, launched: true }; },
  });
  const elsewhere = path.win32.resolve('D:\\ai\\claude-work');
  const result = await ipc.invoke('setup:login', { provider: 'claude', configHome: elsewhere });
  assert.equal(launched, false, 'main never launches it');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HOME_NOT_KNOWN');
  assert.equal(typeof result.manualCommand, 'string', 'but the user is not left with nothing');
  assert.ok(result.manualCommand.includes(elsewhere), 'and the command names the home they chose');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a network configHome gets NO command handed back, because nobody should run one', async () => {
  const { dir, ipc } = await harness({});
  const result = await ipc.invoke('setup:login', { provider: 'claude', configHome: '\\\\evil-host\\share\\home' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HOME_NOT_LOCAL');
  assert.equal(result.manualCommand, null);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a configHome under the home directory (a fresh folder-picker answer) still launches', async () => {
  const calls = [];
  const { dir, ipc } = await harness({
    launchLogin: async (provider, options) => { calls.push(options); return { ok: true, launched: true, pid: 1 }; },
  });
  // Not one of the already-saved profiles: a brand-new home the user just
  // picked in THIS wizard run, which the folder dialog can only ever return
  // as a real, absolute path, here simulated under the harness's own home.
  const freshHome = path.join(dir, '.claude-newteam');
  const result = await ipc.invoke('setup:login', { provider: 'claude', configHome: freshHome });
  assert.equal(result.ok, true, result.reason);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].configHome, freshHome);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a configHome matching an already-saved profile launches even outside the home directory', async () => {
  const calls = [];
  // Deliberately not under the harness's own homedir (a sibling temp dir, not
  // a parent of it), so this proves the "known, saved home" branch on its
  // own, independent of the "under homedir" branch.
  const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-setup-outside-'));
  const outsideHome = path.join(outsideDir, '.claude-outside');
  const seeded = notYetSetUp(outsideDir);
  seeded.profiles[0].configHome = outsideHome;
  const { dir, ipc } = await harness({
    seed: seeded,
    launchLogin: async (provider, options) => { calls.push(options); return { ok: true, launched: true, pid: 1 }; },
  });
  const result = await ipc.invoke('setup:login', { provider: 'claude', configHome: outsideHome });
  assert.equal(result.ok, true, result.reason);
  assert.equal(calls.length, 1);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rm(outsideDir, { recursive: true, force: true });
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
