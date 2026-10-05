'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHistoryIndex } = require('../app/src/main/providers/history-index.js');
const { SessionClient } = require('../app/src/daemon/client.js');
const { defaultConfigFile } = require('../app/src/shared/tasks-file.cjs');

const BIN_DIR = __dirname;
const ROOT = path.dirname(BIN_DIR);

// THE CLI READS THE CONFIG THE APP WROTE, and until 2026-08-07 it only read one
// the caller had pointed it at by hand. `HARBOR_CONFIG_FILE` is set by nothing:
// not by the app when it shells out to these scripts, and not by a human running
// `hist` in a terminal. So every ordinary invocation ran with `config = {}`,
// which meant the wizard's profiles were silently ignored by exactly the tools
// this project calls its reusable organs, and the session index fell through to
// a guess about which config homes exist.
//
// `defaultConfigFile` is the SAME rule `shared/tasks-file.cjs` already uses to
// find Harbor's userData without Electron, so the CLI and the app cannot resolve
// two different files. The env var stays as the override, which is what a
// harness needs and what the old code mistook for the only path.
function configSnapshot() {
  const file = defaultConfigFile();
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* derived defaults below */ }
  return {};
}

function runtime() {
  const config = configSnapshot();
  const home = os.homedir();
  return {
    config,
    home,
    cacheDir: config.paths?.cacheDir || path.join(home, '.cache', 'harbor'),
    projectsDir: config.paths?.projectsDir || path.join(home, '.claude', 'projects'),
    binDir: config.paths?.binDir || path.join(home, '.local', 'bin'),
  };
}

// THE CLAUDE LAUNCHER SHIPS WITH HARBOR, and until 2026-08-07 it did not.
//
// Every claude launch and every claude resume composed `['claude-go', ...]`, a
// 40-line bash wrapper that lived on the author's PATH and in no repository.
// A stranger who followed the README to the letter got a fully rendered app
// whose first `+ New session` click died on ENOENT, and the only place that was
// written down told their coding agent to "write the equivalent, or change
// bin/harbor-bin.cjs". Shipping an app whose core action requires the user to
// patch it is not an install.
//
// The wrapper did exactly three things and all three are portable Node:
// choose the config home, pre-accept the per-folder trust dialog in THAT home,
// exec `claude --dangerously-skip-permissions`. They are done here now, so the
// per-account flags it invented, one literal flag per account, have nothing left
// to do and are gone: an account is a config home, and a config home is a path.
//
// The binary for a provider comes from the user's own config. The wizard has
// always offered an editable path for codex and cursor and the launcher never
// read it, so a user whose binary is not on PATH under the exact expected name
// filled in a field that did nothing. `HARBOR_<PROVIDER>_BIN` outranks the
// config so a harness never has to rewrite somebody's config file.
const PROVIDER_FALLBACK_BIN = { claude: 'claude', codex: 'codex', cursor: 'cursor-agent' };

function providerBin(provider) {
  const fromEnv = process.env[`HARBOR_${provider.toUpperCase()}_BIN`];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const configured = runtime().config.providers?.[provider]?.bin;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  return PROVIDER_FALLBACK_BIN[provider] || provider;
}

function claudeBin() {
  return providerBin('claude');
}

// Where the CLI keeps `projects`, which is where folder trust is recorded.
// `CLAUDE_CONFIG_DIR/.claude.json` when that variable is set, `$HOME/.claude.json`
// when it is not. The old wrapper picked this from its own FLAG rather than from
// the environment, which is why it wrote personal-account trust into
// `$HOME/.claude.json` while Harbor had already pointed the child at
// `~/.claude`: measured on the author's own machine, the folder read
// `hasTrustDialogAccepted: true` in the file the session was not reading and
// `false` in the one it was.
function claudeConfigFile(configHome) {
  return configHome
    ? path.join(configHome, '.claude.json')
    : path.join(os.homedir(), '.claude.json');
}

// Claude Code asks "do you trust the files in this folder?" the first time it
// runs in a directory. Harbor launches into a pty whose window may not be on
// screen yet, so that dialog is an invisible blocker on the one action the user
// just asked for. Pre-accepting it is strictly weaker than the
// `--dangerously-skip-permissions` the launch already carries, and the folder is
// one the user picked by hand. `HARBOR_NO_TRUST_PREACCEPT=1` turns it off.
//
// Never destructive: an unparseable config is left alone (a trust prompt is a
// far better outcome than a clobbered 100KB config), an already-trusted folder
// is not rewritten, the write is tmp+rename so a reader can never see a half
// file, and a symlinked config is written THROUGH rather than replaced.
//
// AND IT IS THE ONE THING IN bin/ THAT WRITES INTO A CONFIG HOME, so it refuses
// under the harness marker. Four separate incidents in this repo were a drive
// reaching real user state through a channel nobody isolated ($HOME, the session
// bus, a systemd unit name, a cache dir); a suite that shells `bin/ai` for its
// argv must not be able to edit the developer's own `.claude.json` as a side
// effect. Unit tests reach this file through HARBOR_AI_DRY_RUN, which returns
// before the launch entirely; HARBOR_E2E covers the gate, which does not.
//
// A CROSS-PROCESS LOCK, because read-modify-write on a shared file is a lost
// update waiting to happen and this one is shared by construction: launching
// two sessions on the same account at once, which is the ordinary case here
// (the rail's per-project buttons, a delegate worker fleet, an orchestration
// batch), has both processes read the same `.claude.json`, add a different
// project, and the second rename to win silently discards the first. Reproduced:
// two launches into different folders under one config home left ONE trust
// entry on disk while both calls returned success, so the launch that lost sat
// on the trust dialog inside a pty nobody was watching, which is the exact
// failure this function exists to prevent.
//
// An atomic `mkdir` is the lock, the same mechanism `providers/tasks.js` uses
// for the same reason. It is BEST EFFORT: a stale lock expires, and a lock that
// cannot be taken at all falls through to the write rather than refusing, since
// a missed trust marker is a prompt and a refusal to launch is worse.
const TRUST_LOCK_STALE_MS = 15_000;

