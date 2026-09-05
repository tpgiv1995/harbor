'use strict';

// The wizard's main-process surface. Everything the renderer can ask for
// during setup goes through here, and nothing here invents a config format:
// the write goes to batch-7's store, which runs deriveDefaults + validateConfig
// before it touches the file, so an invalid config cannot reach disk even if
// the renderer sends one.
//
// Two guards worth naming, both of which exist because the wizard is the very
// first surface a test drive walks through and therefore the easiest place to
// escape a harness from:
//   - the folder picker is a NATIVE DIALOG, so it goes through the same
//     assertDialogAllowed the rest of the app uses. An isolated profile gets a
//     refusal, not a GNOME file chooser on the real desktop.
//   - a vendor login is a REAL LAUNCH against a REAL account, so it is handed
//     the launch policy and refuses the same way a resume does.

const path = require('node:path');
const { detectEnvironment, detectCatalog, readClaudeHome } = require('./detect.js');
const { launchLogin, loginPlan } = require('./auth.js');
const { planShared, applyShared } = require('./symlink.js');

const CHANNELS = [
  'setup:state',
  'setup:detect',
  'setup:read-home',
  'setup:catalog',
  'setup:pick-folder',
  'setup:login',
  'setup:symlink-plan',
  'setup:symlink-apply',
  'setup:preview',
  'setup:save',
];

// Whether the wizard should open at boot. Deliberately derived from the config
// the app already loaded rather than from a second file, so "has setup run" has
// exactly one answer.
function setupState(config) {
  return {
    completed: Boolean(config?.setup?.completed),
    completedAt: config?.setup?.completedAt ?? null,
    appVersion: config?.setup?.appVersion ?? null,
    // Rides along because it is the same question ("what did setup decide") and
    // the renderer needs it at boot: a user who turned orchestration OFF must not
    // be shown an Orch tab that leads to a panel with no launcher behind it. The
    // schema defaults this true, so anything but an explicit false enables it.
    orchestrationEnabled: config?.orchestration?.enabled !== false,
  };
}

