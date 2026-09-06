'use strict';

// ONE WINDOWS SESSION IS ONE JOB OBJECT. Keep the ABI surface deliberately
// small and marshal the two Win32 structures by explicit offsets: these are
// the offsets measured under both system Node and Electron's embedded Node in
// orch-inputs/r1-win-native.md.
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const JOB_OBJECT_ALL_ACCESS = 0x1f003f;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
const JOB_OBJECT_LIMIT_JOB_MEMORY = 0x0200;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JobObjectBasicAccountingInformation = 1;
const JobObjectBasicProcessIdList = 3;
const JobObjectExtendedLimitInformation = 9;
const EXT_LIMIT_SIZE = 144;
const BASIC_ACCT_SIZE = 48;

let api = null;
let loadError = null;

function nativeApi() {
  if (api || loadError) return api;
  try {
    const koffi = require('koffi');
    const kernel32 = koffi.load('kernel32.dll');
    api = {
      create: kernel32.func('CreateJobObjectW', 'void*', ['void*', 'str16']),
      open: kernel32.func('OpenJobObjectW', 'void*', ['uint32', 'int32', 'str16']),
      set: kernel32.func('SetInformationJobObject', 'int32', ['void*', 'int32', 'void*', 'uint32']),
      query: kernel32.func('QueryInformationJobObject', 'int32', ['void*', 'int32', 'void*', 'uint32', 'void*']),
      assign: kernel32.func('AssignProcessToJobObject', 'int32', ['void*', 'void*']),
      terminate: kernel32.func('TerminateJobObject', 'int32', ['void*', 'uint32']),
      openProcess: kernel32.func('OpenProcess', 'void*', ['uint32', 'int32', 'uint32']),
      close: kernel32.func('CloseHandle', 'int32', ['void*']),
      lastError: kernel32.func('GetLastError', 'uint32', []),
    };
  } catch (error) { loadError = error; }
  return api;
}

function defaultStore(env) {
  return env.HARBOR_SESSIOND_DIR || path.join(os.homedir(), '.local/state/harbor/sessiond');
}

function resolveJobPolicy(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return { enabled: false, reason: 'not win32' };
  if (env.HARBOR_SESSIOND_NO_JOB === '1') return { enabled: false, reason: 'opted out (HARBOR_SESSIOND_NO_JOB=1)' };
  const relocated = Boolean(env.HARBOR_SESSIOND_DIR || env.HARBOR_SESSIOND_SOCKET);
  const namespace = env.HARBOR_SESSIOND_JOB_NAMESPACE;
  if (relocated && !namespace) {
    return { enabled: false, reason: 'relocated store did not name its own job namespace (HARBOR_SESSIOND_JOB_NAMESPACE)' };
  }
  if (!nativeApi()) return { enabled: false, reason: `koffi/Win32 unavailable: ${loadError?.message || 'unknown error'}` };
  return {
    enabled: true,
    namespace: namespace || null,
    store: defaultStore(env),
    memoryMax: parseByteLimit(env.HARBOR_SESSIOND_SESSION_JOB_MEMORY_MAX),
  };
}

function parseByteLimit(value) {
  if (value === undefined || value === null || value === '') return null;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?i?b?)?$/i);
  if (!match) return null;
  const units = { '': 1, b: 1, k: 1024, kb: 1024, kib: 1024, m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4 };
  const multiplier = units[(match[2] || '').toLowerCase()];
  if (!multiplier) return null;
  const bytes = Math.floor(Number(match[1]) * multiplier);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

function jobName(id, policy) {
  const cleanId = String(id).replace(/[^A-Za-z0-9._-]/g, '-');
  const identity = policy.namespace || policy.store;
  const tag = crypto.createHash('sha1').update(String(identity)).digest('hex').slice(0, 16);
  return `Local\\harbor-session-${cleanId}-${tag}`;
}

function fail(operation) {
  throw new Error(`${operation} failed: Win32 error ${nativeApi().lastError()}`);
}

