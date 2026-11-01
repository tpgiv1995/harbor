'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { identity, ownerState } = require('./identity.cjs');
const { fail, insist } = require('./errors.cjs');

function flushWrite(file, text, flags = 'w') {
  const fd = fs.openSync(file, flags, 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
const emptyState = () => ({ version: 1, revision: 0, repos: {}, lanes: {}, sessions: {}, maxWrites: null });
const ZERO_HASH = '0'.repeat(64);
const MAPS = ['repos', 'lanes', 'sessions'];
const EVENT_LIMIT = 5 * 1024 * 1024;
const CHECKPOINT_RECORDS = 2000;
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function atomicWrite(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  flushWrite(temporary, JSON.stringify(value) + '\n', 'wx');
  fs.renameSync(temporary, file);
}
function atomicLink(file, record) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { flushWrite(temporary, JSON.stringify(record), 'wx'); fs.linkSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function recordHash(record) {
  return crypto.createHash('sha256').update(JSON.stringify({ format: record.format, revision: record.revision, previous: record.previous, changes: record.changes })).digest('hex');
}
class Store {
  constructor(dir = process.env.HARBOR_LANES_DIR || path.join(process.env.USERPROFILE || os.homedir(), '.harbor', 'lanes')) {
    insist(path.isAbsolute(dir), 'INVALID_ARGUMENT', 'HARBOR_LANES_DIR must be an absolute path');
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true });
    this.owner = identity();
  }
  event(event, details = {}) {
    const file = path.join(this.dir, 'events.jsonl');
    const text = `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`;
    insist(Buffer.byteLength(text) <= EVENT_LIMIT, 'EVENT_TOO_LARGE', 'Event exceeds the bounded log size');
    if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(text) > EVENT_LIMIT) {
      const first = path.join(this.dir, 'events.1.jsonl'); const second = path.join(this.dir, 'events.2.jsonl');
      if (fs.existsSync(second)) fs.unlinkSync(second);
      if (fs.existsSync(first)) fs.renameSync(first, second);
      fs.renameSync(file, first);
    }
    flushWrite(file, text, 'a');
  }
  lock(name) {
    const file = path.join(this.dir, `${name}.lock`);
    const gate = `${file}.recovery`;
    const record = { ...this.owner, token: crypto.randomUUID() };
    const waitMs = Number(process.env.HARBOR_LANES_LOCK_WAIT_MS ?? 60000);
    insist(Number.isFinite(waitMs) && waitMs >= 0 && waitMs <= 600000, 'INVALID_ARGUMENT', 'HARBOR_LANES_LOCK_WAIT_MS must be 0-600000');
    const deadline = performance.now() + waitMs; const probes = new Map(); let attempted = false;
    for (;;) {
      if (attempted && performance.now() >= deadline) fail('LOCK_BUSY', 'Bounded lock wait expired', { name, waitMs });
      attempted = true;
      if (!fs.existsSync(gate)) {
        try {
          atomicLink(file, record);
          if (!fs.existsSync(gate)) break;
          fs.unlinkSync(file);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          let owner;
          try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); }
          catch (readError) { if (readError.code !== 'ENOENT') fail('LOCK_UNKNOWN', 'Unreadable lock needs operator inspection', { file }); }
          if (owner) {
            const key = JSON.stringify(owner);
            if (!probes.has(key)) probes.set(key, ownerState(owner, { timeoutMs: Math.max(1, Math.min(15000, deadline - performance.now())) }));
            if (probes.get(key) === 'gone' || ownerState(owner, { quick: true }) === 'gone') {
              // The holder may have released while the OS query was in flight.
              let same = false; try { same = JSON.parse(fs.readFileSync(file, 'utf8')).token === owner.token; } catch { /* removed */ }
              if (same) fail('LOCK_STALE', 'Dead lock owner; use recover-lock', { name });
              continue;
            }
          }
        }
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) fail('LOCK_BUSY', 'Bounded lock wait expired', { name, waitMs });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(50, remaining));
    }
    try { this.event('lock-acquired', { name, owner: record }); }
    catch (error) { fs.unlinkSync(file); throw error; }
    return () => {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      insist(current.token === record.token, 'LOCK_UNKNOWN', 'Lock ownership changed');
      try { this.event('lock-released', { name, token: record.token }); }
      finally { fs.unlinkSync(file); }
    };
  }
  recoverLock(name) {
    insist(/^(global|repo-[a-z0-9][a-z0-9_-]{0,63})$/.test(name), 'INVALID_ARGUMENT', 'Invalid lock name');
    const file = path.join(this.dir, `${name}.lock`);
    const gate = `${file}.recovery`;
    try { atomicLink(gate, this.owner); }
    catch (error) { if (error.code === 'EEXIST') fail('LOCK_UNKNOWN', 'Recovery guard exists; inspect it before further recovery', { file: gate }); throw error; }
    try {
      if (!fs.existsSync(file)) return { recovered: false };
      let owner; try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('LOCK_UNKNOWN', 'Unreadable lock cannot be stolen'); }
      insist(ownerState(owner) === 'gone', 'LOCK_BUSY', 'Lock owner is live or unknown');
      this.event('lock-recovered', { name, owner });
      fs.unlinkSync(file);
      return { recovered: true };
    } finally { fs.unlinkSync(gate); }
  }
  load() {
    const manifest = path.join(this.dir, 'segments.json');
    this.manifest = null;
    let state = emptyState(); let previous = ZERO_HASH;
    this.segment = { journal: 'journal.jsonl', snapshot: null };
    if (fs.existsSync(manifest)) {
      try { this.manifest = JSON.parse(fs.readFileSync(manifest, 'utf8')); }
      catch { fail('JOURNAL_CORRUPT', 'Invalid segment manifest'); }
      this.segment = this.manifest.current;
      for (const segment of [this.segment, this.manifest.previous].filter(Boolean)) {
        insist(/^journal(?:-[a-f0-9-]+)?\.jsonl$/.test(segment.journal) && (segment.snapshot === null || /^checkpoint-[a-f0-9-]+\.json$/.test(segment.snapshot)), 'JOURNAL_CORRUPT', 'Unsafe segment name');
      }
      let snapshot;
      try { snapshot = JSON.parse(fs.readFileSync(path.join(this.dir, this.segment.snapshot), 'utf8')); }
      catch { fail('JOURNAL_CORRUPT', 'Current checkpoint is missing or unreadable'); }
      insist(snapshot.format === 1 && snapshot.checksum === digest({ state: snapshot.state, lastHash: snapshot.lastHash }) && snapshot.state.version === 1, 'JOURNAL_CORRUPT', 'Invalid checkpoint checksum');
      state = snapshot.state; previous = snapshot.lastHash;
    }
    const journal = path.join(this.dir, this.segment.journal);
    this.records = 0;
    if (!fs.existsSync(journal)) {
      insist(!this.manifest && !fs.existsSync(path.join(this.dir, 'registry.json')), 'JOURNAL_CORRUPT', 'Journal is missing while a snapshot exists');
      this.baseline = emptyState(); this.lastHash = ZERO_HASH;
      return emptyState();
    }
    const text = fs.readFileSync(journal, 'utf8');
    insist((text === '' && this.manifest) || text.endsWith('\n'), 'JOURNAL_CORRUPT', 'Incomplete journal tail; preserve state and inspect before recovery');
    for (const line of text ? text.trimEnd().split('\n') : []) {
      let entry; try { entry = JSON.parse(line); } catch { fail('JOURNAL_CORRUPT', 'Invalid journal record'); }
      insist(entry.format === 1 && entry.revision === state.revision + 1 && entry.previous === previous && entry.hash === recordHash(entry), 'JOURNAL_CORRUPT', 'Journal checksum, chain or sequence mismatch');
      insist(entry.changes && Object.keys(entry.changes).every(key => [...MAPS, 'maxWrites'].includes(key)), 'JOURNAL_CORRUPT', 'Unknown journal field');
      for (const key of MAPS) {
        const changes = entry.changes[key];
        insist(changes && typeof changes === 'object' && !Array.isArray(changes) && Object.values(changes).every(row => row && typeof row === 'object'), 'JOURNAL_CORRUPT', 'Invalid journal map');
        state[key] = { ...state[key], ...changes };
      }
      if (Object.hasOwn(entry.changes, 'maxWrites')) state.maxWrites = entry.changes.maxWrites;
      state.revision = entry.revision; previous = entry.hash;
      this.records++;
    }
    this.baseline = structuredClone(state); this.lastHash = previous;
    return state;
  }
  save(state, event) {
    insist(this.baseline && !this.poisoned, 'JOURNAL_CORRUPT', 'Cannot append without a successfully loaded journal');
    insist(state.revision === this.baseline.revision, 'JOURNAL_CORRUPT', 'State revision changed outside the journal');
    const changes = {};
    for (const key of MAPS) {
      insist(Object.keys(this.baseline[key]).every(id => Object.hasOwn(state[key], id)), 'JOURNAL_CORRUPT', 'v1 never deletes repository, lane or session history');
      changes[key] = Object.fromEntries(Object.entries(state[key]).filter(([id, value]) => JSON.stringify(value) !== JSON.stringify(this.baseline[key][id])));
    }
    if (state.maxWrites !== this.baseline.maxWrites) changes.maxWrites = state.maxWrites;
    state.revision++;
    const entry = { format: 1, revision: state.revision, previous: this.lastHash, event, at: new Date().toISOString(), changes };
    entry.hash = recordHash(entry);
    // Changed records avoid copying all historical lanes into every new journal entry.
    // The fsynced journal remains authoritative if the snapshot rename fails.
    try { flushWrite(path.join(this.dir, this.segment.journal), `${JSON.stringify(entry)}\n`, 'a'); }
    catch (error) { this.poisoned = true; throw error; }
    this.baseline = structuredClone(state); this.lastHash = entry.hash;
    this.records++;
    if (this.records > CHECKPOINT_RECORDS) this.checkpoint(state);
    atomicWrite(path.join(this.dir, 'registry.json'), state);
  }
  checkpoint(state) {
    const suffix = crypto.randomUUID();
    const current = { journal: `journal-${suffix}.jsonl`, snapshot: `checkpoint-${suffix}.json` };
    const snapshot = { format: 1, state, lastHash: this.lastHash, checksum: digest({ state, lastHash: this.lastHash }) };
    flushWrite(path.join(this.dir, current.snapshot), JSON.stringify(snapshot) + '\n', 'wx');
    flushWrite(path.join(this.dir, current.journal), '', 'wx');
    const manifest = { format: 1, current, previous: this.segment };
    // Publish last: interrupted checkpoint files never supersede a valid segment.
    atomicWrite(path.join(this.dir, 'segments.json'), manifest);
    this.manifest = manifest; this.segment = current; this.records = 0;
    const keep = new Set([manifest.current, manifest.previous].flatMap(segment => [segment.journal, segment.snapshot]).filter(Boolean));
    for (const file of fs.readdirSync(this.dir)) {
      if (/^(journal(?:-[a-f0-9-]+)?\.jsonl|checkpoint-[a-f0-9-]+\.json)$/.test(file) && !keep.has(file)) fs.unlinkSync(path.join(this.dir, file));
    }
  }
}
module.exports = { Store, flushWrite };
