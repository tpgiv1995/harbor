'use strict';

// WINDOWS CANNOT EXECUTE A SHEBANG, so every bin/ script must be invoked through
// a named interpreter there (2026-08-06).
//
// The scripts in bin/ are extensionless files whose first line is `#!/bin/sh` or
// `#!/usr/bin/env node`. Linux and macOS honour that; Windows CreateProcess does
// not, and an extensionless text file is not a PE binary or a .bat/.cmd either.
// Harbor launched sessions, resumed sessions and started BOTH daemons by handing
// those raw paths to execFile/spawn, so on Windows the window would open and
// then no session could ever be created or resumed. The app has never run on
// Windows, which is the only reason this was not caught by use.
//
// The proof is deliberately TWO-SIDED — but the axis is ELECTRON, not the
// platform. Under Electron the shebang cannot be trusted to resolve `node`
// (a packaged app inherits launchd's/systemd's PATH), so every platform names
// the interpreter; outside Electron the CLI and this suite keep the bare
// script. Both halves are asserted per platform below, so a regression in
// either direction fails rather than being assumed away.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { scriptInvocation, scriptExecArgs } = require('../../src/main/script-exec.js');

const REPO = path.resolve(__dirname, '../../..');
const BIN = path.join(REPO, 'bin');

test('on win32 a bin/ script is run by naming the interpreter, with the script as its first argument', () => {
  const { command, args, env } = scriptInvocation('/repo/bin/ai', ['--provider', 'claude'], {
    platform: 'win32',
    execPath: 'C:\\harbor\\Harbor.exe',
  });
  assert.equal(command, 'C:\\harbor\\Harbor.exe');
  assert.deepEqual(args, ['/repo/bin/ai', '--provider', 'claude']);
  // Electron only behaves as plain Node when told to.
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
});

test('on linux OUTSIDE Electron the shebang is trusted, so the CLI path is untouched', () => {
  const { command, args, env } = scriptInvocation('/repo/bin/ai', ['--team'], {
    platform: 'linux',
    execPath: '/usr/bin/node',
    electron: false,
  });
  assert.equal(command, '/repo/bin/ai', 'plain-node linux must still exec the script directly');
  assert.deepEqual(args, ['--team']);
  assert.deepEqual(env, {}, 'a real node on PATH needs no interpreter override');
});

test('on linux UNDER ELECTRON the interpreter is named, because a packaged AppImage has no node on PATH', () => {
  // The packaged-Linux twin of the darwin case below: a desktop-entry launch
  // inherits the session manager's PATH, `#!/usr/bin/env node` exits 127, and
  // the daemon dies silently. Same rule, same fix, asserted per platform.
  const { command, args, env } = scriptInvocation('/opt/Harbor/resources/bin/harbor-sessiond', ['start'], {
    platform: 'linux',
    execPath: '/opt/Harbor/harbor',
    electron: true,
  });
  assert.equal(command, '/opt/Harbor/harbor');
  assert.deepEqual(args, ['/opt/Harbor/resources/bin/harbor-sessiond', 'start']);
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
});

test('on darwin UNDER ELECTRON the interpreter is named, because a packaged .app has no node on PATH', () => {
  // A .app launched from Finder/Dock inherits launchd's
  // `/usr/bin:/bin:/usr/sbin:/sbin`. There is no /usr/bin/node on macOS, so
  // `#!/usr/bin/env node` exits 127 and the daemon auto-start silently never
  // happens — observed as a `launchctl list` job parked at 127 while the app
  // showed "Terminal daemon unreachable" (2026-08-27).
  const { command, args, env } = scriptInvocation('/Harbor.app/Contents/Resources/bin/harbor-sessiond', ['start'], {
    platform: 'darwin',
    execPath: '/Harbor.app/Contents/MacOS/Harbor',
    electron: true,
  });
  assert.equal(command, '/Harbor.app/Contents/MacOS/Harbor');
  assert.deepEqual(args, ['/Harbor.app/Contents/Resources/bin/harbor-sessiond', 'start']);
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1', 'the Electron binary only behaves as node when told to');
});

test('on darwin OUTSIDE Electron the shebang is trusted, so the CLI and this suite are unaffected', () => {
  const { command, args, env } = scriptInvocation('/repo/bin/harbor-sessiond', ['status'], {
    platform: 'darwin',
    execPath: '/opt/homebrew/bin/node',
    electron: false,
  });
  assert.equal(command, '/repo/bin/harbor-sessiond');
  assert.deepEqual(args, ['status']);
  assert.deepEqual(env, {}, 'a real node on PATH needs no interpreter override');
});

// The packaged-mac resume path flips scriptExecArgs from the 2-arg to the
// 3-arg execFile shape — exactly the arity hazard the implementation comment
// records breaking resumeSession once already — and until 2026-08-28 no spec
// exercised that shape on darwin. This is that spec: options-less call, under
// Electron, must produce [command, args, options] with the env merged over
// process.env rather than replacing it.
test('scriptExecArgs on darwin under Electron takes the 3-arg shape with a merged env', () => {
  const { command, args, options, execArgs } = scriptExecArgs(
    '/Harbor.app/Contents/Resources/bin/claude-sessions',
    ['--resume', 'abc123'],
    {},
    { platform: 'darwin', execPath: '/Harbor.app/Contents/MacOS/Harbor', electron: true },
  );
  assert.equal(command, '/Harbor.app/Contents/MacOS/Harbor');
  assert.deepEqual(args, ['/Harbor.app/Contents/Resources/bin/claude-sessions', '--resume', 'abc123']);
  assert.equal(execArgs.length, 3, 'the interpreter env forces the options-bearing execFile arity');
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(options.env.PATH, process.env.PATH, 'the interpreter env merges over process.env, never replaces it');
});

