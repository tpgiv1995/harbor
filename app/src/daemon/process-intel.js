'use strict';

const path = require('node:path');

const FILETIME_EPOCH_MS = 11644473600000;
// Two seconds keeps app-side questions inside their fast-path budget while
// avoiding needless kernel-table churn. CPU/orphan sweeps explicitly refresh
// at their decision boundary, so their cadence is independent of this timer.
const DEFAULT_REFRESH_MS = 2000;
const DEFAULT_STALE_MS = 5000;

function loadNative() {
  const koffi = require('koffi');
  const ntdll = koffi.load('ntdll.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const querySystem = ntdll.func('NtQuerySystemInformation', 'int32', ['int32', 'void*', 'uint32', 'void*']);
  const queryProcess = ntdll.func('NtQueryInformationProcess', 'int32', ['void*', 'int32', 'void*', 'uint32', 'void*']);
  const openProcess = kernel32.func('OpenProcess', 'void*', ['uint32', 'int32', 'uint32']);
  const closeHandle = kernel32.func('CloseHandle', 'int32', ['void*']);
  const lastError = kernel32.func('GetLastError', 'uint32', []);
  const mismatch = 0xc0000004 | 0;
  const offsets = { next: 0, created: 0x20, user: 0x28, kernel: 0x30, nameLen: 0x38, namePtr: 0x40, pid: 0x50, ppid: 0x58, workingSet: 0x90, privateBytes: 0xc8 };
  let buffer = Buffer.alloc(2 * 1024 * 1024);
  const returned = Buffer.alloc(4);
  return {
    snapshot() {
      for (;;) {
        const status = querySystem(5, buffer, buffer.length, returned);
        if (status === 0) break;
        if (status !== mismatch) throw new Error(`NtQuerySystemInformation failed: 0x${(status >>> 0).toString(16)}`);
        buffer = Buffer.alloc(Math.max(buffer.length * 2, returned.readUInt32LE(0) + 65536));
      }
      const table = new Map();
      const base = BigInt(koffi.address(buffer));
      let offset = 0;
      for (;;) {
        const pid = Number(buffer.readBigUInt64LE(offset + offsets.pid));
        const length = buffer.readUInt16LE(offset + offsets.nameLen);
        const pointer = buffer.readBigUInt64LE(offset + offsets.namePtr);
        const relative = Number(pointer - base);
        const name = length && relative >= 0 && relative + length <= buffer.length
          ? buffer.toString('utf16le', relative, relative + length) : '';
        table.set(pid, {
          pid, ppid: Number(buffer.readBigUInt64LE(offset + offsets.ppid)), name,
          created: buffer.readBigInt64LE(offset + offsets.created),
          cpuUsec: Number((buffer.readBigInt64LE(offset + offsets.user) + buffer.readBigInt64LE(offset + offsets.kernel)) / 10n),
          workingSet: Number(buffer.readBigUInt64LE(offset + offsets.workingSet)),
          privateBytes: Number(buffer.readBigUInt64LE(offset + offsets.privateBytes)),
        });
        const next = buffer.readUInt32LE(offset + offsets.next);
        if (!next) break;
        offset += next;
      }
      return table;
    },
    commandLine(pid) {
      const handle = openProcess(0x1000, 0, pid);
      if (!handle) return { ok: false, error: `OpenProcess: ${lastError()}` };
      try {
        let output = Buffer.alloc(4096);
        for (;;) {
          const status = queryProcess(handle, 60, output, output.length, returned);
          if (status === 0) break;
          if (status !== mismatch || output.length >= 1024 * 1024) return { ok: false, error: `NtQueryInformationProcess: 0x${(status >>> 0).toString(16)}` };
          output = Buffer.alloc(Math.max(output.length * 2, returned.readUInt32LE(0) + 16));
        }
        const length = output.readUInt16LE(0);
        const relative = Number(output.readBigUInt64LE(8) - BigInt(koffi.address(output)));
        if (relative < 0 || relative + length > output.length) return { ok: false, error: 'cmdline pointer outside buffer' };
        return { ok: true, cmdline: output.toString('utf16le', relative, relative + length) };
      } finally { closeHandle(handle); }
    },
  };
}

function createProcessIntel(options = {}) {
  const clock = options.clock || Date.now;
  const log = options.log || (() => {});
  const platform = options.platform || process.platform;
  const refreshMs = Number(options.refreshMs ?? process.env.HARBOR_SESSIOND_INTEL_REFRESH_MS ?? DEFAULT_REFRESH_MS);
  const staleMs = Number(options.staleMs ?? process.env.HARBOR_SESSIOND_INTEL_STALE_MS ?? DEFAULT_STALE_MS);
  let native = options.native || null;
  let table = null;
  let capturedAt = 0;
  let timer = null;
  let failure = null;
  let logged = false;
  const cmdlines = new Map();

  function disable(error) {
    failure = error instanceof Error ? error : new Error(String(error));
    table = null;
    if (!logged) { logged = true; log(`process intel unavailable: ${failure.message}; using PowerShell CIM fallback`); }
    return null;
  }
  function refresh() {
    if (failure) return null;
    try {
      if (!native) native = loadNative();
      const next = native.snapshot();
      const self = next.get(process.pid);
      if (!self || self.ppid !== process.ppid || !/^(node|electron)(\.exe)?$/i.test(path.win32.basename(self.name || ''))) {
        throw new Error(`SYSTEM_PROCESS_INFORMATION layout self-check failed (pid=${process.pid}, ppid=${self?.ppid}, name=${self?.name || ''})`);
      }
      table = next;
      capturedAt = clock();
      for (const [key] of cmdlines) {
        const [pid, created] = key.split(':');
        if (String(next.get(Number(pid))?.created) !== created) cmdlines.delete(key);
      }
      return table;
    } catch (error) { return disable(error); }
  }
  function fresh() { return table && clock() - capturedAt <= staleMs ? table : null; }
  function age() { return table ? Math.max(0, clock() - capturedAt) : null; }
  function cmdline(pid, source = fresh()) {
    const row = source?.get(pid);
    if (!row) return '';
    const key = `${pid}:${row.created}`;
    if (!cmdlines.has(key)) {
      const answer = native.commandLine(pid);
      cmdlines.set(key, answer?.ok ? String(answer.cmdline || '') : '');
    }
    return cmdlines.get(key);
  }
  function info(pid) {
    const source = fresh();
    if (!source) return null;
    const row = source.get(pid);
    if (!row) return { age_ms: age(), alive: false, pid };
    const command = cmdline(pid, source);
    return { age_ms: age(), alive: true, pid, ppid: row.ppid, name: row.name, cmdline: command, created: Number(row.created), startedAt: Number(row.created) / 10000 - FILETIME_EPOCH_MS, cpuUsec: row.cpuUsec, workingSet: row.workingSet, privateBytes: row.privateBytes };
  }
  function tree(pid, { maxDepth = 12, maxNodes = 64 } = {}) {
    const source = fresh();
    if (!source || !source.has(pid)) return null;
    const children = new Map();
    for (const row of source.values()) { if (!children.has(row.ppid)) children.set(row.ppid, []); children.get(row.ppid).push(row.pid); }
    const rows = []; const queue = [{ pid, depth: 0 }]; const seen = new Set();
    while (queue.length && rows.length < maxNodes) {
      const item = queue.shift();
      if (seen.has(item.pid) || item.depth >= maxDepth) continue;
      seen.add(item.pid);
      const row = source.get(item.pid); if (!row) continue;
      rows.push({ pid: row.pid, ppid: row.ppid, name: row.name, cmdline: cmdline(row.pid, source), created: Number(row.created), startedAt: Number(row.created) / 10000 - FILETIME_EPOCH_MS, depth: item.depth });
      for (const child of children.get(item.pid) || []) queue.push({ pid: child, depth: item.depth + 1 });
    }
    return { age_ms: age(), processes: rows };
  }
  function find(needle) {
    const source = fresh();
    if (!source) return null;
    const matches = [];
    if (!needle) return { age_ms: age(), processes: matches };
    for (const row of source.values()) { const command = cmdline(row.pid, source); if (command && command.includes(needle)) matches.push({ pid: row.pid, ppid: row.ppid, name: row.name, cmdline: command, created: Number(row.created) }); }
    return { age_ms: age(), processes: matches };
  }
  function cpuTable() { const source = fresh(); return source && new Map([...source].map(([pid, row]) => [pid, { ppid: row.ppid, cpuUsec: row.cpuUsec }])); }
  function orphanTable() { const source = fresh(); return source && new Map([...source].map(([pid, row]) => [pid, { ppid: row.ppid, command: cmdline(pid, source), created: Number(row.created) }])); }
  function alive(pid, created) { const row = fresh()?.get(pid); return Boolean(row && (created === undefined || String(row.created) === String(created))); }
  function start() { if (platform !== 'win32' || process.env.HARBOR_SESSIOND_NO_INTEL === '1') return disable(new Error(platform !== 'win32' ? 'not win32' : 'opted out')); refresh(); if (!failure && refreshMs > 0) { timer = setInterval(refresh, refreshMs); timer.unref?.(); } return !failure; }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { start, stop, refresh, info, tree, find, cmdline, alive, cpuTable, orphanTable, age, get available() { return !failure && Boolean(table); }, get reason() { return failure?.message || null; } };
}

module.exports = { createProcessIntel, FILETIME_EPOCH_MS, DEFAULT_REFRESH_MS, DEFAULT_STALE_MS };
