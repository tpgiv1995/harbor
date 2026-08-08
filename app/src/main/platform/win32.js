'use strict';

const path = require('node:path');
const { execFile: execFileCallback, execFileSync, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { available, unavailable } = require('./capabilities.js');

const execFile = promisify(execFileCallback);

function hasCommand(command) {
  try {
    execFileSync('where.exe', [command], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch { return false; }
}

function psScript(pid) {
  return `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue;`
    + 'if($null -eq $p){exit 3};'
    + '$p|Select-Object ProcessId,CommandLine,ExecutionState,CreationDate|ConvertTo-Json -Compress';
}

function createWin32Platform(deps = {}) {
  const env = deps.env || process.env;
  const run = deps.run || ((command, args) => execFile(command, args, {
    encoding: 'utf8', timeout: 3000, windowsHide: true,
  }));
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const spawnProcess = deps.spawn || spawn;
  const logger = deps.logger || console;
  const which = deps.which || hasCommand;

  async function processInfo(pid) {
    let stdout;
    try {
      ({ stdout = '' } = await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', psScript(pid),
      ]));
    } catch (error) {
      if (error?.code === 'ESRCH' || error?.code === 3) return { alive: false, cmdline: '', isAgent: false };
      throw error;
    }
    if (!String(stdout).trim()) return { alive: false, cmdline: '', isAgent: false };
    const record = JSON.parse(String(stdout).trim());
    if (!record.CommandLine) {
      throw new Error(`cannot safely inspect command line for live Windows process ${pid}`);
    }
    const cmdline = String(record.CommandLine);
    // ConvertTo-Json serializes a CIM DateTime as "\/Date(<epoch ms>)\/".
    const created = /\/Date\((\d+)\)\//.exec(String(record.CreationDate || ''));
    return {
      alive: true,
      cmdline,
      isAgent: /(?:^|[\\/"\s])claude(?:\.exe)?(?:["\s]|$)/i.test(cmdline),
      startedAt: created ? Number(created[1]) : null,
    };
  }

  async function alive(pid) {
    try {
      return (await processInfo(pid)).alive;
    } catch (error) {
      if (/cannot safely inspect/.test(error.message)) return true;
      throw error;
    }
  }

  async function killProcess(pid, _signal = 'SIGTERM', options = {}) {
    const initial = await processInfo(pid);
    if (!initial.alive || !initial.isAgent) {
      throw new Error(`refusing to terminate unverified Windows process ${pid}`);
    }
    await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($p){[void]$p.CloseMainWindow()}`,
    ]);
    for (let i = 0; i < (options.gracefulAttempts || deps.gracefulAttempts || 10); i += 1) {
      if (!(await alive(pid))) return { died: true, forced: false };
      await sleep(options.intervalMs || 150);
    }
    const beforeForce = await processInfo(pid);
    if (!beforeForce.alive) return { died: true, forced: false };
    if (!beforeForce.isAgent || beforeForce.cmdline !== initial.cmdline) {
      throw new Error(`refusing to force-kill changed or unverified Windows process ${pid}`);
    }
    await run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
    for (let i = 0; i < (options.forceAttempts || deps.forceAttempts || 20); i += 1) {
      if (!(await alive(pid))) return { died: true, forced: true };
      if (i + 1 < (options.forceAttempts || deps.forceAttempts || 20)) await sleep(options.intervalMs || 150);
    }
    return { died: false, forced: true };
  }

  async function findSessionOwner(sessionId) {
    const script = 'Get-CimInstance Win32_Process|Select-Object ProcessId,CommandLine|ConvertTo-Json -Compress';
    const { stdout = '' } = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script,
    ]);
    if (!String(stdout).trim()) return null;
    const parsed = JSON.parse(String(stdout));
    const records = Array.isArray(parsed) ? parsed : [parsed];
    const match = records.find((record) => record.CommandLine
      && String(record.CommandLine).includes(sessionId)
      && /(?:^|[\\/"\s])claude(?:\.exe)?(?:["\s]|$)/i.test(record.CommandLine));
    return match ? Number(match.ProcessId) : null;
  }

  function herdrTransport() {
    if (!env.HERDR_SOCKET_PATH) {
      throw new Error('HERDR_SOCKET_PATH must name the real Herdr Windows named pipe');
    }
    return env.HERDR_SOCKET_PATH;
  }

  function focusGuard() {
    const reason = 'focus guard is not implemented on win32';
    logger.warn(`Harbor focus guard unavailable: ${reason}`);
    return { available: false, reason };
  }

  function startDaemon(command, args = [], options = {}) {
    const child = spawnProcess(command, args, {
      detached: true, stdio: 'ignore', windowsHide: true, ...options,
    });
    child.unref();
    return child.pid;
  }

  return {
    name: 'win32',
    herdrTransport,
    herdrBin: () => env.HERDR_BIN_PATH || path.join(
      env.LOCALAPPDATA || '',
      'Programs', 'Herdr', 'bin', 'herdr.exe',
    ),
    processInfo,
    findSessionOwner,
    killProcess,
    startDaemon,
    readActiveWindow: () => null,
    focusGuard,
    capabilities: () => ({
      herdrTransport: env.HERDR_SOCKET_PATH
        ? available('configured Windows named pipe')
        : unavailable('HERDR_SOCKET_PATH is required because upstream docs do not publish a stable pipe name'),
      processInfo: available('PowerShell CIM Win32_Process query; inaccessible cmdline refuses'),
      killProcess: available('CloseMainWindow then taskkill /T /F with death verification'),
      clipboardImage: available('Electron clipboard'),
      notify: available('Electron Notification'),
      daemon: available('native Herdr detaches; child launched detached'),
      focusGuard: unavailable('focus guard is not implemented on win32'),
      thumbnailer: {
        pdf: which('pdftoppm') ? available() : unavailable('pdftoppm is not installed'),
        video: which('ffmpeg') ? available() : unavailable('ffmpeg is not installed'),
      },
    }),
    shouldQuitOnWindowAllClosed: () => true,
  };
}

module.exports = { createWin32Platform, psScript };
