'use strict';

// THE MAIN PROCESS NEVER READS A WHOLE TRANSCRIPT (2026-10-09). The Orch
// summaries read every orchestration worker's transcript whole on a cold
// launch (759 files, 4.07GB, codex logs up to 222MB each), and Harbor's main
// process died with "JavaScript heap out of memory" about 20 seconds after its
// window came up, two launches in a row. Questions about a transcript's end go
// through readTailLines / readTranscriptLastSignal / readTranscriptTailRecords
// in providers/transcript.js. This guard fails on any readFile of a
// transcript-shaped path anywhere under src/main or src/shared.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src');
const SCANNED = ['main', 'shared'];
// A readFile whose argument names a transcript, a codex rollout, a session's
// resolved path, or any .jsonl file.
const WHOLE_READ = /readFile(?:Sync)?\(([^)]*(?:transcript|rollout|meta\.path|session\.path|row\.path|entry\.path|\.jsonl)[^)]*)\)/i;
// Small by construction, named on purpose: Claude's prompt history (one line
// per typed prompt, ~1MB after a year) and codex's session index (one line per
// session, tens of KB). Neither is a transcript.
const ALLOWED = [
  /'history\.jsonl'/,
  /'session_index\.jsonl'/,
];

function offenders(source) {
  const found = [];
  source.split(/\r?\n/).forEach((line, index) => {
    const match = line.match(WHOLE_READ);
    if (match && !ALLOWED.some((allowed) => allowed.test(match[1]))) found.push({ line: index + 1, text: line.trim() });
  });
  return found;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(c?js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('the guard catches both whole-file reads that crashed the 2026-10-09 launches', () => {
  // Verbatim from the pre-fix tree: index.js orchHistoryRows and
  // transcript.js readTranscriptTailRecords.
  assert.equal(offenders("          for (const line of (await fs.readFile(meta.path, 'utf8')).split(/\\r?\\n/)) {").length, 1);
  assert.equal(offenders("  const raw = await fsp.readFile(transcriptPath, 'utf8');").length, 1);
  assert.equal(offenders("        for (const line of splitLines(fsImpl.readFileSync(path.join(root, 'history.jsonl'), 'utf8'))) {").length, 0);
});

test('no main-process or shared module reads a transcript whole', () => {
  const found = [];
  for (const root of SCANNED) {
    for (const file of walk(path.join(SRC, root))) {
      for (const hit of offenders(fs.readFileSync(file, 'utf8'))) {
        found.push(`${path.relative(SRC, file)}:${hit.line}  ${hit.text}`);
      }
    }
  }
  assert.deepEqual(found, [], `read the tail instead (providers/transcript.js readTailLines):\n${found.join('\n')}`);
});
