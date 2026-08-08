'use strict';

// Daemon lifecycle: single-instance lock, socket probe, clean-start, protocol
// assertion, and herdr binary archive.  No Electron import here so this module
// is unit-testable under plain Node.
//
// Part of /home/you/dev/harbor (see README.md).

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { platform } = require('./platform/index.js');
const { scriptInvocation } = require('./script-exec.js');

const HERDR_SOCKET = platform.herdrTransport();
const HERDR_SERVER_CLEAN = path.resolve(__dirname, '../../../bin/herdr-server-clean');
const HARBOR_SESSIOND_BIN = path.resolve(__dirname, '../../../bin/harbor-sessiond');
const HERDR_BIN = path.join(os.homedir(), '.local/bin/herdr');
const HERDR_ARCHIVE = path.join(os.homedir(), '.local/bin/herdr-0.7.4');
const SCHEMA_PATH = path.resolve(__dirname, '../../../docs/herdr-api.schema.json');
// The daemon protocols Harbor is known to work against. An ALLOWLIST, not a
// `>=` comparison: a future protocol must fail closed and be checked by a human
// rather than be accepted because its number is larger.
//
// 16 is Herdr 0.7.4, the pinned stable build Linux runs. 17 is 0.7.5-preview,
// which matters because Herdr publishes Windows binaries ONLY on the preview
// channel, so there is no Windows build that speaks 16 and Harbor could not
// connect to any Windows daemon at all (batch-13, 2026-07-29).
//
// Adding 17 was checked rather than assumed. Diffing the two schemas
// (`herdr api schema --json` on each) the whole delta is one method removed,
// `agent.send`, and five added: agent.prompt, agent.send_keys, agent.view.clear,
// agent.view.set, agent.wait. Harbor calls none of them; it drives pane.*,
// tab.*, workspace.*, session.snapshot, events.subscribe and layout.*. All 49
// herdr names referenced in main/herdr/client.js were verified present in the
// protocol 17 schema, and schema_version stays 1 in both.
const SUPPORTED_PROTOCOLS = Object.freeze([16, 17]);
const EXPECTED_PROTOCOL = SUPPORTED_PROTOCOLS[0];
const EXPECTED_SCHEMA_VERSION = 1;

// Probe whether the socket file exists and accepts a connection.
// Resolves true if connectable, false if not (file missing, refused, or timed out).
function probeSocket(socketPath = HERDR_SOCKET) {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) { resolve(false); return; }
    const sock = net.createConnection({ path: socketPath });
    const finish = (result) => { sock.destroy(); resolve(result); };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    setTimeout(() => finish(false), 1500);
  });
}

// Start herdr via herdr-server-clean in the background (detached).
// Never blocks; callers should poll probeSocket until the socket appears.
function startDaemon(herdrServerClean = HERDR_SERVER_CLEAN) {
  const { command, args, env } = scriptInvocation(herdrServerClean);
  return platform.startDaemon(command, args, Object.keys(env).length ? { env: { ...process.env, ...env } } : {});
}

// The sessiond equivalent. `harbor-sessiond start` owns the decision about
// systemd versus a detached spawn, including the rule that a relocated store is
// not the real installation and so does not get the shared unit name.
function startSessionDaemon(sessiondBin = HARBOR_SESSIOND_BIN) {
  const { command, args, env } = scriptInvocation(sessiondBin, ['start']);
  return platform.startDaemon(command, args, Object.keys(env).length ? { env: { ...process.env, ...env } } : {});
}

