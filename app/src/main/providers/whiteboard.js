'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { availableBoardId, orderBoards } = require('../../renderer/whiteboard/board-files.cjs');

const BOARD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WATCH_DEBOUNCE_MS = 150;

function resolveBoardsDir({ env = process.env, configuredDir = null, app = null } = {}) {
  if (env.HARBOR_BOARDS_DIR) return path.resolve(env.HARBOR_BOARDS_DIR);
  if (configuredDir) return path.resolve(configuredDir);
  const electronApp = app || require('electron').app;
  return path.join(electronApp.getPath('userData'), 'boards');
}

function createWhiteboardStore(options = {}) {
  const dir = options.dir || resolveBoardsDir(options);
  const now = options.now || (() => Date.now());
  const logger = options.logger || console;
  let chain = Promise.resolve();
  // H1 watch plane (mirrors notes.js): subscribers hear about OUTSIDE writes to
  // any board file, so a CLI write to an open board reaches the canvas instead
  // of being silently overwritten by its next debounced save. Self-echo is
  // suppressed by remembering the exact text this store last wrote per board.
  const listeners = new Set();
  const lastWritten = new Map();
  const debounces = new Map();
  let watcher = null;

  const boardFile = (id) => {
    if (!BOARD_ID.test(String(id || ''))) throw new TypeError('invalid board id');
    return path.join(dir, `${id}.json`);
  };

  const stamp = () => new Date(now()).toISOString().replace(/[:.]/g, '-');
  const metadata = (board, id) => ({
    id,
    name: typeof board.name === 'string' && board.name.trim() ? board.name.trim() : id,
    updatedAt: typeof board.updatedAt === 'string' ? board.updatedAt : new Date(0).toISOString(),
  });

  async function quarantine(file, error) {
    const target = `${file}.corrupt-${stamp()}`;
    try {
      await fsp.rename(file, target);
      return { kind: 'corrupt', detail: target, reason: String(error?.message || error) };
    } catch (renameError) {
      logger.error('Harbor whiteboard: could not quarantine corrupt board:', renameError);
      return { kind: 'corrupt-locked', detail: file, reason: String(error?.message || error) };
    }
  }

  async function readParsed(id) {
    const file = boardFile(id);
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { ok: false, reason: 'board not found' };
      return { ok: false, reason: `could not read board: ${error?.message || error}` };
    }
    try {
      const board = JSON.parse(text);
      if (!board || typeof board !== 'object' || !Array.isArray(board.elements) || !board.files || typeof board.files !== 'object') {
        throw new TypeError('board JSON does not contain a valid Excalidraw scene');
      }
      return { ok: true, board: { ...board, id } };
    } catch (error) {
      const recovery = await quarantine(file, error);
      return { ok: false, reason: 'board file was corrupt and has been set aside', recovery };
    }
  }

  async function save(id, board) {
    await fsp.mkdir(dir, { recursive: true });
    const file = boardFile(id);
    const temp = `${file}.tmp-${process.pid}-${now()}`;
    const backup = `${file}.bak`;
    const text = `${JSON.stringify(board, null, 2)}\n`;
    await fsp.writeFile(temp, text, 'utf8');
    await fsp.copyFile(file, backup).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    await fsp.rename(temp, file);
    lastWritten.set(id, text);
  }

  function serial(run) {
    const result = chain.then(run);
    chain = result.catch(() => {});
    return result;
  }

  function notify(payload) {
    for (const listener of listeners) {
      try { listener(payload); } catch { /* one listener cannot break the store */ }
    }
  }

  function startWatch() {
    if (watcher || listeners.size === 0) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      watcher = fs.watch(dir, (_event, filename) => {
        const name = filename ? filename.toString() : '';
        // Only real board files: .tmp-*, .bak, .corrupt-*, .renamed-* and the
        // .trash subfolder all fail either the suffix or the id shape.
        if (!name.endsWith('.json')) return;
        const id = name.slice(0, -5);
        if (!BOARD_ID.test(id)) return;
        clearTimeout(debounces.get(id));
        const timer = setTimeout(async () => {
          debounces.delete(id);
          let text = null;
          try {
            text = await fsp.readFile(boardFile(id), 'utf8');
          } catch (error) {
            if (error?.code !== 'ENOENT') return;
          }
          if (text === null) {
            // Gone: an outside delete, or this store's own rename/trash (the
            // renderer refreshes its list either way).
            lastWritten.delete(id);
            notify({ id, removed: true });
            return;
          }
          if (text === lastWritten.get(id)) return; // self-echo
          let board = null;
          try { board = JSON.parse(text); } catch { return; } // half-written; the writer's rename will re-fire
          if (!board || typeof board !== 'object' || !Array.isArray(board.elements)) return;
          notify({ id, ...metadata(board, id) });
        }, WATCH_DEBOUNCE_MS);
        timer.unref?.();
        debounces.set(id, timer);
      });
      watcher.on('error', () => {});
    } catch {
      watcher = null;
    }
  }

  function stopWatch() {
    for (const timer of debounces.values()) clearTimeout(timer);
    debounces.clear();
    if (watcher) {
      watcher.close();
      watcher = null;
    }
  }

  return {
    dir,

    subscribe(listener) {
      listeners.add(listener);
      startWatch();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stopWatch();
      };
    },

    close() {
      listeners.clear();
      stopWatch();
    },

    async list() {
      await fsp.mkdir(dir, { recursive: true });
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const boards = [];
      const recovery = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const id = entry.name.slice(0, -5);
        if (!BOARD_ID.test(id)) continue;
        const result = await readParsed(id);
        if (result.ok) boards.push(metadata(result.board, id));
        else if (result.recovery) recovery.push({ id, ...result.recovery });
      }
      return { ok: true, boards: orderBoards(boards), recovery };
    },

    read({ id } = {}) {
      return readParsed(id);
    },

    write({ id, scene } = {}) {
      return serial(async () => {
        const current = await readParsed(id);
        if (!current.ok) return current;
        if (!scene || !Array.isArray(scene.elements) || !scene.files || typeof scene.files !== 'object') {
          return { ok: false, reason: 'invalid Excalidraw scene' };
        }
        const board = {
          ...scene,
          name: current.board.name,
          updatedAt: new Date(now()).toISOString(),
        };
        try {
          await save(id, board);
          return { ok: true, board: { ...board, id } };
        } catch (error) {
          logger.error('Harbor whiteboard: write failed:', error);
          return { ok: false, reason: `could not save board: ${error?.message || error}` };
        }
      });
    },

    create({ name } = {}) {
      return serial(async () => {
        const list = await this.list();
        const cleanName = String(name || 'Untitled board').trim() || 'Untitled board';
        const id = availableBoardId(cleanName, list.boards.map((board) => board.id));
        const board = {
          type: 'excalidraw', version: 2, source: 'local', name: cleanName,
          updatedAt: new Date(now()).toISOString(), elements: [], appState: {}, files: {},
        };
        await save(id, board);
        return { ok: true, board: { ...board, id } };
      });
    },

    rename({ id, name } = {}) {
      return serial(async () => {
        const current = await readParsed(id);
        if (!current.ok) return current;
        const cleanName = String(name || '').trim();
        if (!cleanName) return { ok: false, reason: 'board name is required' };
        const list = await this.list();
        const nextId = availableBoardId(cleanName, list.boards.map((board) => board.id).filter((item) => item !== id));
        const board = { ...current.board, name: cleanName, updatedAt: new Date(now()).toISOString() };
        delete board.id;
        await save(nextId, board);
        if (nextId !== id) await fsp.rename(boardFile(id), path.join(dir, `${id}.renamed-${stamp()}`));
        return { ok: true, board: { ...board, id: nextId }, previousId: id };
      });
    },

    delete({ id } = {}) {
      return serial(async () => {
        const current = await readParsed(id);
        if (!current.ok) return current;
        const trash = path.join(dir, '.trash');
        await fsp.mkdir(trash, { recursive: true });
        const target = path.join(trash, `${id}-${stamp()}.json`);
        await fsp.rename(boardFile(id), target);
        return { ok: true, id, trashPath: target };
      });
    },
  };
}

module.exports = { createWhiteboardStore, resolveBoardsDir };
