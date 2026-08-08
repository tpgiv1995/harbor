'use strict';

// HOW TO RUN ONE OF HARBOR'S OWN bin/ SCRIPTS, on any OS.
//
// The scripts in bin/ are extensionless and carry a shebang. `bin/ai`,
// `bin/claude-sessions`, `bin/harbor-hydrate`, `bin/herdr-health.sh` and
// `bin/herdr-server-clean` are sh+node polyglots (`#!/bin/sh` followed by
// `':' //; exec node "$0" "$@"`); `bin/harbor-sessiond` and `bin/harbor-tasks`
// are plain `#!/usr/bin/env node`. Every one of them is valid JavaScript, so
// `node <script>` runs all of them.
//
// On Linux and macOS the kernel honours the shebang, so handing the raw path to
// execFile/spawn works and always has. WINDOWS HAS NO SHEBANG: CreateProcess
// needs a PE binary, a .bat/.cmd, or an explicit interpreter, and an
// extensionless text file is none of those. Every launch, every resume and the
// daemon auto-start at boot all went through a bare
// `execFile('<repo>/bin/ai', ...)`, so on Windows the app would open its window
// and then be unable to start or resume a single session. Harbor has never run
// on Windows, so nothing had caught it.
//
// The fix is to name the interpreter rather than rely on the OS to infer one.
// Under Electron `process.execPath` is the Electron binary, which runs as plain
// Node when ELECTRON_RUN_AS_NODE is set; under the test runner it is already
// node and the variable is harmless. Linux and macOS keep the exact behaviour
// they have today (the script path as the command, the system `node` from the
// shebang), because that path is proven and this change must not risk it.

const IS_WIN32 = process.platform === 'win32';

// Returns { command, args, env } ready for execFile/spawn. `env` is only the
// ADDITIONS the invocation needs; callers merge it into whatever they already
// pass so an explicit env is never clobbered.
function scriptInvocation(scriptPath, argv = [], { platform = process.platform, execPath = process.execPath } = {}) {
  if (platform === 'win32') {
    return {
      command: execPath,
      args: [scriptPath, ...argv],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  return { command: scriptPath, args: [...argv], env: {} };
}

// Convenience for the common execFile shape, where options may already carry a
// cwd and an env.
function scriptExecArgs(scriptPath, argv = [], options = {}, overrides = {}) {
  const { command, args, env } = scriptInvocation(scriptPath, argv, overrides);
  const merged = { ...options };
  if (Object.keys(env).length) merged.env = { ...(options.env || process.env), ...env };

  // `execArgs` is the leading arguments to execFile, ready to spread before the
  // callback. It OMITS the options object entirely when there is nothing to say,
  // because execFile's signature is overloaded on arity: a caller that used to
  // run `execFile(script, argv, cb)` must keep doing exactly that on POSIX, or
  // an injected three-argument stub silently receives the options object as its
  // callback and never calls back. That is not hypothetical; it is what the
  // first version of this change did to `resumeSession`.
  const hasOptions = Object.keys(merged).length > 0;
  return { command, args, options: merged, execArgs: hasOptions ? [command, args, merged] : [command, args] };
}

module.exports = { IS_WIN32, scriptInvocation, scriptExecArgs };