// Assert the running daemon speaks a supported protocol with schema_version 1.
// Returns { ok: true, protocol, schemaVersion } on success, or
// { ok: false, error: string, protocol?, schemaVersion? } on mismatch.
// Throws on socket/connection errors so the caller can surface degraded state.
//
// `expectedProtocol` narrows the check to exactly one protocol. It exists so a
// caller (or a test) can pin harder than the app default, and passing it is the
// only way to get single-value behaviour: the default is the allowlist.
async function assertDaemonCompat(client, {
  expectedProtocol = null,
  supportedProtocols = expectedProtocol == null ? SUPPORTED_PROTOCOLS : [expectedProtocol],
  expectedSchemaVersion = EXPECTED_SCHEMA_VERSION,
  schemaPath = SCHEMA_PATH,
} = {}) {
  await client.ping();

  const snapRes = await client.snapshot();
  const protocol = snapRes?.snapshot?.protocol ?? null;
  if (!supportedProtocols.includes(protocol)) {
    const accepted = supportedProtocols.length === 1
      ? String(supportedProtocols[0])
      : `one of ${supportedProtocols.join(', ')}`;
    return {
      ok: false,
      error: `protocol_mismatch: expected ${accepted}, got ${protocol}`,
      protocol,
    };
  }

  let schemaVersion = null;
  try {
    const raw = fs.readFileSync(schemaPath, 'utf8');
    schemaVersion = JSON.parse(raw).schema_version ?? null;
  } catch {
    // schema file unreadable
  }
  if (schemaVersion !== expectedSchemaVersion) {
    return {
      ok: false,
      error: `schema_version_mismatch: expected ${expectedSchemaVersion}, got ${schemaVersion}`,
      protocol,
      schemaVersion,
    };
  }

  return { ok: true, protocol, schemaVersion };
}

// Copy the herdr binary to herdr-0.7.4 if not already done.
// Returns { skipped: true, dest } when the archive already exists,
// { skipped: false, dest } after copying.
async function archiveBinary(src = HERDR_BIN, dest = HERDR_ARCHIVE) {
  try {
    await fsp.access(dest, fs.constants.F_OK);
    return { skipped: true, dest };
  } catch {
    // dest does not exist
  }
  await fsp.copyFile(src, dest);
  const stat = await fsp.stat(src);
  await fsp.chmod(dest, stat.mode);
  return { skipped: false, dest };
}

// Parse launch-intent flags from an argv array.
// CAUTION: Chromium REORDERS argv before delivering the second-instance event
// (flags are hoisted ahead of positionals and extra Chromium flags appear), so
// space-separated profile values arrive torn apart. Only the equals form
// survives intact. The reliable channel is
// requestSingleInstanceLock(additionalData); this parser is the fallback and
// therefore only trusts equals-form values.
// Returns { action, noFocusSteal } where action is 'focus' | 'new-session'.
// noFocusSteal carries the out-of-band-restart intent through to the FIRST
// instance: a relaunch that races a not-yet-dead process lands in the
// second-instance handler, which used to focus unconditionally. That is one of
// the two paths that put Harbor over Pat's game on 2026-07-27 despite the flag
// being set on both processes.
function parseSecondInstanceArgs(argv) {
  const args = (argv || []).slice(1);

  const flagValue = (name) => {
    const eq = args.find((a) => typeof a === 'string' && a.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    // Space-separated pairs survive only in our OWN process.argv (pre-mangling);
    // accept them when the next token is not itself a flag.
    const idx = args.indexOf(name);
    if (idx >= 0 && args[idx + 1] && !String(args[idx + 1]).startsWith('--')) return args[idx + 1];
    return null;
  };

  const noFocusSteal = args.includes('--no-focus-steal');
  if (!args.includes('--new-session')) return { action: 'focus', noFocusSteal };
  const homeFlag = flagValue('--home');
  const home = homeFlag;
  const cwd = flagValue('--cwd') || os.homedir();
  return { action: 'new-session', home, cwd, noFocusSteal };
}

// Build the additionalData payload for requestSingleInstanceLock from OUR OWN
// process.argv (never mangled in-process). The first instance receives this
// verbatim in the second-instance event and should prefer it over argv.
function buildSecondInstancePayload(argv) {
  return parseSecondInstanceArgs(argv);
}

module.exports = {
  HERDR_SOCKET,
  HERDR_SERVER_CLEAN,
  HARBOR_SESSIOND_BIN,
  HERDR_BIN,
  HERDR_ARCHIVE,
  SCHEMA_PATH,
  EXPECTED_PROTOCOL,
  EXPECTED_SCHEMA_VERSION,
  probeSocket,
  startDaemon,
  startSessionDaemon,
  assertDaemonCompat,
  archiveBinary,
  parseSecondInstanceArgs,
  buildSecondInstancePayload,
};
