'use strict';

const { HerdrClient } = require('../herdr/client.js');
const { PaneStreamSupervisor } = require('../herdr/streams.js');
const { SessionDaemonClient } = require('./client.js');
const { SessionStreamSupervisor } = require('./streams.js');

const BACKEND_ENV = 'HARBOR_SESSION_BACKEND';

function resolveSessionBackend(env = process.env) {
  const value = String(env?.[BACKEND_ENV] || 'sessiond').trim().toLowerCase();
  if (value === 'herdr' || value === 'sessiond') return value;
  throw new Error(`${BACKEND_ENV} must be herdr or sessiond, got ${value}`);
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
  if (resolveSessionBackend(env) === 'sessiond') {
    assertStoreAllowed(options.sessionStorePolicy);
    const Client = options.SessionDaemonClient || SessionDaemonClient;
    return new Client({
      socketPath: options.sessionSocketPath || env.HARBOR_SESSIOND_SOCKET,
      requestTimeoutMs: options.requestTimeoutMs,
      env,
    });
  }
  const Client = options.HerdrClient || HerdrClient;
  return new Client({ socketPath: options.socketPath, requestTimeoutMs: options.requestTimeoutMs });
}

function createStreamSupervisor(options = {}) {
  const env = options.env || process.env;
  if (resolveSessionBackend(env) === 'sessiond') {
    assertStoreAllowed(options.sessionStorePolicy);
    const Supervisor = options.SessionStreamSupervisor || SessionStreamSupervisor;
    return new Supervisor({ socketPath: options.sessionSocketPath || env.HARBOR_SESSIOND_SOCKET, env });
  }
  const Supervisor = options.PaneStreamSupervisor || PaneStreamSupervisor;
  return new Supervisor({ socketPath: options.socketPath, herdrBin: options.herdrBin });
}

module.exports = { BACKEND_ENV, resolveSessionBackend, createControlClient, createStreamSupervisor };
