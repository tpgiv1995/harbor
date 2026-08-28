'use strict';

// HOW TO RUN ONE OF HARBOR'S OWN bin/ SCRIPTS, on any OS.
//
// The scripts in bin/ are extensionless and carry a shebang. `bin/ai`,
// `bin/claude-sessions` and the session daemon launchers are sh+node polyglots
// (`#!/bin/sh` followed by
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
// and then be unable to start or resume a single session. Until the 2026-08-11
// port Harbor had never run on Windows, so nothing had caught it.
//
// The fix is to name the interpreter rather than rely on the OS to infer one.
// Under Electron `process.execPath` is the Electron binary, which runs as plain
// Node when ELECTRON_RUN_AS_NODE is set; under the test runner it is already
// node and the variable is harmless.
//
// MACOS JOINED THE INTERPRETER BRANCH ON 2026-08-27, for a different reason than
// Windows. macOS honours the shebang perfectly well — but `#!/usr/bin/env node`
// still has to FIND node, and a packaged .app launched from Finder or the Dock
// inherits launchd's `/usr/bin:/bin:/usr/sbin:/sbin`. macOS ships no
// `/usr/bin/node`, and Homebrew's lives in `/opt/homebrew/bin`, off that PATH.
// So the daemon auto-start exec'd, failed to resolve node, and exited 127 —
// caught live with `launchctl list` showing the job parked at 127 while the app
// showed "Terminal daemon unreachable". It worked during development only
// because `npm start` inherits a developer's shell PATH; every packaged launch
// was broken. Naming Electron as the interpreter also drops the requirement
// that the user have Node installed at all, which is the right answer for a
// packaged app that already ships a Node runtime.
//
// LINUX IS DELIBERATELY UNCHANGED. It is the proven path, it is not broken, and
// the two-sided test below is what keeps it that way.

const IS_WIN32 = process.platform === 'win32';

// Returns { command, args, env } ready for execFile/spawn. `env` is only the
// ADDITIONS the invocation needs; callers merge it into whatever they already
// pass so an explicit env is never clobbered.
function scriptInvocation(scriptPath, argv = [], {
  platform = process.platform,
  execPath = process.execPath,
  // `process.versions.electron` is absent under plain Node, so the test runner
  // and any CLI use of these helpers keep the bare-script POSIX path. The
  // interpreter is taken ONLY where the shebang genuinely cannot be trusted.
  electron = Boolean(process.versions.electron),
} = {}) {
  if (platform === 'win32' || (platform === 'darwin' && electron)) {
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