function withTrustLock(file, work) {
  const lock = `${file}.harbor-lock`;
  let held = false;
  // The lock lives beside the config, so its directory has to exist before the
  // lock can. On a brand-new config home it does not, `mkdirSync(lock)` fails
  // ENOENT rather than EEXIST, and the loop below would fall straight through to
  // an UNLOCKED write: correct once, and a race the very first time two launches
  // into a fresh account happen together.
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* the write reports it */ }
  for (let attempt = 0; attempt < 50 && !held; attempt += 1) {
    try {
      fs.mkdirSync(lock);
      held = true;
    } catch (error) {
      if (error.code !== 'EEXIST') break;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > TRUST_LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
      } catch { /* raced away, try again */ }
      // Busy-wait briefly: this is a sub-millisecond critical section and the
      // caller is about to spawn a process, so a short spin beats async plumbing.
      const until = Date.now() + 10;
      while (Date.now() < until) { /* spin */ }
    }
  }
  try {
    return work();
  } finally {
    if (held) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* gone already */ } }
  }
}

// The CLI keys `projects` by the cwd path, and 2.1.229 changed that key to
// FORWARD slashes on Windows (`C:/dev/x`, verified empirically: a fresh accept
// creates the forward-slash entry, and a backslash entry holding
// `hasTrustDialogAccepted: true` is simply never read, which is how every
// folder Pat had already trusted re-prompted after the CLI auto-updated,
// 2026-08-13). Trust is written under BOTH spellings: the forward-slash key is
// the one current CLIs read, the backslash key keeps a not-yet-updated CLI
// working, and an extra never-read entry is inert. The same first-run flow
// also carries the bypass-permissions acceptance, so a pre-seeded entry
// suppresses both dialogs (proven: same scratch home + folder, seeded entry,
// second launch lands on the composer with zero dialogs).
function trustKeysFor(cwd) {
  const keys = [cwd];
  if (process.platform === 'win32') {
    const forward = cwd.replace(/\\/g, '/');
    if (forward !== cwd) keys.push(forward);
  }
  return keys;
}

