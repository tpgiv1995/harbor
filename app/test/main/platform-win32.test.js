'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWin32Platform } = require('../../src/main/platform/win32.js');

test('win32 parses real PowerShell CIM JSON and refuses an inaccessible live command line', async () => {
  const outputs = new Map([
    [101, '{"ProcessId":101,"CommandLine":"claude.exe --resume abc","ExecutionState":null,"CreationDate":"\\/Date(1753772400000)\\/"}'],
    [102, '{"ProcessId":102,"CommandLine":"powershell.exe","ExecutionState":null}'],
    [103, '{"ProcessId":103,"CommandLine":null,"ExecutionState":null}'],
  ]);
  const run = async (_command, args) => {
    const pid = Number(/ProcessId=(\d+)/.exec(args.at(-1))[1]);
    if (!outputs.has(pid)) { const error = new Error('not found'); error.code = 'ESRCH'; throw error; }
    return { stdout: outputs.get(pid) };
  };
  // No daemon intel: these cases are about the PowerShell fallback. Without
  // the injection the adapter's default asks the REAL user daemon, which
  // answered "pid 101 is not alive" on the gate machine and failed the case
  // (2026-09-03); a test must never reach the real daemon.
  const platform = createWin32Platform({ run, daemonRequest: async () => null });
  assert.deepEqual(await platform.processInfo(101), { alive: true, cmdline: 'claude.exe --resume abc', isAgent: true, startedAt: 1753772400000 });
  assert.deepEqual(await platform.processInfo(102), { alive: true, cmdline: 'powershell.exe', isAgent: false, startedAt: null });
  await assert.rejects(() => platform.processInfo(103), /cannot safely inspect command line/);
  assert.deepEqual(await platform.processInfo(104), { alive: false, cmdline: '', isAgent: false });
});

test('win32 killProcess requests graceful close, escalates with taskkill, and re-verifies', async () => {
  const calls = [];
  let checks = 0;
  const platform = createWin32Platform({
    run: async (command, args) => {
      calls.push([command, args]);
      if (command === 'powershell.exe' && args.at(-1).includes('Get-CimInstance')) {
        checks += 1;
        if (checks > 3) { const error = new Error('not found'); error.code = 'ESRCH'; throw error; }
        return { stdout: '{"ProcessId":201,"CommandLine":"claude.exe","ExecutionState":null}' };
      }
      return { stdout: '' };
    },
    sleep: async () => {},
    daemonRequest: async () => null,
    gracefulAttempts: 1,
    forceAttempts: 2,
  });
  assert.equal((await platform.killProcess(201, 'SIGTERM')).died, true);
  assert.ok(calls.some(([cmd, args]) => cmd === 'powershell.exe' && args.at(-1).includes('CloseMainWindow')));
  assert.ok(calls.some(([cmd, args]) => cmd === 'taskkill.exe' && args.includes('/F')));
});

test('win32 refuses force-kill when the pid was recycled during graceful shutdown', async () => {
  let inspections = 0;
  const calls = [];
  const platform = createWin32Platform({
    run: async (command, args) => {
      calls.push([command, args]);
      if (command === 'powershell.exe' && args.at(-1).includes('Get-CimInstance')) {
        inspections += 1;
        const commandLine = inspections < 3 ? 'claude.exe --resume abc' : 'notepad.exe';
        return { stdout: JSON.stringify({ ProcessId: 202, CommandLine: commandLine, ExecutionState: null }) };
      }
      return { stdout: '' };
    },
    sleep: async () => {},
    daemonRequest: async () => null,
    gracefulAttempts: 1,
  });
  await assert.rejects(() => platform.killProcess(202), /refusing to force-kill changed or unverified/);
  assert.equal(calls.some(([command]) => command === 'taskkill.exe'), false);
});

