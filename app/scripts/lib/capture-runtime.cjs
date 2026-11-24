'use strict';

// Screenshot helpers own only harbor-* directories directly inside app/verify (or ~/harbor-capture) and child PIDs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const APP_ROOT = path.resolve(__dirname, '../..');
const VERIFY = path.join(APP_ROOT, 'verify');
// A capture whose pictures group folders by project sits in ~/harbor-capture (2026-11-24). It must be OUTSIDE any
// <drive>:\dev\<name> or ~/dev/<name> folder, because the phone folds every folder under one into that project
// (shared/project-root.cjs rule 1) and app/verify always sits inside the checkout: a phone capture there showed all six
// demo projects as one "demo" group with the capture's own path on every row. It must not be under a Temp/tmp folder
// either, because the phone hides those as scratch (shared/sidebar-model.cjs isScratchProject): "No sessions match."
// Pinned for children through CAPTURE_OUTSIDE_BASE, because a capture child's home is the root itself.
const OUTSIDE_BASE = process.env.CAPTURE_OUTSIDE_BASE || path.join(os.homedir(), 'harbor-capture');

function ownedRoot(root) {
  const target = path.resolve(root);
  const base = path.dirname(target);
  if ((base !== VERIFY && base !== OUTSIDE_BASE) || !/^harbor-[\w.-]+$/.test(path.basename(target))) {
    throw new Error(`capture root must be a harbor-* directory directly inside ${VERIFY} or ${OUTSIDE_BASE}`);
  }
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('capture root cannot be a link');
  return target;
}

function captureEnv(root, inherited = process.env) {
  const target = ownedRoot(root);
  const home = target;
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (/^(HARBOR_|CLAUDE|CODEX|CURSOR|HERDR|ANTHROPIC|OPENAI)/.test(key) || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  }
  const temp = path.join(target, 'tmp');
  fs.mkdirSync(temp, { recursive: true });
  env.CAPTURE_OUTSIDE_BASE = OUTSIDE_BASE;
  const socket = process.platform === 'win32'
    ? `\\\\.\\pipe\\harbor-shot-${crypto.createHash('sha256').update(target).digest('hex').slice(0, 18)}`
    : path.join(target, 'sessiond', 'sessiond.sock');
  return {
    ...env, HOME: home, USERPROFILE: home,
    HOMEDRIVE: path.parse(home).root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(path.parse(home).root.length - 1),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
    HARBOR_SHOT_ROOT: target,
    NODE_OPTIONS: `--require="${path.join(__dirname, 'capture-home-guard.cjs').replace(/\\/g, '/')}"`,
    APPDATA: path.join(home, 'appdata'),
    LOCALAPPDATA: path.join(home, 'localappdata'), XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'), TEMP: temp, TMP: temp, TMPDIR: temp,
    HARBOR_E2E: '1', HARBOR_E2E_FAKE_LAUNCH: '1', HARBOR_E2E_USER_DATA: path.join(target, 'userData'),
    HARBOR_USER_DATA_DIR: path.join(target, 'userData'), HARBOR_CONFIG_FILE: path.join(target, 'userData', 'config.json'),
    HARBOR_SESSIOND_DIR: path.join(target, 'sessiond'), HARBOR_SESSIOND_SOCKET: socket,
    HARBOR_CONTEXT_DIR: path.join(target, 'context'), HARBOR_ASK_DIR: path.join(target, 'asks'),
    HARBOR_TASKS_FILE: path.join(target, 'tasks.json'), HARBOR_NOTES_FILE: path.join(target, 'notes.json'),
    HARBOR_BOARDS_DIR: path.join(target, 'boards'), HARBOR_DELEGATE_STATE_DIR: path.join(target, 'delegate'),
    HARBOR_ARTIFACTS_ROOTS: path.join(target, 'projects'), HARBOR_ARTIFACTS_CACHE: path.join(target, 'cache', 'artifacts-index.json'),
    HARBOR_ARTIFACT_THUMBS_DIR: path.join(target, 'cache', 'thumbs'), HARBOR_PROJECT_ICONS_DIR: path.join(target, 'icons'),
    HARBOR_NO_DAEMON_START: '1', HARBOR_NO_VOICE: '1', HARBOR_NO_TITLER: '1', HARBOR_NO_ICON_GEN: '1',
    HARBOR_NO_USAGE_FETCH: '1', HARBOR_NO_MODEL_DISCOVERY: '1', HARBOR_NO_UPDATE_CHECK: '1',
    HARBOR_NO_SEND_LOG: '1', HARBOR_NO_PERF_LOG: '1', ELECTRON_DISABLE_GPU: '1',
    HARBOR_TAILNET_LOGINS: 'none',
    // These two read the REAL profile (os.userInfo), not HOME, because workers in
    // shadow homes write there; a relocated HOME does not move them, only these do.
    HARBOR_TEAM_LAUNCHES_FILE: path.join(target, 'team-launches.jsonl'), HARBOR_LANES_DIR: path.join(target, 'lanes'),
    // The Team chart reads the machine's process table, which no HOME isolates.
    HARBOR_TEAM_NO_PROCESS_SCAN: '1',
  };
}

