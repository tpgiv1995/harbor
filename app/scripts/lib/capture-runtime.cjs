'use strict';

// Screenshot helpers own only app/verify/harbor-* directories and child PIDs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const APP_ROOT = path.resolve(__dirname, '../..');
const VERIFY = path.join(APP_ROOT, 'verify');

function ownedRoot(root) {
  const target = path.resolve(root);
  if (path.dirname(target) !== VERIFY || !/^harbor-[\w.-]+$/.test(path.basename(target))) {
    throw new Error(`capture root must be a harbor-* directory directly inside ${VERIFY}`);
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
  const child = app.process();
  await Promise.race([app.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
  await stopChild(child);
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

module.exports = { APP_ROOT, VERIFY, ownedRoot, captureEnv, underDisplay, stopChild, closeApp, assertHidden, reportIsolation,
  hiddenMain: path.join(__dirname, 'hidden-electron.cjs') };
