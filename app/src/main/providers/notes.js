'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const model = require('../../shared/notes-model.cjs');
const notesFile = require('../../shared/tasks-file.cjs');

const BACKUP_SUFFIX = '.bak';
const WATCH_DEBOUNCE_MS = 150;
const LOCK_SUFFIX = '.lock';
const LOCK_WAIT_MS = 4000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 15000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquireLock(dir, now) {
  const deadline = now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await fsp.mkdir(dir);
      await fsp.writeFile(path.join(dir, 'owner'), String(process.pid), 'utf8').catch(() => {});
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') return false;
      let age = 0;
      try { age = now() - (await fsp.stat(dir)).mtimeMs; } catch { return false; }
      if (age > LOCK_STALE_MS) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (now() >= deadline) return false;
      await sleep(LOCK_RETRY_MS);
    }
  }
}

function resolveNotesFile({ env = process.env, configuredFile = null, app = null } = {}) {
  if (env.HARBOR_NOTES_FILE) return path.resolve(env.HARBOR_NOTES_FILE);
  const electronApp = app || (configuredFile ? null : require('electron').app);
  return notesFile.resolveNotesFile({
    env,
    configuredFile,
    userDataPath: electronApp ? electronApp.getPath('userData') : undefined,
  });
}

function serialize(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function createNoteStore(options = {}) {
  const file = options.file || resolveNotesFile(options);
  const logger = options.logger || console;
  const now = options.now || (() => Date.now());
  const directory = path.dirname(file);
  const basename = path.basename(file);
  const backupFile = file + BACKUP_SUFFIX;
  const lockDir = file + LOCK_SUFFIX;

  let chain = Promise.resolve();
  let lastWritten = null;
  let watcher = null;
  const listeners = new Set();
  let debounce = null;
  let recovery = null;

  async function readRaw(target) {
    try {
      return await fsp.readFile(target, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function load() {
    recovery = null;
    let text = null;
    try {
      text = await readRaw(file);
    } catch (error) {
      logger.error(`Harbor notes: cannot read ${file}:`, error);
      recovery = { kind: 'unreadable', detail: String(error?.message || error) };
      return model.emptyDoc();
    }
    if (text === null) return model.emptyDoc();

    try {
      const parsed = JSON.parse(text);
      const doc = model.normalizeDoc(parsed, { now: now() });
      if (model.mintsIds(parsed)) await save(doc).catch(() => {});
      return doc;
    } catch (parseError) {
      if (parseError instanceof SyntaxError) {
        logger.error(`Harbor notes: ${file} is not valid JSON:`, parseError);
      } else {
        logger.error(`Harbor notes: could not normalise ${file}:`, parseError);
        throw parseError;
      }
    }

    let fromBackup = null;
    try {
      const backupText = await readRaw(backupFile);
      if (backupText !== null) {
        fromBackup = model.normalizeDoc(JSON.parse(backupText), { now: now() });
      }
    } catch { /* the backup is no better than the file */ }

    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const quarantine = `${file}.corrupt-${stamp}`;
    try {
      await fsp.rename(file, quarantine);
    } catch (error) {
      logger.error('Harbor notes: could not set aside the unreadable file:', error);
      recovery = { kind: 'corrupt-locked', detail: file };
      return fromBackup || model.emptyDoc();
    }
    recovery = { kind: fromBackup ? 'restored-backup' : 'corrupt', detail: quarantine };
    return fromBackup || model.emptyDoc();
  }

  async function save(doc) {
    const text = serialize(doc);
    await fsp.mkdir(directory, { recursive: true }).catch(() => {});
    const temp = `${file}.tmp-${process.pid}`;
    await fsp.writeFile(temp, text, 'utf8');
    await fsp.copyFile(file, backupFile).catch(() => {});
    await fsp.rename(temp, file);
    lastWritten = text;
    return doc;
  }

  function notify(doc) {
    for (const listener of listeners) {
      try { listener(doc); } catch { /* one listener cannot break the store */ }
    }
  }

  function startWatch() {
    if (watcher || listeners.size === 0) return;
    try {
      fs.mkdirSync(directory, { recursive: true });
      watcher = fs.watch(directory, (_event, filename) => {
        if (filename && filename.toString() !== basename) return;
        clearTimeout(debounce);
        debounce = setTimeout(async () => {
          const text = await readRaw(file).catch(() => null);
          if (text !== null && text === lastWritten) return;
          notify(await load());
        }, WATCH_DEBOUNCE_MS);
        debounce.unref?.();
      });
      watcher.on('error', () => {});
    } catch {
      watcher = null;
    }
  }

  async function applyLocked(op) {
    const doc = await load();
    // A file the store could not READ must never be saved over: with a
    // transient EPERM/EBUSY (a scanner holding the file) load() answers the
    // fallback doc, and applying a mutation on top of it would rename an
    // almost-empty document over every note on disk. Refusing keeps the disk
    // untouched and surfaces the reason; the caller retries. Quarantined
    // corruption ('corrupt') already moved the bad file aside and may proceed.
    if (recovery && (recovery.kind === 'unreadable' || recovery.kind === 'corrupt-locked')) {
      return {
        ok: false,
        reason: `notes file could not be read (${recovery.kind}); refusing to save over it`,
        doc,
        recovery,
      };
    }
    const result = model.applyOp(doc, op, { now: now() });
    if (!result.ok) return { ok: false, reason: result.reason, doc, recovery };
    try {
      await save(result.doc);
    } catch (error) {
      logger.error('Harbor notes: write failed:', error);
      return {
        ok: false,
        reason: `could not save to ${file}: ${error?.message || error}`,
        doc,
        recovery,
      };
    }
    return {
      ok: true,
      doc: result.doc,
      recovery,
      noteId: result.noteId,
      removed: result.removed,
    };
  }

  return {
    file,
    async read() {
      const doc = await load();
      return { ok: true, doc, recovery };
    },
    async mutate(op) {
      const run = chain.then(async () => {
        const held = await acquireLock(lockDir, now);
        try {
          return await applyLocked(op);
        } finally {
          if (held) await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => {});
        }
      });
      chain = run.catch(() => {});
      return run;
    },
    subscribe(listener) {
      listeners.add(listener);
      startWatch();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && watcher) {
          clearTimeout(debounce);
          watcher.close();
          watcher = null;
        }
      };
    },
    close() {
      listeners.clear();
      clearTimeout(debounce);
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    },
  };
}

module.exports = { createNoteStore, resolveNotesFile };
