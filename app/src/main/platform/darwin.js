'use strict';

const { execFile: execFileCallback, execFileSync, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { available, unavailable } = require('./capabilities.js');

const execFile = promisify(execFileCallback);

function hasCommand(command) {
  try {
    execFileSync('/usr/bin/which', [command], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function createDarwinPlatform(deps = {}) {
  const run = deps.run || ((command, args) => execFile(command, args, { encoding: 'utf8', timeout: 2000 }));
  const processKill = deps.processKill || process.kill.bind(process);
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const spawnProcess = deps.spawn || spawn;
  const logger = deps.logger || console;
  const which = deps.which || hasCommand;

  // ps etime ([[dd-]hh:]mm:ss) to milliseconds, or null when unparseable.
  function etimeToMs(text) {
    const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text).trim());
    if (!match) return null;
    const [, dd, hh, mm, ss] = match;
    return (((Number(dd || 0) * 24 + Number(hh || 0)) * 60 + Number(mm)) * 60 + Number(ss)) * 1000;
  }

  async function processInfo(pid) {
    const { stdout = '' } = await run('ps', ['-p', String(pid), '-o', 'state=,etime=,command=']);
    const line = String(stdout).trim();
    if (!line) return { alive: false, cmdline: '', isAgent: false };
    const match = /^(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) throw new Error(`cannot safely inspect process ${pid} on darwin`);
    if (match[1].startsWith('Z')) return { alive: false, cmdline: '', isAgent: false };
    const cmdline = match[3].trim();
    if (!cmdline) throw new Error(`cannot safely inspect process ${pid} on darwin`);
    const elapsed = etimeToMs(match[2]);
    return {
      alive: true,
      cmdline,
      isAgent: /claude/i.test(cmdline),
      startedAt: elapsed == null ? null : Date.now() - elapsed,
    };
  }

  async function killProcess(pid, signal = 'SIGTERM', options = {}) {
    processKill(pid, signal);
    let forced = signal === 'SIGKILL';
    for (let i = 0; i < (options.attempts || 40); i += 1) {
      const info = await processInfo(pid);
      if (!info.alive) return { died: true, forced };
      if (!forced && i === (options.forceAttempt ?? 20)) {
        processKill(pid, 'SIGKILL');
        forced = true;
      }
      if (i + 1 < (options.attempts || 40)) await sleep(options.intervalMs || 150);
    }
    return { died: false, forced };
  }

  async function findSessionOwner(sessionId) {
    const { stdout = '' } = await run('ps', ['-ax', '-o', 'pid=,state=,command=']);
    for (const line of String(stdout).split('\n')) {
      const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!match || match[2].startsWith('Z')) continue;
      if (match[3].includes(sessionId) && /claude/i.test(match[3])) return Number(match[1]);
    }
    return null;
  }

  function focusGuard() {
    const reason = 'focus guard is not implemented on darwin';
    logger.warn(`Harbor focus guard unavailable: ${reason}`);
    return { available: false, reason };
  }

  // A DETACHED SPAWN, not `launchctl submit` (2026-08-28, after Harbor opened
  // on a packaged macOS build showing "Terminal daemon unreachable" and could
  // not recover on its own for the rest of the boot).
  //
  // `launchctl submit -l <label> -- <script> start` was wrong in three ways at
  // once, and every one of them was invisible because the submit's own stdio is
  // ignored and its exit status was never read:
  //
  //   1. A SUBMITTED JOB RUNS IN LAUNCHD'S ENVIRONMENT, NOT THE CALLER'S, so
  //      `options.env` was discarded before it could reach the daemon — and
  //      that is exactly what carries ELECTRON_RUN_AS_NODE for a packaged app
  //      (see script-exec.js). No fix at the caller can survive while submit is
  //      in the path.
  //   2. THE LABEL IS NEVER CLEARED. On the failing machine `launchctl list`
  //      showed the submitted job parked at exit status 127 — `/usr/bin/env
  //      node` finding no node on launchd's `/usr/bin:/bin:/usr/sbin:/sbin`,
  //      because macOS ships none and Homebrew's is off that PATH. launchctl
  //      refuses a label that is already taken, so that ONE failed start wedged
  //      auto-start for the rest of the boot: restarting the app could not fix
  //      it, and nothing anywhere said why.
  //   3. The pid returned was `launchctl`'s, never the daemon's, so a caller
  //      that trusted it was watching a process that had already exited.
  //
  // linux.js and win32.js have always used a plain detached spawn and neither
  // has ever had this failure mode; darwin was the odd one out. Nothing is lost
  // by dropping launchd here, because `bin/harbor-sessiond start` already owns
  // every lifecycle decision it was standing in for: the already-running gate,
  // the detached spawn, and the health wait that decides "started" by a real
  // request rather than by a fork having happened.
  function startDaemon(command, args = [], options = {}) {
    const child = spawnProcess(command, args, { detached: true, stdio: 'ignore', ...options });
    child.unref();
    return child.pid;
  }

  return {
    name: 'darwin',
    processInfo,
    findSessionOwner,
    killProcess,
    startDaemon,
    readActiveWindow: () => null,
    focusGuard,
    capabilities: () => ({
      processInfo: available('ps state and command verification'),
      killProcess: available('POSIX signals'),
      clipboardImage: available('Electron clipboard'),
      notify: available('Electron Notification'),
      daemon: available('detached launch; launchd validation pending'),
      focusGuard: unavailable('focus guard is not implemented on darwin'),
      thumbnailer: {
        pdf: which('pdftoppm') ? available() : unavailable('pdftoppm is not installed'),
        video: which('ffmpeg') ? available() : unavailable('ffmpeg is not installed'),
      },
    }),
    shouldQuitOnWindowAllClosed: () => false,
  };
}

module.exports = { createDarwinPlatform };
