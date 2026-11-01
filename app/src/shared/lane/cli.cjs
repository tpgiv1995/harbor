'use strict';

const { Pool } = require('./pool.cjs');
const { LaneError, insist } = require('./errors.cjs');
const COMMANDS = {
  'init-repo': ['repo', 'path', 'pool-root', 'size', 'allowlist', 'max-writes'],
  lease: ['repo', 'lane', 'branch', 'base', 'type', 'owner-pid', 'runtimes'],
  resume: ['lane', 'token', 'generation', 'owner-pid', 'runtimes'],
  status: [],
  release: ['lane', 'token', 'generation', 'final'],
  checkpoint: ['lane', 'token', 'generation', 'final'],
  recover: ['repo', 'slot', 'token', 'generation'],
  quarantine: ['lane', 'token', 'generation', 'reason'],
  'env-begin': ['lane', 'token', 'generation'],
  'env-ready': ['lane', 'token', 'generation', 'fingerprint'],
  'bind-session': ['lane', 'token', 'generation', 'provider', 'config-home', 'session'],
  'resolve-session': ['provider', 'config-home', 'session'],
  'recover-lock': ['name'],
};
const RETRY = new Set(['POOL_FULL', 'LOCK_BUSY', 'LOCK_STALE', 'BRANCH_TAKEN', 'LANE_BUSY']);
const REQUIRED = {
  'init-repo': ['repo', 'path', 'poolRoot', 'size'], lease: ['repo', 'lane', 'base', 'type'],
  resume: ['lane', 'token', 'generation', 'ownerPid'], release: ['lane', 'token', 'generation', 'final'],
  checkpoint: ['lane', 'token', 'generation', 'final'], recover: ['repo', 'slot', 'token', 'generation'],
  quarantine: ['lane', 'token', 'generation', 'reason'], 'env-begin': ['lane', 'token', 'generation'],
  'env-ready': ['lane', 'token', 'generation', 'fingerprint'], 'recover-lock': ['name'],
  'bind-session': ['lane', 'token', 'generation', 'provider', 'configHome', 'session'],
  'resolve-session': ['provider', 'configHome', 'session'],
};
function parse(argv) {
  const [command, ...args] = argv;
  insist(Object.hasOwn(COMMANDS, command), 'INVALID_ARGUMENT', 'Unknown command', { commands: Object.keys(COMMANDS) });
  const options = {};
  for (let n = 0; n < args.length; n += 2) {
    const key = args[n].slice(2);
    insist(args[n].startsWith('--') && COMMANDS[command].includes(key) && args[n + 1] !== undefined && !Object.hasOwn(options, key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())), 'INVALID_ARGUMENT', 'Unknown, repeated, or valueless option', { option: args[n] });
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    options[camel] = args[n + 1];
  }
  for (const key of ['allowlist', 'runtimes']) if (options[key] !== undefined) {
    try { options[key] = JSON.parse(options[key]); } catch { throw new LaneError('INVALID_ARGUMENT', `${key} must be JSON`); }
  }
  for (const key of REQUIRED[command] || []) insist(options[key] !== undefined && options[key] !== '', 'INVALID_ARGUMENT', `Missing required ${key}`);
  if (command === 'lease' && ['write', 'verify', 'integration'].includes(options.type)) insist(options.ownerPid !== undefined, 'INVALID_ARGUMENT', 'owner-pid is required for executable leases');
  if (options.ownerPid !== undefined) options.ownerPid = Number(options.ownerPid);
  return { command, options };
}
function main(argv = process.argv.slice(2)) {
  try {
    const { command, options } = parse(argv);
    const pool = new Pool();
    const actions = {
      'init-repo': () => pool.init(options), lease: () => pool.lease(options), resume: () => pool.resume(options), status: () => pool.status(),
      release: () => pool.release(options), checkpoint: () => pool.checkpoint(options), recover: () => pool.recover(options), quarantine: () => pool.quarantine(options),
      'env-begin': () => pool.environment(options, false), 'env-ready': () => pool.environment(options, true),
      'bind-session': () => pool.bindSession(options), 'resolve-session': () => pool.resolveSession(options), 'recover-lock': () => pool.store.recoverLock(options.name),
    };
    console.log(JSON.stringify({ ok: true, command, result: actions[command]() }));
    return 0;
  } catch (error) {
    const code = error.code || 'INTERNAL_ERROR';
    console.log(JSON.stringify({ ok: false, code, message: error.message, details: error.details || {} }));
    return code === 'INVALID_ARGUMENT' ? 2 : RETRY.has(code) ? 3 : error instanceof LaneError ? 4 : 1;
  }
}
module.exports = { main, parse, COMMANDS };
