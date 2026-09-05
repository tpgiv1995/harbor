'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const model = require('../../shared/tasks-model.cjs');
const tasksFile = require('../../shared/tasks-file.cjs');

// The task store's file end. Everything about WHAT a mutation means lives in
// shared/tasks-model.cjs; this module only owns getting a document safely on and
// off disk.
//
// The file is deliberately plain, readable, hand-editable JSON in the user's own
// config directory (the same place project icons live), not a database: a task
// list is the last thing that should need Harbor running to be recoverable, and
// an agent or a script can read it with `jq`.
//
// Three properties this has to hold, because losing a task list is not a bug the
// user forgives:
//   1. A write is ATOMIC. Serialise, write a temp file, rename over the target.
//      A crash mid-write leaves either the old file or the new one, never half.
//   2. The previous good copy survives every write as tasks.json.bak.
//   3. Unreadable JSON is never overwritten. It is moved aside with a timestamp
//      and reported, so the worst case is "your tasks are in this file" rather
//      than "your tasks are gone".

const BACKUP_SUFFIX = '.bak';
const WATCH_DEBOUNCE_MS = 150;
// Cross-PROCESS locking, not just in-process serialising. Harbor is no longer
// the only writer: bin/harbor-tasks lets a Claude session add and edit tasks
// while the app is open, so a read-modify-write that is only safe inside one
// process can lose whichever side finished second. mkdir is the atomic primitive
// every platform agrees on.
const LOCK_SUFFIX = '.lock';
const LOCK_WAIT_MS = 4000;
const LOCK_RETRY_MS = 25;
// A lock older than this belonged to a process that died holding it. Generous
// next to a sub-millisecond write, short enough that a crash does not wedge the
// list until the next reboot.
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
      if (error?.code !== 'EEXIST') return false; // unwritable directory: proceed unlocked
      let age = 0;
      try { age = now() - (await fsp.stat(dir)).mtimeMs; } catch { return false; }
      if (age > LOCK_STALE_MS) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (now() >= deadline) return false; // never block forever on a lock
      await sleep(LOCK_RETRY_MS);
    }
  }
}

/**
 * Where the document lives. The precedence rule itself lives in
 * shared/tasks-file.cjs, because bin/harbor-tasks (the CLI a Claude session
 * drives) has to resolve the SAME file and a second copy of the rule would
 * eventually point an agent at a different file from the one on screen.
 *
 * Electron's userData is supplied here rather than derived, so a relocated
 * profile relocates the file with it and an isolated harness is already
 * isolated without anyone remembering to set anything.
 */
function resolveTasksFile({ env = process.env, configuredFile = null, app = null } = {}) {
  if (env.HARBOR_TASKS_FILE) return path.resolve(env.HARBOR_TASKS_FILE);
  const electronApp = app || (configuredFile ? null : require('electron').app);
  return tasksFile.resolveTasksFile({
    env,
    configuredFile,
    userDataPath: electronApp ? electronApp.getPath('userData') : undefined,
  });
}

