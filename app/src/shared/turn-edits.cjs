'use strict';

// The "Edited N files" rows for one turn (2026-10-19). Shared by the
// transcript parser (main/providers/transcript.js), which keeps each turn's
// rows on that turn's prompt block as file actions resolve, and the
// conversation (renderer/stage/turn-cards.cjs), which falls back to the same
// aggregation over the blocks it holds when a turn has no prompt in the window.
//
// Why the parser keeps them: the parser's bounded window evicts old action
// rows long before it evicts prompts, so a card summed from the rows still on
// screen stated a confident, wrong number for any older turn (a 20-file turn
// read "Edited 8 files" once the next turn grew). The prompt survives, and so
// do the totals riding on it.
//
// A file entry is { path, added, removed, diff? }: `removed` is null when no
// call could count it (NotebookEdit).

// Diff previews are kept for the expandable rows, but only so many: they are
// the only large thing a row carries, and a prompt block is kept for a long
// time. Six previews per file and a line budget per turn.
const ROW_HUNK_CAP = 6;
const TURN_DIFF_LINE_BUDGET = 400;

function baseName(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
}

function createEditRows({ diffBudget = Infinity } = {}) {
  return { rows: [], byPath: new Map(), budget: diffBudget };
}

function newRow(filePath) {
  return { path: filePath, name: baseName(filePath), added: 0, removed: null, edits: 0, diffs: [] };
}

// One resolved file-changing call: { key, files, diff } where `diff` is the
// row's own preview, used for a one-file call that carries no per-file diff.
function addEdits(state, entry) {
  const files = Array.isArray(entry?.files) ? entry.files : null;
  if (!files) return;
  for (const file of files) {
    if (!file?.path) continue;
    let row = state.byPath.get(file.path);
    if (!row) {
      row = newRow(file.path);
      state.byPath.set(file.path, row);
      state.rows.push(row);
    }
    row.edits += 1;
    if (Number.isFinite(file.added)) row.added += file.added;
    if (Number.isFinite(file.removed)) row.removed = (row.removed || 0) + file.removed;
    const diff = file.diff || (files.length === 1 ? entry.diff : null);
    if (Array.isArray(diff) && diff.length && row.diffs.length < ROW_HUNK_CAP && diff.length <= state.budget) {
      row.diffs.push({ key: `${entry.key}:${row.diffs.length}`, lines: diff });
      state.budget -= diff.length;
    }
  }
}

// A snapshot that later additions never mutate (the parser publishes these on
// the prompt block; the renderer memoizes on their identity).
function snapshotEditRows(state) {
  return state.rows.map((row) => ({ ...row, diffs: row.diffs.slice() }));
}

function aggregateEdits(entries, options) {
  const state = createEditRows(options);
  for (const entry of entries || []) addEdits(state, entry);
  return state.rows;
}

module.exports = {
  ROW_HUNK_CAP,
  TURN_DIFF_LINE_BUDGET,
  createEditRows,
  addEdits,
  snapshotEditRows,
  aggregateEdits,
  baseName,
};
