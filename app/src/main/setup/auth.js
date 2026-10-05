'use strict';

// Signing a config home in, WITHOUT Harbor ever touching a credential.
//
// This module is the single most important place in the wizard to get the
// posture right, so it is worth stating plainly: Harbor never asks for, reads,
// transports or stores an API key, a token or a password. Claude, codex and
// cursor each ship their own login flow and each own their own credential
// store. All this module does is start the vendor's own command in a terminal
// the user can see, pointed at the config home they chose, and then get out of
// the way. There is deliberately no code path here that receives a secret, so
// there is no code path here that could persist one.
//
// The commands are the real ones, verified against the installed binaries
// rather than assumed:
//   claude auth login      (claude auth --help: "Sign in to your Anthropic account")
//   codex login            (codex --help: "Manage login")
//   cursor-agent login     (cursor-agent --help: "Authenticate with Cursor")
//
// The second rule is NEVER DEAD-END. A machine with no terminal emulator we
// recognize is common (a bare Windows install, a stripped container), so every
// return value carries `manualCommand`: the exact line the user can paste
// themselves. A failure to launch degrades to instructions, never to a shrug.

const { spawn } = require('node:child_process');
const path = require('node:path');

const PROVIDER_LOGIN = {
  claude: { args: ['auth', 'login'], defaultBin: 'claude' },
  codex: { args: ['login'], defaultBin: 'codex' },
  cursor: { args: ['login'], defaultBin: 'cursor-agent' },
};

// ---------------------------------------------------------------------------
// 2026-09-19: `bin` and `configHome` reach this module STRAIGHT FROM
// THE RENDERER (`setup:login` in ipc.js hands them through unchanged), and
// the wizard legitimately lets a user type a custom executable path and pick
// a custom config-home folder, so neither can be restricted to a fixed
// allowlist of names. The main process still has to treat both as untrusted
// before they reach a real spawn.
// ---------------------------------------------------------------------------

