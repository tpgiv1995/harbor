'use strict';

// Per-turn cards in the conversation (2026-10-19): the "Edited N files" card
// that closes a finished turn, and the turn boundaries both cards are placed
// by. Pure functions over the parsed blocks (main/providers/transcript.js), so
// the conversation and the tests read the same rules.

const { aggregateEdits, baseName } = require('../../shared/turn-edits.cjs');

// A turn is a user prompt and everything up to the next one. A message the
// user queued while Claude worked joins the running turn rather than starting
// one (it does not start a turn in the parser either).
function startsTurn(block) {
  return block?.kind === 'user' && !block.queued;
}

// [[block, ...], ...]. Blocks before the first prompt (a tail that began
// mid-turn) are a turn of their own.
function splitTurns(blocks) {
  const turns = [];
  let current = [];
  for (const block of blocks || []) {
    if (startsTurn(block) && current.length) {
      turns.push(current);
      current = [];
    }
    current.push(block);
  }
  if (current.length) turns.push(current);
  return turns;
}

// Every file the turn's file-changing actions touched, by full path, in the
// order first touched. Each row sums its +/- across the turn and keeps the
// diff previews its actions carried. A failed call changed nothing and is not
// counted. `removed` stays null when no call could count it (NotebookEdit).
// This is the FALLBACK, for blocks before the first prompt in the window: a
// turn led by its prompt reads the totals the parser kept on that prompt
// (`edits`, shared/turn-edits.cjs), which evicting the turn's older action
// rows cannot shrink.
function turnEdits(blocks) {
  const entries = [];
  for (const block of blocks || []) {
    if (block?.kind !== 'action' || block.status === 'err' || !Array.isArray(block.files)) continue;
    entries.push({ key: block.key, files: block.files, diff: block.diff });
  }
  return aggregateEdits(entries);
}

function editTotals(rows) {
  let added = 0;
  let removed = 0;
  for (const row of rows || []) {
    added += row.added || 0;
    removed += row.removed || 0;
  }
  return { added, removed };
}

// A short coloured label by extension; null means the generic file glyph.
const BADGES = {
  js: ['JS', 'js'], cjs: ['JS', 'js'], mjs: ['JS', 'js'], jsx: ['JSX', 'js'],
  ts: ['TS', 'ts'], tsx: ['TSX', 'ts'], mts: ['TS', 'ts'], cts: ['TS', 'ts'],
  py: ['PY', 'py'], pyi: ['PY', 'py'],
  md: ['MD', 'md'], mdx: ['MD', 'md'], markdown: ['MD', 'md'], txt: ['TXT', 'md'],
  json: ['JSON', 'json'], jsonl: ['JSON', 'json'], yaml: ['YML', 'json'], yml: ['YML', 'json'], toml: ['TOML', 'json'],
  css: ['CSS', 'css'], scss: ['CSS', 'css'], html: ['HTML', 'css'], htm: ['HTML', 'css'],
  sh: ['SH', 'sh'], bash: ['SH', 'sh'], zsh: ['SH', 'sh'], ps1: ['PS', 'sh'],
  go: ['GO', 'ts'], rs: ['RS', 'py'], rb: ['RB', 'py'], java: ['JAVA', 'py'], swift: ['SWIFT', 'py'],
  sql: ['SQL', 'json'], ipynb: ['NB', 'py'],
};

function fileBadge(p) {
  const name = baseName(p);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const found = BADGES[name.slice(dot + 1).toLowerCase()];
  return found ? { label: found[0], tone: found[1] } : null;
}

// Is the last turn still going? The same signal as the working shimmer:
// transcript.js workingState, which also ends a turn whose owner died or went
// quiet, so a dead session's last turn still gets its card.
function turnRunning(header) {
  return Boolean(header?.working);
}

const NO_EDITS = Object.freeze([]);

// The conversation's turns with what each one closes on: `running` is true
// only for the LAST turn while it is still going (turnRunning), and `edits`
// is the "Edited N files" card's rows, empty while running or when nothing
// changed. A prompt-led turn's rows are the parser's (the same array until
// the prompt block changes, so a memoized card holds). `key` is stable for
// the turn's life: its prompt's key, or 'head' for the blocks before the
// first prompt in the window (whose first block changes as the window slides).
function planTurns(blocks, running) {
  const turns = splitTurns(blocks);
  return turns.map((turn, index) => {
    const isRunning = Boolean(running) && index === turns.length - 1;
    const lead = turn[0];
    const ledByPrompt = startsTurn(lead);
    let edits = NO_EDITS;
    if (!isRunning) edits = ledByPrompt && Array.isArray(lead.edits) ? lead.edits : turnEdits(turn);
    if (!edits.length) edits = NO_EDITS;
    return { blocks: turn, running: isRunning, edits, key: ledByPrompt ? lead.key : 'head' };
  });
}

function filesLabel(n) {
  return `Edited ${n} file${n === 1 ? '' : 's'}`;
}

module.exports = { startsTurn, splitTurns, turnEdits, planTurns, turnRunning, editTotals, fileBadge, filesLabel };
