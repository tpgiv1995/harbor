'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

// AF_UNIX sun_path is a FIXED 108-byte field on Linux and 104 on macOS, and it
// is not a soft limit that reports itself: measured on this machine, a 109 byte
// path makes `listen()` succeed while the socket lands on disk under a name
// truncated to 108. The bind looks fine, the exact path does not exist, and the
// very next `chmodSync` on the full name throws ENOENT inside a detached keeper
// whose stderr went nowhere. That is the whole reason a deep store directory
// turned into `spawn request timed out after 10000ms`. Windows uses named pipes
// rather than filesystem sockets, so no limit applies there.
const SUN_PATH_MAX = process.platform === 'darwin' ? 104 : (process.platform === 'win32' ? Infinity : 108);

// A session id is a uuid, so this is the longest keeper socket any store will
// ever be asked to hold. Choosing the directory against the worst case means a
// store is decided once, not per session, and can never half-fit.
const LONGEST_SOCKET_NAME = `${'0'.repeat(36)}.sock`;

function socketFits(socketPath) {
  return Buffer.byteLength(socketPath) <= SUN_PATH_MAX;
}

function dirHoldsSockets(dir) {
  return socketFits(path.join(dir, LONGEST_SOCKET_NAME));
}

function runtimeRoot(env) {
  if (env.XDG_RUNTIME_DIR) return env.XDG_RUNTIME_DIR;
  if (typeof process.getuid === 'function') return path.join('/run/user', String(process.getuid()));
  return null;
}

// Keeper sockets live beside their state files, because that store is the
// durable thing: it survives a logout, which a runtime directory does not, and
// a keeper deliberately outlives the daemon. Only when the store is too deep to
// hold a socket at all do we fall back, and then the fallback is namespaced by
// a hash of the store rather than shared: a relocated harness must never bind
// into the same directory as the real daemon (the 2026-07-29 unit-name lesson,
// arriving here as a socket path).
function resolveSocketDir(root, sessions, env) {
  if (env.HARBOR_SESSIOND_SOCKET_DIR) return env.HARBOR_SESSIOND_SOCKET_DIR;
  if (dirHoldsSockets(sessions)) return sessions;
  const tag = crypto.createHash('sha256').update(root).digest('hex').slice(0, 10);
  const candidates = [runtimeRoot(env), os.tmpdir()].filter(Boolean);
  for (const base of candidates) {
    const candidate = path.join(base, `harbor-sd-${tag}`);
    if (dirHoldsSockets(candidate)) return candidate;
  }
  // Nothing fits. Return the store anyway so the caller reports an honest,
  // specific error at spawn instead of this function inventing a path that
  // would fail later and further away.
  return sessions;
}

function resolvePaths(env = process.env) {
  const root = env.HARBOR_SESSIOND_DIR || path.join(os.homedir(), '.local/state/harbor/sessiond');
  const sessions = path.join(root, 'sessions');
  const sockets = resolveSocketDir(root, sessions, env);
  return {
    root,
    socket: env.HARBOR_SESSIOND_SOCKET || preferredDaemonSocket(root, sockets),
    log: env.HARBOR_SESSIOND_LOG || path.join(root, 'sessiond.log'),
    sessions,
    sockets,
  };
}

// The daemon's own socket is short enough in every real store, but it is bound
// by the same field, and a client computing the default has to land on the same
// answer the daemon did. Both sides go through here, so they cannot disagree.
function preferredDaemonSocket(root, sockets) {
  const inRoot = path.join(root, 'sessiond.sock');
  return socketFits(inRoot) ? inRoot : path.join(sockets, 'sessiond.sock');
}

// WINDOWS HAS NO FILESYSTEM SOCKETS, and this is the address a listen() or a
// connect() must actually be given (2026-08-06, measured on a real Windows
// machine rather than reasoned about).
//
// Node's net module on win32 supports only NAMED PIPES. Handing it a path like
// `C:\Users\x\.local\state\harbor\sessiond\sessiond.sock` does not create a
// file and does not fail as a bad argument: it fails as
// `listen EACCES: permission denied`, which reads like a permissions problem
// and is really "that is not a pipe name". The daemon therefore started,
// logged EACCES, and never became healthy, so nothing on Windows could open a
// session on the default backend.
//
// The pipe namespace is FLAT and machine-global, so the name is derived from
// the full socket path: two stores (a real install and an isolated harness)
// must not collide, which is the same reasoning `resolveSocketDir` already
// applies when it namespaces a fallback directory by a hash of the store. The
// readable prefix is kept so a pipe is identifiable in Process Explorer, and
// the hash is what actually guarantees uniqueness.
//
// The socket PATH stays the identity everywhere else (state files, logs, the
// existing length checks); this converts only at the point of binding and
// connecting, so both ends derive the same name from the same path.
function listenAddress(socketPath) {
  if (process.platform !== 'win32') return socketPath;
  const base = path.basename(String(socketPath)).replace(/[^A-Za-z0-9._-]/g, '') || 'sock';
  const hash = crypto.createHash('sha1').update(String(socketPath)).digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\harbor-${base}-${hash}`;
}

module.exports = {
  resolvePaths, socketFits, dirHoldsSockets, listenAddress, SUN_PATH_MAX, LONGEST_SOCKET_NAME,
};