// Characters cmd.exe treats specially when they appear, unquoted, in a
// command line it is about to run. `bin` lands inside exactly such a line on
// win32 (`cmd.exe /c start "" cmd /k <inner>`, see terminalPlan below).
// cmd's escaping rules for these are famously context-dependent (inside vs
// outside quotes, `%` variable expansion, `^` as its own escape character),
// so they are refused outright here rather than escaped: a wrong escape is
// exactly how this class of bug happens, and refusing is far simpler to get
// right than escaping every case.
const CMD_METACHARACTERS = /[&|<>^%!"\r\n]/;

// A conservative bare command name: what a PATH lookup expects, and nothing
// a shell could parse differently. No slashes (a bare name with a slash is a
// path, handled by the absolute-path branch below); no whitespace (a real
// executable is never named with a space in it, so whitespace here can only
// be a quoting trick).
const BARE_COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// `bin` is safe once it is EITHER a bare name matching the conservative
// shape above (resolved later by PATH lookup, same as leaving it unset) OR
// an absolute path to a file that actually exists on this machine right now.
// Anything else (a relative path, a bare name with a metacharacter, an
// absolute path to nothing) is refused with a reason the wizard can show.
function validateBin(bin, { existsSync } = {}) {
  if (!bin) return { ok: true };
  const value = String(bin);
  if (CMD_METACHARACTERS.test(value)) {
    return { ok: false, reason: `"${value}" contains a character a shell would interpret; use a plain command name or a full path to the executable` };
  }
  if (BARE_COMMAND_RE.test(value)) return { ok: true };
  const checkExists = existsSync || require('node:fs').existsSync;
  if (path.isAbsolute(value)) {
    return checkExists(value)
      ? { ok: true }
      : { ok: false, reason: `"${value}" does not exist on this machine` };
  }
  return { ok: false, reason: `"${value}" is not a plain command name or an absolute path to an existing file` };
}

// A UNC path ('\\server\share\...') or a Windows device path
// ('\\.\PhysicalDrive0', '\\?\C:\...') is refused outright: a UNC target
// routes file access through SMB to a host the picker does not control (a
// classic vector for coercing an unwanted NTLM authentication attempt), and
// neither is a legitimate answer to "which local folder holds my config".
// Node's path.isAbsolute() alone does not distinguish them from an ordinary
// drive-lettered path ('C:\Users\me' and '\\server\share' are BOTH
// "absolute"), so the UNC/device shape has to be checked explicitly.
const UNC_OR_DEVICE_PATH_RE = /^[\\/]{2}/;

// The structural half of the configHome check: is this even SHAPED like a
// real local folder. Usable with no context (no homedir, no config), so
// loginPlan can apply it unconditionally without knowing who is calling it.
function isLocalAbsoluteConfigHome(configHome) {
  const value = String(configHome || '');
  if (!value) return { ok: true };
  if (!path.isAbsolute(value)) {
    return { ok: false, reason: `"${value}" is not an absolute path` };
  }
  if (UNC_OR_DEVICE_PATH_RE.test(value)) {
    return { ok: false, reason: `"${value}" is a network or device path, not a local folder` };
  }
  return { ok: true };
}

// The contextual half. A folder that passes the structural check above could
// still name ANY local folder (System32, a temp dir, something unrelated
// entirely); the value alone does not say Harbor has any reason to trust
// it, and CLAUDE_CONFIG_DIR/CODEX_HOME there would point the vendor CLI's
// own config read/write straight at it. So the folder must be either one
// Harbor itself already detected or has saved as a profile, or must live
// under the user's own home directory (which covers a fresh custom home the
// wizard's native folder picker just returned: a real dialog answer, never
// renderer-typed text). ipc.js is the only caller with both pieces of
// context, which is why this lives here as a separate, explicitly-invoked
// function rather than folded into loginPlan.
//
// The two refusals carry different codes because they deserve different help.
// HOME_NOT_LOCAL (a network or device path) is one nobody should act on.
// HOME_NOT_KNOWN is an ordinary thing for a real user to have, a config home on
// another drive that is not saved yet, so the caller hands back the command to
// run by hand instead of a dead end.
//
// Windows paths are case-insensitive and this comparison used not to be: a home
// typed with a lowercase drive letter was "outside your home directory" against
// the same folder spelled the way the OS reports it (2026-09-19).
function isSafeConfigHome(configHome, { homedir, allowedHomes = [], platform = process.platform } = {}) {
  const structural = isLocalAbsoluteConfigHome(configHome);
  if (!structural.ok) return { ...structural, code: 'HOME_NOT_LOCAL' };
  const value = String(configHome || '');
  if (!value) return { ok: true };
  const p = platform === 'win32' ? path.win32 : path.posix;
  const fold = (s) => (platform === 'win32' ? s.toLowerCase() : s);
  const normalized = fold(p.resolve(value));
  const resolvedHome = homedir ? fold(p.resolve(homedir)) : null;
  const withinHome = Boolean(resolvedHome)
    && (normalized === resolvedHome || normalized.startsWith(`${resolvedHome}${p.sep}`));
  const isKnownHome = allowedHomes.some((home) => home && fold(p.resolve(String(home))) === normalized);
  if (!withinHome && !isKnownHome) {
    return { ok: false, code: 'HOME_NOT_KNOWN', reason: `"${value}" is not one of Harbor's known config homes and is outside your home directory` };
  }
  return { ok: true };
}

// Linux terminals in preference order. x-terminal-emulator is the Debian
// alternatives symlink and therefore whatever the user actually has; the rest
// are the common concrete ones. Each entry says how it takes a command,
// because they genuinely disagree (`-e` vs `--` vs bare argv).
const LINUX_TERMINALS = [
  { bin: 'x-terminal-emulator', wrap: (argv) => ['-e', ...argv] },
  { bin: 'gnome-terminal', wrap: (argv) => ['--', ...argv] },
  { bin: 'konsole', wrap: (argv) => ['-e', ...argv] },
  { bin: 'xfce4-terminal', wrap: (argv) => ['-x', ...argv] },
  { bin: 'alacritty', wrap: (argv) => ['-e', ...argv] },
  { bin: 'kitty', wrap: (argv) => [...argv] },
  { bin: 'wezterm', wrap: (argv) => ['start', '--', ...argv] },
  { bin: 'xterm', wrap: (argv) => ['-e', ...argv] },
];

function shellQuote(value) {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function powerShellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// The environment the login runs in. CLAUDE_CONFIG_DIR is how the Claude CLI is
// told WHICH home to sign in, and it is the same variable bin/harbor-bin.cjs
// uses, so the wizard and the launcher can never disagree about what a home is.
// Nothing secret is added here and nothing is read back out.
function loginEnv(provider, configHome) {
  if (!configHome) return {};
  if (provider === 'claude') return { CLAUDE_CONFIG_DIR: configHome };
  if (provider === 'codex') return { CODEX_HOME: configHome };
  return {};
}

// Pure: what would be run, without running it. The review UI shows `display`
// verbatim so the user can see the exact command before agreeing to it, and can
// copy it if they would rather run it themselves.
//
// `deps` is optional and exists only so tests can inject a fake `existsSync`
// for the absolute-path branch of validateBin; a real caller never needs to
// pass it (validateBin falls back to the real filesystem).
function loginPlan(provider, options = {}, deps = {}) {
  const spec = PROVIDER_LOGIN[provider];
  if (!spec) throw new Error(`unknown provider for login: ${provider}`);
  const bin = options.bin || spec.defaultBin;
  // The renderer is untrusted: refuse before a plan is even built,
  // so nothing downstream (terminalPlan's win32 command line, the exported
  // env, the manual-command display shown back to the user) ever sees an
  // unsafe value. Both checks are structural/context-free on purpose so they
  // apply the same way regardless of who calls loginPlan; the configHome
  // CONTEXTUAL check (is this a home Harbor actually knows about) needs
  // homedir/allowlist context loginPlan does not have, and is applied
  // separately at the ipc.js boundary via isSafeConfigHome.
  const binCheck = validateBin(bin, deps);
  if (!binCheck.ok) throw new Error(binCheck.reason);
  if (options.configHome) {
    const homeCheck = isLocalAbsoluteConfigHome(options.configHome);
    if (!homeCheck.ok) throw new Error(homeCheck.reason);
  }
  const env = loginEnv(provider, options.configHome);
  const argv = [bin, ...spec.args];
  const platformName = deps.platform || process.platform;
  const prefix = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
  let display = prefix ? `${prefix} ${argv.map(shellQuote).join(' ')}` : argv.map(shellQuote).join(' ');
  if (platformName === 'win32') {
    // 2026-09-19: the fallback is pasted in PowerShell, which does not accept
    // POSIX assignments or invoke a quoted executable path without &.
    const assignments = Object.entries(env).map(([key, value]) => `$env:${key} = ${powerShellQuote(value)}; `).join('');
    const invocation = BARE_COMMAND_RE.test(bin) ? bin : `& ${powerShellQuote(bin)}`;
    display = `${assignments}${invocation} ${spec.args.join(' ')}`;
  }
  return {
    provider,
    command: bin,
    args: [...spec.args],
    argv,
    env,
    display,
  };
}

// How to get that argv in front of a human, per platform. Returns null when we
// cannot find a terminal, which the caller turns into instructions rather than
// an error, because "we could not open a window for you" is not "you cannot
// sign in".
function terminalPlan(plan, deps) {
  const platformName = deps.platform;
  if (platformName === 'win32') {
    // SAFE ONLY BECAUSE loginPlan already ran validateBin on every argv
    // element before `plan` ever reached here: no part can carry a cmd.exe
    // metacharacter or an embedded double quote. Checked again, defensively,
    // so a future caller that builds a `plan` object by hand and reaches
    // terminalPlan without going through loginPlan's validation fails loudly
    // instead of silently building an exploitable command line. What is left
    // to quote here is ordinary: a part that merely CONTAINS whitespace (a
    // path like 'C:\Program Files\Claude\claude.exe') is wrapped in quotes,
    // which cmd.exe's own parser reads back as one token because, thanks to
    // the check just above, it never contains a quote of its own to escape.
    for (const part of plan.argv) {
      if (CMD_METACHARACTERS.test(String(part))) {
        throw new Error(`refusing to build a cmd.exe command line: "${part}" contains a character a shell would interpret`);
      }
    }
    // `start` is a cmd builtin, so it has to run through cmd. /k keeps the
    // window open after the login finishes so its output is readable.
    const inner = plan.argv.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ');
    return { command: 'cmd.exe', args: ['/c', 'start', '""', 'cmd', '/k', inner] };
  }
  if (platformName === 'darwin') {
    const script = `${Object.entries(plan.env).map(([k, v]) => `export ${k}=${shellQuote(v)};`).join(' ')} ${plan.argv.map(shellQuote).join(' ')}`;
    return {
      command: 'osascript',
      args: ['-e', `tell application "Terminal" to do script ${JSON.stringify(script)}`, '-e', 'tell application "Terminal" to activate'],
    };
  }
  for (const terminal of LINUX_TERMINALS) {
    if (deps.hasCommand(terminal.bin)) {
      return { command: terminal.bin, args: terminal.wrap(plan.argv) };
    }
  }
  return null;
}

function defaultHasCommand(name) {
  const { execFileSync } = require('node:child_process');
  try {
    execFileSync('sh', ['-lc', 'command -v -- "$1"', 'sh', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Start the vendor's login. Every outcome is reported honestly, including the
// two that are not failures of the login itself: an isolated profile refusing
// to launch, and a machine with no terminal we know how to open.
async function launchLogin(provider, options = {}, deps = {}) {
  const platformName = deps.platform || process.platform;
  const plan = loginPlan(provider, options, deps);

  // The same guard that stops a harness resuming a real session. A login opens
  // a real browser against a real account, which is exactly the class of effect
  // an isolated Harbor must not have, and the wizard is the first thing a drive
  // walks through.
  if (deps.launchPolicy && deps.launchPolicy.allowed === false) {
    return {
      ok: false,
      launched: false,
      reason: deps.launchPolicy.reason,
      code: 'LAUNCH_BLOCKED',
      manualCommand: plan.display,
    };
  }

  const terminal = (deps.terminalPlan || terminalPlan)(plan, {
    platform: platformName,
    hasCommand: deps.hasCommand || defaultHasCommand,
  });
  if (!terminal) {
    return {
      ok: false,
      launched: false,
      code: 'NO_TERMINAL',
      reason: 'Harbor could not find a terminal application to open. Run the command below yourself, then come back and press Re-check.',
      manualCommand: plan.display,
    };
  }

  try {
    const spawnProcess = deps.spawn || spawn;
    const child = spawnProcess(terminal.command, terminal.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: { ...process.env, ...plan.env },
    });
    child.unref?.();
    return {
      ok: true,
      launched: true,
      pid: child.pid ?? null,
      manualCommand: plan.display,
      // The wizard cannot know when a login finished: it happens in another
      // process, in a browser. So it never claims success, it tells the user to
      // re-check, and the re-check reads the home's .claude.json for real.
      note: 'Finish signing in in the window that opened, then press Re-check to read the account back.',
    };
  } catch (error) {
    return {
      ok: false,
      launched: false,
      code: 'SPAWN_FAILED',
      reason: error.message,
      manualCommand: plan.display,
    };
  }
}

module.exports = {
  PROVIDER_LOGIN, LINUX_TERMINALS, loginPlan, loginEnv, terminalPlan, launchLogin,
  validateBin, isLocalAbsoluteConfigHome, isSafeConfigHome,
  // Exported so setup:login (ipc.js, 2026-09-19) can tell a
  // metacharacter refusal apart from a "does not exist" refusal without
  // re-deriving or loosening the same regex validateBin already enforces.
  CMD_METACHARACTERS,
};
