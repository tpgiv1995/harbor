'use strict';

const { SessionDaemonClient } = require('./client.js');
const { SessionStreamSupervisor } = require('./streams.js');

const BACKEND_ENV = 'HARBOR_SESSION_BACKEND';

function resolveSessionBackend(env = process.env) {
  const value = String(env?.[BACKEND_ENV] || 'sessiond').trim().toLowerCase();
  if (value === 'herdr') {
    throw new Error(`${BACKEND_ENV}=herdr is no longer supported because the Herdr backend was retired; use sessiond`);
  }
  if (value !== 'sessiond') throw new Error(`${BACKEND_ENV} must be sessiond, got ${value}`);
  return 'sessiond';
}

function assertStoreAllowed(policy) {
  if (policy && !policy.allowed) {
    const error = new Error(policy.reason);
    error.code = 'SESSION_STORE_BLOCKED';
    throw error;
  }
}

function createControlClient(options = {}) {
  const env = options.env || process.env;
  resolveSessionBackend(env);
  assertStoreAllowed(options.sessionStorePolicy);
  const Client = options.SessionDaemonClient || SessionDaemonClient;
  return new Client({
    socketPath: options.sessionSocketPath || env.HARBOR_SESSIOND_SOCKET,
    requestTimeoutMs: options.requestTimeoutMs,
    env,
  });
}

function createStreamSupervisor(options = {}) {
  const env = options.env || process.env;
  resolveSessionBackend(env);
  assertStoreAllowed(options.sessionStorePolicy);
  const Supervisor = options.SessionStreamSupervisor || SessionStreamSupervisor;
  return new Supervisor({ socketPath: options.sessionSocketPath || env.HARBOR_SESSIOND_SOCKET, env });
}

module.exports = { BACKEND_ENV, resolveSessionBackend, createControlClient, createStreamSupervisor };
