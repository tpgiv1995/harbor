'use strict';

const { execFile: execFileCallback, execFileSync, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { available, unavailable } = require('./capabilities.js');
const { SessionClient } = require('../../daemon/client.js');

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

// Deadlines for the PowerShell process questions, sized for the slowest
// honest machine rather than the fastest imaginable one (the 0c0ad4e lesson).
// Measured 2026-08-21 on the real, idle machine: powershell.exe spawn alone
// is ~0.9s, a single-pid Get-CimInstance answer lands at ~3.2s, the
// full-table scan at ~4.8s — and the previous 3000ms execFile timeout killed
// every one of them (3/3 runs), which made adopt-on-send structurally dead
// on win32 (send-log 2026-08-21 05:21:51/05:22:17/05:22:27, each refusal at
// exactly +3.0s). The daemon already sizes this exact query family honestly:
// dormancy 15s, orphan-sweep 20s.
//
// processQuestionDeadlineMs is the OUTER, human-facing deadline the owner
// probe races (createSessionOwnerProbe reads it off the platform); the
// execFile timeout sits ABOVE it so the probe's honest refusal always
// outranks a raw killed-child error while the child is still reaped — the
// same inner/outer ordering daemon.js keeps between keeper requests and the
// client's own timeout.
const PROCESS_QUESTION_DEADLINE_MS = 20000;
const PROCESS_QUERY_REAP_TIMEOUT_MS = 30000;
// The full-table CommandLine JSON is megabytes on a busy box; node's 1MB
// default maxBuffer would kill the scan mid-answer even with time to spare
// (orphan-sweep already carries 32MB for the same reason).
const PROCESS_QUERY_MAX_BUFFER = 32 * 1024 * 1024;
const PROCESS_INTEL_BUDGET_MS = 2000;

function createWin32Platform(deps = {}) {
  const execFileImpl = deps.execFile || execFile;
  const run = deps.run || ((command, args) => execFileImpl(command, args, {
    encoding: 'utf8',
    timeout: PROCESS_QUERY_REAP_TIMEOUT_MS,
    maxBuffer: PROCESS_QUERY_MAX_BUFFER,
    windowsHide: true,
  }));
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const spawnProcess = deps.spawn || spawn;
  const logger = deps.logger || console;
  const which = deps.which || hasCommand;
  const daemonRequest = deps.daemonRequest || (async (verb, params) => {
    const client = new SessionClient({ requestTimeoutMs: PROCESS_INTEL_BUDGET_MS });
    try { return await client.request(verb, params); } finally { client.close(); }
  });

  async function intelRequest(verb, params) {
    try { return await daemonRequest(verb, params); } catch { return null; }
  }

  async function processInfo(pid) {
    const intel = await intelRequest('proc-info', { pid });
    if (intel) {
      if (!intel.alive) return { alive: false, cmdline: '', isAgent: false };
      if (intel.cmdline) return {
        alive: true, cmdline: intel.cmdline,
        isAgent: /(?:^|[\\/"\s])claude(?:\.exe)?(?:["\s]|$)/i.test(intel.cmdline),
        startedAt: Number.isFinite(intel.startedAt) ? intel.startedAt : null,
      };
      // A live process whose native cmdline was denied is not safely identified;
      // CIM retains today's privileged-provider answer.
    }
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
    const intel = await intelRequest('proc-find', { needle: sessionId });
    if (intel) {
      const match = intel.processes?.find((record) => record.cmdline
        && /(?:^|[\\/"\s])claude(?:\.exe)?(?:["\s]|$)/i.test(record.cmdline));
      return match ? Number(match.pid) : null;
    }
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
    processInfo,
    processQuestionDeadlineMs: PROCESS_QUESTION_DEADLINE_MS,
    findSessionOwner,
    killProcess,
    startDaemon,
    readActiveWindow: () => null,
    focusGuard,
    capabilities: () => ({
      processInfo: available('PowerShell CIM Win32_Process query; inaccessible cmdline refuses'),
      killProcess: available('CloseMainWindow then taskkill /T /F with death verification'),
      clipboardImage: available('Electron clipboard'),
      notify: available('Electron Notification'),
      daemon: available('native session daemon detaches; child launched detached'),
      focusGuard: unavailable('focus guard is not implemented on win32'),
      thumbnailer: {
        pdf: which('pdftoppm') ? available() : unavailable('pdftoppm is not installed'),
        video: which('ffmpeg') ? available() : unavailable('ffmpeg is not installed'),
      },
    }),
    shouldQuitOnWindowAllClosed: () => true,
  };
}

module.exports = { createWin32Platform, psScript, PROCESS_INTEL_BUDGET_MS };