// The owner probe's deadline was calibrated for /proc, where a process
// question answers in microseconds; on win32 the same question is a
// powershell.exe spawn plus a cold CIM session, measured on the real machine
// at ~3.2s for one pid and ~4.8s for the full table (2026-08-21, idle). The
// shipped 3000ms execFile timeout therefore killed EVERY query — three real
// takeover attempts that night each refused at exactly +3.0s — so the
// platform names the honest deadline itself, the way dormancy (15s) and the
// orphan sweep (20s) already size this exact query family.
test('win32 names an honest process-question deadline sized for the measured CIM cost', () => {
  const platform = createWin32Platform({ run: async () => ({ stdout: '' }) });
  assert.ok(
    platform.processQuestionDeadlineMs >= 15000,
    `deadline ${platform.processQuestionDeadlineMs}ms must cover the ~4.8s honest full-table answer with headroom for the loaded machine`,
  );
});

// Two layers must agree or the outer one is fiction: the probe races
// processQuestionDeadlineMs, and the child's own execFile timeout must sit
// ABOVE it so the human-facing refusal is always the probe's honest message
// while the child is still reaped (the same inner/outer ordering daemon.js
// keeps between keeper requests and the client timeout). And the full-table
// CommandLine JSON is megabytes on a busy box: node's 1MB default maxBuffer
// would kill the scan mid-answer even with time to spare (the orphan sweep
// already carries 32MB for the same reason).
test('the default runner gives PowerShell room past the platform deadline and the table scan room to answer at all', async () => {
  const captured = [];
  const execFile = async (command, args, opts) => {
    captured.push({ command, args, opts });
    if (String(args.at(-1)).includes('ProcessId=')) {
      return { stdout: '{"ProcessId":101,"CommandLine":"claude.exe","ExecutionState":null}' };
    }
    return { stdout: '[]' };
  };
  const platform = createWin32Platform({ execFile, daemonRequest: async () => null });
  assert.ok(
    Number.isFinite(platform.processQuestionDeadlineMs),
    'the platform must name its process-question deadline',
  );
  await platform.processInfo(101);
  await platform.findSessionOwner('abc');
  assert.equal(captured.length, 2, 'the default runner must run through the injectable execFile');
  for (const { command, opts } of captured) {
    assert.equal(command, 'powershell.exe');
    assert.ok(
      opts.timeout > platform.processQuestionDeadlineMs,
      `execFile timeout ${opts.timeout}ms must outlive the probe deadline ${platform.processQuestionDeadlineMs}ms`,
    );
    assert.ok(
      opts.maxBuffer >= 16 * 1024 * 1024,
      `maxBuffer ${opts.maxBuffer} must hold a full process table's CommandLine JSON`,
    );
  }
});

test('win32 focus guard is an honest unavailable operation', () => {
  const logs = [];
  const platform = createWin32Platform({ logger: { warn: (message) => logs.push(message) } });
  assert.deepEqual(platform.focusGuard(), { available: false, reason: 'focus guard is not implemented on win32' });
  assert.match(logs[0], /unavailable/);
});

test('win32 process questions prefer daemon intel and do not spawn PowerShell', async () => {
  let runs = 0;
  const platform = createWin32Platform({
    daemonRequest: async (verb) => verb === 'proc-info'
      ? { alive: true, cmdline: 'claude --session-id fast', startedAt: 123 }
      : { processes: [{ pid: 77, cmdline: 'claude --session-id fast' }] },
    run: async () => { runs += 1; throw new Error('must not spawn'); },
  });
  assert.deepEqual(await platform.processInfo(77), { alive: true, cmdline: 'claude --session-id fast', isAgent: true, startedAt: 123 });
  assert.equal(await platform.findSessionOwner('fast'), 77);
  assert.equal(runs, 0);
});

test('win32 process questions fall back unchanged when daemon intel is down', async () => {
  let runs = 0;
  const platform = createWin32Platform({
    daemonRequest: async () => { throw new Error('daemon down'); },
    run: async (_command, args) => {
      runs += 1;
      return args.at(-1).includes('ProcessId=88')
        ? { stdout: JSON.stringify({ ProcessId: 88, CommandLine: 'claude --session-id fallback', CreationDate: '/Date(456)/' }) }
        : { stdout: JSON.stringify([{ ProcessId: 88, CommandLine: 'claude --session-id fallback' }]) };
    },
  });
  assert.equal((await platform.processInfo(88)).startedAt, 456);
  assert.equal(await platform.findSessionOwner('fallback'), 88);
  assert.equal(runs, 2);
});
