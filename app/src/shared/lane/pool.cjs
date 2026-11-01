'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store } = require('./store.cjs');
const lookup = require('./lookup.cjs');
const identities = require('./identity.cjs');
const { fail, insist } = require('./errors.cjs');
const ws = require('./workspace.cjs');

const TYPES = ['write', 'verify', 'integration', 'inspect', 'live'];
const writes = type => type === 'write' || type === 'integration';
function id(value, name) {
  insist(typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value), 'INVALID_ARGUMENT', `${name} must be 1-64 lowercase letters, digits, underscores or hyphens`);
  return value;
}
function integer(value, name, min = 1, max = 1000) {
  const number = Number(value);
  insist(Number.isSafeInteger(number) && number >= min && number <= max, 'INVALID_ARGUMENT', `${name} must be an integer from ${min} to ${max}`);
  return number;
}
function allowlist(value = []) {
  insist(Array.isArray(value), 'INVALID_ARGUMENT', 'allowlist must be an array');
  const dirs = [...new Set(value)].sort();
  for (const dir of dirs) {
    insist(typeof dir === 'string' && dir.split('/').every(p => /^[a-zA-Z0-9_.-]+$/.test(p) && !['.', '..', '.git'].includes(p.toLowerCase())), 'INVALID_ARGUMENT', 'allowlist entries must be safe relative directory paths');
    insist(!dirs.some(other => other !== dir && (dir.toLowerCase() === other.toLowerCase() || dir.toLowerCase().startsWith(`${other.toLowerCase()}/`))), 'INVALID_ARGUMENT', 'allowlist paths cannot overlap');
  }
  return dirs;
}
function runtimes(value = {}) {
  insist(value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(v => typeof v === 'string'), 'INVALID_ARGUMENT', 'runtimes must be a JSON object of version/option strings');
  return value;
}
class Pool {
  constructor(options = {}) {
    this.store = new Store(options.dir);
    this.identities = options.identities || identities;
    // Fault injection is module-only and used by isolated child-process crash proofs.
    this.fault = options.fault || (() => {});
  }
  transaction(repoId, action, reconcile = false) {
    const unlock = this.store.lock('global');
    let unlockRepo;
    try {
      const state = this.store.load();
      if (typeof repoId === 'function') repoId = repoId(state);
      if (repoId) unlockRepo = this.store.lock(`repo-${id(repoId, 'repo')}`);
      if (reconcile) this.reconcile(state, reconcile);
      return action(state);
    } finally { try { unlockRepo?.(); } finally { unlock(); } }
  }
  reconcile(state, mode) {
    let changed = false;
    const candidates = Object.values(state.lanes).filter(lane => {
      if (lane.state === 'awaiting-review' && lane.finalSha) {
        const repo = state.repos[lane.repo];
        if (ws.git(repo.canonical, ['show-ref', '--verify', '--hash', `refs/lanes/${lane.id}/final`], { allowFailure: true }) === lane.finalSha) return false;
      }
      return ['preparing', 'running', 'awaiting-review', 'releasing'].includes(lane.state) || (mode === 'recover' && lane.state === 'quarantined');
    });
    const owners = candidates.map(lane => lane.state === 'preparing' ? lane.preparer : lane.state === 'releasing' ? lane.releaser : lane.owner);
    const unique = [...new Map(owners.map(owner => [JSON.stringify(owner), owner])).values()];
    const verdicts = this.identities.ownerStates(unique, { quick: mode === 'status' });
    this.probes = new Map(unique.map((owner, index) => [JSON.stringify(owner), verdicts[index]]));
    candidates.forEach((lane, index) => {
      const status = this.probes.get(JSON.stringify(owners[index]));
      const interrupted = ['preparing', 'releasing'].includes(lane.state);
      if (status === 'gone' && lane.state !== 'quarantined') {
        lane.state = 'quarantined'; lane.reason = interrupted ? 'INTERRUPTED_TRANSACTION' : 'OWNER_GONE';
        if (lane.slot !== null) {
          const slot = state.repos[lane.repo].slots[lane.slot];
          slot.state = 'quarantined'; slot.reason = lane.reason;
        }
        changed = true;
      }
    });
    if (changed) this.store.save(state, 'owners-reconciled');
  }
  repo(state, repoId) {
    const repo = state.repos[id(repoId, 'repo')];
    insist(repo, 'NOT_FOUND', 'Repository is not registered');
    return repo;
  }
  lane(state, laneId) {
    const lane = state.lanes[id(laneId, 'lane')];
    insist(lane, 'NOT_FOUND', 'Lane is not registered');
    return lane;
  }
  guarded(state, options, allowed = ['running', 'awaiting-review']) {
    const lane = this.lane(state, options.lane);
    insist(options.token === lane.token && Number(options.generation) === lane.generation, 'STALE_TOKEN', 'Lane token or generation does not match');
    insist(allowed.includes(lane.state), lane.state === 'quarantined' ? 'QUARANTINED' : 'LANE_BUSY', `Lane is ${lane.state}`, { reason: lane.reason });
    const repo = this.repo(state, lane.repo);
    const slot = lane.slot === null ? null : repo.slots[lane.slot];
    if (slot && lane.state !== 'released') insist(slot.lane === lane.id && slot.generation === lane.generation && slot.token === lane.token, 'STALE_TOKEN', 'Slot has a different occupant');
    return { lane, repo, slot };
  }
  result(repo, lane, slot) {
    return { repo: repo.id, canonical: repo.canonical, lane: lane.id, type: lane.type, state: lane.state, branch: lane.branch,
      baseSha: lane.baseSha, tipSha: lane.tipSha, finalSha: lane.finalSha, slot: lane.slot, path: slot?.path || (lane.type === 'live' ? repo.canonical : null),
      generation: lane.generation, token: lane.token, owner: lane.owner, environment: slot ? { expected: lane.fingerprint, installed: slot.installedFingerprint || null, stale: slot.installedFingerprint !== lane.fingerprint || slot.installing === true } : null };
  }
  init(options) {
    const repoId = id(options.repo, 'repo');
    return this.transaction(repoId, state => {
      insist(!state.repos[repoId], 'REPO_EXISTS', 'Repository id already registered');
      insist(typeof options.path === 'string' && path.isAbsolute(options.path) && typeof options.poolRoot === 'string' && path.isAbsolute(options.poolRoot), 'INVALID_ARGUMENT', 'path and pool-root must be absolute paths');
      const canonical = fs.realpathSync.native(path.resolve(options.path));
      insist(fs.existsSync(options.poolRoot), 'VOLUME_MISSING', 'Configured pool root does not exist; registration never creates it');
      // A root named `pool` lets launch guards recognise a slot by its shape when the registry snapshot is unreadable.
      insist(path.basename(path.resolve(options.poolRoot)).toLowerCase() === 'pool', 'INVALID_ARGUMENT', 'The pool root must be a folder named pool');
      const poolRoot = fs.realpathSync.native(path.resolve(options.poolRoot));
      ws.noLinks(poolRoot);
      insist(ws.samePath(ws.git(canonical, ['rev-parse', '--show-toplevel']), canonical), 'INVALID_ARGUMENT', 'path must be the repository root');
      const common = ws.commonDir(canonical);
      insist(!Object.values(state.repos).some(repo => ws.samePath(repo.common, common)), 'REPO_EXISTS', 'This Git repository is already registered');
      insist(!ws.inside(canonical, poolRoot) && !ws.inside(poolRoot, canonical) && !ws.inside(poolRoot, this.store.dir) && !ws.inside(this.store.dir, poolRoot), 'PATH_UNSAFE', 'Pool, canonical repository and state must be separate directories');
      const count = integer(options.size, 'size', 1, 99);
      const maxWrites = options.maxWrites === undefined ? state.maxWrites || 4 : integer(options.maxWrites, 'max-writes');
      insist(state.maxWrites === null || state.maxWrites === maxWrites, 'CONFIG_CONFLICT', 'Machine write cap is already configured');
      const repo = { id: repoId, canonical, common, commonIdentity: ws.fileIdentity(common), poolRoot, volume: this.identities.volumeIdentity(poolRoot), size: count, allowlist: allowlist(options.allowlist), slots: [] };
      ws.validateRepo(repo); ws.validateTarget(repo, ws.sha(canonical, 'HEAD'));
      for (let n = 0; n <= count; n++) repo.slots.push({ id: n, path: path.join(poolRoot, repoId, `slot-${String(n).padStart(2, '0')}`), reserved: n === 0 ? 'integration' : null, state: 'free', generation: 0, created: false, lane: null, token: null });
      state.maxWrites = maxWrites; state.repos[repoId] = repo;
      this.store.save(state, 'repo-registered');
      return repo;
    });
  }
  capacity(state, repo, type, originalSlot) {
    if (writes(type)) {
      const occupied = Object.values(state.repos).flatMap(r => r.slots).filter(s => s.state !== 'free' && s.lane && writes(state.lanes[s.lane].type)).length;
      insist(occupied < state.maxWrites, 'POOL_FULL', 'Machine-wide write capacity is full');
    }
    const candidates = repo.slots.filter(s => type === 'integration' ? s.id === 0 : s.id !== 0);
    const slot = originalSlot === undefined ? candidates.find(s => s.state === 'free') : candidates.find(s => s.id === originalSlot);
    insist(slot && slot.state === 'free', slot?.state === 'quarantined' ? 'QUARANTINED' : 'POOL_FULL', 'Required workspace capacity is unavailable', { slot: originalSlot });
    return slot;
  }
  claim(state, repo, lane, slot, target, resume) {
    lane.owner = this.identities.identity(lane.ownerPid);
    delete lane.ownerPid;
    lane.generation = slot ? slot.generation + 1 : lane.generation + 1;
    lane.token = crypto.randomUUID(); lane.state = 'preparing'; lane.reason = null;
    lane.preparer = identities.identity();
    if (slot) Object.assign(slot, { generation: lane.generation, lane: lane.id, token: lane.token, state: 'preparing', reason: null });
    state.lanes[lane.id] = lane;
    try { this.store.save(state, resume ? 'resume-claimed' : 'lane-claimed'); }
    catch (error) {
      lane.state = 'quarantined'; lane.reason = 'INTERRUPTED_TRANSACTION'; delete lane.preparer;
      if (slot) { slot.state = 'quarantined'; slot.reason = lane.reason; }
      try { this.store.save(state, 'claim-publication-failed'); } catch { /* Preserve the original failure; a torn journal refuses load. */ }
      throw error;
    }
    return { repo: structuredClone(repo), lane: structuredClone(lane), slot: slot ? structuredClone(slot) : null, target, resume };
  }
  prepareClaim({ repo, lane, slot, target, resume }) {
    let failure;
    try {
      this.fault('after-claim');
      if (slot) {
        ws.prepare(repo, slot, target, lane.branch, resume, this.fault);
        lane.fingerprint = ws.fingerprint(repo, slot, lane.runtimes).hash;
      }
    } catch (error) { failure = error; }
    const result = this.transaction(repo.id, state => {
      const current = this.guarded(state, { lane: lane.id, token: lane.token, generation: lane.generation }, ['preparing']);
      insist(JSON.stringify(current.lane.preparer) === JSON.stringify(lane.preparer), 'STALE_TOKEN', 'Preparation owner changed');
      if (current.slot) current.slot.created = slot.created;
      delete current.lane.preparer;
      if (failure) {
        current.lane.state = failure.checkoutRolledBack ? 'failed' : 'quarantined';
        current.lane.reason = failure.code || 'PREPARE_FAILED';
        if (current.slot) {
          current.slot.state = failure.checkoutRolledBack ? 'free' : 'quarantined';
          current.slot.reason = failure.checkoutRolledBack ? null : current.lane.reason;
          if (failure.checkoutRolledBack) Object.assign(current.slot, { lane: null, token: null, created: false });
        }
      } else {
        current.lane.state = 'running'; current.lane.tipSha = target; current.lane.fingerprint = lane.fingerprint;
        if (current.slot) current.slot.state = 'running';
        for (const session of Object.values(state.sessions)) if (session.lane === lane.id) session.generation = lane.generation;
      }
      this.store.save(state, failure ? 'prepare-failed' : resume ? 'lane-resumed' : 'lane-running');
      return this.result(current.repo, current.lane, current.slot);
    });
    if (failure) throw failure;
    return result;
  }
  lease(options) {
    if (!['inspect', 'live'].includes(options.type)) integer(options.ownerPid, 'owner-pid', 1, 2147483647);
    return this.prepareClaim(this.transaction(options.repo, state => {
      const repo = this.repo(state, options.repo);
      const laneId = id(options.lane, 'lane');
      insist(!state.lanes[laneId], 'LANE_EXISTS', 'Lane id is already recorded');
      insist(TYPES.includes(options.type), 'INVALID_ARGUMENT', `type must be one of ${TYPES.join(', ')}`);
      ws.checkVolume(repo); ws.validateRepo(repo);
      const baseSha = ws.sha(repo.canonical, options.base);
      const branch = options.branch || null;
      if (writes(options.type)) insist(branch, 'INVALID_ARGUMENT', 'Write and integration lanes require a new branch');
      else insist(!branch, 'INVALID_ARGUMENT', 'Only write and integration lanes create branches');
      if (branch) {
        insist(ws.git(repo.canonical, ['check-ref-format', `refs/heads/${branch}`], { allowFailure: true }) !== null && !branch.startsWith('-'), 'INVALID_ARGUMENT', 'Invalid branch name');
        insist(!ws.git(repo.canonical, ['show-ref', '--verify', '--hash', `refs/heads/${branch}`], { allowFailure: true }) && !Object.values(state.lanes).some(l => l.repo === repo.id && l.branch === branch), 'BRANCH_TAKEN', 'Branch already exists or is claimed');
      }
      const slot = ['inspect', 'live'].includes(options.type) ? null : this.capacity(state, repo, options.type);
      insist(!ws.git(repo.canonical, ['for-each-ref', '--format=%(refname)', `refs/lanes/${laneId}/`]), 'LANE_EXISTS', 'Durable refs already exist for this lane id');
      const lane = { id: laneId, repo: repo.id, type: options.type, branch, baseSha, tipSha: baseSha, finalSha: null, slot: slot?.id ?? null, generation: 0, ownerPid: options.ownerPid ?? process.ppid, runtimes: runtimes(options.runtimes) };
      return this.claim(state, repo, lane, slot, baseSha, false);
    }, 'allocate'));
  }
  resume(options) {
    integer(options.ownerPid, 'owner-pid', 1, 2147483647);
    return this.prepareClaim(this.transaction(state => this.lane(state, options.lane).repo, state => {
      const { lane, repo } = this.guarded(state, options, ['released']);
      ws.checkVolume(repo); ws.validateRepo(repo);
      const target = lane.finalSha || lane.tipSha;
      insist(target && ws.sha(repo.canonical, `refs/lanes/${lane.id}/final`) === target, 'DELIVERABLE_MISSING', 'Recorded final ref is missing or changed');
      if (lane.branch) {
        const tip = ws.git(repo.canonical, ['show-ref', '--verify', '--hash', `refs/heads/${lane.branch}`], { allowFailure: true });
        insist(!tip || tip === target, 'TIP_MOVED', 'Branch differs from recorded deliverable; refusing to reset');
      }
      const slot = lane.slot === null ? null : this.capacity(state, repo, lane.type, lane.slot);
      lane.ownerPid = options.ownerPid ?? process.ppid;
      if (options.runtimes) lane.runtimes = runtimes(options.runtimes);
      return this.claim(state, repo, lane, slot, target, true);
    }, 'allocate'));
  }
  checkCurrent(repo, lane, slot, allowDetached = false, scanEnvironment = true) {
    ws.validateSlot(repo, slot);
    if (scanEnvironment) ws.validateEnvironment(repo, slot);
    ws.cleanTree(slot.path);
    slot.created = true;
    const branch = ws.git(slot.path, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowFailure: true });
    insist(branch === lane.branch || (allowDetached && branch === null), 'BRANCH_CHANGED', 'Slot branch differs from lane record');
    lane.fingerprint = ws.fingerprint(repo, slot, lane.runtimes).hash;
    return ws.sha(slot.path, 'HEAD');
  }
  seal(state, lane, repo, slot, final, scanEnvironment = false) {
    const head = slot ? this.checkCurrent(repo, lane, slot, false, scanEnvironment) : lane.tipSha;
    insist(final && ws.sha(repo.canonical, final) === head, 'TIP_MOVED', 'Explicit final commit must equal the clean slot HEAD');
    ws.git(repo.canonical, ['update-ref', `refs/lanes/${lane.id}/final`, head]);
    lane.finalSha = head; lane.tipSha = head;
    this.store.save(state, 'deliverable-recorded');
    return head;
  }
  checkpoint(options) {
    return this.transaction(state => this.lane(state, options.lane).repo, state => {
      const { lane, repo, slot } = this.guarded(state, options, ['running', 'awaiting-review', 'quarantined']);
      this.seal(state, lane, repo, slot, options.final);
      if (lane.state !== 'quarantined') { lane.state = 'awaiting-review'; if (slot) slot.state = 'awaiting-review'; }
      this.store.save(state, 'checkpoint');
      return this.result(repo, lane, slot);
    });
  }
  // A revision before release: the sealed lane runs again in the same slot under a new owner.
  // The token and generation renew so the previous capability cannot release the slot while
  // the revision writes. The slot must still hold the sealed deliverable, clean and unmoved.
  reopen(options) {
    integer(options.ownerPid, 'owner-pid', 1, 2147483647);
    const nextRuntimes = options.runtimes === undefined ? undefined : runtimes(options.runtimes);
    return this.transaction(state => this.lane(state, options.lane).repo, state => {
      const { lane, repo, slot } = this.guarded(state, options, ['awaiting-review']);
      insist(slot, 'INVALID_ARGUMENT', 'Only a lane that holds a slot can be reopened');
      // Admission boundary: the full environment link scan runs here as on prepare, and new
      // runtime inputs re-fingerprint the slot so a stale environment shows as stale.
      if (nextRuntimes) lane.runtimes = nextRuntimes;
      const head = this.checkCurrent(repo, lane, slot, false, true);
      insist(lane.finalSha === head && ws.sha(repo.canonical, `refs/lanes/${lane.id}/final`) === head, 'TIP_MOVED', 'The slot no longer holds the sealed deliverable');
      lane.owner = this.identities.identity(options.ownerPid);
      lane.generation = slot.generation + 1;
      lane.token = crypto.randomUUID(); lane.state = 'running'; lane.reason = null;
      Object.assign(slot, { generation: lane.generation, token: lane.token, state: 'running', reason: null });
      for (const session of Object.values(state.sessions)) if (session.lane === lane.id) session.generation = lane.generation;
      this.store.save(state, 'lane-reopened');
      return this.result(repo, lane, slot);
    });
  }
  finish(state, lane, repo, slot, checked = false) {
    if (slot && !checked) {
      const head = this.checkCurrent(repo, lane, slot, lane.state === 'quarantined');
      insist(lane.finalSha === head && ws.sha(repo.canonical, `refs/lanes/${lane.id}/final`) === head, 'DELIVERABLE_MISSING', 'A matching recorded durable deliverable is required');
    }
    lane.state = 'releasing'; if (slot) slot.state = 'releasing';
    lane.releaser = identities.identity();
    this.store.save(state, 'release-started');
    try {
      if (slot) {
        ws.git(slot.path, ['switch', '--detach', lane.finalSha]);
        this.fault('after-detach');
        ws.cleanTree(slot.path);
        insist(ws.git(slot.path, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true }) === null, 'SLOT_ATTACHED', 'Slot did not detach');
        Object.assign(slot, { state: 'free', lane: null, token: null, reason: null });
      }
      lane.state = 'released'; lane.reason = null;
      delete lane.releaser;
      this.store.save(state, 'lane-released');
      return this.result(repo, lane, slot);
    } catch (error) {
      lane.state = 'quarantined'; lane.reason = error.code || 'RELEASE_FAILED';
      if (slot) { slot.state = 'quarantined'; slot.reason = lane.reason; slot.lane = lane.id; slot.token = lane.token; }
      this.store.save(state, 'release-failed'); throw error;
    }
  }
  release(options) {
    return this.transaction(state => this.lane(state, options.lane).repo, state => {
      const { lane, repo, slot } = this.guarded(state, options);
      this.seal(state, lane, repo, slot, options.final, true);
      return this.finish(state, lane, repo, slot, true);
    });
  }
  recover(options) {
    return this.transaction(options.repo, state => {
      const repo = this.repo(state, options.repo);
      const slot = repo.slots[integer(options.slot, 'slot', 0, 99)];
      insist(slot?.lane, 'NOT_FOUND', 'Slot has no quarantined occupant');
      const { lane } = this.guarded(state, { ...options, lane: slot.lane }, ['quarantined']);
      insist(this.probes.get(JSON.stringify(lane.owner)) === 'gone', 'OWNER_LIVE', 'Recovery requires a provably gone owner; live or unknown owners retain their slot');
      try { return this.finish(state, lane, repo, slot); }
      catch (error) { slot.reason = lane.reason = error.code || 'RECOVERY_FAILED'; this.store.save(state, 'recovery-refused'); throw error; }
    }, 'recover');
  }
  quarantine(options) {
    return this.transaction(state => this.lane(state, options.lane).repo, state => {
      const { lane, repo, slot } = this.guarded(state, options, ['running', 'awaiting-review', 'quarantined']);
      insist(typeof options.reason === 'string' && options.reason.trim(), 'INVALID_ARGUMENT', 'reason is required');
      lane.state = 'quarantined'; lane.reason = options.reason;
      if (slot) { slot.state = 'quarantined'; slot.reason = options.reason; }
      this.store.save(state, 'explicit-quarantine');
      return this.result(repo, lane, slot);
    });
  }
  environment(options, ready) {
    return this.transaction(state => this.lane(state, options.lane).repo, state => {
      const { lane, repo, slot } = this.guarded(state, options);
      insist(slot, 'INVALID_ARGUMENT', 'This lane has no environment');
      // Installation can happen during unfinished edits. Only read slot metadata
      // and on-disk manifests here; never inspect operations or rewrite the index.
      ws.validateSlot(repo, slot);
      const expected = ws.fingerprint(repo, slot, lane.runtimes).hash;
      if (ready) insist(slot.installing && options.fingerprint === expected, 'FINGERPRINT_MISMATCH', 'env-ready requires env-begin and the current fingerprint');
      lane.fingerprint = expected;
      slot.installing = !ready; slot.installedFingerprint = ready ? expected : null;
      this.store.save(state, ready ? 'environment-ready' : 'environment-invalidated');
      return this.result(repo, lane, slot);
    });
  }
  sessionKey(options) {
    insist(['claude', 'codex', 'cursor'].includes(options.provider) && typeof options.configHome === 'string' && path.isAbsolute(options.configHome) && options.session, 'INVALID_ARGUMENT', 'provider, absolute config-home and session are required');
    return lookup.sessionKey(options);
  }
  bindSession(options) {
    return this.transaction(state => this.lane(state, options.lane).repo, state => {
      const { lane } = this.guarded(state, options);
      const key = this.sessionKey(options);
      insist(!state.sessions[key] || state.sessions[key].lane === lane.id, 'SESSION_TAKEN', 'Session is already mapped to another lane');
      state.sessions[key] = { provider: options.provider, configHome: path.resolve(options.configHome), session: options.session, repo: lane.repo, lane: lane.id, slot: lane.slot, generation: lane.generation };
      this.store.save(state, 'session-bound'); return state.sessions[key];
    });
  }
  resolveSession(options) {
    return this.transaction(null, state => {
      const session = state.sessions[this.sessionKey(options)];
      insist(session, 'NOT_FOUND', 'No durable lane mapping for this session');
      const lane = this.lane(state, session.lane); const repo = this.repo(state, lane.repo);
      return { session, lease: this.result(repo, lane, lane.slot === null ? null : repo.slots[lane.slot]) };
    });
  }
  status() { return this.transaction(null, state => state, 'status'); }
}
module.exports = { Pool, TYPES };
