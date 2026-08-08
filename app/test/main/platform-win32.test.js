'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWin32Platform } = require('../../src/main/platform/win32.js');

test('win32 requires the real named pipe to be configured and reports absence honestly', () => {
  const missing = createWin32Platform({ env: {} });
  assert.throws(() => missing.herdrTransport(), /HERDR_SOCKET_PATH/);
  assert.equal(missing.capabilities().herdrTransport.available, false);

  const configured = createWin32Platform({ env: { HERDR_SOCKET_PATH: '\\\\.\\pipe\\herdr-real' } });
  assert.equal(configured.herdrTransport(), '\\\\.\\pipe\\herdr-real');
  assert.equal(configured.capabilities().herdrTransport.available, true);
});

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
  const platform = createWin32Platform({ run });
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
    gracefulAttempts: 1,
  });
  await assert.rejects(() => platform.killProcess(202), /refusing to force-kill changed or unverified/);
  assert.equal(calls.some(([command]) => command === 'taskkill.exe'), false);
});

test('win32 focus guard is an honest unavailable operation', () => {
  const logs = [];
  const platform = createWin32Platform({ logger: { warn: (message) => logs.push(message) } });
  assert.deepEqual(platform.focusGuard(), { available: false, reason: 'focus guard is not implemented on win32' });
  assert.match(logs[0], /unavailable/);
});
