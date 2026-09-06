'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { deriveDefaults } = require('./defaults.js');
const { legacyConfig, hasPriorInstall } = require('./migrate.js');
const { validateConfig } = require('./schema.js');

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function resolveConfigFile({ file, env = process.env, app } = {}) {
  if (file) return path.resolve(file);
  if (env.HARBOR_CONFIG_FILE) return path.resolve(env.HARBOR_CONFIG_FILE);
  const electronApp = app || require('electron').app;
  const userData = electronApp.getPath('userData');
  // The DEFAULT installation's config lives at the shared rule's answer
  // (`~/.harbor/config.json` on win32, outside MSIX AppData virtualization —
  // see shared/tasks-file.cjs for the incident). A RELOCATED userData (E2E,
  // harnesses) keeps <userData>/config.json, because a relocated profile is by
  // definition not the real installation and must never read or write the real
  // file — the same rule resolveUnitPolicy states for the daemon unit.
  const { defaultConfigFile, defaultUserDataDir } = require('../../shared/tasks-file.cjs');
  const isDefaultProfile = path.resolve(userData).toLowerCase()
    === path.resolve(defaultUserDataDir()).toLowerCase();
  if (isDefaultProfile) return defaultConfigFile({ env });
  return path.join(userData, 'config.json');
}

const CORRUPT_BACKUPS_KEPT = 3;

async function pruneCorruptBackups(file) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.corrupt-`;
  let names;
  try { names = await fs.readdir(dir); } catch { return; }
  const backups = names.filter((name) => name.startsWith(prefix)).sort();
  for (const name of backups.slice(0, Math.max(0, backups.length - CORRUPT_BACKUPS_KEPT))) {
    try { await fs.rm(path.join(dir, name), { force: true }); } catch { /* leave it */ }
  }
}

// FORENSIC LOG for the profile-order incident (2026-08-13). Some app boots
// serve DISCOVERY-ordered profiles (personal, work, team with palette-index
// colours) while this very file, read back by hand, holds the user's saved
// order — it has burned Pat at least five separate times, two sessions have
// failed to explain it statically, and the renderer bundle is proven faithful
// (headless probe renders exactly what it is fed). So every load now records
// which branch answered and what it answered with, and a load whose profile
// order disagrees with the raw bytes it just read records the contradiction.
// One line per boot; keep it cheap and never let it throw.
function logConfigLoad(entry) {
  try {
    const os = require('node:os');
    const fsSync = require('node:fs');
    const dir = path.join(os.homedir(), '.cache', 'harbor');
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.appendFileSync(path.join(dir, 'config-load.log'), `${JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      execPath: process.execPath,
      argv: process.argv.slice(0, 4),
      cwd: process.cwd(),
      ...entry,
    })}\n`);
  } catch { /* forensics must never break a boot */ }
}

function createConfigStore(options = {}) {
  const emitter = new EventEmitter();
  const file = resolveConfigFile(options);
  const runtime = options.runtime || {};
  const logger = options.logger || console;
  let snapshot = null;
  // Set when load() had to move an unreadable config aside, so the wizard can
  // say so instead of silently looking like a first run.
  let corruptBackup = null;

  emitter.file = file;
  emitter.get = () => {
    if (!snapshot) throw new Error('Harbor config has not been loaded');
    return snapshot;
  };
  emitter.corruptBackup = () => corruptBackup;
  emitter.load = async () => {
    try {
      const raw = await fs.readFile(file, 'utf8');
      snapshot = deepFreeze(deriveDefaults(JSON.parse(raw), runtime));
      const fileOrder = (JSON.parse(raw).profiles || []).map((p) => p && p.id);
      const servedOrder = (snapshot.profiles || []).map((p) => p.id);
      logConfigLoad({
        branch: 'file',
        file,
        fileOrder,
        servedOrder,
        servedColors: (snapshot.profiles || []).map((p) => p.color),
        mismatch: JSON.stringify(fileOrder) !== JSON.stringify(servedOrder) || undefined,
      });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // No config file means one of two very different things, and treating
        // them as one is what hid the first-run wizard from every new user
        // (2026-07-29). Migrate only when there is a prior Harbor install to
        // migrate from; otherwise fall to schema defaults, where
        // `setup.completed` is false and the wizard opens by itself.
        const prior = hasPriorInstall(runtime);
        snapshot = deepFreeze(prior ? legacyConfig(runtime) : deriveDefaults({}, runtime));
        logConfigLoad({
          branch: prior ? 'legacy-discovery' : 'schema-defaults',
          file,
          error: String(error?.message || error),
          servedOrder: (snapshot.profiles || []).map((p) => p.id),
        });
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      } else {
        // A CONFIG THAT WILL NOT PARSE IS QUARANTINED, NEVER SILENTLY REPLACED.
        // The old behaviour fell back to defaults in memory and left the file
        // alone, which reads as safe and is not: `setup.completed` reverts to
        // false, so the wizard opens looking like day one, and the first Finish
        // writes over the unreadable file with no copy taken. A hand-edit typo
        // therefore cost the user every profile, workflow and path they had
        // configured, with the only notice a console.error nobody sees in a
        // packaged app. The Tasks store already got this right
        // (`tasks.json.corrupt-<ts>`); this is the same rule for the same reason.
        //
        // BOUNDED, because the failure that produces these is usually
        // persistent: a file with the wrong permissions, or a typo nobody has
        // fixed yet, makes every launch take another copy, and an unbounded pile
        // of them in the user's config directory is litter dressed as evidence.
        // The newest few are what anybody would actually look at.
        corruptBackup = `${file}.corrupt-${Date.now()}`;
        try {
          await fs.copyFile(file, corruptBackup);
          await pruneCorruptBackups(file);
        } catch {
          corruptBackup = null;
        }
        logger.error(
          `Harbor config load failed for ${file}; using runtime defaults`
          + `${corruptBackup ? ` (a copy of the unreadable file is at ${corruptBackup})` : ''}:`,
          error,
        );
        snapshot = deepFreeze(deriveDefaults({}, runtime));
        logConfigLoad({
          branch: 'corrupt-defaults',
          file,
          error: String(error?.message || error),
          corruptBackup,
          servedOrder: (snapshot.profiles || []).map((p) => p.id),
        });
      }
    }
    return snapshot;
  };
  emitter.save = async (next = snapshot) => {
    const validated = validateConfig(deriveDefaults(next, runtime));
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    await fs.writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, file);
    snapshot = deepFreeze(validated);
    emitter.emit('change', snapshot);
    return snapshot;
  };
  return emitter;
}

module.exports = { createConfigStore, deepFreeze, resolveConfigFile };