function preacceptFolderTrust(configHome, cwd) {
  if (process.env.HARBOR_NO_TRUST_PREACCEPT === '1') return false;
  if (process.env.HARBOR_E2E === '1') return false;
  if (!cwd || !path.isAbsolute(cwd)) return false;
  const file = claudeConfigFile(configHome);
  return withTrustLock(file, () => {
    // Read INSIDE the lock. Reading outside it is the lost update.
    let data;
    let mode = 0o600;
    // A config home whose `.claude.json` is a symlink (a dotfiles setup, say)
    // must keep being that symlink: renaming over a link replaces the LINK and
    // leaves the real file behind, diverged and stale. Resolve first, and keep
    // whatever permissions the file already had.
    let target = file;
    try {
      target = fs.realpathSync(file);
      mode = fs.statSync(target).mode & 0o777;
    } catch { /* absent: the defaults above are right */ }
    try {
      data = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') return false;
      data = {};
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    if (!data.projects || typeof data.projects !== 'object' || Array.isArray(data.projects)) data.projects = {};
    let wrote = false;
    for (const key of trustKeysFor(cwd)) {
      if (!data.projects[key] || typeof data.projects[key] !== 'object') data.projects[key] = {};
      if (data.projects[key].hasTrustDialogAccepted === true) continue;
      data.projects[key].hasTrustDialogAccepted = true;
      wrote = true;
    }
    if (!wrote) return false;
    const tmp = `${target}.harbor-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
      fs.renameSync(tmp, target);
      return true;
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
      return false;
    }
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout,
    cwd: options.cwd,
    env: options.env || process.env,
    input: options.input,
    stdio: options.stdio,
  });
  // A timeout is returned to the caller as a nonzero result. Every other spawn
  // error still throws because it is a broken invocation, not a deadline.
  if (result.error && result.error.code !== 'ETIMEDOUT') throw result.error;
  return result;
}

function resolveSessionBackend(env = process.env) {
  const value = String(env.HARBOR_SESSION_BACKEND || 'sessiond').trim().toLowerCase();
  if (value === 'herdr') {
    throw new Error('HARBOR_SESSION_BACKEND=herdr is no longer supported because the Herdr backend was retired; use sessiond');
  }
  if (value !== 'sessiond') throw new Error(`HARBOR_SESSION_BACKEND must be sessiond, got ${value}`);
  return 'sessiond';
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=+-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function commandString(argv) {
  return argv.map(shellQuote).join(' ');
}

function cleanDaemonEnv() {
  const { home } = runtime();
  const env = {
    HOME: home,
    USER: process.env.USER || process.env.USERNAME || path.basename(home),
    LOGNAME: process.env.LOGNAME || process.env.USER || process.env.USERNAME || path.basename(home),
    LANG: process.env.LANG || 'en_US.UTF-8',
    // The allowlist exists to keep a launching SESSION's ids and API keys out
    // of the children; PATH is not a secret, and a hand-built PATH is a trap.
    // On Windows the five-entry list below carried no nodejs dir and no npm
    // dir, so inside every Harbor-spawned session the statusline command
    // (`node .../statusline-command.js`) could not resolve `node`: no context
    // tee, no usage tee, meters frozen at their boot values, and no session
    // could ever show a context percentage (live-caught 2026-08-12). `git`,
    // `npm` and every other user tool were equally unresolvable in the
    // session's own shell. The user's PATH travels whole on win32; POSIX keeps
    // the proven fixed list.
    PATH: process.platform === 'win32'
      ? (process.env.PATH || [
        path.dirname(process.execPath),
        process.env.SystemRoot,
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
      ].filter(Boolean).join(path.delimiter))
      : [
        path.join(home, '.local', 'bin'),
        path.join(home, '.npm-global', 'bin'),
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
      ].join(path.delimiter),
  };
  if (process.platform === 'win32') {
    // USERPROFILE included: bin/harbor-sessiond's sibling of this allowlist
    // always carried it, and this one missing it is exactly the missed-sibling
    // shape that file documents.
    for (const key of ['SystemRoot', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE',
      'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'PUBLIC', 'COMPUTERNAME', 'USERDOMAIN',
      'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'windir', 'HOMEDRIVE', 'HOMEPATH']) {
      if (process.env[key]) env[key] = process.env[key];
    }
  } else {
    env.SHELL = process.env.SHELL || '/bin/bash';
    env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
    for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY']) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  return env;
}

function sessiondChildEnv(sourceEnv = process.env) {
  const env = cleanDaemonEnv();
  if (sourceEnv.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = sourceEnv.CLAUDE_CONFIG_DIR;
  if (sourceEnv.CODEX_HOME) env.CODEX_HOME = sourceEnv.CODEX_HOME;
  return env;
}

async function spawnSessiond({ argv, cwd, env, agent, agentSession }) {
  const client = new SessionClient({ socketPath: process.env.HARBOR_SESSIOND_SOCKET });
  try {
    return await client.request('spawn', {
      argv,
      cwd,
      env: sessiondChildEnv(env),
      cols: 120,
      rows: 60,
      agent,
      agent_session: agentSession || null,
    });
  } finally {
    client.close();
  }
}

// Who owns the systemd unit (live-caught 2026-07-29). The default unit belongs
// to the REAL herdr installation, and `startClean` manages it by STOPPING it
// first, which kills its whole cgroup: the daemon, every pane it forked and
// every claude session in them. app/test/bin/herdr-wedge-recovery.test.js
// isolated the herdr binary, the config dir, the log and the timeouts but not
// the unit NAME, so every run stopped Pat's live daemon and Harbor's watchdog
// recovered behind it; 160 stub dirs in /tmp meant 160 of those, eight of them
// inside twenty-two minutes while he was working. Isolating the parts you
// thought of is not isolation, so the floor lives here rather than in each
// harness: a run that relocated the herdr BINARY or CONFIG DIR is by definition
// not the real installation, and the default unit is not its unit to touch. It
// falls back to the detached spawn, exactly what HERDR_NO_SYSTEMD_UNIT=1
// already does, so the worst case is the pre-2026-07-28 behaviour. Naming a
// unit with HARBOR_HERDR_UNIT is the escape, and it is the harness's business
// which name it picks.
function resolveUnitPolicy(env = process.env) {
  const named = env.HARBOR_HERDR_UNIT;
  const unit = named || 'herdr-daemon';
  if (process.platform !== 'linux') return { unit, mayManage: false, reason: 'not linux' };
  if (env.HERDR_NO_SYSTEMD_UNIT === '1') return { unit, mayManage: false, reason: 'opted out' };
  if (named) return { unit, mayManage: true, reason: 'named explicitly' };
  if (env.HARBOR_HERDR_BIN || env.HARBOR_HERDR_DIR) {
    return { unit, mayManage: false, reason: 'relocated herdr may not manage the default unit' };
  }
  // An overridden HOME is the same relocation wearing a different hat, and it
  // is the one a cold-start drive uses: the herdr dir is derived from
  // os.homedir(), so a throwaway HOME moves the sockets and the session.json
  // while leaving the unit NAME pointing at the real daemon. os.userInfo()
  // reads the passwd entry and ignores $HOME, so the two disagreeing is an
  // exact test for "someone moved HOME under us".
  try {
    if (os.homedir() !== os.userInfo().homedir) {
      return { unit, mayManage: false, reason: 'relocated HOME may not manage the default unit' };
    }
  } catch { /* no passwd entry to compare against: fall through to the default */ }
  return { unit, mayManage: true, reason: 'real installation' };
}

// A BARE PROVIDER NAME ON WINDOWS IS A SHELL NAME, and sessiond has no shell
// (2026-09-25). The keeper hands argv[0] to node-pty, whose CreateProcess runs
// PE binaries only: `codex` from npm is `codex.cmd` (plus an extensionless sh
// script and a .ps1), so every codex pane Harbor tried to open died with
// "Cannot create process, error code: 2" (reproduced against the daemon's own
// node-pty). Claude only ever worked because the wizard saves the full
// claude.exe path. This resolves the name the way a shell would (PATH x
// PATHEXT) and runs what the shim itself runs: a native .exe directly, or
// `node <script>` for an npm cmd-shim, so the arguments cross CreateProcess
// with exact quoting and never pass through cmd.exe, which would reinterpret
// a prompt's & | < > ^ %. Cursor's two-hop launcher is resolved too (see
// cursorHandoffLaunch); a shim of any other shape is left exactly as it was:
// no answer beats a wrong one.
const NPM_SHIM_TARGET_RE = /"%dp0%\\([^"%]+\.(?:exe|[cm]?js))"\s+%\*/i;

// CURSOR'S LAUNCHER IS A TWO-HOP HANDOFF (2026-09-26, the cursor 2026.09.26
// review). cursor-agent.cmd runs `powershell -File cursor-agent.ps1 %*`, and the
// .ps1 runs versions\<newest>\node.exe versions\<newest>\index.js $args. Neither
// hop can start under sessiond (CreateProcess runs PE files only, so a bare
// `cursor-agent` never opened a pane on Windows), and an explicit .cmd path
// sends a prompt through cmd.exe and then PowerShell 5.1's native-argument
// quoting, which splits an argument that holds a double quote. So a launch runs
// the second hop's target directly, from the version folder the .ps1 picks: the
// newest by the DATE in its name (Parse-VersionString), never by mtime. The one
// thing the direct start drops is CURSOR_INVOKED_AS, which only gates a one-time
// "you can also type `agent`" tip; the in-use marker cursor's updater honours
// (versions\<v>\.running) is written by index.js itself.
const CURSOR_HANDOFF_RE = /-File\s+"%SCRIPT_DIR%\\([^"%\\]+\.ps1)"\s+%\*/i;
const CURSOR_VERSION_DIR_RE = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/i;

function cursorRuntime(dir) {
  const node = path.join(dir, 'node.exe');
  const index = path.join(dir, 'index.js');
  return isFile(node) && isFile(index) ? [node, index] : null;
}

function cursorHandoffLaunch(shim, text, rest) {
  const handoff = CURSOR_HANDOFF_RE.exec(text);
  const root = path.dirname(shim);
  if (!handoff || !isFile(path.join(root, handoff[1]))) return null;
  // The .ps1's first branch: a launcher sitting inside a version folder runs
  // the node.exe beside it.
  const beside = cursorRuntime(root);
  if (beside) return [...beside, ...rest];
  let names = [];
  try {
    names = fs.readdirSync(path.join(root, 'versions'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch { return null; }
  const dated = [];
  for (const name of names) {
    const m = CURSOR_VERSION_DIR_RE.exec(name);
    if (m) dated.push({ name, date: Number(`${m[1]}${m[2].padStart(2, '0')}${m[3].padStart(2, '0')}`) });
  }
  // Same date: the later build string, the only order two same-day builds have.
  dated.sort((a, b) => b.date - a.date || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  // A folder still being extracted (cursor self-updates in the background) has
  // no runtime yet; the newest COMPLETE one is a real install, not a guess.
  for (const { name } of dated) {
    const runtime = cursorRuntime(path.join(root, 'versions', name));
    if (runtime) return [...runtime, ...rest];
  }
  return null;
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function findOnPath(name, env, exts, delimiter = ';') {
  for (const dir of String(env.PATH || env.Path || '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

// An EXPLICIT path is the user's call, with one exception, because it is what
// the setup wizard itself saves: detection resolves over PATHEXT and stores
// `...\npm\codex.cmd`. CreateProcess quietly runs a .cmd through cmd.exe, where
// a prompt argument holding `& echo x` ran as a second command (review-caught
// 2026-09-25). So an explicit npm cmd-shim (or an extensionless path whose .cmd
// sibling is one) gets the same node <script> rewrite as a bare name, and an
// explicit cursor-agent.cmd the same handoff resolution.
function resolveWindowsLaunch(argv, { platform = process.platform, env = process.env } = {}) {
  const [bin, ...rest] = argv;
  if (platform !== 'win32' || !bin || /\.(exe|com)$/i.test(bin)) return argv;
  let found;
  if (/[\\/]/.test(bin)) {
    if (/\.cmd$/i.test(bin)) found = bin;
    else if (!path.extname(bin) && isFile(`${bin}.cmd`)) found = `${bin}.cmd`;
    else return argv;
  } else {
    const exts = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => ext.toLowerCase());
    found = findOnPath(bin, env, exts);
    if (!found) return argv;
    if (/\.(exe|com)$/i.test(found)) return [found, ...rest];
  }
  if (!/\.cmd$/i.test(found)) return argv;
  let text = '';
  try { text = fs.readFileSync(found, 'utf8'); } catch { return argv; }
  const match = NPM_SHIM_TARGET_RE.exec(text);
  if (!match) return cursorHandoffLaunch(found, text, rest) || argv;
  const target = path.join(path.dirname(found), match[1]);
  if (!isFile(target)) return argv;
  if (/\.exe$/i.test(target)) return [target, ...rest];
  // The shim prefers a node.exe beside itself, then node on PATH; so does this.
  const node = isFile(path.join(path.dirname(found), 'node.exe'))
    ? path.join(path.dirname(found), 'node.exe')
    : findOnPath('node', env, ['.exe']);
  return node ? [node, target, ...rest] : argv;
}

// CODEX PANE CONTROLS (2026-09-25, the 0.157.0 review). Three codex defaults
// changed under a pane Harbor owns, each pinned here per launch and per resume:
//
// - 0.157.0 turns `daemon_auto_start` on. A plain launch then COPIES the codex
//   package into $CODEX_HOME/packages/app-server-daemon and runs the thread
//   inside a detached shared server that outlives the pane, keeps that copied
//   version after npm moves codex on, and can carry an updater loop. Harbor's
//   model is one pane, one process, one thread, and its rule is that no CLI
//   updates itself, so every pane runs `--no-daemon` (which also refuses to
//   ATTACH to a server something else started).
// - 0.157.0 flips `tui.fullscreen_transcript` to true: the TUI owns the whole
//   alternate screen and the mouse. Harbor's raw-terminal view and screen reads
//   were proven against the inline transcript 0.156.0 drew, so that stays.
// - Its catalog puts an `upgrade` on gpt-5.5 and every gpt-5.6 model, and the
//   TUI opens a model-migration screen at startup (new AND resumed sessions)
//   for any model that has one. That screen drops pasted text and takes Enter
//   as "Try new model", which switches the session AND writes `model = ...`
//   into config.toml: a Harbor send into it loses the message and silently
//   changes the home's default. Each pair the launch home's own
//   models_cache.json lists is acknowledged for this process only (nothing is
//   persisted), which is what "Use existing model" does minus the config write.
//
// `--no-daemon` and the transcript key exist from 0.156.0; an older codex
// rejects an unknown flag outright, so both need a KNOWN version at least that.
// An unreadable version adds neither: a launch that works beats a pinned one
// that cannot start. HARBOR_CODEX_VERSION pins the answer for harnesses.
const CODEX_PANE_CONTROLS_SINCE = [0, 156, 0];
const CODEX_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function parseSemver(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  return match ? match.slice(1, 4).map(Number) : null;
}

function semverAtLeast(version, floor) {
  if (!version) return false;
  for (let i = 0; i < floor.length; i += 1) {
    if (version[i] !== floor[i]) return version[i] > floor[i];
  }
  return true;
}

// The version is READ OFF DISK when the binary is the npm package (the same rule
// cli-updates.js keeps: installed versions come from package.json, not from
// running the CLI), so a launch pays a file read, not a cold node + native start.
// Only a codex that is not the npm package (a standalone install, an explicit
// .exe) is asked `--version`, with a short deadline: a hung probe must not hold a
// pane open for long, and no answer only means no pins.
function codexPackageVersion(bin, env) {
  let script = null;
  if (process.platform === 'win32') {
    const launch = resolveWindowsLaunch([bin], { env });
    script = launch.length === 2 && /\.[cm]?js$/i.test(launch[1]) ? launch[1] : null;
  } else {
    const found = /[\\/]/.test(bin) ? bin : findOnPath(bin, env, [''], ':');
    try { script = found ? fs.realpathSync(found) : null; } catch { script = null; }
  }
  if (!script || path.basename(path.dirname(script)) !== 'bin') return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(script)), 'package.json'), 'utf8'));
    return pkg?.name === '@openai/codex' ? parseSemver(pkg.version) : null;
  } catch {
    return null;
  }
}

function codexCliVersion(bin, env = process.env) {
  if (env.HARBOR_CODEX_VERSION) return parseSemver(env.HARBOR_CODEX_VERSION);
  const onDisk = codexPackageVersion(bin, env);
  if (onDisk) return onDisk;
  const [file, ...args] = resolveWindowsLaunch([bin, '--version'], { env });
  try {
    const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 5_000, env });
    return result.status === 0 ? parseSemver(result.stdout) : null;
  } catch {
    return null;
  }
}

// Migrations codex keeps IN CODE for selections that outlived their catalog
// entry (0.158.0 tui/src/app/startup_prompts.rs model_upgrade_for_migration).
// Its screen only opens when the target is listed in its available catalog.
const CODEX_BUILTIN_MIGRATIONS = [
  ['gpt-5.4-mini', 'gpt-6-luna'],
  ['gpt-5.4', 'gpt-6-sol'],
  ['openai.gpt-5.4', 'openai.gpt-6-sol'],
];

function codexMigrationAcks(codexHome, version = null) {
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(path.join(codexHome, 'models_cache.json'), 'utf8')); } catch { /* reviewed built-ins below do not need the cache */ }
  const models = Array.isArray(cache?.models) ? cache.models : [];
  // The CLI may reject even a readable cache for age, version or auth identity.
  // Pin its reviewed OpenAI pairs independently of that cache. Codex still
  // checks provider, target visibility and the exact pair before any prompt;
  // these process-only acknowledgments never select a model or write config.
  const reviewed = new Set(semverAtLeast(version, [0, 158, 0])
    ? CODEX_BUILTIN_MIGRATIONS.filter(([from]) => !from.startsWith('openai.')).map(([from]) => from) : []);
  const found = [];
  for (const model of models) {
    if (!reviewed.has(model?.slug)) found.push([model?.slug, model?.upgrade?.model || model?.upgrade?.id]);
  }
  const listed = new Set(models.filter((m) => m?.visibility === 'list').map((m) => m.slug));
  for (const [from, to] of CODEX_BUILTIN_MIGRATIONS) {
    if ((reviewed.has(from) || listed.has(to)) && !found.some(([slug]) => slug === from)) found.push([from, to]);
  }
  const pairs = [];
  for (const [from, to] of found) {
    // Slugs land inside a TOML inline table on a command line: anything but a
    // plain slug is skipped rather than quoted.
    if (CODEX_SLUG_RE.test(from || '') && CODEX_SLUG_RE.test(to || '') && from !== to) pairs.push(`'${from}'='${to}'`);
  }
  // The table is `notice`, singular (config_toml.rs `pub notice: Option<Notice>`);
  // `notices.` is silently ignored unless --strict-config names it unknown.
  return pairs.length ? `notice.model_migrations={${pairs.join(',')}}` : null;
}

function codexPaneControls({ version, codexHome }) {
  const controls = [];
  if (semverAtLeast(version, CODEX_PANE_CONTROLS_SINCE)) controls.push('--no-daemon', '-c', 'tui.fullscreen_transcript=false');
  const acks = codexHome ? codexMigrationAcks(codexHome, version) : null;
  if (acks) controls.push('-c', acks);
  return controls;
}

// The controls go straight after the bypass flag, ahead of --model, the resume
// id and any prompt, so the positional arguments stay last.
function withCodexPaneControls(argv, controls) {
  if (!controls.length) return argv;
  const at = argv.indexOf('--dangerously-bypass-approvals-and-sandbox');
  if (at < 0) return argv;
  return [...argv.slice(0, at + 1), ...controls, ...argv.slice(at + 1)];
}

function parseAi(args) {
  let provider = 'claude';
  let model = '';
  let effort = '';
  let resumeId = '';
  let sessionId = '';
  let here = false;
  let configHome = '';
  let prompt = '';
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--here') here = true;
    else if (['--provider', '--model', '--effort', '--resume-id', '--session-id', '--home'].includes(arg)) {
      const next = args[i + 1];
      if (!next) throw new Error(`${arg} requires a value`);
      // A value that is itself a flag means the caller left one out. Accepting
      // it sends a bogus model id to the CLI and turns the following word into
      // the session's opening prompt, both silently.
      if (next.startsWith('-')) throw new Error(`${arg} requires a value, got the flag ${next}`);
      const value = args[++i];
      if (arg === '--provider') provider = value;
      if (arg === '--model') model = value;
      if (arg === '--effort') effort = value;
      if (arg === '--resume-id') resumeId = value;
      if (arg === '--session-id') sessionId = value;
      if (arg === '--home') configHome = value;
    } else if (arg === '-h' || arg === '--help') return { help: true };
    // A trailing positional is the PROMPT the agent starts with, which is how
    // the Orch view kicks off a run (`/orchestrate-research <goal>`). It used to
    // reach the CLI only through an unshipped wrapper that forwarded "$@".
    else if (!arg.startsWith('-') && !prompt) prompt = arg;
    else throw new Error(`unknown option: ${arg} (see --help)`);
  }
  if (!['claude', 'codex', 'cursor'].includes(provider)) throw new Error(`unknown provider: ${provider}`);
  if (provider === 'claude' && resumeId) throw new Error('--resume-id is codex/cursor only; claude resumes via claude-sessions');
  if (provider !== 'claude' && sessionId) throw new Error('--session-id is claude only');
  let argv;
  if (provider === 'claude') argv = [claudeBin(), '--dangerously-skip-permissions', ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), ...(sessionId ? ['--session-id', sessionId] : [])];
  else if (provider === 'codex') argv = resumeId
    ? [providerBin('codex'), 'resume', '--dangerously-bypass-approvals-and-sandbox', resumeId]
    : [providerBin('codex'), '--dangerously-bypass-approvals-and-sandbox', ...(model ? ['--model', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : [])];
  // --trust (2026-09-26): the interactive TUI opens "Workspace Trust Required"
  // in any folder it has not recorded, --force or not, and its first option is
  // "Trust this workspace", so the Enter that ends Harbor's first send would
  // answer the screen and the message would be lost. It is cursor's own flag
  // (present from 2026.08.11 at least) and records the same trust marker the
  // screen writes: the cursor side of preacceptFolderTrust. Resume needs it too:
  // a chat started headless with -f runs WITHOUT recording trust (cursor treats
  // run-everything as permission, not as a trust decision), so its folder can
  // still be untrusted when Harbor reopens that chat interactively.
  // --disable-auto-update (same day): an interactive cursor schedules a
  // background self-update that extracts the next build into versions\ and
  // makes it the one every later launch runs, unreviewed (2026.09.23 appeared
  // with no install session behind it). Harbor's rule, the one --no-daemon
  // enforces for codex, is that no
  // CLI updates itself under a pane. A hidden flag, present from 2026.08.11.
  else argv = resumeId
    ? [providerBin('cursor'), '--force', '--trust', '--disable-auto-update', '--resume', resumeId]
    : [providerBin('cursor'), '--force', '--trust', '--disable-auto-update', ...(model ? ['--model', model] : [])];
  if (prompt) argv.push(prompt);
  return { argv, here, configHome, provider, resumeId, sessionId, prompt };
}

async function ai(args) {
  resolveSessionBackend();
  const parsed = parseAi(args);
  if (parsed.help) {
    process.stdout.write('ai [--home PROFILE|CONFIG_HOME] [--provider claude|codex|cursor] [--model MODEL] [--effort LEVEL] [--resume-id ID] [--session-id UUID] [--here] [PROMPT]\n');
    return 0;
  }
  const childEnv = { ...process.env };
  // Through the SAME resolver resume uses: a profile id, a config-home path, or
  // the ~/.claude[-id] convention. This line used to pass the flag value RAW,
  // so `ai --home personal` handed the child CLAUDE_CONFIG_DIR=personal, a
  // RELATIVE path, and claude minted a fresh unauthenticated config home at
  // <cwd>/personal (live-caught 2026-08-12: two of them sitting in the harbor
  // repo root). The GUI never hit this because buildNewArgv passes the
  // profile's absolute configHome; only a bare CLI invocation did.
  if (parsed.configHome) {
    if (parsed.provider === 'cursor') throw new Error('--home is not supported for cursor; cursor-agent exposes no verified home selector');
    const selected = resolveProfileHome(parsed.configHome, parsed.provider);
    if (!selected?.configHome) {
      throw new Error(`--home ${parsed.configHome} names neither a ${parsed.provider} profile nor a config home`);
    }
    if (parsed.provider === 'claude') childEnv.CLAUDE_CONFIG_DIR = selected.configHome;
    if (parsed.provider === 'codex') childEnv.CODEX_HOME = selected.configHome;
  }
  // Against the home the child will read (the profile's, else an inherited
  // CODEX_HOME, else ~/.codex: the same order codex-model-catalog.js reads).
  if (parsed.provider === 'codex') {
    parsed.argv = withCodexPaneControls(parsed.argv, codexPaneControls({
      version: codexCliVersion(parsed.argv[0], childEnv),
      codexHome: childEnv.CODEX_HOME || path.join(os.homedir(), '.codex'),
    }));
  }
  if (process.env.HARBOR_AI_DRY_RUN === '1') {
    process.stdout.write(`${commandString(parsed.argv)}\n`);
    return 0;
  }
  // Against the home the CHILD will read, which is the one just decided above.
  if (parsed.provider === 'claude') preacceptFolderTrust(childEnv.CLAUDE_CONFIG_DIR || null, process.cwd());
  const launchArgv = resolveWindowsLaunch(parsed.argv, { env: childEnv });
  if (parsed.here) {
    const result = spawnSync(launchArgv[0], launchArgv.slice(1), { stdio: 'inherit', env: childEnv, cwd: process.cwd() });
    return result.status ?? 1;
  }
  const spawned = await spawnSessiond({
    argv: launchArgv,
    cwd: process.cwd(),
    env: childEnv,
    agent: parsed.provider,
    agentSession: parsed.sessionId || parsed.resumeId || null,
  });
  process.stdout.write(`started ${parsed.provider} in sessiond session ${spawned.id}\n`);
  return 0;
}

function historyIndex() {
  const state = runtime();
  return createHistoryIndex({
    home: state.home,
    projectsDir: state.projectsDir,
    cacheDir: state.cacheDir,
    profiles: Array.isArray(state.config.profiles) ? state.config.profiles : undefined,
  });
}

function index(args, options = {}) {
  try {
    const stdout = historyIndex().run(args, { ...process.env, ...(options.env || {}) });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: 1, stdout: '', stderr: `${error.message}\n` };
  }
}

// The legacy per-account flags lived here until 2026-08-07, and the argument for
// keeping them (checked 2026-08-06, nearly removed) was real at the time: they
// were how the unshipped wrapper chose which config file to write folder trust
// into, so dropping them meant the trust prompt came back. That argument dies
// with the wrapper. Harbor writes the trust marker itself now, against the home
// the child is actually pointed at, so an account is a config home and nothing
// on the command line has to encode WHICH account by name.
//
// That is also what removes the last functional reason a profile id had to be
// one of three specific words, one of which was a person's first name.
function resumeArgv(id, prompt = null) {
  const argv = [claudeBin(), '--dangerously-skip-permissions', '--resume', id];
  if (prompt != null) argv.push(String(prompt));
  return argv;
}

// The inverse of the wizard's `homeId`: `personal` is the bare `~/.claude`, and
// any other id is `~/.claude-<id>`. Deriving it means an id the user's config has
// never heard of still resolves to a real directory instead of to nothing.
//
// An id arrives here as a bare word off the command line and is about to become
// a DIRECTORY NAME, so anything that is not a plain token is refused rather than
// joined: `path.join(homedir, '.claude-' + '../..')` escapes the home directory
// entirely. Gate-caught by "opaque profile ids never participate in path
// construction" the first time this function existed.
const SAFE_PROFILE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function conventionalConfigHome(id) {
  if (!id || !SAFE_PROFILE_ID.test(id)) return null;
  return path.join(os.homedir(), id === 'personal' ? '.claude' : `.claude-${id}`);
}

// The configured default, for the case where a session's own home is unknown.
// This used to be the literal string 'team', which is the author's default
// account and a directory nobody else has: a stranger resuming a session the
// index could not attribute got CLAUDE_CONFIG_DIR pointed at a `~/.claude-team`
// that does not exist.
function defaultProfileId() {
  const profiles = runtime().config.profiles || [];
  const preferred = profiles.find((item) => item?.isDefault) || profiles[0];
  return preferred?.id || 'personal';
}

function resolveProfileHome(value, provider = 'claude') {
  if (value === 'auto') return null;
  const profiles = runtime().config.profiles || [];
  const profile = profiles.find((item) => (
    (item.provider || 'claude') === provider
    && (item.id === value || item.configHome === value)
  ));
  if (profile) return { id: profile.id, configHome: profile.configHome };
  // A filesystem path names the home directly; a bare word is an id.
  if (path.isAbsolute(value) || value.includes('/') || value.includes('\\') || value.startsWith('~')) {
    return { id: 'personal', configHome: value };
  }
  if (provider !== 'claude') return null;
  return { id: value, configHome: conventionalConfigHome(value) };
}

function requireValue(args, indexAt) {
  const value = args[indexAt + 1];
  if (!value || value.startsWith('-')) throw new Error(`${args[indexAt]} requires a value (see --help)`);
  return value;
}

async function claudeSessions(args) {
  resolveSessionBackend();
  const emit = [];
  let resumeId = '';
  let home = 'auto';
  let here = false;
  let liveOk = false;
  let prompt = null;
  let tsv = false;
  let flat = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-p' || arg === '--project' || arg === '-s' || arg === '--since') {
      emit.push(arg === '-p' ? '--project' : arg === '-s' ? '--since' : arg, requireValue(args, i));
      i += 1; flat = true;
    } else if (arg === '--today') { emit.push('--since', 'today'); flat = true; }
    else if (arg === '--all' || arg === '--rebuild') emit.push(arg);
    else if (arg === '--flat') flat = true;
    else if (arg === '--tsv') tsv = true;
    else if (arg === '--resume-id') { resumeId = requireValue(args, i); i += 1; }
    else if (arg === '--home') { home = requireValue(args, i); i += 1; }
    else if (arg === '--here') here = true;
    else if (arg === '--live-ok') liveOk = true;
    else if (arg === '--prompt') {
      if (args[i + 1] == null) throw new Error('--prompt requires a value (see --help)');
      prompt = args[i + 1]; i += 1;
    }
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write('claude-sessions [--flat] [-p PROJECT] [-s SINCE] [--today] [--all] [--rebuild] [--tsv] [--resume-id ID [--home PROFILE|CONFIG_HOME] [--prompt TEXT] [--here]]\n');
      return 0;
    } else throw new Error(`unknown option: ${arg} (see --help)`);
  }
  if (resumeId) {
    const metadata = index(['meta', resumeId]);
    if (metadata.status !== 0) throw new Error(`session ${resumeId} not found in index`);
    const meta = JSON.parse(metadata.stdout);
    const selected = resolveProfileHome(home === 'auto' ? (meta.home || defaultProfileId()) : home);
    home = selected.id;
    const resumeEnv = { ...process.env };
    if (selected.configHome) resumeEnv.CLAUDE_CONFIG_DIR = selected.configHome;
    if (!meta.cwd || !fs.existsSync(meta.cwd) || !fs.statSync(meta.cwd).isDirectory()) {
      throw new Error(`project directory is gone or unknown for ${resumeId}`);
    }
    preacceptFolderTrust(resumeEnv.CLAUDE_CONFIG_DIR || null, meta.cwd);
    if (!meta.path || !fs.existsSync(meta.path)) throw new Error(`transcript no longer exists (pruned?): ${meta.path || ''}`);
    const age = Math.floor(Date.now() / 1000 - fs.statSync(meta.path).mtimeMs / 1000);
    if (!liveOk && age < 90) throw new Error(`session ${resumeId} looks LIVE right now (its transcript was written ${age}s ago). Resuming would attach a second Claude to the same conversation file. Close the original first, or re-run with --live-ok if you are sure.`);
    // The same Windows resolution a launch gets: a bare `claude` is npm's
    // claude.cmd, which sessiond's CreateProcess cannot start. A full path (what
    // the wizard saves) passes through untouched.
    const argv = resolveWindowsLaunch(resumeArgv(resumeId, prompt), { env: resumeEnv });
    if (here) {
      const result = spawnSync(argv[0], argv.slice(1), { cwd: meta.cwd, env: resumeEnv, stdio: 'inherit', windowsHide: true });
      return result.status ?? 1;
    }
    const spawned = await spawnSessiond({
      argv,
      cwd: meta.cwd,
      env: resumeEnv,
      agent: 'claude',
      agentSession: resumeId,
    });
    process.stdout.write(`resumed (${home}) in sessiond session ${spawned.id}\n`);
    return 0;
  }
  const mode = !flat && !tsv ? 'tree' : 'emit';
  const rows = index([mode, ...emit]);
  if (rows.status !== 0) throw new Error(rows.stderr.trim() || 'index failed');
  if (tsv) { process.stdout.write(rows.stdout); return 0; }
  if (!rows.stdout.trim()) throw new Error('no sessions matched');
  // fzf is itself cross-platform. The picker remains a presentation layer;
  // all indexing and resume behavior stays in this command.
  const picked = run('fzf', [
    '--delimiter', '\t', '--with-nth', mode === 'tree' ? '2' : '2,3,4',
    '--height=90%', '--reverse', '--info=inline',
  ], { input: rows.stdout });
  if (picked.status !== 0 || !picked.stdout.trim()) return 0;
  const first = picked.stdout.trim().split('\t')[0];
  if (mode === 'tree' && first.startsWith('N:')) return ai.call(null, []);
  const id = first.startsWith('S:') ? first.slice(2) : first;
  return claudeSessions(['--resume-id', id]);
}

module.exports = {
  ROOT, ai, parseAi, claudeSessions, claudeBin, claudeConfigFile, cleanDaemonEnv, commandString,
  preacceptFolderTrust, runtime, resolveUnitPolicy,
  trustKeysFor,
  resolveSessionBackend, sessiondChildEnv, spawnSessiond,
  resolveWindowsLaunch, codexCliVersion, codexMigrationAcks, codexPaneControls, withCodexPaneControls,
};
