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
  else argv = resumeId
    ? [providerBin('cursor'), '--force', '--resume', resumeId]
    : [providerBin('cursor'), '--force', ...(model ? ['--model', model] : [])];
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
  if (process.env.HARBOR_AI_DRY_RUN === '1') {
    process.stdout.write(`${commandString(parsed.argv)}\n`);
    return 0;
  }
  // Against the home the CHILD will read, which is the one just decided above.
  if (parsed.provider === 'claude') preacceptFolderTrust(childEnv.CLAUDE_CONFIG_DIR || null, process.cwd());
  if (parsed.here) {
    const result = spawnSync(parsed.argv[0], parsed.argv.slice(1), { stdio: 'inherit', env: childEnv, cwd: process.cwd() });
    return result.status ?? 1;
  }
  const spawned = await spawnSessiond({
    argv: parsed.argv,
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
    const argv = resumeArgv(resumeId, prompt);
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
  ROOT, ai, claudeSessions, claudeBin, claudeConfigFile, cleanDaemonEnv, commandString,
  preacceptFolderTrust, runtime, resolveUnitPolicy,
  trustKeysFor,
  resolveSessionBackend, sessiondChildEnv, spawnSessiond,
};
