'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

// A missing main file can mean quarantine, not a new store. Inspect only its
// own directory and preserve that recovery state across readers and restarts.
async function readQuarantine(file, model, now) {
  const directory = path.dirname(file);
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const compare = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const prefix = compare(path.basename(file) + '.corrupt-');
  const name = entries.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && compare(entry.name).startsWith(prefix))
    .map(entry => entry.name).sort().at(-1);
  if (!name) return null;
  let backup = null;
  try { backup = model.normalizeDoc(JSON.parse(await fs.readFile(file + '.bak', 'utf8')), { now }); }
  catch { /* a missing or unreadable backup cannot clear the quarantine notice */ }
  return {
    doc: backup || model.emptyDoc(now),
    recovery: { kind: backup ? 'restored-backup' : 'corrupt', detail: path.join(directory, name) },
  };
}

module.exports = { readQuarantine };
