'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { cliCommand } = require('./cli-command.js');

function parseCursorModels(text) {
  const rows = [];
  const seen = new Set(['default']);
  for (const line of String(text).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const match = line.match(/^\s*([\w.-]+) - (.+?)\s*$/);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    rows.push({ value: match[1], label: match[2].replace(/\s+\((?:current, default|current|default)\)$/, '') });
  }
  return rows;
}

function readCursorModels(cacheFile) {
  try {
    const rows = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).models;
    return Array.isArray(rows) ? rows.filter((m) => m && /^[\w.-]+$/.test(m.value) && m.value !== 'default' && typeof m.label === 'string') : [];
  } catch { return []; }
}

function cursorModelOptions(cacheFile) {
  return [{ value: 'default', label: 'Default' }, ...readCursorModels(cacheFile)];
}

function createCursorModelCatalog(options = {}) {
  const { cacheFile } = options;
  const env = options.env || process.env;
  const execFile = options.execFile || require('node:util').promisify(require('node:child_process').execFile);
  let pending = null;
  const refresh = () => {
    if (env.HARBOR_E2E === '1' || env.HARBOR_NO_MODEL_DISCOVERY === '1') return Promise.resolve({ ok: false, reason: 'disabled' });
    if (pending) return pending;
    pending = (async () => {
      try {
        const command = cliCommand(env.HARBOR_CURSOR_BIN || options.bin || 'cursor-agent', ['models'], options.platform);
        const { stdout } = await execFile(command.file, command.args, { env, windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
        const models = parseCursorModels(stdout);
        if (!models.length) return { ok: false, reason: 'Cursor returned no model rows' };
        await fs.promises.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.promises.writeFile(`${cacheFile}.tmp`, JSON.stringify({ models }));
        await fs.promises.rename(`${cacheFile}.tmp`, cacheFile);
        return { ok: true };
      } catch (error) { return { ok: false, reason: error.message }; }
    })().finally(() => { pending = null; });
    return pending;
  };
  return { models: () => cursorModelOptions(cacheFile), refresh };
}

module.exports = { parseCursorModels, cursorModelOptions, createCursorModelCatalog };
