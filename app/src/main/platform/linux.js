'use strict';

const fs = require('node:fs/promises');
const { execFileSync, spawn } = require('node:child_process');
const { available, unavailable, commandAvailable } = require('./capabilities.js');
const linuxFocus = require('../focus-guard.js');

function gone(error) {
  return error?.code === 'ENOENT' || error?.code === 'ESRCH';
}

function defaultWhich(command) {
  execFileSync('sh', ['-lc', `command -v -- "$1"`, 'sh', command], { stdio: 'ignore' });
  return true;
}

function createLinuxPlatform(deps = {}) {
  const readFile = deps.readFile || fs.readFile;
  const readdir = deps.readdir || fs.readdir;
  const processKill = deps.processKill || process.kill.bind(process);
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const spawnProcess = deps.spawn || spawn;
  const which = deps.which || defaultWhich;

  // Boot time (epoch ms) from /proc/stat btime, read once: process start
  // times in /proc are ticks since boot, not since the epoch.
  let bootTimeMsPromise = null;
  function bootTimeMs() {
    bootTimeMsPromise ||= (async () => {
      const stat = String(await readFile('/proc/stat'));
      const match = /^btime (\d+)$/m.exec(stat);
      if (!match) throw new Error('no btime in /proc/stat');
      return Number(match[1]) * 1000;
    })();
    return bootTimeMsPromise;
  }

  // Epoch ms the process started, or null when unreadable. Field 22 of
  // /proc/<pid>/stat is the start time in USER_HZ ticks since boot; USER_HZ
  // is fixed at 100 for the /proc ABI regardless of the kernel's CONFIG_HZ.
  // comm (field 2) can itself contain spaces and parens, so the numeric
  // fields are taken after the LAST ')'.
  async function processStartedAt(pid) {
    try {
      const stat = String(await readFile(`/proc/${pid}/stat`));
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = Number(rest[19]);
      if (!Number.isFinite(ticks)) return null;
      return (await bootTimeMs()) + ticks * 10;
    } catch { return null; }
  }

  async function processInfo(pid) {
    try {
      const cmdline = String(await readFile(`/proc/${pid}/cmdline`));
      if (!cmdline) return { alive: false, cmdline: '', isAgent: false };
      const isAgent = /claude/i.test(cmdline);
      if (!isAgent) return { alive: true, cmdline, isAgent: false };
      try {
        processKill(pid, 0);
      } catch (error) {
        if (gone(error)) return { alive: false, cmdline: '', isAgent: false };
        throw error;
      }
      return { alive: true, cmdline, isAgent: true, startedAt: await processStartedAt(pid) };
    } catch (error) {
      if (gone(error)) return { alive: false, cmdline: '', isAgent: false };
      throw error;
    }
  }

  async function killProcess(pid, signal = 'SIGTERM', options = {}) {
    processKill(pid, signal);
    const attempts = options.attempts || 40;
    let forced = signal === 'SIGKILL';
    for (let i = 0; i < attempts; i += 1) {
      try {
        processKill(pid, 0);
      } catch (error) {
        if (gone(error)) return { died: true, forced };
        throw error;
      }
      if (!forced && i === (options.forceAttempt ?? 20)) {
        processKill(pid, 'SIGKILL');
        forced = true;
      }
      if (i + 1 < attempts) await sleep(options.intervalMs || 150);
    }
    return { died: false, forced };
  }

  async function findSessionOwner(sessionId) {
    let entries;
    try { entries = await readdir('/proc'); } catch { return null; }
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const cmdline = String(await readFile(`/proc/${name}/cmdline`));
        if (cmdline.includes(sessionId) && /claude/i.test(cmdline)) return Number(name);
      } catch { /* process exited during scan */ }
    }
    return null;
  }

  function startDaemon(command, args = [], options = {}) {
    const child = spawnProcess(command, args, { detached: true, stdio: 'ignore', ...options });
    child.unref();
    return child.pid;
  }

  function capabilities() {
    const tool = (name) => commandAvailable(name, which) ? available() : unavailable(`${name} is not installed`);
    return {
      processInfo: available('/proc cmdline verification'),
      killProcess: available('POSIX signals'),
      clipboardImage: available('Electron clipboard'),
      notify: available('Electron Notification'),
      daemon: tool('systemd-run'),
      focusGuard: commandAvailable('wmctrl', which) && commandAvailable('xprop', which)
        ? available('X11 wmctrl and _NET_ACTIVE_WINDOW')
        : unavailable('wmctrl and xprop are required'),
      thumbnailer: { pdf: tool('pdftoppm'), video: tool('ffmpeg') },
    };
  }

  return {
    name: 'linux',
    processInfo,
    findSessionOwner,
    killProcess,
    startDaemon,
    readActiveWindow: (options) => linuxFocus.readActiveWindow(options),
    focusGuard: (win, options) => linuxFocus.guardAgainstFocusSteal(win, options),
    capabilities,
    shouldQuitOnWindowAllClosed: () => true,
  };
}

module.exports = { createLinuxPlatform };
