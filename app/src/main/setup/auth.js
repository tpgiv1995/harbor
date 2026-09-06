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

const PROVIDER_LOGIN = {
  claude: { args: ['auth', 'login'], defaultBin: 'claude' },
  codex: { args: ['login'], defaultBin: 'codex' },
  cursor: { args: ['login'], defaultBin: 'cursor-agent' },
};

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
function loginPlan(provider, options = {}) {
  const spec = PROVIDER_LOGIN[provider];
  if (!spec) throw new Error(`unknown provider for login: ${provider}`);
  const bin = options.bin || spec.defaultBin;
  const env = loginEnv(provider, options.configHome);
  const argv = [bin, ...spec.args];
  const prefix = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
  return {
    provider,
    command: bin,
    args: [...spec.args],
    argv,
    env,
    display: prefix ? `${prefix} ${argv.map(shellQuote).join(' ')}` : argv.map(shellQuote).join(' '),
  };
}

// How to get that argv in front of a human, per platform. Returns null when we
// cannot find a terminal, which the caller turns into instructions rather than
// an error, because "we could not open a window for you" is not "you cannot
// sign in".
function terminalPlan(plan, deps) {
  const platformName = deps.platform;
  if (platformName === 'win32') {
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
  const plan = loginPlan(provider, options);

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

  const terminal = terminalPlan(plan, {
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

module.exports = { PROVIDER_LOGIN, LINUX_TERMINALS, loginPlan, loginEnv, terminalPlan, launchLogin };