function registerSetupIpc(deps = {}) {
  const {
    ipcMain,
    dialog,
    app,
    getConfig,
    saveConfig,
    assertDialogAllowed,
    launchPolicy,
    onCompleted,
  } = deps;
  if (!ipcMain) throw new TypeError('registerSetupIpc requires ipcMain');
  if (typeof getConfig !== 'function') throw new TypeError('registerSetupIpc requires getConfig()');
  if (typeof saveConfig !== 'function') throw new TypeError('registerSetupIpc requires saveConfig(next)');

  const detect = deps.detectEnvironment || detectEnvironment;
  const catalog = deps.detectCatalog || detectCatalog;
  const readHome = deps.readClaudeHome || readClaudeHome;
  const login = deps.launchLogin || launchLogin;

  const handle = (channel, handler) => {
    // Re-registering is what a re-opened wizard would do on a hot reload; drop
    // the old handler rather than throwing on a duplicate channel.
    ipcMain.removeHandler?.(channel);
    ipcMain.handle(channel, handler);
  };

  handle('setup:state', () => setupState(getConfig()));

  handle('setup:detect', async () => {
    // The CURRENT config rides along, and it is not a nicety. The wizard is
    // re-openable for the life of the install, and Finish rebuilds the config
    // from wizard state, so without a base to merge onto, re-running it to
    // change one launcher would reset every field the seven screens never ask
    // about. It also lets a re-run pre-fill from what is already saved.
    let config = null;
    try { config = getConfig(); } catch { config = null; }
    try {
      return { ok: true, detected: await detect(), config };
    } catch (error) {
      // Detection failing is survivable: the wizard falls back to manual entry
      // on every field, which is the honest-detection rule taken to its end.
      return { ok: false, reason: error.message, detected: null, config };
    }
  });

  // Re-check after a login. Reads the home's .claude.json for real rather than
  // believing the login window succeeded, because the login finishes in another
  // process and Harbor cannot see it.
  handle('setup:read-home', async (_event, { home } = {}) => {
    if (!home) return { ok: false, reason: 'no folder given' };
    return { ok: true, home: await readHome(home, require('node:fs/promises').readFile) };
  });

  // The real skills and slash commands from the homes the user just picked.
  // Called AFTER the Claude step on purpose: before it there is no home to read
  // and the answer would be an empty list dressed up as a catalogue.
  handle('setup:catalog', async (_event, { homes = [], cwd = null } = {}) => {
    try {
      return { ok: true, ...(await catalog(homes, { cwd })) };
    } catch (error) {
      return { ok: false, reason: error.message, commands: [] };
    }
  });

  handle('setup:pick-folder', async (_event, { title } = {}) => {
    // HARBOR_E2E_FAKE_DIALOG answers with the path the OS would have given, and
    // it is checked BEFORE the guard on purpose: with an answer in hand no
    // portal call happens at all, which is what makes the guard's proof
    // two-sided rather than passing because the click never reached a picker.
    const faked = process.env.HARBOR_E2E_FAKE_DIALOG;
    if (faked) return { ok: true, path: faked };
    if (typeof assertDialogAllowed === 'function') assertDialogAllowed('setup folder picker');
    const result = await dialog.showOpenDialog({
      title: title || 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths?.length) return { ok: false, canceled: true };
    return { ok: true, path: result.filePaths[0] };
  });

  handle('setup:login', async (_event, { provider, bin, configHome } = {}) => {
    if (!provider) return { ok: false, reason: 'no provider given' };
    try {
      return await login(provider, { bin, configHome }, { launchPolicy, platform: process.platform });
    } catch (error) {
      return { ok: false, launched: false, reason: error.message, manualCommand: safePlan(provider, bin, configHome) };
    }
  });

  handle('setup:symlink-plan', async (_event, payload = {}) => {
    try {
      return { ok: true, plan: await planShared(payload, {}) };
    } catch (error) {
      return { ok: false, reason: error.message, plan: null };
    }
  });

  handle('setup:symlink-apply', async (_event, { plan } = {}) => {
    if (!plan) return { ok: false, reason: 'no plan given' };
    try {
      return { ok: true, ...(await applyShared(plan, {})) };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  });

  // The review screen's source of truth. Runs the SAME derive + validate the
  // save runs, so what the user reads is what would be written, and an invalid
  // config is reported before the button rather than after it.
  handle('setup:preview', async (_event, { config } = {}) => {
    if (!config) return { ok: false, reason: 'no config given' };
    try {
      const { deriveDefaults } = require('../config/defaults.js');
      return { ok: true, config: deriveDefaults(config) };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  });

  handle('setup:save', async (_event, { config } = {}) => {
    if (!config) return { ok: false, reason: 'no config given' };
    try {
      const next = {
        ...config,
        setup: {
          ...(config.setup || {}),
          completed: true,
          completedAt: new Date().toISOString(),
          appVersion: app?.getVersion?.() ?? config.setup?.appVersion ?? null,
        },
      };
      const saved = await saveConfig(next);
      if (typeof onCompleted === 'function') onCompleted(saved);
      return { ok: true, config: saved };
    } catch (error) {
      // A validation failure is the honest outcome to surface: the schema
      // refused, and the wizard says which field rather than writing a
      // half-config and letting the next boot fail.
      return { ok: false, reason: error.message };
    }
  });

  return {
    channels: [...CHANNELS],
    dispose() {
      for (const channel of CHANNELS) ipcMain.removeHandler?.(channel);
    },
  };
}

function safePlan(provider, bin, configHome) {
  try {
    return loginPlan(provider, { bin, configHome }).display;
  } catch {
    return null;
  }
}

module.exports = { CHANNELS, registerSetupIpc, setupState };
