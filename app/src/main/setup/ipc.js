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

const os = require('node:os');
const path = require('node:path');
const { detectEnvironment, detectCatalog, readClaudeHome } = require('./detect.js');
const { launchLogin, loginPlan, isSafeConfigHome, validateBin, CMD_METACHARACTERS } = require('./auth.js');
const { planShared, applyShared } = require('./symlink.js');
const { validateProviderExecutables, executablePath } = require('./executables.js');
const { deriveDefaults } = require('../config/defaults.js');

// The homes Harbor itself has reason to trust, gathered fresh for every
// setup:login call rather than cached: a saved profile (an existing
// install's `config.profiles`) plus whatever the SAME detection setup:detect
// already runs (existing Claude/codex/cursor homes actually found on disk).
// Detection failing here is survivable exactly like it is in setup:detect;
// it just means fewer homes are pre-approved, never a crash.
async function knownConfigHomes({ getConfig, detect }) {
  const homes = [];
  try {
    const config = getConfig();
    for (const profile of config?.profiles || []) {
      if (profile?.configHome) homes.push(profile.configHome);
    }
  } catch { /* no config yet: nothing saved to allow */ }
  try {
    const detected = await detect();
    for (const home of detected?.claudeHomes || []) {
      if (home?.path) homes.push(home.path);
    }
    if (detected?.providers?.codex?.home) homes.push(detected.providers.codex.home);
    if (detected?.providers?.cursor?.home) homes.push(detected.providers.cursor.home);
  } catch { /* detection failing is survivable here too */ }
  return homes;
}

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
    // Injectable so a test can point the configHome "is this under the
    // user's home directory" check at a throwaway directory instead of the
    // real machine's home. A real caller never passes this.
    homedir = os.homedir,
    platform = process.platform,
  } = deps;
  if (!ipcMain) throw new TypeError('registerSetupIpc requires ipcMain');
  if (typeof getConfig !== 'function') throw new TypeError('registerSetupIpc requires getConfig()');
  if (typeof saveConfig !== 'function') throw new TypeError('registerSetupIpc requires saveConfig(next)');

  const detect = deps.detectEnvironment || detectEnvironment;
  const catalog = deps.detectCatalog || detectCatalog;
  const readHome = deps.readClaudeHome || readClaudeHome;
  const login = deps.launchLogin || launchLogin;
  const checkExecutables = deps.validateProviderExecutables || validateProviderExecutables;
  // The SAME resolver setup:preview / setup:save trust (2026-09-19), so
  // setup:login can stop disagreeing with them about whether an explicit path
  // exists. Injectable only so a test could stub it; a real caller never does.
  const resolveBinPath = deps.executablePath || executablePath;

  const handle = (channel, handler) => {
    // Re-registering is what a re-opened wizard would do on a hot reload; drop
    // the old handler rather than throwing on a duplicate channel.
    ipcMain.removeHandler?.(channel);
    ipcMain.handle(channel, channel === 'setup:login' ? async (...args) => {
      const result = await handler(...args);
      return result.manualCommand
        ? { ...result, manualCommandLabel: platform === 'win32' ? 'PowerShell command' : 'Shell command' }
        : result;
    } : handler);
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
    const manualPlan = (id, command, home) => safePlan(id, command, home, platform);
    // The renderer is untrusted, so `bin` is resolved and refused
    // HERE, before `login()` is ever called, not just inside it. loginPlan
    // (auth.js) runs its own validateBin unconditionally too (belt and
    // suspenders for any future caller that reaches loginPlan some other way),
    // but doing the real work here means an invalid bin never even reaches a
    // real terminalPlan/spawn attempt.
    //
    // 2026-09-19: validateBin's own existence check on an absolute path
    // is a bare existsSync with no extension resolution, so a path typed
    // WITHOUT its extension (`C:\tools\claude` when only `claude.exe` exists)
    // failed it even though executablePath - what setup:preview/setup:save
    // actually check - resolves it fine and it launches through cmd.exe
    // without complaint. That disagreement dead-ended sign-in for a path that
    // previewed and saved cleanly. An absolute bin now gets a second chance
    // through the SAME resolver setup:preview/setup:save trust, so sign-in and
    // save can never again disagree about whether a path exists, and it
    // launches with the RESOLVED path.
    let loginBin = bin;
    let binRefusal = null;

    if (bin && CMD_METACHARACTERS.test(String(bin))) {
      // a real folder can be named `R&D`. Refusing it stays correct
      // (escaping cmd.exe correctly is how this class of bug happens), but a
      // command BUILT FROM that path would itself be unsafe to paste, so the
      // way forward is the provider's own plain command, not the offending
      // one.
      binRefusal = {
        code: 'BIN_UNSAFE',
        reason: `"${bin}" contains a character a shell would interpret; sign in from a terminal with the plain command below instead.`,
        manualCommand: manualPlan(provider, undefined, configHome),
      };
    } else if (bin && path.isAbsolute(String(bin))) {
      const resolved = await resolveBinPath(bin, { platform });
      if (resolved) {
        loginBin = resolved;
      } else {
        // Genuinely not found, even with extension resolution. "Use this path
        // anyway" (DefaultsStep.jsx, config.setup.executableApprovals) is a
        // statement about SAVING the config, not a licence for main to spawn a
        // path it still cannot find, so an approval still does not
        // auto-launch here; it only upgrades the refusal from a flat "does
        // not exist" to an honest explanation, and still hands back a command
        // to run by hand rather than nothing.
        let config = null;
        try { config = getConfig(); } catch { config = null; }
        const approved = config?.setup?.executableApprovals?.[provider] === bin;
        binRefusal = {
          code: 'BIN_NOT_FOUND',
          reason: approved
            ? `"${bin}" was approved to finish setup, but Harbor still cannot find it to launch a sign-in from here. Sign in from a terminal with the command below instead.`
            : `"${bin}" does not exist on this machine.`,
          manualCommand: manualPlan(provider, bin, configHome),
        };
      }
    } else {
      // A bare command name (resolved by PATH lookup at spawn time, same as
      // leaving it unset) or a relative/otherwise malformed value: the shape
      // check is unchanged from before this fix.
      const shapeCheck = validateBin(bin);
      if (!shapeCheck.ok) {
        binRefusal = {
          code: 'BIN_NOT_FOUND',
          reason: shapeCheck.reason,
          manualCommand: manualPlan(provider, bin, configHome),
        };
      }
    }

    if (binRefusal) return { ok: false, launched: false, ...binRefusal };

    // Defense in depth: whatever loginBin ended up being (the original value
    // or the resolved absolute path), the SAME safety check runs once more
    // before it is ever exported to a real spawn. Nothing about resolution or
    // an approval may loosen it.
    const finalCheck = validateBin(loginBin);
    if (!finalCheck.ok) {
      return {
        ok: false,
        launched: false,
        code: 'BIN_UNSAFE',
        reason: `${finalCheck.reason}. Sign in from a terminal with the plain command below instead.`,
        manualCommand: manualPlan(provider, undefined, configHome),
      };
    }

    // configHome's CONTEXTUAL check (is this a home Harbor actually knows
    // about, not just a well-shaped local path) needs the saved/detected
    // homes only this handler has to hand, so it runs here, BEFORE
    // configHome is ever exported as CLAUDE_CONFIG_DIR/CODEX_HOME to a real
    // spawned process.
    if (configHome) {
      const verdict = isSafeConfigHome(configHome, {
        homedir: homedir(),
        platform,
        allowedHomes: await knownConfigHomes({ getConfig, detect }),
      });
      // A refusal to LAUNCH is not a refusal to help. An unknown but local home
      // gets the command to run by hand, exactly as the isolated-profile refusal
      // does; a network or device path gets nothing, because nobody should run it.
      if (!verdict.ok) {
        return {
          ok: false,
          launched: false,
          code: verdict.code,
          reason: verdict.reason,
          manualCommand: verdict.code === 'HOME_NOT_KNOWN' ? manualPlan(provider, loginBin, configHome) : null,
        };
      }
    }
    try {
      return await login(provider, { bin: loginBin, configHome }, { launchPolicy, platform });
    } catch (error) {
      return { ok: false, launched: false, reason: error.message, manualCommand: manualPlan(provider, loginBin, configHome) };
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
      const next = deriveDefaults(config);
      await checkExecutables(next);
      return { ok: true, config: next };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  });

  handle('setup:save', async (_event, { config } = {}) => {
    if (!config) return { ok: false, reason: 'no config given' };
    try {
      // A valid preview can go stale if the executable moves before Finish.
      await checkExecutables(deriveDefaults(config));
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

function safePlan(provider, bin, configHome, platform) {
  try {
    return loginPlan(provider, { bin, configHome }, { platform }).display;
  } catch {
    // A bin that cannot even build a plan (unsafe, malformed, or resolved to
    // nothing) must not leave the caller with an empty manualCommand: fall
    // back to the provider's own plain command, which is always safe to build
    // and always correct, rather than dead-ending (2026-09-19).
    if (bin === undefined) return null;
    try {
      return loginPlan(provider, { configHome }, { platform }).display;
    } catch {
      return null;
    }
  }
}

module.exports = { CHANNELS, registerSetupIpc, setupState };