test('scriptExecArgs merges the interpreter environment without discarding the caller`s', () => {
  const { command, args, options } = scriptExecArgs(
    '/repo/bin/ai',
    ['--model', 'opus'],
    { cwd: '/work', env: { PATH: '/bin', HARBOR_KEEP: 'yes' } },
    { platform: 'win32', execPath: 'C:\\Harbor.exe' },
  );
  assert.equal(command, 'C:\\Harbor.exe');
  assert.deepEqual(args, ['/repo/bin/ai', '--model', 'opus']);
  assert.equal(options.cwd, '/work', 'cwd must survive');
  assert.equal(options.env.HARBOR_KEEP, 'yes', "the caller's env must survive");
  assert.equal(options.env.PATH, '/bin');
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
});

test('a POSIX invocation does not invent an env object the caller did not ask for', () => {
  const { options } = scriptExecArgs('/repo/bin/ai', [], { cwd: '/work' }, { platform: 'linux' });
  assert.equal(options.cwd, '/work');
  assert.equal(options.env, undefined, 'adding an env on POSIX would silently narrow the inherited environment');
});

test('execArgs preserves execFile arity, so a three-argument stub still gets its callback', () => {
  // execFile is overloaded on arity. `resumeSession` has always called
  // `execFile(script, argv, cb)` with no options, and the suite injects a
  // three-parameter stub. Passing an empty options object turns that stub's
  // callback parameter into the options object, so the promise never settles
  // and the resume hangs. Caught by the suite when this fix was first written.
  const posix = scriptExecArgs('/repo/bin/claude-sessions', ['--resume-id', 'x'], {}, { platform: 'linux' });
  assert.equal(posix.execArgs.length, 2, 'POSIX with no options must stay a two-argument lead');
  assert.deepEqual(posix.execArgs, ['/repo/bin/claude-sessions', ['--resume-id', 'x']]);

  const win = scriptExecArgs('/repo/bin/claude-sessions', ['--resume-id', 'x'], {}, { platform: 'win32', execPath: 'C:\\H.exe' });
  assert.equal(win.execArgs.length, 3, 'win32 needs the options object to carry ELECTRON_RUN_AS_NODE');
  assert.equal(win.execArgs[2].env.ELECTRON_RUN_AS_NODE, '1');

  const withCwd = scriptExecArgs('/repo/bin/ai', [], { cwd: '/w' }, { platform: 'linux' });
  assert.equal(withCwd.execArgs.length, 3, 'a caller that passes options still gets them through');
});

test('every bin/ script Harbor executes is valid JavaScript, which is what makes an interpreter work', () => {
  // The sh+node polyglot (`':' //; exec node "$0" "$@"`) is what lets the SAME
  // file be run by sh on POSIX and by node on Windows. If a script were ever
  // written as real shell, naming node as the interpreter would break it, so
  // this is the assumption the fix rests on, checked rather than believed.
  const executed = ['ai', 'claude-sessions', 'harbor-sessiond'];
  const broken = [];
  for (const name of executed) {
    const file = path.join(BIN, name);
    if (!fs.existsSync(file)) continue;
    const head = fs.readFileSync(file, 'utf8').split('\n').slice(0, 3).join('\n');
    const isNodeShebang = /^#!.*\bnode\b/.test(head);
    const isPolyglot = head.includes("':' //") && head.includes('exec node');
    if (!isNodeShebang && !isPolyglot) broken.push(`${name} is not runnable by node (head: ${JSON.stringify(head.split('\n')[0])})`);
  }
  assert.deepEqual(broken, [], `these bin/ scripts cannot be run through a node interpreter:\n  ${broken.join('\n  ')}`);
});

test('no main-process code execs a bin/ script by bare path any more', () => {
  // The regression guard. Any new `execFile(SOME_BIN, ...)` reintroduces the
  // Windows blocker, and it would look correct on the author's Linux machine.
  const roots = [path.join(REPO, 'app', 'src', 'main')];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(abs, 'utf8');
      // Constants that name a bin/ script, used directly as an exec command.
      const re = /(?:execFile|execFileSync|spawn|spawnSync)\(\s*(CLAUDE_SESSIONS|AI_BIN|HARBOR_SESSIOND_BIN)\b/g;
      let m;
      while ((m = re.exec(text))) {
        offenders.push(`${path.relative(REPO, abs)} execs ${m[1]} directly; route it through scriptExecArgs/scriptInvocation`);
      }
    }
  };
  for (const root of roots) walk(root);
  assert.deepEqual(offenders, [], `bin/ scripts executed by bare path (breaks Windows):\n  ${offenders.join('\n  ')}`);
});
