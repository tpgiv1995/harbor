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

  function startDaemon(command, args = [], options = {}) {
    const label = options.label || 'com.harbor.session-daemon';
    const child = spawnProcess('launchctl', ['submit', '-l', label, '--', command, ...args], {
      detached: true, stdio: 'ignore',
    });
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