function underDisplay(script, screen) {
  if (process.env.HARBOR_SHOT_HEADED === '1') throw new Error('Published captures are hidden only');
  if (process.platform !== 'linux' || process.env.HARBOR_SHOT_INNER) return;
  const result = spawnSync('env', ['-u', 'DISPLAY', '-u', 'WAYLAND_DISPLAY', '-u', 'DBUS_SESSION_BUS_ADDRESS',
    'xvfb-run', '-a', `--server-args=-screen 0 ${screen}x24`, process.execPath, script], {
    cwd: APP_ROOT, env: { ...process.env, HARBOR_SHOT_INNER: '1' }, stdio: 'inherit', timeout: 300000, windowsHide: true,
  });
  process.exit(result.status ?? 1);
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function stopChild(child) {
  if (!child?.pid) return;
  const pid = child.pid;
  if (child.exitCode === null && alive(pid)) child.kill();
  for (let n = 0; n < 40 && alive(pid); n += 1) await new Promise(r => setTimeout(r, 100));
  if (alive(pid)) {
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000, stdio: 'ignore' });
    else child.kill('SIGKILL');
  }
  for (let n = 0; n < 30 && alive(pid); n += 1) await new Promise(r => setTimeout(r, 100));
  if (alive(pid)) throw new Error(`owned child ${pid} survived teardown`);
  console.log(`owned child ${pid} confirmed dead`);
}

async function closeApp(app) {
  if (!app) return;
  // process() throws once Playwright has lost the app (it crashed or never
  // finished connecting). Teardown must not throw then: an error here replaces
  // the failure that actually stopped the capture.
  let child = null;
  try { child = app.process(); } catch (error) { console.log(`app connection already gone at teardown: ${error.message}`); }
  await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
  if (child) await stopChild(child);
}

async function assertHidden(app) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focused: w.isFocused() })));
  if (!windows.length || windows.some(w => w.visible || w.focused)) throw new Error('capture needs at least one hidden, unfocused window');
  console.log(`hidden windows verified: ${JSON.stringify(windows)}`);
}

function reportIsolation(root) {
  const target = ownedRoot(root);
  for (const name of fs.readdirSync(target).filter(name => /^capture-proof-\d+\.json$/.test(name))) {
    const proof = JSON.parse(fs.readFileSync(path.join(target, name), 'utf8'));
    console.log(`capture isolation: ${JSON.stringify(proof)}`);
    if (proof.blocked.length) throw new Error('capture attempted a read outside its isolated home');
  }
}

module.exports = { APP_ROOT, VERIFY, OUTSIDE_BASE, ownedRoot, captureEnv, underDisplay, stopChild, closeApp, assertHidden, reportIsolation,
  hiddenMain: path.join(__dirname, 'hidden-electron.cjs') };