function serialize(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function createTaskStore(options = {}) {
  const file = options.file || resolveTasksFile(options);
  const logger = options.logger || console;
  const now = options.now || (() => Date.now());
  const directory = path.dirname(file);
  const basename = path.basename(file);
  const backupFile = file + BACKUP_SUFFIX;
  const lockDir = file + LOCK_SUFFIX;

  // Every mutation runs on one chain. Two IPC calls landing in the same tick
  // (tick a box, then tick another) would otherwise both read the pre-change
  // document and the second write would erase the first.
  let chain = Promise.resolve();
  let lastWritten = null;
  let watcher = null;
  const listeners = new Set();
  let debounce = null;
  // Set when the last read had to fall back or give up, so the UI can say so
  // instead of silently showing an empty list.
  let recovery = null;

  async function readRaw(target) {
    try {
      return await fsp.readFile(target, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function load() {
    recovery = null;
    let text = null;
    try {
      text = await readRaw(file);
    } catch (error) {
      logger.error(`Harbor tasks: cannot read ${file}:`, error);
      recovery = { kind: 'unreadable', detail: String(error?.message || error) };
      return model.emptyDoc(now());
    }
    if (text === null) return model.emptyDoc(now());

    try {
      const parsed = JSON.parse(text);
      const doc = model.normalizeDoc(parsed, { now: now() });
      // A hand-added entry with no id of its own gets a fresh one on every
      // read, so nothing could reference it: ticking that task's box would be
      // told it does not exist. Writing the repaired document back once makes
      // the invented ids real.
      if (model.mintsIds(parsed)) await save(doc).catch(() => { /* read still works */ });
      return doc;
    } catch (parseError) {
      if (parseError instanceof SyntaxError) {
        logger.error(`Harbor tasks: ${file} is not valid JSON:`, parseError);
      } else {
        logger.error(`Harbor tasks: could not normalise ${file}:`, parseError);
        throw parseError;
      }
    }

    // Corrupt. Try the backup before doing anything destructive.
    let fromBackup = null;
    try {
      const backupText = await readRaw(backupFile);
      if (backupText !== null) fromBackup = model.normalizeDoc(JSON.parse(backupText), { now: now() });
    } catch { /* the backup is no better than the file */ }

    // Never overwrite bytes we could not read. Move them aside under a name
    // that says what they are, so recovery is a text editor away.
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const quarantine = `${file}.corrupt-${stamp}`;
    try {
      await fsp.rename(file, quarantine);
    } catch (error) {
      logger.error(`Harbor tasks: could not set aside the unreadable file:`, error);
      recovery = { kind: 'corrupt-locked', detail: file };
      return fromBackup || model.emptyDoc(now());
    }
    recovery = {
      kind: fromBackup ? 'restored-backup' : 'corrupt',
      detail: quarantine,
    };
    return fromBackup || model.emptyDoc(now());
  }

  async function save(doc) {
    const text = serialize(doc);
    await fsp.mkdir(directory, { recursive: true }).catch(() => {});
    const temp = `${file}.tmp-${process.pid}`;
    await fsp.writeFile(temp, text, 'utf8');
    // Keep the copy we are about to replace. copyFile, not rename: a rename
    // would leave no target for a moment, and a reader in that gap would decide
    // the user has no tasks.
    await fsp.copyFile(file, backupFile).catch(() => { /* first write, nothing to back up */ });
    await fsp.rename(temp, file);
    lastWritten = text;
    return doc;
  }

  function notify(doc) {
    for (const listener of listeners) {
      try { listener(doc); } catch { /* a bad listener must not break the store */ }
    }
  }

  function startWatch() {
    if (watcher || listeners.size === 0) return;
    try {
      fs.mkdirSync(directory, { recursive: true });
      // Watch the DIRECTORY, not the file: an atomic write replaces the inode,
      // and a file watch would follow the old one into the void after the first
      // save. Filtering on the basename keeps the noise out.
      watcher = fs.watch(directory, (_event, filename) => {
        if (filename && filename.toString() !== basename) return;
        clearTimeout(debounce);
        debounce = setTimeout(async () => {
          // Our own writes come back through this watcher; comparing against
          // the exact bytes we last wrote keeps the renderer from repainting
          // for every keystroke it just caused.
          const text = await readRaw(file).catch(() => null);
          if (text !== null && text === lastWritten) return;
          notify(await load());
        }, WATCH_DEBOUNCE_MS);
        debounce.unref?.();
      });
      watcher.on('error', () => { /* watcher death costs live refresh, nothing else */ });
    } catch {
      watcher = null;
    }
  }

  return {
    file,

    /** The document as it is on disk right now, plus any recovery news. */
    async read() {
      const doc = await load();
      return { ok: true, doc, recovery };
    },

    /**
     * Apply one operation from shared/tasks-model.cjs and persist the result.
     * A refused operation leaves the file untouched and answers with the reason
     * the UI should show; it never throws at the IPC boundary.
     */
    async mutate(op) {
      const run = chain.then(async () => {
        // The whole read-modify-write happens under the cross-process lock, so
        // an agent adding a task through bin/harbor-tasks and Harbor ticking a
        // box cannot each read the same document and erase the other. The lock
        // is best-effort by design: if it cannot be taken within a few seconds
        // the write still goes ahead, because refusing to save a task is worse
        // than a vanishingly rare interleave.
        const held = await acquireLock(lockDir, now);
        try {
          return await applyLocked(op);
        } finally {
          if (held) await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => {});
        }
      });
      // The chain must survive a rejection, or one failure wedges every later
      // mutation behind it forever.
      chain = run.catch(() => {});
      return run;
    },

    /** Live updates for edits that did not come from this process. */
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
      if (watcher) { watcher.close(); watcher = null; }
    },
  };


  // The read-modify-write itself. Kept separate so mutate() reads as exactly
  // what it is: take the lock, do this, release.
  async function applyLocked(op) {
    const doc = await load();
    const result = model.applyOp(doc, op, { now: now() });
    if (!result.ok) return { ok: false, reason: result.reason, doc, recovery };
    try {
      await save(result.doc);
    } catch (error) {
      logger.error('Harbor tasks: write failed:', error);
      return {
        ok: false,
        reason: `could not save to ${file}: ${error?.message || error}`,
        doc,
        recovery,
      };
    }
    // `removed` matters as much as the ids: it is how a caller reports "deleted
    // that task and its 2 sub-tasks" instead of silently understating what it
    // just destroyed.
    return {
      ok: true,
      doc: result.doc,
      recovery,
      taskId: result.taskId,
      listId: result.listId,
      removed: result.removed,
    };
  }
}

module.exports = { createTaskStore, resolveTasksFile };