// The job is created UNARMED (no kill-on-close): the daemon is the sole
// holder until the keeper opens its own handle, and a sole holder dying must
// not take the live session with it (f8 finding M1). The KEEPER arms the flag
// once it holds, via armKillOnClose below.
function configure(handle, policy) {
  const buffer = Buffer.alloc(EXT_LIMIT_SIZE);
  let flags = 0;
  if (policy.memoryMax) {
    flags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
    buffer.writeBigUInt64LE(BigInt(policy.memoryMax), 120);
  }
  buffer.writeUInt32LE(flags, 16);
  if (!nativeApi().set(handle, JobObjectExtendedLimitInformation, buffer, buffer.length)) fail('SetInformationJobObject');
}

// Read-modify-write so arming never drops a configured memory limit.
function armKillOnClose(job) {
  if (!job?.handle) return false;
  const buffer = Buffer.alloc(EXT_LIMIT_SIZE);
  if (!nativeApi().query(job.handle, JobObjectExtendedLimitInformation, buffer, buffer.length, null)) fail('QueryInformationJobObject(limits)');
  buffer.writeUInt32LE(buffer.readUInt32LE(16) | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
  if (!nativeApi().set(job.handle, JobObjectExtendedLimitInformation, buffer, buffer.length)) fail('SetInformationJobObject(arm)');
  return true;
}

function createSessionJob(id, policy) {
  if (!policy?.enabled) return null;
  const name = jobName(id, policy);
  const handle = nativeApi().create(null, name);
  if (!handle) fail(`CreateJobObjectW(${name})`);
  try { configure(handle, policy); }
  catch (error) { nativeApi().close(handle); throw error; }
  return { id, name, handle };
}

function openSessionJob(id, policy) {
  if (!policy?.enabled) return null;
  const name = jobName(id, policy);
  const handle = nativeApi().open(JOB_OBJECT_ALL_ACCESS, 0, name);
  if (!handle) return null;
  return { id, name, handle };
}

function assignPid(job, pid) {
  if (!job) return false;
  const processHandle = nativeApi().openProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
  if (!processHandle) fail(`OpenProcess(${pid})`);
  try {
    if (!nativeApi().assign(job.handle, processHandle)) fail(`AssignProcessToJobObject(${pid})`);
    return true;
  } finally { nativeApi().close(processHandle); }
}

function queryJob(job, maxPids = 4096) {
  if (!job) return null;
  const acct = Buffer.alloc(BASIC_ACCT_SIZE);
  if (!nativeApi().query(job.handle, JobObjectBasicAccountingInformation, acct, acct.length, null)) fail('QueryInformationJobObject(accounting)');
  const limits = Buffer.alloc(EXT_LIMIT_SIZE);
  if (!nativeApi().query(job.handle, JobObjectExtendedLimitInformation, limits, limits.length, null)) fail('QueryInformationJobObject(limits)');
  const list = Buffer.alloc(8 + maxPids * 8);
  if (!nativeApi().query(job.handle, JobObjectBasicProcessIdList, list, list.length, null)) fail('QueryInformationJobObject(processes)');
  const count = list.readUInt32LE(4);
  const pids = [];
  for (let i = 0; i < count; i += 1) pids.push(Number(list.readBigUInt64LE(8 + i * 8)));
  const cpu100ns = acct.readBigInt64LE(0) + acct.readBigInt64LE(8);
  return {
    cpuUsec: Number(cpu100ns / 10n),
    totalProcesses: acct.readUInt32LE(36),
    activeProcesses: acct.readUInt32LE(40),
    terminatedProcesses: acct.readUInt32LE(44),
    pids,
    limitFlags: limits.readUInt32LE(16),
    jobMemoryLimitBytes: Number(limits.readBigUInt64LE(120)),
    peakProcessMemoryBytes: Number(limits.readBigUInt64LE(128)),
    peakJobMemoryBytes: Number(limits.readBigUInt64LE(136)),
  };
}

function terminateJob(job, exitCode = 1) {
  if (!job) return false;
  if (!nativeApi().terminate(job.handle, exitCode >>> 0)) fail('TerminateJobObject');
  return true;
}

function closeJob(job) {
  if (!job?.handle) return;
  nativeApi().close(job.handle);
  job.handle = null;
}

module.exports = {
  resolveJobPolicy, parseByteLimit, jobName, createSessionJob, openSessionJob,
  assignPid, queryJob, terminateJob, closeJob, armKillOnClose,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_JOB_MEMORY,
};
