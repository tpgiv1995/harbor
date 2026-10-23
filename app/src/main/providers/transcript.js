'use strict';

const { watchPath } = require('../watch-path.js');
const { turnSignal } = require('../../shared/claude-turn-state.cjs');

// Transcript provider: the data plane of the Slate conversation surface. Tails
// a session's JSONL transcript (the same files harbor-index.py indexes) and
// parses it into renderer-ready conversation blocks: user bubbles, assistant
// prose, and tool-action rows. The pty is NOT the source here; transcripts
// update for every session Claude Code writes, including sessions running
// outside Harbor, so every tile renders live regardless of where the agent runs.

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { readSessionBeacon, readOwnerProcessAlive } = require('./session-owner.js');
const { processAliveFromEvidence } = require('../../shared/session-run-state.cjs');


// Cap what one tile renders; a 2-day session transcript can be tens of MB.
// Keep recent conversation rows plus a bounded set of image-bearing rows.
const MAX_BLOCKS = 240;
const MAX_IMAGE_BLOCKS = 32;
const MAX_INITIAL_BYTES = 1024 * 1024;
// Windowed delivery (MOBILE-3): a phone on cellular cannot take the full
// desktop payload. A windowed open trims what gets EMITTED to the client to
// the most recent N blocks; the live parser and its tailing offset are
// untouched, so the desktop default (no `window` hint) is byte-identical.
// Older blocks page in on demand via `page()`, reading further back in the
// file independently of the live-tailing entry.
const DEFAULT_WINDOW_BLOCKS = 60;
const PAGE_CHUNK_START_BYTES = 512 * 1024;
const PAGE_CHUNK_MAX_BYTES = 64 * 1024 * 1024;

function normalizeWindowBlocks(window) {
  const requested = Number.isFinite(window?.blocks) ? Math.floor(window.blocks) : DEFAULT_WINDOW_BLOCKS;
  return Math.max(1, Math.min(MAX_BLOCKS, requested));
}
// Text carried per block is display material, not an archive.
// Prose cap: a perf guard against pathological blocks (a megabyte of pasted
// logs), NOT an editorial limit. Real reports run 6-10k chars and must render
// whole (live-caught 2026-07-20: a final report was silently amputated at the
// old 4,000). When the guard does fire it must say so, never a bare ellipsis.
const MAX_TEXT_CHARS = 24_000;
const MAX_DIFF_LINES = 14;
// The statusline tee and transcript are separate writes, so allow a little
// scheduling/filesystem skew before deciding the transcript grew past the tee.
const TEE_TRANSCRIPT_SKEW_MS = 5_000;
// Claude Code re-renders the statusline at least every ~3 minutes while a
// session is open; a tee younger than this is at most one render stale, which
// is a far smaller error than the L2 ratchet's 200k-denominator fallback.
const TEE_RECENT_MS = 5 * 60_000;

function extractHandoffPath(text) {
  const matches = String(text || '').match(/\/(?:[^\\\s"'`<>]+\/)*\.claude\/handoffs\/handoff-[^\\\s"'`<>]+\.md/g);
  return matches?.at(-1) || null;
}

// Read only transcript bytes written after /handoff was sent, so an older
// handoff path elsewhere in a long session can never launch the wrong pickup.
async function waitForHandoffPath(transcriptPath, startOffset, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const pollMs = options.pollMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let offset = startOffset;
  let tail = '';
  while (Date.now() < deadline) {
    let handle;
    try {
      const stat = await fsp.stat(transcriptPath);
      if (stat.size > offset) {
        handle = await fsp.open(transcriptPath, 'r');
        const buffer = Buffer.alloc(stat.size - offset);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        offset += bytesRead;
        tail = `${tail}${buffer.toString('utf8', 0, bytesRead)}`.slice(-256 * 1024);
        const found = extractHandoffPath(tail);
        if (found) return found;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    } finally {
      await handle?.close();
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error('handoff completed without reporting a handoff file path');
}

// Model id -> display name + chip tint. The NAME is DERIVED from the id, the
// SAME way the phone does it (web/src/shell/model-label.js prettyModelId), so
// the two surfaces cannot drift and a new model never needs a code change. This
// was a hardcoded regex table, and /^claude-fable-5/ matched claude-fable-5-1
// and rendered a real Fable 5.1 session as "Fable 5" (2026-09-01) while the
// phone, which derives, showed "Fable 5.1", exactly the drift the shared rule
// exists to prevent, and the same no-stale-table doctrine as the model catalog.
// TONE (chip tint) is the only per-family fact left, keyed off the family word
// (family-first ids, plus the legacy family-last claude-3-5-haiku).
const FAMILY_TONE = { fable: 'fable', mythos: 'fable', opus: 'opus', sonnet: 'sonnet', haiku: 'haiku' };

function modelName(modelId) {
  return String(modelId || '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
    // Split version segments read as a version, not two numbers: "Opus 4 5"
    // becomes "Opus 4.5", and "Fable 5 1" becomes "Fable 5.1".
    .replace(/(\d) (\d)/, '$1.$2');
}

function modelTone(modelId) {
  const family = String(modelId || '').match(/^claude-([a-z]+)/)?.[1]
    || String(modelId || '').match(/-([a-z]+)$/)?.[1];
  return FAMILY_TONE[family] || 'other';
}

function modelDisplay(modelId) {
  if (!modelId) return null;
  return { id: modelId, name: modelName(modelId), tone: modelTone(modelId) };
}

// The inverse of modelName, for the cap-menu current-row highlight: a friendly
// "Fable 5.1" back to its canonical id. Standard versioned Claude names
// round-trip (spaces and dots become hyphens); an alias with no version
// ("Sonnet") stays id-less because it names no single model.
function idFromModelName(name) {
  const slug = String(name || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/\./g, '-');
  return /^(fable|mythos|opus|sonnet|haiku)-\d/.test(slug) ? `claude-${slug}` : null;
}

// A /model switch emits no assistant message, so header.model can't learn the
// new model from a reply. The CLI instead writes a "<local-command-stdout>Set
// model to <NAME> and saved…" confirmation (name wrapped in ANSI bold). Parse
// it so the chip follows a switch from ANY path (cap menu, composer, or the raw
// terminal) the instant the CLI confirms it, not on the next reply.
// (Live-caught 2026-07-20; verified against a real 2.1.216 transcript.)
function modelFromSetModelStdout(text) {
  const stripped = String(text || '').replace(/\[[0-9;]*m/g, '');
  const match = stripped.match(/Set model to\s+(.+?)(?:\s+and saved\b|<\/local-command-stdout>|$)/i);
  if (!match) return null;
  const name = match[1].trim();
  if (!name || /^default$/i.test(name)) return null;
  const family = name.toLowerCase().split(/[\s-]/)[0];
  return { id: idFromModelName(name), name, tone: FAMILY_TONE[family] || 'other' };
}

// /effort has the same invisibility as /model: it emits no assistant message,
// only a "<local-command-stdout>Set effort level to <LEVEL> (…)" confirmation
// (verified against a real 2.1.216 transcript). Follow it so the effort badge
// updates on the switch, not on the next reply.
function effortFromSetEffortStdout(text) {
  const match = String(text || '').match(/Set effort level to\s+(low|medium|high|xhigh|max)\b/i);
  return match ? match[1].toLowerCase() : null;
}

// There is deliberately NO per-model context-window table here. Five live
// incidents in four days (2026-07-18 through 2026-07-21) each traced to a
// percentage computed from a GUESSED denominator: a family default, an
// assumed 1M, a table missing a new model id. The invariant since
// 2026-07-21 (Pat mandate): Harbor never invents a denominator. A percent
// comes from Claude's own math (the statusline tee, or a window LEARNED
// numerically from a pairable tee and persisted); otherwise the chip shows
// the honest token count.

function usageTokens(usage) {
  if (!usage) return null;
  const total = (usage.input_tokens || 0)
    + (usage.cache_read_input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0);
  return total > 0 ? total : null;
}

// Conversation prose: unbounded for anything a person actually wrote or read;
// the guard only trims pathological blocks and announces that it did.
function clipProse(text) {
  const s = String(text ?? '');
  if (s.length <= MAX_TEXT_CHARS) return s;
  return `${s.slice(0, MAX_TEXT_CHARS)}\n\n[clipped by Harbor: the full message is in the transcript]`;
}

function clip(text, max = MAX_TEXT_CHARS) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function countLines(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  return s.split('\n').length;
}

function basename(p) {
  const s = String(p || '');
  return s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s;
}

// Cursor's munge collapses every RUN of non-alphanumerics to one dash
// ('C:\dev\x' -> 'C-dev-x'), unlike Claude's per-character munge below. The
// per-character spelling this carried until 2026-08-23 built paths no Windows
// cursor dir ever has, so a cursor window derived from its cwd found no
// transcript. Matches mungeCwd in provider-history.js.
function cursorProjectDir(cwd) {
  return String(cwd || '').replace(/^\/+/, '').replace(/[^a-zA-Z0-9]+/g, '-');
}

// Claude Code's project-dir munge: every non-alphanumeric cwd character becomes
// '-' ('/home/you/dev/harbor' -> '-home-you-dev-harbor').
const mungeCwd = (cwd) => String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
const claudeProjectsRoot = (home) => path.join(home, '.claude', 'projects');

function transcriptPathFor({ provider = 'claude', sessionId, cwd, home = os.homedir() }) {
  if (provider === 'codex') {
    // Rollout filenames include a launch timestamp before the session id, so
    // no honest exact path can be derived from the id alone. Discovery scans
    // the dated directories in findProviderTranscript instead.
    return null;
  }
  if (provider === 'cursor') {
    return path.join(home, '.cursor', 'projects', cursorProjectDir(cwd), 'agent-transcripts', sessionId, `${sessionId}.jsonl`);
  }
  // Claude's path is deterministic: the cwd munged into a project dir, then
  // <session id>.jsonl. Deriving it is what lets a window render a session the
  // INDEX has not caught up to yet (see findProviderTranscript).
  if (!cwd) return null;
  return path.join(claudeProjectsRoot(home), mungeCwd(cwd), `${sessionId}.jsonl`);
}

async function findProviderTranscript({ provider, sessionId, cwd, home = os.homedir() }) {
  if (provider === 'cursor') {
    const candidate = transcriptPathFor({ provider, sessionId, cwd, home });
    try { await fsp.access(candidate); return candidate; } catch { return null; }
  }
  // CLAUDE used to fall straight through this function to `return null`, so the
  // only way a claude window ever found its transcript was `meta.path` from the
  // harbor INDEX. A session younger than the index therefore opened to "No
  // transcript yet" and stayed there, because the renderer marks a failed open
  // as missing and never asks again.
  //
  // That is what Pat hit twice on 2026-07-28 with brand-new sessions, the
  // second time on a session that was already 190 transcript lines deep and
  // plainly on disk. The path is derivable and the id is unique, so neither the
  // index nor a known cwd is actually required to find it.
  if (!provider || provider === 'claude') {
    const direct = transcriptPathFor({ provider: 'claude', sessionId, cwd, home });
    if (direct) {
      try { await fsp.access(direct); return direct; } catch { /* not under that cwd */ }
    }
    // No cwd, or the session was launched from somewhere else: a session id is
    // unique across the store, so look for the file itself. One readdir plus a
    // stat per project dir, and only on the path that would otherwise fail.
    const root = claudeProjectsRoot(home);
    const dirs = await fsp.readdir(root).catch(() => []);
    for (const dir of dirs) {
      const candidate = path.join(root, dir, `${sessionId}.jsonl`);
      try {
        await fsp.access(candidate);
        return candidate;
      } catch { /* not in this project */ }
    }
    return null;
  }
  if (provider !== 'codex') return null;
  const root = path.join(home, '.codex', 'sessions');
  const years = await fsp.readdir(root).catch(() => []);
  for (const year of years.sort().reverse()) {
    const months = await fsp.readdir(path.join(root, year)).catch(() => []);
    for (const month of months.sort().reverse()) {
      const days = await fsp.readdir(path.join(root, year, month)).catch(() => []);
      for (const day of days.sort().reverse()) {
        const dir = path.join(root, year, month, day);
        const names = await fsp.readdir(dir).catch(() => []);
        const name = names.find((item) => item.endsWith(`${sessionId}.jsonl`));
        if (name) return path.join(dir, name);
      }
    }
  }
  return null;
}

// THE MAIN PROCESS NEVER READS A WHOLE TRANSCRIPT (2026-10-09). Two callers
// read the entire file into one string to look at its last few records, and an
// orchestration worker's codex log routinely runs 100-600MB. A fresh launch
// built the Orch summaries by doing that for every worker session at once, and
// one string that size cannot be placed in a main-process heap already holding
// a gigabyte: "JavaScript heap out of memory" about 20 seconds after the window
// came up, two launches in a row (crash dumps 2026-10-09 02:26 and 02:31).
// Every question asked of a transcript's END is now answered from its tail:
// the window starts at MAX_INITIAL_BYTES and doubles until it holds `minLines`
// non-empty lines, reaches the start of the file, or hits `maxBytes`. Lines are
// decoded one at a time from the buffer, so no string is ever larger than one
// record. The first line of a window that starts mid-file is dropped (it is
// cut); the trailing segment is kept, and a half-written one simply fails to
// parse, exactly as it did when the whole file was split.
const TAIL_SIGNAL_MIN_LINES = 64;
const TAIL_SIGNAL_MAX_BYTES = 16 * 1024 * 1024;
const TAIL_RECORDS_MAX_BYTES = 64 * 1024 * 1024;

async function readTailLines(filePath, { minLines = 1, startBytes = MAX_INITIAL_BYTES, maxBytes = TAIL_RECORDS_MAX_BYTES } = {}) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    let span = Math.min(size, startBytes, maxBytes);
    for (;;) {
      const start = size - span;
      const buffer = Buffer.alloc(span);
      let filled = 0;
      while (filled < span) {
        const { bytesRead } = await handle.read(buffer, filled, span - filled, start + filled);
        if (!bytesRead) break;
        filled += bytesRead;
      }
      const lines = [];
      let lineStart = 0;
      if (start > 0) {
        const firstNewline = buffer.indexOf(0x0a);
        lineStart = firstNewline === -1 || firstNewline >= filled ? filled : firstNewline + 1;
      }
      while (lineStart < filled) {
        let lineEnd = buffer.indexOf(0x0a, lineStart);
        if (lineEnd === -1 || lineEnd > filled) lineEnd = filled;
        const text = buffer.toString('utf8', lineStart, lineEnd).trim();
        if (text) lines.push(text);
        lineStart = lineEnd + 1;
      }
      if (lines.length >= minLines || start === 0 || span >= maxBytes) return lines;
      span = Math.min(size, span * 2, maxBytes);
    }
  } finally {
    await handle.close();
  }
}

// Resume recovery needs raw tail records, not renderer blocks: origin,
// promptSource, and isMeta are exactly what distinguish a typed message from
// harness traffic. The tail window grows until it holds maxRecords complete
// lines, so one very long final message is never clipped by a byte window
// (up to TAIL_RECORDS_MAX_BYTES, which no single record has come near).
async function readTranscriptTailRecords(transcriptPath, { maxRecords = 128 } = {}) {
  const lines = await readTailLines(transcriptPath, { minLines: maxRecords, maxBytes: TAIL_RECORDS_MAX_BYTES });
  const records = [];
  for (let index = lines.length - 1; index >= 0 && records.length < maxRecords; index -= 1) {
    try { records.unshift(JSON.parse(lines[index])); } catch { /* incomplete or foreign line */ }
  }
  return records;
}

// Whether a session's last turn ended ('idle'), is waiting on a tool, or is
// mid-turn: the same lastSignal the full parse produced, read off the tail the
// way every tile prices its own working state off a MAX_INITIAL_BYTES tail.
async function readTranscriptLastSignal(transcriptPath, provider = 'claude') {
  const lines = await readTailLines(transcriptPath, { minLines: TAIL_SIGNAL_MIN_LINES, maxBytes: TAIL_SIGNAL_MAX_BYTES });
  const parser = new TranscriptParser(provider);
  for (const line of lines) {
    try { parser.applyLine(JSON.parse(line)); } catch { /* skip partial records */ }
  }
  return parser.header.lastSignal;
}

// One tool_use -> one action row: verb + mono chip + optional right-hand pill,
// in the design's vocabulary. The chip shows the thing acted on; the full value
// rides in chipTitle for hover.
function actionForToolUse(block) {
  const name = String(block.name || 'Tool');
  const input = block.input || {};
  // `path` and `contents` are cursor's spelling of the same two arguments
  // (Read{path}, Write{path,contents}); without them a cursor file action drew
  // a verb with no filename and "0 lines" beside it.
  const file = input.file_path || input.notebook_path || input.path || null;
  const mk = (verb, chip, extra = {}) => ({
    verb,
    chip: chip ? clip(chip, 64) : null,
    chipTitle: chip ? clip(chip, 400) : null,
    ...extra,
  });
  switch (name) {
    case 'Edit': {
      const added = countLines(input.new_string);
      const removed = countLines(input.old_string);
      return mk('Edited', basename(file), {
        pill: { text: `+${added} −${removed}`, tone: 'ok' },
        diff: buildDiffPreview(input.old_string, input.new_string),
      });
    }
    case 'Write':
      return mk('Wrote', basename(file), {
        pill: { text: `${countLines(input.content ?? input.contents)} lines`, tone: 'ok' },
      });
    case 'NotebookEdit':
      return mk('Edited', basename(file));
    case 'Read':
      return mk('Read', basename(file), {
        cv: input.pages ? `p. ${input.pages}` : (input.offset ? `from :${input.offset}` : null),
      });
    case 'Bash':
    case 'Shell':
    case 'exec_command':
      return mk('Ran', input.command, { cv: null });
    case 'Grep':
      return mk('Searched', input.pattern, { cv: input.path ? basename(input.path) : null });
    case 'Glob':
      return mk('Globbed', input.pattern);
    case 'Task':
    case 'Agent':
      return mk('Delegated', input.description || input.subagent_type || 'subagent');
    case 'TodoWrite':
      return mk('Updated todos', null);
    case 'WebFetch':
      return mk('Fetched', hostOf(input.url));
    case 'WebSearch':
      return mk('Searched web', input.query);
    case 'Skill':
      return mk('Skill', input.skill || input.command);
    case 'AskUserQuestion':
      return mk('Asked', firstQuestion(input));
    case 'ExitPlanMode':
      return mk('Proposed plan', null);
    case 'EnterPlanMode':
      return mk('Entered plan mode', null);
    default: {
      const mcp = name.match(/^mcp__(.+?)__(.+)$/);
      if (mcp) return mk(prettyToolName(mcp[2]), null, { cv: mcp[1].replace(/^claude_ai_/, '') });
      return mk(prettyToolName(name), primaryInputValue(input));
    }
  }
}

function prettyToolName(name) {
  return String(name).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return clip(url, 48); }
}

function firstQuestion(input) {
  const q = input?.questions?.[0]?.question;
  return q ? clip(q, 80) : null;
}

// Codex writes a custom_tool_call's input as the JavaScript it is about to run
// rather than as JSON: `const r = await tools.exec_command({"cmd":"npm test"})`.
// Taken literally that made EVERY codex tool row in Harbor read
// `Exec  const r = await tools.exec_command({"cmd":"npm te…`, which is the
// snippet and not the command; `exec` is the transport, `exec_command` is the
// tool and `cmd` is its argument. A survey of the real store found exactly two
// tool names in use (`exec` this shape, and `wait` as plain JSON), so this is
// the shape of nearly every action row a codex session has. Pulling the inner
// call back out gives the row a codex user would recognise (`Ran  npm test`),
// and anything that does not match falls through to the JSON path unchanged.
const CODEX_TOOL_SNIPPET_RE = /\btools\.([A-Za-z_]\w*)\s*\(\s*\{/;

function codexToolSnippet(source) {
  const text = String(source);
  const match = CODEX_TOOL_SNIPPET_RE.exec(text);
  if (!match) return null;
  const open = text.indexOf('{', match.index);
  // Balanced and string-aware, because a brace inside a quoted command must not
  // close the object early: `{"cmd":"awk '{print $1}' log"}` is an ordinary line.
  let depth = 0;
  let quote = null;
  let end = -1;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;
  let input;
  try { input = JSON.parse(text.slice(open, end + 1)); } catch { return null; }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  return { name: match[1], input };
}

// CODEX APPLY_PATCH. Codex edits files by sending a patch envelope rather than
// Claude's old_string/new_string pair:
//   *** Begin Patch
//   *** Update File: src/a.js      (or Add File / Delete File, + Move to:)
//   @@ ...
//   -old line
//   +new line
//   *** End Patch
// It reaches the rollout three ways: as the freeform `apply_patch` tool's raw
// input, as `{"input": ...}` JSON, or inside an exec snippet
// (`tools.apply_patch("*** Begin Patch\n...")`, or a shell heredoc through
// exec_command). Every one of them renders like a Claude Edit row: the file,
// +/- counts and a short diff. Context lines are left out of the preview, the
// same as buildDiffPreview. Drawn as the raw call it read "Exec  const r =
// await tools.apply_patch(..." or "Apply Patch" with no file at all.
function parseApplyPatch(text) {
  const source = String(text ?? '');
  const begin = source.indexOf('*** Begin Patch');
  if (begin < 0) return null;
  const files = [];
  let current = null;
  for (const raw of source.slice(begin).split('\n')) {
    const line = raw.replace(/\r$/, '');
    const header = /^\*\*\* (Update|Add|Delete) File:\s*(.+?)\s*$/.exec(line);
    if (header) {
      current = { op: header[1].toLowerCase(), path: header[2], moveTo: null, added: 0, removed: 0, lines: [] };
      files.push(current);
      continue;
    }
    if (/^\*\*\* End Patch/.test(line)) break;
    const move = /^\*\*\* Move to:\s*(.+?)\s*$/.exec(line);
    if (move) { if (current) current.moveTo = move[1]; continue; }
    if (!current || line.startsWith('***') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) { current.added += 1; current.lines.push({ t: 'add', s: clip(line.slice(1), 160) }); }
    else if (line.startsWith('-')) { current.removed += 1; current.lines.push({ t: 'del', s: clip(line.slice(1), 160) }); }
  }
  return files.length ? files : null;
}

function fileBase(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
}

function actionForApplyPatch(patchText) {
  const files = parseApplyPatch(patchText);
  if (!files) return null;
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const ops = new Set(files.map((f) => f.op));
  const verb = ops.size === 1 && ops.has('add') ? 'Wrote'
    : ops.size === 1 && ops.has('delete') ? 'Deleted' : 'Edited';
  const first = files[0];
  const name = fileBase(first.moveTo || first.path);
  const chip = files.length > 1 ? `${name} +${files.length - 1} more` : name;
  const lines = [];
  let shown = 0;
  let total = 0;
  for (const file of files) {
    total += file.lines.length;
    if (files.length > 1 && shown < MAX_DIFF_LINES) lines.push({ t: 'ctx', s: fileBase(file.moveTo || file.path) });
    for (const line of file.lines) {
      if (shown >= MAX_DIFF_LINES) break;
      lines.push(line);
      shown += 1;
    }
  }
  if (total > shown) lines.push({ t: 'ctx', s: `… ${total - shown} more lines` });
  // A delete or a pure rename has no lines to count, so its pill says what
  // happened instead of "+0 −0".
  const renamedOnly = !added && !removed && files.every((f) => f.op === 'update' && f.moveTo && f.moveTo !== f.path);
  let pill;
  if (verb === 'Deleted') pill = { text: files.length > 1 ? `${files.length} files` : 'deleted', tone: 'ok' };
  else if (renamedOnly) pill = { text: 'renamed', tone: 'ok' };
  else pill = { text: `+${added} −${removed}`, tone: 'ok' };
  return {
    verb,
    chip: clip(chip, 64),
    chipTitle: clip(files.map((f) => (f.moveTo ? `${f.path} → ${f.moveTo}` : f.path)).join('\n'), 400),
    pill,
    diff: lines.length ? lines : null,
  };
}

// `tools.apply_patch("*** Begin Patch\n...")`: the argument is a JS string
// literal, not an object, so codexToolSnippet cannot read it. Only the FIRST
// literal is taken; a patch concatenated from several pieces previews what its
// first piece holds, which is still the right file and the right shape.
const APPLY_PATCH_CALL_RE = /\btools\.apply_patch\s*\(\s*/;
function applyPatchFromSnippet(source) {
  const text = String(source ?? '');
  const match = APPLY_PATCH_CALL_RE.exec(text);
  if (!match) return null;
  const start = match.index + match[0].length;
  const quote = text[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let i = start + 1;
  for (; i < text.length; i += 1) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text[i] === quote) break;
  }
  const body = text.slice(start + 1, i);
  if (quote === '"') {
    try { return JSON.parse(`"${body}"`); } catch { /* fall through to the loose unescape */ }
  }
  return body.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(["'`\\])/g, '$1');
}

// A codex UserMessage carries a pasted or attached image as a `local_image`
// part holding only the file's PATH, not Claude's inline base64 (the older
// user_message event carries the same paths as a `local_images` array). The
// live window reads it into the same data URI a Claude image uses so it renders
// identically; every other parser (titles, previews, paging) keeps just a
// named attachment, and a file that is gone or too large stays one too, never
// a broken image.
const LOCAL_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const LOCAL_IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
// The opening-block scan, the prefix image seeder and the live tail all parse
// the same prompt, so the encoded string is kept per path + size + mtime: an
// unchanged file costs a stat, and every parser holding it shares ONE string.
// Bounded both ways (entries and encoded bytes), least recently used out first.
const LOCAL_IMAGE_CACHE_ENTRIES = 32;
const LOCAL_IMAGE_CACHE_BYTES = 64 * 1024 * 1024;
const localImageCache = new Map(); // path -> { size, mtimeMs, image }
let localImageCacheBytes = 0;
const localImageStats = { reads: 0, hits: 0 }; // for tests and measurement

function forgetLocalImage(filePath) {
  const cached = localImageCache.get(filePath);
  if (!cached) return;
  localImageCache.delete(filePath);
  localImageCacheBytes -= cached.image.dataUri.length;
}

function readLocalImage(filePath) {
  const mediaType = LOCAL_IMAGE_TYPES[path.extname(String(filePath || '')).slice(1).toLowerCase()];
  if (!mediaType) return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > LOCAL_IMAGE_MAX_BYTES) { forgetLocalImage(filePath); return null; }
    const cached = localImageCache.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      // Re-insert: Map order is the LRU order.
      localImageCache.delete(filePath);
      localImageCache.set(filePath, cached);
      localImageStats.hits += 1;
      return { ...cached.image };
    }
    forgetLocalImage(filePath);
    localImageStats.reads += 1;
    const image = { mediaType, dataUri: `data:${mediaType};base64,${fs.readFileSync(filePath).toString('base64')}` };
    if (image.dataUri.length <= LOCAL_IMAGE_CACHE_BYTES) {
      localImageCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, image });
      localImageCacheBytes += image.dataUri.length;
      while (localImageCache.size > LOCAL_IMAGE_CACHE_ENTRIES || localImageCacheBytes > LOCAL_IMAGE_CACHE_BYTES) {
        forgetLocalImage(localImageCache.keys().next().value);
      }
    }
    return { ...image };
  } catch {
    forgetLocalImage(filePath);
    return null;
  }
}

// A tool call's output: a plain string before codex 0.160, an ARRAY of text
// parts since.
function codexOutputText(output) {
  if (Array.isArray(output)) {
    return output.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('\n');
  }
  return typeof output === 'string' ? output : '';
}

// Only an exit code in the text counts. The bare word "error" used to mark a
// row failed, which made every `grep error` and every log a command printed
// read as a failure.
const CODEX_EXIT_TEXT_RE = /Process exited with code ([1-9]\d*)|"exit_code"\s*:\s*([1-9]\d*)/;

// turn_context's approval_policy / sandbox_policy, as the raw value codex
// wrote: a string stays a string, a tagged object (`{ "type":
// "workspace-write", ... }`, or a serde enum variant `{ "granular": {...} }`)
// is reduced to the name of its mode.
function codexPolicyValue(value) {
  if (typeof value === 'string') return value || null;
  if (!value || typeof value !== 'object') return null;
  if (typeof value.type === 'string') return value.type;
  if (typeof value.mode === 'string') return value.mode;
  return Object.keys(value)[0] || null;
}

// A question set as Harbor keeps it: [{ title, options: [string] | null }].
// The desktop app writes it on an AgentMessage as { title, options: [string] };
// the TUI's request_user_input call writes { question, options: [{ label }] }.
// Two question sets are the same question when their titles match in order.
function sameCodexQuestions(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((q, i) => q.title === b[i].title);
}

function normalizeCodexQuestions(questions) {
  if (!Array.isArray(questions)) return null;
  const out = [];
  for (const q of questions) {
    if (!q || typeof q !== 'object') continue;
    const title = clip(String(q.title ?? q.question ?? '').trim(), 400);
    const options = Array.isArray(q.options)
      ? q.options
        .map((o) => (typeof o === 'string' ? o : (o?.label ?? o?.title ?? '')))
        .map((o) => clip(String(o).trim(), 200))
        .filter(Boolean)
      : null;
    if (title || options?.length) out.push({ title, options: options?.length ? options : null });
  }
  return out.length ? out : null;
}

// One codex tool call -> one action row. See codexToolSnippet for the exec
// shape. MCP tools arrive as a function_call whose `namespace` names the
// server (`mcp__cua_repl`) and whose `name` is the bare tool (`js`), so on its
// own the row read "Js"; folded back into the Claude spelling it renders like
// a Claude MCP row (tool, then the server on the right), with the call's own
// title as the chip when it has one. An apply_patch, however it was sent,
// renders as an edit (actionForApplyPatch).
function codexActionFor(payload) {
  let name = payload.name || 'Tool';
  const raw = payload.arguments ?? payload.input ?? {};
  let input = raw;
  if (typeof raw === 'string') {
    if (name === 'apply_patch') {
      const edit = actionForApplyPatch(raw);
      if (edit) return edit;
    }
    const literal = applyPatchFromSnippet(raw);
    const edit = literal ? actionForApplyPatch(literal) : null;
    if (edit) return edit;
    const snippet = codexToolSnippet(raw);
    if (snippet) ({ name, input } = snippet);
    else { try { input = JSON.parse(raw); } catch { input = { command: raw }; } }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
  if (input.cmd && !input.command) input.command = input.cmd;
  if (name === 'apply_patch') {
    const edit = actionForApplyPatch(input.input ?? input.patch ?? '');
    if (edit) return edit;
  }
  // `apply_patch <<'EOF' ... EOF` through the shell is the same edit.
  if (typeof input.command === 'string' && input.command.includes('*** Begin Patch')) {
    const edit = actionForApplyPatch(input.command);
    if (edit) return edit;
  }
  const namespace = typeof payload.namespace === 'string' && payload.namespace ? payload.namespace : null;
  const mcp = namespace && /^mcp__/.test(namespace);
  if (mcp && !/^mcp__/.test(name)) name = `mcp__${namespace.replace(/^mcp__/, '').replace(/_+$/, '')}__${name}`;
  const action = actionForToolUse({ name, input });
  if (namespace && !mcp && !action.cv && !action.pill) action.cv = namespace;
  if (!action.chip && typeof input.title === 'string' && input.title.trim()) {
    action.chip = clip(input.title.trim(), 64);
    action.chipTitle = clip(input.title.trim(), 400);
  }
  return action;
}

function primaryInputValue(input) {
  if (!input || typeof input !== 'object') return null;
  for (const key of ['file_path', 'path', 'command', 'query', 'pattern', 'url', 'description', 'prompt']) {
    if (typeof input[key] === 'string' && input[key]) return clip(input[key], 64);
  }
  return null;
}

// A compact diff preview for Edit blocks: a few removed lines then a few added
// lines, enough to see the shape of the change without opening anything.
function buildDiffPreview(oldString, newString) {
  const removed = String(oldString ?? '').split('\n');
  const added = String(newString ?? '').split('\n');
  if (removed.length + added.length > MAX_DIFF_LINES * 4) return null;
  const lines = [];
  for (const line of removed.slice(0, MAX_DIFF_LINES / 2)) lines.push({ t: 'del', s: clip(line, 160) });
  if (removed.length > MAX_DIFF_LINES / 2) lines.push({ t: 'ctx', s: `… ${removed.length - MAX_DIFF_LINES / 2} more removed` });
  for (const line of added.slice(0, MAX_DIFF_LINES / 2)) lines.push({ t: 'add', s: clip(line, 160) });
  if (added.length > MAX_DIFF_LINES / 2) lines.push({ t: 'ctx', s: `… ${added.length - MAX_DIFF_LINES / 2} more added` });
  return lines.length ? lines : null;
}

// User-message text arrives with harness framing that must never render as
// conversation: the transcript stores plenty of user-ROLE events nobody typed
// (task notifications, system-notification frames, hook output, command
// stdout). Only genuinely human text may become a user bubble; anything
// harness-injected rendering as "you said this" is a lie (live-caught).
// Normalize a queued message's text so an enqueue and its paired queued_command
// (which carry the same text) match despite whitespace differences.
function normalizeQueuedKey(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

// A message another Claude session sent (cross-session messaging) is written
// as a queued user message, wrapped in <cross-session-message ...>. It renders
// as a bubble like any other, but Pat did not type it, so it carries `peer` and
// gets none of the trim protection his own turns get (see push()).
function isPeerMessage(raw) {
  return /^<cross-session-message[\s>]/.test(String(raw ?? '').trim());
}

function userTextFor(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (text.startsWith('<local-command-caveat>')) return null;
  if (text.startsWith('<local-command-stdout>')) return null;
  // Background-task events and their system-notification framing are
  // harness plumbing, never typed input.
  if (text.startsWith('[SYSTEM NOTIFICATION')) return null;
  const cmd = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/);
    const label = `${cmd[1].trim()}${args && args[1].trim() ? ` ${args[1].trim()}` : ''}`.trim();
    return label ? { text: label, command: true } : null;
  }
  if (text.startsWith('[Request interrupted')) return { text: 'Interrupted', command: true };
  // Strip every harness-injected wrapper; if nothing human remains, it was
  // never a message.
  //
  // <pasted_content> is the one wrapper whose INSIDE is human (2026-09-20, Pat, with a
  // screenshot of his own bubble: "wtf is that 'pasted content id'?"). Claude Code 2.1.27x
  // records a large paste as <pasted_content id="9d3b"> ... </pasted_content id="9d3b">,
  // the closing tag carrying the id too, and Harbor sends every message as a bracketed
  // paste, so his own words came back wearing the CLI's markup. Keep the words, drop the
  // tags. Only a real PAIR is unwrapped, so prose that merely names the tag is untouched.
  const stripped = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?<\/pasted_content(?: id="\1")?>\n?/g, '$2')
    .trim();
  if (!stripped) return null;
  return { text: clipProse(stripped), command: false };
}

// The auto-compact continuation is a user-ROLE event carrying the context
// summary; rendering it as a typed bubble reads as "I sent that". It marks a
// settled discontinuity instead.
function isCompactContinuation(obj, text) {
  if (obj.isCompactSummary) return true;
  return /^This session is being continued from a previous conversation/.test(String(text ?? '').trim());
}

// Base64 image parts ride on conversation blocks by reference; never re-encode.
function imageFromPart(part) {
  if (!part || part.type !== 'image') return null;
  const src = part.source;
  if (!src || src.type !== 'base64' || !src.media_type || !src.data) return null;
  return { mediaType: src.media_type, dataUri: `data:${src.media_type};base64,${src.data}` };
}

function imagesFromContent(content) {
  if (!Array.isArray(content)) return [];
  const images = [];
  for (const part of content) {
    const img = imageFromPart(part);
    if (img) images.push(img);
  }
  return images;
}

function attachImages(block, images) {
  if (!images.length) return block;
  block.images = (block.images || []).concat(images);
  return block;
}

// Verbs are past tense in action rows ("Edited x") but present in the working
// shimmer ("Editing x…").
const PRESENT_TENSE = {
  Ran: 'Running',
  Edited: 'Editing',
  Wrote: 'Writing',
  Read: 'Reading',
  Searched: 'Searching',
  Globbed: 'Globbing',
  Delegated: 'Delegating',
  Fetched: 'Fetching',
  'Searched web': 'Searching the web',
  'Updated todos': 'Updating todos',
  Asked: 'Asking',
  Skill: 'Running skill',
  Deleted: 'Deleting',
};

class TranscriptParser {
  constructor(provider = 'claude', seedModel = null, options = {}) {
    this.provider = provider;
    // Codex only: read local_image parts into data URIs (the live window), or
    // keep them as named attachments (every other parser). See readLocalImage.
    this.loadLocalImages = Boolean(options.loadLocalImages);
    // Codex turn bookkeeping (see applyCodexLine). codexExits / codexItemFailed
    // hold what an item said about a tool call before that call's output line
    // resolved it; codexTotalOutput is the session's cumulative output tokens
    // as of the last token_count, the baseline a new task's spend is measured
    // from.
    this.codexExits = new Map(); // call_id -> its last command's exit (0, the code, or -1)
    this.codexItemFailed = new Map(); // call_id -> true when its item failed
    this.codexExecCalls = new Set(); // open custom_tool_call (exec) call_ids
    // TUI request_user_input calls still waiting for their output: call_id ->
    // the question block drawn for it (see codexQuestionCall).
    this.codexQuestionCalls = new Map();
    this.codexTurnOpen = false; // a task's prompt is in, its end is not
    // A UserMessage while a task runs and no task_started has come since its
    // prompt is the user steering THAT task, not a new one. Only trusted once
    // a task_started has been seen in this parse: a tail that starts
    // mid-session, and the oldest rollouts, keep one turn per message.
    this.codexSawTaskStarted = false;
    this.codexPromptExpected = false; // a task_started is waiting for its prompt
    this.codexTotalOutput = null;
    this.codexCompactKind = null; // which of the two compaction records drew the note
    this.blocks = [];
    this.pendingTools = new Map(); // tool_use id -> action block
    // The task in flight: the user prompt that opened it and the output tokens
    // each API message spent on it. See noteTurnUsage.
    this.turn = null;
    // The live AskUserQuestion used to be tracked here as well, for the
    // in-window question card. It is not any more: a value produced as a side
    // effect of this tail is only as current as the last read that landed, and
    // that is exactly how it failed Pat on 2026-07-27 (his window was thirteen
    // minutes behind the question the card was showing). The card reads the
    // transcript FILE on demand instead; see providers/pending-ask.js. There is
    // deliberately no second copy of that state here to drift from it.
    this.queuedByText = new Map(); // normalized text -> queued user block (to attach its images)
    this.header = {
      model: seedModel && seedModel !== 'default' ? modelDisplay(seedModel) : null,
      effort: null,
      contextTokens: null,
      contextPct: null,
      lastEventTs: null,
      lastSignal: null, // 'user-turn' | 'tool-pending' | 'idle'
      // Prompt-cache facts for the cache chip, straight from the assistant
      // records' own usage (the cache_creation TTL breakdown the API writes).
      // Facts only; the warm/expired verdict is derived at render time in
      // renderer/stage/cache-freshness.cjs, because warmth expires with no
      // transcript event.
      cacheTtlMs: null,
      cacheTouchedMs: null,
      // Codex-only facts; only this parser writes them. approvalPolicy and
      // sandboxPolicy are turn_context's raw values (a sandbox object is
      // reduced to its type). turnEnd is how the last FINISHED task ended
      // ('complete' | 'aborted' | 'error'), null while one runs; turnError is
      // { message, ts } when that end was an error. pendingQuestion is a
      // request_user_input question set still waiting for the user:
      // { id, ts, questions: [{ title, options }] }.
      approvalPolicy: null,
      sandboxPolicy: null,
      turnEnd: null,
      turnError: null,
      pendingQuestion: null,
    };
    this.seq = 0;
    // Once set, remains true: any evidence of a 1M context window (high-water
    // The window size learned from Claude's own statusline math (pct =
    // tokens/window). Until it is known, usage lines carry tokens only and
    // contextPct stays null; a percentage is never computed from a guess.
    this.learnedWindow = null;
  }

  // Set the learned window (from the tee's math or its persisted file) and
  // reprice the gauge so the correction shows on the same update.
  setLearnedWindow(windowTokens) {
    if (!Number.isFinite(windowTokens) || windowTokens <= 0) return;
    this.learnedWindow = windowTokens;
    const tokens = this.header.contextTokens;
    if (tokens) {
      this.header.contextPct = Math.max(1, Math.min(99, Math.round((tokens / windowTokens) * 100)));
    }
  }

  push(block) {
    block.key = `b${this.seq++}`;
    this.blocks.push(block);
    while (this.blocks.length > MAX_BLOCKS) {
      // Trim priority, keep longest: images, then the user's OWN turns, then
      // everything else. This stops the cap from dropping Pat's text messages to
      // keep screenshots (live-caught: follow-up messages vanishing) while still
      // preserving early inline images in a long transcript. Drop the oldest
      // block in the lowest-priority tier that still exists.
      //
      // A PEER MESSAGE IS NOT PAT'S OWN TURN (2026-10-22, Pat: "i only see
      // cross section messages to it and dont see any agent turns"). A lead
      // session that other sessions message all night received 227 of them;
      // protected as user turns they filled all 240 slots and every agent row
      // was evicted the moment it arrived, while the `>_` terminal showed the
      // work. Peer blocks share the bottom tier with agent rows, so the window
      // stays a time-ordered slice of both.
      let dropIndex = this.blocks.findIndex((item) => (item.kind !== 'user' || item.peer) && !item.images?.length);
      if (dropIndex < 0) dropIndex = this.blocks.findIndex((item) => item.kind === 'user' && !item.images?.length);
      if (dropIndex < 0) dropIndex = 0; // only image-bearing blocks remain
      const [dropped] = this.blocks.splice(dropIndex, 1);
      if (dropped?.toolId) this.pendingTools.delete(dropped.toolId);
    }
    // Image-payload cap on the LIVE path (2026-09-06). A block's base64 image
    // data URI is the only large thing a block carries; every screenshot a long
    // browser/orchestration session takes rode in the transcript AND out to the
    // renderer with nothing bounding it, because the total-block trim above
    // deliberately KEEPS images (it only drops them once all 240 blocks are
    // images). The renderer then held every screenshot of every open window and
    // died of an out-of-memory crash (render-process-gone reason "oom",
    // 0xE0000008), caught by the crash-capture instrumentation ~4h into busy
    // sessions on 2026-09-06 after the older -36861 crashes could not be
    // decoded. MAX_IMAGE_BLOCKS already caps the initial prefix scan
    // (readPrefixImageBlocks); enforce the SAME bound live so retained base64 is
    // finite. Drop the oldest image-bearing block once over the cap: the 32 most
    // recent images stay on screen, and the full image is always in the JSONL
    // (and the terminal view). Dropping a key makes the next read emit a
    // wholesale `replace`, so the renderer frees it too.
    let imageBlocks = 0;
    for (const item of this.blocks) if (item.images?.length) imageBlocks += 1;
    while (imageBlocks > MAX_IMAGE_BLOCKS) {
      const dropIndex = this.blocks.findIndex((item) => item.images?.length);
      if (dropIndex < 0) break;
      const [dropped] = this.blocks.splice(dropIndex, 1);
      if (dropped?.toolId) this.pendingTools.delete(dropped.toolId);
      imageBlocks -= 1;
    }
    return block;
  }

  // PER-TASK TOKENS, like the Claude app's live usage readout. A task runs
  // from a user prompt to the next one. Each assistant line carries its API message's usage, and one
  // message is written as SEVERAL lines (one per content block) repeating the
  // same message id, so output tokens are kept per id (max, never summed twice)
  // and the turn total is the sum across ids. The total and the elapsed time
  // ride on the prompt block as `turnMeta`, re-rendered in place as they grow.
  // Sidechain (subagent) lines are skipped upstream, so this is the main
  // conversation's own spend.
  startTurn(block, ts) {
    const startMs = Date.parse(ts);
    this.turn = { block, startMs: Number.isFinite(startMs) ? startMs : null, outputs: new Map() };
  }

  noteTurnUsage(message, ts, changed) {
    const turn = this.turn;
    const out = message?.usage?.output_tokens;
    if (!turn || !Number.isFinite(out)) return;
    const id = message.id || `line-${this.seq}`;
    turn.outputs.set(id, Math.max(turn.outputs.get(id) || 0, out));
    let outputTokens = 0;
    for (const value of turn.outputs.values()) outputTokens += value;
    const endMs = Date.parse(ts);
    const durationMs = turn.startMs !== null && Number.isFinite(endMs) ? Math.max(0, endMs - turn.startMs) : null;
    // A usage record that moves neither number changes nothing on screen, so
    // it re-renders nothing and sends nothing.
    const prior = turn.block.turnMeta;
    if (prior && prior.outputTokens === outputTokens && prior.durationMs === durationMs) return;
    turn.block.turnMeta = { outputTokens, durationMs };
    if (this.blocks.includes(turn.block)) changed.push(turn.block.key);
  }

  // Returns the keys of blocks that CHANGED in place (tool results resolving
  // an earlier action row) so the renderer can re-render them.
  applyLine(obj) {
    const changed = [];
    if (!obj || typeof obj !== 'object') return changed;
    if (this.provider === 'codex') return this.applyCodexLine(obj);
    if (this.provider === 'cursor') return this.applyCursorLine(obj);
    if (obj.isSidechain) return changed;
    if (turnSignal(obj) === 'idle') this.header.lastSignal = 'idle';
    const ts = obj.timestamp || null;
    if (ts) this.header.lastEventTs = ts;

    if (obj.type === 'system') {
      // turn_duration marks the turn settled; anything still pending is stale.
      if (obj.subtype === 'turn_duration') this.header.lastSignal = 'idle';
      // CLI warnings must SHOW. "Unknown command: /x" was the only reply a
      // mistyped skill ever got, and Harbor hid it, so the send looked
      // silently dropped (live-caught 2026-07-24: /dml-gold-sweep typed
      // twice into a window that stayed blank both times).
      if ((obj.level === 'warning' || obj.level === 'error') && typeof obj.content === 'string' && obj.content.trim()) {
        this.push({ kind: 'note', tone: 'warn', text: clip(obj.content, 400), ts });
        this.header.lastSignal = 'idle';
      }
      return changed;
    }

    if (obj.type === 'user') {
      const content = obj.message?.content;
      if (typeof content === 'string') {
        if (obj.isMeta) return changed;
        if (isCompactContinuation(obj, content)) {
          this.push({ kind: 'note', text: 'Session compacted: earlier context was summarized.', ts });
          this.header.lastSignal = 'idle';
          return changed;
        }
        // A completed local command's stdout means the command finished; the
        // shimmer must settle instead of reading "Thinking…" off it. A /model
        // switch confirms here (no assistant message carries the new model), so
        // move the chip off this line: every switch path lands on it.
        if (content.trim().startsWith('<local-command-stdout>')) {
          const switched = modelFromSetModelStdout(content);
          if (switched) this.header.model = switched;
          const effort = effortFromSetEffortStdout(content);
          if (effort) this.header.effort = effort;
          this.header.lastSignal = 'idle';
          return changed;
        }
        const user = userTextFor(content);
        if (user) {
          this.startTurn(this.push({ kind: 'user', text: user.text, command: user.command, ts, ...(isPeerMessage(content) ? { peer: true } : {}) }), ts);
          this.header.lastSignal = turnSignal(obj) === 'idle' ? 'idle' : 'user-turn';
        }
        return changed;
      }
      if (Array.isArray(content)) {
        let lastUserInLine = null;
        for (const part of content) {
          if (!part || typeof part !== 'object') continue;
          if (part.type === 'text' && !obj.isMeta) {
            if (isCompactContinuation(obj, part.text)) {
              this.push({ kind: 'note', text: 'Session compacted: earlier context was summarized.', ts });
              this.header.lastSignal = 'idle';
              lastUserInLine = null;
              continue;
            }
            const user = userTextFor(part.text);
            if (user) {
              lastUserInLine = this.push({ kind: 'user', text: user.text, command: user.command, ts, ...(isPeerMessage(part.text) ? { peer: true } : {}) });
              this.startTurn(lastUserInLine, ts);
              this.header.lastSignal = turnSignal(obj) === 'idle' ? 'idle' : 'user-turn';
            }
          } else if (part.type === 'image') {
            const img = imageFromPart(part);
            if (img) {
              if (lastUserInLine) {
                attachImages(lastUserInLine, [img]);
              } else {
                lastUserInLine = this.push({ kind: 'user', text: '', images: [img], ts });
              }
              this.header.lastSignal = 'user-turn';
            }
          } else if (part.type === 'tool_result') {
            const action = this.pendingTools.get(part.tool_use_id);
            if (action) {
              action.status = part.is_error ? 'err' : 'ok';
              if (part.is_error && !action.pill) action.pill = { text: 'error', tone: 'err' };
              this.pendingTools.delete(part.tool_use_id);
              changed.push(action.key);
            }
            const resultImages = imagesFromContent(part.content);
            if (resultImages.length) {
              // Tool results use a user-role API envelope, but their content is
              // assistant/tool context, not an image the human sent.
              lastUserInLine = this.push({ kind: 'assistant', text: '', images: resultImages, ts });
            }
            if (this.header.lastSignal !== 'idle') this.header.lastSignal = 'user-turn';
          }
        }
        return changed;
      }
      return changed;
    }

    // A message the user sends WHILE Claude is busy is queued, not written as a
    // normal user message, so without this it stays invisible the whole time
    // Claude works (live-caught: Pat's messages "not showing in chat"). The TEXT
    // is on the queue-operation `enqueue` (always present, even for text-only
    // messages); any pasted IMAGES are on the paired queued_command attachment
    // (whose prompt is empty for text-only messages). Render the enqueue as a
    // user bubble and attach the queued_command's images to it by matching text.
    if (obj.type === 'queue-operation' && obj.operation === 'enqueue') {
      const user = userTextFor(obj.content);
      if (user) {
        const block = this.push({ kind: 'user', text: user.text, command: user.command, ts, queued: true, ...(isPeerMessage(obj.content) ? { peer: true } : {}) });
        this.queuedByText.set(normalizeQueuedKey(user.text), block);
        this.header.lastSignal = 'user-turn';
      }
      return changed;
    }
    if (obj.type === 'attachment' && obj.attachment?.type === 'queued_command') {
      if (obj.attachment.origin && obj.attachment.origin.kind !== 'human') return changed;
      const prompt = Array.isArray(obj.attachment.prompt) ? obj.attachment.prompt : [];
      const text = prompt.filter((p) => p?.type === 'text').map((p) => p.text || '').join('');
      const images = prompt.map(imageFromPart).filter(Boolean);
      if (!images.length) return changed;
      // Attach to the enqueue block with matching text; otherwise render the
      // queued_command on its own (an image with no separate enqueue text).
      const existing = this.queuedByText.get(normalizeQueuedKey(userTextFor(text)?.text || ''));
      if (existing) {
        attachImages(existing, images);
      } else {
        this.push({ kind: 'user', text: userTextFor(text)?.text || '', images, ts, queued: true });
      }
      this.header.lastSignal = 'user-turn';
      return changed;
    }

    if (obj.type === 'assistant') {
      const message = obj.message || {};
      // "<synthetic>" stamps system-generated messages ("No response
      // requested."), not a real model; never let it take the chip.
      if (message.model && !/^<.*>$/.test(message.model)) {
        this.header.model = modelDisplay(message.model);
        if (obj.effort) this.header.effort = String(obj.effort);
      }
      // Cache facts for the chip. The TTL comes from the record's own
      // cache_creation breakdown (real bytes verified 2026-08-21:
      // ephemeral_1h_input_tokens / ephemeral_5m_input_tokens); 1h outranks
      // 5m when both appear because the long-lived prefix is the bulk that
      // decides the next turn's warmth. Any cache activity (read or write)
      // refreshes the touch clock — the API refreshes a cache entry's TTL on
      // use. A record with activity but no breakdown (older CLI) keeps the
      // TTL already learned rather than guessing; a session that never
      // reports cache fields keeps null facts and gets no chip.
      const cacheActivity = ((message.usage?.cache_read_input_tokens || 0) > 0)
        || ((message.usage?.cache_creation_input_tokens || 0) > 0);
      if (cacheActivity) {
        const breakdown = message.usage?.cache_creation;
        if ((breakdown?.ephemeral_1h_input_tokens || 0) > 0) this.header.cacheTtlMs = 60 * 60_000;
        else if ((breakdown?.ephemeral_5m_input_tokens || 0) > 0) this.header.cacheTtlMs = 5 * 60_000;
        const touched = ts ? Date.parse(ts) : NaN;
        this.header.cacheTouchedMs = Number.isFinite(touched) ? touched : Date.now();
      }
      this.noteTurnUsage(message, ts, changed);
      const tokens = usageTokens(message.usage);
      if (tokens) {
        this.header.contextTokens = tokens;
        // A percent only against the LEARNED window; tokens alone otherwise.
        this.header.contextPct = this.learnedWindow
          ? Math.max(1, Math.min(99, Math.round((tokens / this.learnedWindow) * 100)))
          : null;
      }
      let lastAssistantInLine = null;
      for (const part of message.content || []) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text') {
          const text = clipProse(String(part.text || '').trim());
          if (text) lastAssistantInLine = this.push({ kind: 'assistant', text, ts });
        } else if (part.type === 'image') {
          const img = imageFromPart(part);
          if (img) {
            if (lastAssistantInLine) {
              attachImages(lastAssistantInLine, [img]);
            } else {
              lastAssistantInLine = this.push({ kind: 'assistant', text: '', images: [img], ts });
            }
          }
        } else if (part.type === 'tool_use') {
          const action = this.push({
            kind: 'action',
            toolId: part.id || null,
            status: 'run',
            ts,
            ...actionForToolUse(part),
          });
          if (part.id) this.pendingTools.set(part.id, action);
        } else if (part.type === 'thinking') {
          // Claude's own reasoning arrives here with EMPTY text and never
          // renders; the working shimmer covers "busy". But since Opus 5.5 /
          // Sonnet 5.5 the short notes the model writes between tool calls
          // ("Setting up two worktrees off HEAD...") come back as thinking
          // blocks WITH text, and hiding them left windows silent for whole
          // turns (Pat, 2026-09-28). Only non-empty text is shown, as a
          // progress line, and it never becomes the "last assistant" block.
          const text = clipProse(String(part.thinking || '').trim());
          if (text) this.push({ kind: 'progress', text, ts });
        }
      }
      const terminalStop = turnSignal(obj) === 'idle';
      if (terminalStop) this.header.lastSignal = 'idle';
      else if (this.pendingTools.size) this.header.lastSignal = 'tool-pending';
      else this.header.lastSignal = terminalStop ? 'idle' : 'user-turn';
      return changed;
    }

    return changed;
  }

  // CODEX TURNS. A codex task runs from `task_started` to `task_complete` (or
  // `turn_aborted`); between them the model may speak several times. Only an
  // AgentMessage whose phase is `final_answer` (or that carries no phase at
  // all: rollouts from before phases existed) ends the turn's speech, and
  // task_complete / turn_aborted end the turn itself. A `commentary` message is
  // the model narrating mid-task, so it keeps the turn in flight: about one
  // turn in seven on a real store spoke more than once, and treating the first
  // message as the end painted those windows "ready" (and told every
  // readTranscriptLastSignal caller the session had finished) while codex was
  // still working.
  applyCodexLine(obj) {
    const changed = [];
    const payload = obj.payload || {};
    const ts = obj.timestamp || null;
    if (ts) this.header.lastEventTs = ts;
    if (obj.type === 'turn_context') {
      if (payload.model) this.header.model = modelDisplay(payload.model);
      if (payload.effort) this.header.effort = String(payload.effort);
      if (payload.approval_policy != null) this.header.approvalPolicy = codexPolicyValue(payload.approval_policy);
      if (payload.sandbox_policy != null) this.header.sandboxPolicy = codexPolicyValue(payload.sandbox_policy);
    } else if (obj.type === 'compacted') {
      this.noteCodexCompaction('compacted', ts);
    } else if (obj.type === 'event_msg') {
      this.applyCodexEvent(payload, ts, changed);
    } else if (obj.type === 'response_item') {
      this.applyCodexResponseItem(payload, ts, changed);
    }
    return changed;
  }

  applyCodexEvent(payload, ts, changed) {
    switch (payload.type) {
      case 'task_started':
        this.header.turnEnd = null;
        this.header.turnError = null;
        this.codexSawTaskStarted = true;
        this.codexPromptExpected = true;
        // A TUI question lives inside one turn; one still open when the next
        // turn starts was never answered (the process died under it).
        this.dropCodexQuestionCalls(changed);
        this.noteCodexWindow(payload.model_context_window);
        this.header.lastSignal = 'user-turn';
        break;
      // The pre-0.147 conversation events, kept for the historical corpus.
      case 'user_message':
        if (payload.message || payload.local_images?.length) {
          const paths = Array.isArray(payload.local_images) ? payload.local_images.filter((p) => typeof p === 'string' && p) : [];
          this.codexUser(payload.message ? clipProse(payload.message) : '', paths, ts, changed);
        }
        break;
      case 'agent_message':
        if (payload.message) this.codexAgent(String(payload.message), payload.phase, null, null, ts);
        break;
      case 'item_completed':
        this.applyCodexItem(payload.item || {}, ts, changed);
        break;
      case 'token_count':
        this.noteCodexTokens(payload.info, ts, changed);
        break;
      case 'task_complete':
      case 'task_completed':
        this.endCodexTurn(payload.error ? 'error' : 'complete', payload, ts, changed);
        break;
      case 'turn_aborted':
        this.endCodexTurn('aborted', payload, ts, changed);
        break;
      default:
        break;
    }
  }

  // Codex 0.147.0 stopped writing user_message/agent_message and moved the
  // conversation into this item stream, the same items its own UI renders
  // (found 2026-08-08: Pat's real 4.5MB review parsed to 16 tool actions and
  // zero text). The response_item message lines are NOT the conversation, they
  // carry the injected scaffolding (skills instructions, AGENTS.md,
  // environment_context) that would bury the real prompt. Part type casing
  // differs by role in the real bytes ('text' vs 'Text'), so any part carrying
  // a text string counts. CommandExecution and McpToolCall items never draw a
  // row of their own (the call lines already did); they only say how it went.
  applyCodexItem(item, ts, changed) {
    const parts = Array.isArray(item.content) ? item.content : [];
    const text = parts
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    switch (item.type) {
      case 'UserMessage': {
        const paths = parts
          .filter((part) => part?.type === 'local_image' && typeof part.path === 'string' && part.path)
          .map((part) => part.path);
        this.codexUser(text ? clipProse(text) : '', paths, ts, changed);
        break;
      }
      case 'AgentMessage':
        this.codexAgent(text, item.phase, item.questions, item.id || null, ts);
        break;
      case 'CommandExecution':
        this.noteCodexCommand(item);
        break;
      case 'McpToolCall':
        this.noteCodexItemFailed(item.id, item.status === 'failed' || item.result?.isError === true, changed);
        break;
      case 'ContextCompaction':
        this.noteCodexCompaction('item', ts);
        break;
      default:
        break;
    }
  }

  codexUser(text, imagePaths, ts, changed) {
    const images = [];
    const attachments = [];
    for (const imagePath of imagePaths) {
      const image = this.loadLocalImages ? readLocalImage(imagePath) : null;
      if (image) images.push(image);
      else attachments.push({ path: imagePath, name: fileBase(imagePath) });
    }
    if (!text && !images.length && !attachments.length) return;
    const block = { kind: 'user', text, ts };
    if (images.length) block.images = images;
    if (attachments.length) block.attachments = attachments;
    // A steer (a message typed while the task runs; real TUI rollouts write
    // it as a UserMessage with no task_started before it) joins the open
    // task. Starting a turn on it froze the real prompt's time and tokens
    // part-way and charged the rest of the task to the steer. Marked, so the
    // window's work meter keeps timing the prompt that started the task.
    const steer = this.codexTurnOpen && this.turn && this.codexSawTaskStarted && !this.codexPromptExpected;
    if (steer) block.steer = true;
    this.push(block);
    if (!steer) {
      this.startTurn(block, ts);
      // The baseline this task's spend is measured from: the session's
      // cumulative output as of the last token_count before it began.
      this.turn.codexOutputBase = this.codexTotalOutput;
    }
    this.codexPromptExpected = false;
    this.codexTurnOpen = true;
    this.header.lastSignal = 'user-turn';
    // A message after a request_user_input question is its answer.
    const pending = this.header.pendingQuestion;
    if (pending) {
      const asked = this.blocks.find((b) => b.kind === 'question' && b.questionId === pending.id);
      if (asked) { asked.answered = true; changed.push(asked.key); }
      this.header.pendingQuestion = null;
    }
  }

  codexAgent(text, phase, questions, id, ts) {
    const asked = normalizeCodexQuestions(questions);
    const already = asked && this.header.pendingQuestion && sameCodexQuestions(this.header.pendingQuestion.questions, asked)
      ? this.blocks.find((b) => b.kind === 'question' && b.questionId === this.header.pendingQuestion.id)
      : null;
    if (already) {
      // The same question set the request_user_input call already drew: one
      // block, not two.
      if (text && !already.text) already.text = clipProse(text);
    } else if (asked) {
      // request_user_input: the model is asking, with options, and waits.
      // Rendered as a question block (read-only here), and exposed on the
      // header for anything that has to know a session is waiting on the user.
      const block = this.push({ kind: 'question', text: text ? clipProse(text) : '', questions: asked, questionId: id, answered: false, ts });
      if (!block.questionId) block.questionId = block.key;
      this.header.pendingQuestion = { id: block.questionId, ts, questions: asked };
    } else if (text) {
      this.push({ kind: 'assistant', text: clipProse(text), ts });
    } else {
      return;
    }
    const final = !phase || phase === 'final_answer';
    if (final) this.header.lastSignal = 'idle';
    else this.header.lastSignal = this.pendingTools.size ? 'tool-pending' : 'user-turn';
  }

  // The context gauge and the per-task meter, from codex's own numbers.
  // token_count carries the last request's usage (its total is what now sits
  // in the context), the session's cumulative usage, and the model's context
  // window as codex itself states it, so a percentage here is codex's own
  // denominator, never a Harbor guess.
  noteCodexWindow(windowTokens) {
    if (Number.isFinite(windowTokens) && windowTokens > 0 && windowTokens !== this.learnedWindow) this.setLearnedWindow(windowTokens);
  }

  noteCodexTokens(info, ts, changed) {
    if (!info || typeof info !== 'object') return;
    const last = info.last_token_usage || null;
    const total = info.total_token_usage || null;
    this.noteCodexWindow(info.model_context_window);
    const inContext = Number.isFinite(last?.total_tokens) && last.total_tokens > 0
      ? last.total_tokens
      : (Number(last?.input_tokens) || 0) + (Number(last?.output_tokens) || 0);
    if (inContext > 0) {
      this.header.contextTokens = inContext;
      this.header.contextPct = this.learnedWindow
        ? Math.max(1, Math.min(99, Math.round((inContext / this.learnedWindow) * 100)))
        : null;
    }
    const totalOut = Number.isFinite(total?.output_tokens) ? total.output_tokens : null;
    if (totalOut === null) return;
    // The same `turnMeta` the Claude side writes (noteTurnUsage), on the
    // prompt block of the one task in flight (`this.turn`).
    const turn = this.turn;
    if (turn && this.codexTurnOpen) {
      const lastOut = Number.isFinite(last?.output_tokens) ? last.output_tokens : 0;
      // No baseline (the tail began mid-session) or a counter that went
      // backwards: this report's own request is the task's first spend.
      if (turn.codexOutputBase == null || totalOut < turn.codexOutputBase) turn.codexOutputBase = Math.max(0, totalOut - lastOut);
      const endMs = Date.parse(ts);
      turn.block.turnMeta = {
        ...turn.block.turnMeta,
        outputTokens: totalOut - turn.codexOutputBase,
        durationMs: turn.startMs !== null && Number.isFinite(endMs) ? Math.max(0, endMs - turn.startMs) : (turn.block.turnMeta?.durationMs ?? null),
      };
      if (this.blocks.includes(turn.block)) changed.push(turn.block.key);
    }
    this.codexTotalOutput = totalOut;
  }

  endCodexTurn(kind, payload, ts, changed) {
    if (kind === 'aborted') {
      // An interrupt ends every call still running, the way Claude's
      // interrupted tool results resolve as errors, and leaves the same
      // "Interrupted" marker in the conversation.
      for (const action of this.pendingTools.values()) {
        action.status = 'err';
        if (!action.pill) action.pill = { text: 'interrupted', tone: 'err' };
        if (this.blocks.includes(action)) changed.push(action.key);
      }
      this.pendingTools.clear();
      this.codexExits.clear();
      this.codexItemFailed.clear();
      this.codexExecCalls.clear();
      this.push({ kind: 'user', text: 'Interrupted', command: true, ts });
    }
    if (kind === 'error') {
      // A failed task (codex gave up on the API, the stream broke) must SHOW,
      // exactly like a CLI warning on the Claude side: otherwise the window
      // just stops with no reply and reads as finished.
      const message = clip(String(payload.error?.message || 'The task failed.').trim(), 400);
      this.push({ kind: 'note', tone: 'warn', text: message, ts });
      this.header.turnError = { message, ts };
    } else {
      this.header.turnError = null;
    }
    this.header.turnEnd = kind;
    this.header.lastSignal = 'idle';
    this.codexPromptExpected = false;
    this.dropCodexQuestionCalls(changed);
    const turn = this.turn;
    if (turn && this.codexTurnOpen && Number.isFinite(payload.duration_ms)) {
      // Codex's own task clock outranks the last token report's timestamp.
      turn.block.turnMeta = { outputTokens: 0, ...turn.block.turnMeta, durationMs: payload.duration_ms };
      if (this.blocks.includes(turn.block)) changed.push(turn.block.key);
    }
    this.codexTurnOpen = false;
  }

  // A tool call's status comes from what it actually did. A CommandExecution
  // item names its exit code but not its call (its id matches nothing), and
  // arrives while the exec call that ran it is still open, so it belongs to
  // the newest open exec call. One call can run several commands, and the
  // LAST one decides: a code-mode snippet that runs `grep` (exit 1 on no
  // match) and handles it before moving on succeeded, and marking it by the
  // first non-zero exit painted the row a false "exit 1". An execution that
  // lands after its call already resolved (a long command polled through
  // write_stdin) is left unattributed rather than pinned on the wrong row.
  noteCodexCommand(item) {
    const failed = (Number.isInteger(item.exit_code) && item.exit_code !== 0) || item.status === 'failed';
    let callId = null;
    for (const [id] of [...this.pendingTools.entries()].reverse()) {
      if (this.codexExecCalls.has(id)) { callId = id; break; }
    }
    if (!callId) return;
    this.codexExits.set(callId, failed ? (Number.isInteger(item.exit_code) && item.exit_code > 0 ? item.exit_code : -1) : 0);
  }

  // An McpToolCall item's id IS its function_call's call_id.
  noteCodexItemFailed(callId, failed, changed) {
    if (!callId) return;
    if (this.pendingTools.has(callId)) { this.codexItemFailed.set(callId, failed); return; }
    if (!failed) return;
    for (let i = this.blocks.length - 1; i >= 0; i -= 1) {
      const block = this.blocks[i];
      if (block.kind !== 'action' || block.toolId !== callId) continue;
      block.status = 'err';
      if (!block.pill) block.pill = { text: 'error', tone: 'err' };
      changed.push(block.key);
      return;
    }
  }

  // CODEX TUI QUESTIONS. The desktop app carries a question as an
  // AgentMessage with `questions`; the 0.160 TUI writes it as a
  // `function_call request_user_input` (arguments {questions: [{id, header,
  // question, options: [{label, description}]}]}) and its answer as that
  // call's function_call_output ({"answers": {...}}). Drawn as an action row
  // it read "Running request user input…" while the session was waiting on
  // the user. It is a question block, open until its output lands. Returns
  // false when the arguments carry no question, so the call falls back to an
  // ordinary row.
  codexQuestionCall(payload, ts) {
    let args = payload.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
    const asked = normalizeCodexQuestions(args?.questions);
    if (!asked) return false;
    const callId = payload.call_id || payload.id || null;
    const pending = this.header.pendingQuestion;
    let block = pending && sameCodexQuestions(pending.questions, asked)
      ? this.blocks.find((b) => b.kind === 'question' && b.questionId === pending.id && !b.answered)
      : null;
    if (!block) {
      block = this.push({ kind: 'question', text: '', questions: asked, questionId: callId, answered: false, ts });
      if (!block.questionId) block.questionId = block.key;
      this.header.pendingQuestion = { id: block.questionId, ts, questions: asked };
    }
    if (callId) this.codexQuestionCalls.set(callId, block);
    return true;
  }

  // TUI questions whose turn ended without an answer stop being "pending":
  // the header no longer says the session waits on it, and the card is
  // re-rendered marked `closed` (not `answered`: nobody answered it), so it
  // stops saying "Waiting for your answer" forever.
  // A DESKTOP question (an AgentMessage carrying `questions`, asked through
  // request_user_input_async) is not here: its call returns {"accepted":true}
  // at once and the answer arrives as a later UserMessage, in real rollouts
  // both inside the same task and in the NEXT task after task_complete, so it
  // legitimately waits past the end of its turn.
  dropCodexQuestionCalls(changed) {
    if (!this.codexQuestionCalls.size) return;
    const pending = this.header.pendingQuestion;
    for (const block of this.codexQuestionCalls.values()) {
      if (pending && block.questionId === pending.id) this.header.pendingQuestion = null;
      if (!block.answered && !block.closed) {
        block.closed = true;
        if (this.blocks.includes(block)) changed.push(block.key);
      }
    }
    this.codexQuestionCalls.clear();
  }

  applyCodexResponseItem(payload, ts, changed) {
    if (payload.type === 'function_call' && payload.name === 'request_user_input' && this.codexQuestionCall(payload, ts)) {
      return;
    }
    if (['function_call_output', 'custom_tool_call_output'].includes(payload.type) && this.codexQuestionCalls.has(payload.call_id)) {
      const block = this.codexQuestionCalls.get(payload.call_id);
      this.codexQuestionCalls.delete(payload.call_id);
      block.answered = true;
      changed.push(block.key);
      if (this.header.pendingQuestion?.id === block.questionId) this.header.pendingQuestion = null;
      // Answered: the model owes the next step.
      if (this.header.lastSignal !== 'idle') this.header.lastSignal = this.pendingTools.size ? 'tool-pending' : 'user-turn';
      return;
    }
    if (['function_call', 'custom_tool_call'].includes(payload.type)) {
      const action = this.push({ kind: 'action', toolId: payload.call_id || payload.id || null, status: 'run', ts, ...codexActionFor(payload) });
      if (action.toolId) {
        this.pendingTools.set(action.toolId, action);
        if (payload.type === 'custom_tool_call') this.codexExecCalls.add(action.toolId);
      }
      this.header.lastSignal = 'tool-pending';
    } else if (['function_call_output', 'custom_tool_call_output'].includes(payload.type)) {
      const id = payload.call_id;
      const action = this.pendingTools.get(id);
      if (action) {
        let failure = null;
        if (this.codexExits.has(id)) {
          const code = this.codexExits.get(id);
          if (code !== 0) failure = code > 0 ? `exit ${code}` : 'error';
        } else if (this.codexItemFailed.has(id)) {
          if (this.codexItemFailed.get(id)) failure = 'error';
        } else {
          // Fallback for calls no item describes (older rollouts, or a tool
          // with no item): an exit code written in the output text. The output
          // is an ARRAY of parts since 0.160 and a plain string before it.
          const match = CODEX_EXIT_TEXT_RE.exec(codexOutputText(payload.output));
          if (match) failure = `exit ${match[1] || match[2]}`;
        }
        action.status = failure ? 'err' : 'ok';
        if (failure && !action.pill) action.pill = { text: failure, tone: 'err' };
        this.pendingTools.delete(id);
        changed.push(action.key);
      }
      // Forgotten even when the row is gone: push() evicts old blocks, and a
      // call whose row was evicted while it ran still answers here.
      this.codexExits.delete(id);
      this.codexItemFailed.delete(id);
      this.codexExecCalls.delete(id);
      // Every call answered: the model owes the next step, not a tool.
      if (this.header.lastSignal === 'tool-pending' && !this.pendingTools.size) this.header.lastSignal = 'user-turn';
    }
  }

  // Codex writes one compaction twice: a `compacted` record and a
  // ContextCompaction item. Whichever lands first draws the note and the other
  // one of the pair is absorbed; rollouts that only ever write one kind still
  // get a note per compaction.
  noteCodexCompaction(kind, ts) {
    if (this.codexCompactKind && this.codexCompactKind !== kind) {
      this.codexCompactKind = null;
      return;
    }
    this.codexCompactKind = kind;
    this.push({ kind: 'note', text: 'Session compacted: earlier context was summarized.', ts });
  }

  applyCursorLine(obj) {
    const changed = [];
    if (obj.type === 'turn_ended') { this.header.lastSignal = 'idle'; return changed; }
    const content = obj.message?.content;
    if (!Array.isArray(content)) return changed;
    if (obj.role === 'user') {
      for (const part of content) {
        if (part?.type !== 'text' || !part.text) continue;
        const framed = String(part.text).match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
        const text = framed?.[1]?.trim() || (String(part.text).startsWith('<') ? null : part.text);
        if (text) this.push({ kind: 'user', text: clipProse(text), ts: obj.timestamp || null });
      }
      this.header.lastSignal = 'user-turn';
      return changed;
    }
    if (obj.role !== 'assistant') return changed;
    for (const part of content) {
      if (part?.type === 'text' && part.text) this.push({ kind: 'assistant', text: clipProse(part.text), ts: obj.timestamp || null });
      else if (part?.type === 'tool_use') {
        const action = this.push({ kind: 'action', toolId: part.id || null, status: 'run', ...actionForToolUse(part) });
        if (part.id) this.pendingTools.set(part.id, action);
      } else if (part?.type === 'tool_result') {
        const action = this.pendingTools.get(part.tool_use_id);
        if (action) { action.status = part.is_error ? 'err' : 'ok'; this.pendingTools.delete(part.tool_use_id); changed.push(action.key); }
      }
    }
    this.header.lastSignal = this.pendingTools.size ? 'tool-pending' : 'idle';
    return changed;
  }

  // Working state, computed at read time: a turn is in flight when the model
  // owes a reply or a tool result is outstanding and its owner is alive. With
  // no exact owner beacon, transcript recency remains the fallback.
  workingState(fileMtimeMs, now = Date.now(), processAlive = null) {
    const inFlight = this.header.lastSignal === 'tool-pending'
      || this.header.lastSignal === 'user-turn';
    if (!inFlight || processAlive === false) return { working: false, text: null };
    // A codex turn stopped on a question is waiting on the user, not working.
    if (this.header.pendingQuestion) return { working: false, text: null };
    const fresh = fileMtimeMs && (now - fileMtimeMs) < 180_000;
    if (processAlive !== true && !fresh) return { working: false, text: null };
    if (this.header.lastSignal === 'tool-pending') {
      const pending = [...this.pendingTools.values()].pop();
      if (!pending) return { working: true, text: 'Working…' };
      const doing = PRESENT_TENSE[pending.verb] || `Running ${pending.verb.toLowerCase()}`;
      const what = pending.chip ? `${doing} ${pending.chip}` : doing;
      return { working: true, text: clip(`${what}…`, 90) };
    }
    if (this.header.lastSignal === 'user-turn') return { working: true, text: 'Thinking…' };
    return { working: false, text: null };
  }
}

// Incremental line feed: bytes arrive in arbitrary chunks; hold the trailing
// partial line until its newline shows up.
class LineBuffer {
  constructor() { this.rest = ''; }
  feed(chunk) {
    const text = this.rest + chunk;
    const lines = text.split('\n');
    this.rest = lines.pop() ?? '';
    return lines.filter((l) => l.trim());
  }
}

// Large transcripts initialize from a small recent tail. Scan the skipped
// prefix cheaply for image-bearing JSONL records only, so pasted images remain
// available without parsing every old text/tool event. Claude's inline base64
// `"type":"image"` parts count, and so do codex's `local_image` parts (0.147+
// items) and `local_images` path arrays (the older user_message event).
const PREFIX_IMAGE_LINE_RE = /"type"\s*:\s*"(?:local_)?image"|"local_images"\s*:\s*\[\s*"/;
async function readPrefixImageBlocks(filePath, endOffset, provider = 'claude') {
  if (endOffset <= 0) return [];
  const stream = fs.createReadStream(filePath, { start: 0, end: endOffset - 1, encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const images = [];
  for await (const line of lines) {
    if (!PREFIX_IMAGE_LINE_RE.test(line)) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    // A codex image is a local_image PATH; the live window reads it into a
    // data URI exactly as it does in the tail (readLocalImage, cached).
    const parser = new TranscriptParser(provider, null, { loadLocalImages: provider === 'codex' });
    parser.applyLine(obj);
    for (const block of parser.blocks) {
      if (!block.images?.length) continue;
      const { key: _key, ...retained } = block;
      images.push(retained);
      if (images.length > MAX_IMAGE_BLOCKS) images.shift();
    }
  }
  return images;
}

// THE SESSION'S OPENING PROMPT IS NEVER OUT OF REACH (2026-08-13). A large
// transcript initializes from its last MAX_INITIAL_BYTES, so the first thing
// the user typed — the message the whole session is an answer to — fell outside
// the parsed window and the tile opened on Claude replying to nothing. Pat:
// "my first messages in each session are getting lost."
//
// It is not a rare edge. A pasted screenshot rides in the JSONL as base64, so
// ONE image-bearing first message is routinely larger than the entire window:
// measured on the real transcript he reported, the opening user line was
// 1,109,121 bytes against a 1,048,576-byte window. That message could not be
// recovered from either direction — too big to fit in the tail, and
// readPrefixImageBlocks reads bytes 0..tailStart-1, which CUT THAT SAME LINE IN
// HALF, so its JSON.parse threw and the image seeder dropped it too.
//
// So the opening is read FORWARD from byte 0, in chunks, stopping at the first
// user block. The common case touches a few KB; the cap only matters when the
// first message is itself enormous, and a line that does not complete inside it
// is left alone rather than half-parsed.
const OPENING_SCAN_BYTES = 16 * 1024 * 1024;
const OPENING_CHUNK_BYTES = 256 * 1024;

async function readOpeningBlock(filePath, provider = 'claude', limitBytes = OPENING_SCAN_BYTES) {
  const handle = await fsp.open(filePath, 'r');
  const parser = new TranscriptParser(provider, null, { loadLocalImages: true });
  let carry = Buffer.alloc(0);
  let position = 0;
  try {
    while (position < limitBytes) {
      const want = Math.min(OPENING_CHUNK_BYTES, limitBytes - position);
      const chunk = Buffer.alloc(want);
      const { bytesRead } = await handle.read(chunk, 0, want, position);
      if (!bytesRead) break;
      position += bytesRead;
      const data = carry.length
        ? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead);
      let lineStart = 0;
      for (let i = 0; i < data.length; i += 1) {
        // Split on raw '\n' bytes: 0x0a never occurs inside a multi-byte UTF-8
        // sequence, so line boundaries stay exact without decoding first.
        if (data[i] !== 0x0a) continue;
        const line = data.toString('utf8', lineStart, i);
        lineStart = i + 1;
        let obj = null;
        try { obj = JSON.parse(line); } catch { continue; }
        parser.applyLine(obj);
        const opening = parser.blocks.find((block) => block.kind === 'user');
        if (opening) {
          const { key: _key, ...retained } = opening;
          return retained;
        }
      }
      // A trailing partial line is never parsed; it is carried into the next
      // chunk, which is what lets a single multi-megabyte line be read whole.
      carry = data.subarray(lineStart);
    }
  } finally {
    await handle.close();
  }
  return null;
}

// Read one chunk of the file ending at `endOffset` (a byte position that is
// always a real line-start boundary: either a live entry's tail-read offset,
// or a previously returned page's oldest block offset) and parse every full
// line inside it with a fresh, throwaway TranscriptParser. The first line of
// the chunk is discarded when `start > 0` since it is cut mid-line by our
// arbitrary chunk boundary, exactly like the live tailing reader's own
// `skipFirstPartial`. Splitting on raw '\n' bytes (never on decoded string
// length) keeps line-start offsets exact regardless of multi-byte UTF-8.
async function readChunkEndingAt(filePath, provider, endOffset, chunkSize) {
  const start = Math.max(0, endOffset - chunkSize);
  if (start >= endOffset) return { blocks: [], reachedStart: true };
  const handle = await fsp.open(filePath, 'r');
  let buffer;
  try {
    buffer = Buffer.alloc(endOffset - start);
    await handle.read(buffer, 0, buffer.length, start);
  } finally {
    await handle.close();
  }
  const lineRanges = [];
  let lineBegin = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x0a) {
      lineRanges.push([lineBegin, i]);
      lineBegin = i + 1;
    }
  }
  const parser = new TranscriptParser(provider);
  const firstLineIsPartial = start > 0;
  // Track by parser.seq, NOT parser.blocks.length: once a chunk pushes past
  // the class's own MAX_BLOCKS cap, push() evicts an old block for every new
  // one it appends, so the array length stops growing even though new blocks
  // keep landing at the tail. A length-delta check would silently stop
  // tagging blocks with their offset right at that point (every block from
  // there on read back as key "aundefined"); seq increments unconditionally
  // on every push, evicted or not, so it never loses track.
  let prevSeq = 0;
  for (let idx = 0; idx < lineRanges.length; idx += 1) {
    if (idx === 0 && firstLineIsPartial) continue;
    const [lineStart, lineEnd] = lineRanges[idx];
    const text = buffer.toString('utf8', lineStart, lineEnd).trim();
    if (!text) continue;
    let obj;
    try { obj = JSON.parse(text); } catch { continue; }
    parser.applyLine(obj);
    const newSeq = parser.seq;
    if (newSeq > prevSeq) {
      const offset = start + lineStart;
      for (let i = parser.blocks.length - 1; i >= 0; i -= 1) {
        const block = parser.blocks[i];
        if (Number(block.key.slice(1)) < prevSeq) break;
        if (block._pageOffset === undefined) block._pageOffset = offset;
      }
    }
    prevSeq = newSeq;
  }
  return { blocks: parser.blocks, reachedStart: start === 0 };
}

// Grow the read window backward from `endOffset` until at least `minCount`
// blocks are found or the start of the file is reached. Doubling keeps a
// short session's page cheap (one small chunk) while a page deep into a
// 100+MB file still terminates in a bounded number of reads.
async function readArchiveBlocksBeforeOffset(filePath, provider, endOffset, minCount) {
  if (!(endOffset > 0)) return { blocks: [], hasMore: false };
  let chunkSize = PAGE_CHUNK_START_BYTES;
  let result = { blocks: [], reachedStart: false };
  for (;;) {
    result = await readChunkEndingAt(filePath, provider, endOffset, chunkSize);
    if (result.blocks.length >= minCount || result.reachedStart || chunkSize >= PAGE_CHUNK_MAX_BYTES) break;
    chunkSize *= 2;
  }
  const { blocks } = result;
  const overflow = blocks.length > minCount;
  const trimmed = overflow ? blocks.slice(blocks.length - minCount) : blocks;
  const hasMore = overflow || !result.reachedStart;
  for (const block of trimmed) {
    block.key = `a${block._pageOffset}`;
    delete block._pageOffset;
  }
  return { blocks: trimmed, hasMore };
}

function createTranscriptProvider(options = {}) {
  const getSessionMeta = options.getSessionMeta;
  if (typeof getSessionMeta !== 'function') {
    throw new TypeError('createTranscriptProvider requires getSessionMeta');
  }
  // contextCacheDir holds per-session tee files written by the statusline
  // script; the tee carries the authoritative used_percentage straight from
  // Claude Code's context_window field, bypassing the transcript model-id gap.
  const contextCacheDir = options.contextCacheDir
    ?? path.join(os.homedir(), '.cache', 'harbor', 'context');
  const watchFactory = options.watchFactory || ((target, listener) => watchPath(target, listener));
  // The /proc default cannot answer on Windows: every read throws, the catch
  // said processAlive=false, and a LIVE outside session rendered as killed
  // (which is the exact "Resume offered on an alive session" two-writer trap
  // the beacon comment below warns about). Without an injected reader there,
  // liveness falls through to the statusline beacon instead of lying.
  const yieldToEventLoop = options.yieldToEventLoop
    || (() => new Promise((resolve) => setImmediate(resolve)));
  const emitter = new EventEmitter();
  const open = new Map(); // sessionId -> entry
  let closed = false;

  // Pushed BEFORE the prefix images and before the tail, so the opening prompt
  // is the first row in the tile, where it belongs. Returned so the image
  // seeder can recognise it: when the first message is small enough to sit
  // wholly inside the prefix it is image-bearing too, and would otherwise be
  // pushed a second time.
  const seedOpeningBlock = async (entry) => {
    if (entry.offset <= 0) return null;
    // Windowed (mobile) opens emit only the most recent blocks, so a seeded
    // opening would be trimmed straight back out; it pages in instead. Same
    // reasoning as the image seeder immediately below.
    if (entry.windowBlocks) return null;
    const opening = await readOpeningBlock(entry.path, entry.provider).catch(() => null);
    if (!opening) return null;
    entry.parser.push(opening);
    return opening;
  };

  const seedPrefixImages = async (entry, seeded = null) => {
    if (entry.offset <= 0) return;
    // Windowed (mobile) opens skip this eagerly: it streams the whole
    // skipped prefix on every open (measured 481ms on a real 147MB file), and
    // a windowed client only ever shows DEFAULT_WINDOW_BLOCKS-ish recent rows
    // up front anyway. Its images resolve instead when the client PAGES back
    // into that region: readArchiveBlocksBeforeOffset parses every block type
    // there, images included, with full fidelity. Unwindowed desktop opens
    // are untouched, so the measured-and-cleared cost stays exactly as is.
    if (entry.windowBlocks) return;
    const blocks = await readPrefixImageBlocks(entry.path, entry.offset, entry.provider);
    for (const block of blocks) {
      if (seeded && block.ts === seeded.ts && block.text === seeded.text) continue;
      entry.parser.push(block);
    }
  };

  // Which images each block carried when it was last SENT (by reference: the
  // parser replaces a block's images array whenever it adds one). A block whose
  // images are still exactly those can go out as a metadata patch; anything
  // else, including images attached after the block was sent, goes out whole.
  const noteSentImages = (entry, payload) => {
    if (Array.isArray(payload.replace)) {
      entry.sentImages = new Map();
      for (const block of payload.replace) if (block.images?.length) entry.sentImages.set(block.key, block.images);
      return;
    }
    for (const key of payload.removed || []) entry.sentImages.delete(key);
    for (const block of [...(payload.changed || []), ...(payload.append || [])]) {
      if (block.images?.length) entry.sentImages.set(block.key, block.images);
      else entry.sentImages.delete(block.key);
    }
  };

  const emitUpdate = (entry, payload) => {
    if (closed) return;
    const stat = entry.lastMtimeMs;
    // Exact owner liveness: the teed pid is checked against the process
    // table, with the cmdline required to still be a claude (pid reuse
    // guard). The mtime beacon is only a fallback for sessions whose tee
    // predates the pid field; its refresh cadence is minutes, so it gets a
    // deliberately conservative window (a mid-gap flap once offered Resume
    // on an ALIVE session, which is the two-writers trap).
    // Codex has no statusline tee and no beacon, so without the pane check a
    // codex task running one long command (no rollout writes for minutes)
    // aged past the transcript-recency window and read "ready" mid-command. A
    // Harbor pane whose detected foreground agent is codex AND that is paired
    // with this session IS the live codex process; see entry.providerPaneAlive
    // in readNew.
    const exactOwner = entry.providerPaneAlive
      ? true
      : readOwnerProcessAlive(entry.ownerPid, options.readProcessCmdline);
    // The transcript is a beacon too. The statusline beacon repaints only
    // on interactive activity, so across a long idle gap it goes stale
    // while the session is very much alive; meanwhile a session that wrote
    // its transcript five seconds ago provably had a live writer five
    // seconds ago. 2026-08-21: Pat's prompt reached the transcript
    // instantly, the model then spent 36 seconds reading a ~470k-token
    // context before its first record, and the whole time the window said
    // "ready" because a 41-minute-old beacon outvoted a one-second-old
    // transcript write. The freshest evidence of life decides; the owner
    // is called dead only when BOTH are stale.
    const processAlive = processAliveFromEvidence({ processAlive: exactOwner, beaconMs: entry.beaconMs, lastWriteMs: stat });
    const working = entry.parser.workingState(stat, Date.now(), processAlive);
    const header = {
      ...entry.parser.header,
      ...working,
      lastWriteMs: stat || null,
      processAlive,
    };
    // L1 ground truth: prefer the tee-file percentage over the ratchet estimate.
    if (entry.teedContextPct !== null) header.contextPct = entry.teedContextPct;
    // Windowed sessions (MOBILE-3) trim ONLY the emitted `replace` payload to
    // the most recent N blocks; `header` above is always priced off the full
    // live parser state, never off this trimmed list, so a windowed payload
    // never computes a percentage from a partial window. `append`/`changed`
    // payloads are naturally small increments and are never trimmed.
    const outgoing = entry.windowBlocks && Array.isArray(payload.replace)
      ? { ...payload, replace: payload.replace.slice(-entry.windowBlocks) }
      : payload;
    noteSentImages(entry, outgoing);
    emitter.emit('update', {
      sessionId: entry.sessionId,
      header,
      ...outgoing,
    });
  };

  const readNew = async (entry) => {
    let handle;
    try {
      handle = await fsp.open(entry.path, 'r');
      const stat = await handle.stat();
      entry.lastMtimeMs = stat.mtimeMs;
      if (stat.size < entry.offset) {
        // Truncated/rewritten underneath us: start over from the tail.
        entry.offset = 0;
        entry.tailStartOffset = 0;
        entry.parser = new TranscriptParser(entry.provider, null, { loadLocalImages: true });
        entry.lineBuffer = new LineBuffer();
        entry.needsReplace = true;
        entry.skipFirstPartial = false;
        if (stat.size > MAX_INITIAL_BYTES) {
          entry.offset = stat.size - MAX_INITIAL_BYTES;
          entry.tailStartOffset = entry.offset;
          entry.skipFirstPartial = true;
          await seedPrefixImages(entry, await seedOpeningBlock(entry));
        }
      }
      // L1 ground truth: trust the statusline tee while the transcript has not
      // grown past it. An idle transcript leaves an old tee authoritative; only
      // a meaningfully later transcript write makes that percentage stale and
      // falls back to the L2 ratchet. EXCEPT: an actively working session
      // streams transcript writes every few seconds while the statusline only
      // re-renders between turns, so "transcript grew past the tee" is the
      // NORMAL mid-turn state, not staleness. A tee younger than the statusline
      // re-render cadence stays authoritative regardless (live-caught
      // 2026-07-20: real 20% of a 1M window rendered as 99% of 200k every time
      // Pat glanced at a busy young session).
      try {
        const teeFile = path.join(contextCacheDir, `${entry.sessionId}.json`);
        const teeStat = await fsp.stat(teeFile);
        const teeRecentlyRendered = (Date.now() - teeStat.mtimeMs) < TEE_RECENT_MS;
        const transcriptHasGrownPastTee = stat.mtimeMs > (teeStat.mtimeMs + TEE_TRANSCRIPT_SKEW_MS);
        const raw = JSON.parse(await fsp.readFile(teeFile, 'utf8'));
        if (teeRecentlyRendered || !transcriptHasGrownPastTee) {
          const pct = raw?.used_percentage;
          entry.teedContextPct = (typeof pct === 'number' && pct >= 1 && pct <= 99)
            ? Math.round(pct) : null;
          // A pairable tee also TEACHES the window size (pct = tokens/window,
          // Claude's own math), applied after this read parses the tokens it
          // describes. pct >= 5 keeps rounding noise from implying nonsense.
          entry.teeWindowTeacherPct = (typeof pct === 'number' && pct >= 5 && pct <= 99) ? pct : null;
        } else {
          entry.teedContextPct = null;
          entry.teeWindowTeacherPct = null;
        }
        // The CLI now hands over its own denominator outright
        // (context_window.context_window_size, teed since 2026-08-12), which
        // beats deriving it from pct arithmetic: it is available from the very
        // first statusline repaint, before any percentage exists. Still
        // Claude's own number — never a Harbor guess — so the no-invented-
        // denominator rule holds. Same clamp and drift rule as the learner.
        const teeWindow = raw?.context_window_size;
        if (Number.isFinite(teeWindow) && teeWindow >= 50_000 && teeWindow <= 5_000_000) {
          const current = entry.parser.learnedWindow;
          if (!current || Math.abs(teeWindow - current) / current > 0.1) {
            entry.parser.setLearnedWindow(teeWindow);
            fsp.writeFile(path.join(contextCacheDir, `${entry.sessionId}.learned.json`), JSON.stringify({
              window_tokens: teeWindow,
              source: 'context_window_size',
              learned_at: new Date().toISOString(),
            })).catch(() => {});
          }
        }
        // Owner pid (statusline runs as the claude process's child and tees
        // $PPID): the EXACT liveness signal, regardless of tee freshness.
        entry.ownerPid = Number.isInteger(raw?.pid) && raw.pid > 1 ? raw.pid : null;
      } catch { entry.teedContextPct = null; entry.ownerPid = null; }
      // Liveness beacon: Claude Code re-renders the statusline every ~3 min
      // while a session's composer is OPEN, stamping statusline-state/<id>.json
      // in its config home. A fresh beacon = another writer is alive in some
      // terminal; a stale one = that process is gone and the session is
      // adoptable. Far sharper than transcript recency (a session that just
      // replied is NOT resumable while its terminal stays open, and IS within
      // minutes of the terminal closing).
      //
      // EVERY config home on the machine is checked, not a hardcoded pair. This
      // read used to be `['.claude', '.claude-team']`, which missed a beacon in
      // any other home, including the third one on the machine it was written
      // on. A missed beacon is not a cosmetic loss: no beacon reads as "that
      // process is gone", which is the input to adopt-on-send deciding a session
      // is adoptable, and adopting kills the owner. The homes come from the same
      // discovery the config and the wizard use, so the three cannot disagree.
      entry.beaconMs = await readSessionBeacon(entry.sessionId);
      // The codex owner: is a live Harbor pane running codex on this session?
      // Asked per read, never cached past it, so a pane that exits stops
      // vouching on the very next read. Unknown (no answerer, or it threw) is
      // not "dead"; it falls back to transcript recency exactly as before.
      if (entry.provider === 'codex' && typeof options.providerPaneAlive === 'function') {
        try { entry.providerPaneAlive = Boolean(await options.providerPaneAlive(entry.sessionId, entry.provider)); }
        catch { entry.providerPaneAlive = false; }
      }
      if (stat.size === entry.offset) {
        await handle.close();
        // mtime moved with no new bytes still refreshes the working clock.
        emitUpdate(entry, { append: [], changed: [] });
        return;
      }
      const length = stat.size - entry.offset;
      const buffer = Buffer.alloc(Math.min(length, 8 * 1024 * 1024));
      let position = entry.offset;
      const before = entry.parser.blocks.length;
      const keysBefore = new Set(entry.parser.blocks.map((block) => block.key));
      const seqBefore = entry.parser.seq;
      const changedKeys = new Set();
      let linesSinceYield = 0;
      while (position < stat.size) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        position += bytesRead;
        const lines = entry.lineBuffer.feed(buffer.toString('utf8', 0, bytesRead));
        for (const line of lines) {
          if (entry.skipFirstPartial) { entry.skipFirstPartial = false; continue; }
          let obj = null;
          try { obj = JSON.parse(line); } catch { continue; }
          for (const key of entry.parser.applyLine(obj)) changedKeys.add(key);
          linesSinceYield += 1;
          if (linesSinceYield >= 256) {
            linesSinceYield = 0;
            await yieldToEventLoop();
          }
        }
      }
      entry.offset = position;
      await handle.close();
      // Window learning: a pairable tee's pct and the tokens it describes
      // yield the window numerically (pct = tokens/window is Claude's own
      // arithmetic). Persist it so cold starts and stale-tee fallbacks keep
      // an honest denominator for ANY model id: there is no window table to
      // be wrong. Clamped to a sane range so absurd math never sticks, and
      // rewritten only on meaningful drift (a model switch mid-session
      // re-teaches within one statusline repaint).
      if (entry.teeWindowTeacherPct != null) {
        const tokens = entry.parser.header.contextTokens;
        const implied = tokens ? Math.round(tokens / (entry.teeWindowTeacherPct / 100)) : 0;
        if (implied >= 50_000 && implied <= 5_000_000) {
          const current = entry.parser.learnedWindow;
          if (!current || Math.abs(implied - current) / current > 0.1) {
            entry.parser.setLearnedWindow(implied);
            const learnedFile = path.join(contextCacheDir, `${entry.sessionId}.learned.json`);
            fsp.writeFile(learnedFile, JSON.stringify({
              window_tokens: implied,
              at_tokens: tokens,
              used_percentage: entry.teeWindowTeacherPct,
              ts: new Date().toISOString(),
            })).catch(() => { /* learning must never break the read */ });
          }
        }
      }
      const blocks = entry.parser.blocks;
      const currentKeys = new Set(blocks.map((block) => block.key));
      if (entry.needsReplace) {
        entry.needsReplace = false;
        emitUpdate(entry, { replace: blocks });
      } else {
        // Appended rows are the ones minted this read (seq is monotonic);
        // changed rows are earlier action rows whose tool result just landed,
        // and prompts whose turn tokens grew.
        const appended = blocks.filter((b) => Number(b.key.slice(1)) >= seqBefore);
        const removed = [...keysBefore].filter((key) => !currentKeys.has(key));
        // A TOKEN TICK MUST NOT RESEND THE PROMPT'S IMAGE (2026-10-21 audit).
        // Every assistant usage record re-marks the prompt that opened the
        // turn, and a whole changed block carries its base64 images: one
        // 130 KB screenshot prompt and twelve short replies sent 1.57 MB to
        // the phone. A block whose images the client already holds goes in
        // `patched` without them; the shared reducer merges a patch into the
        // held block, keeping its images. Text-only blocks still go whole.
        const changed = [];
        const patched = [];
        for (const block of blocks) {
          if (!changedKeys.has(block.key) || Number(block.key.slice(1)) >= seqBefore) continue;
          if (block.images?.length && entry.sentImages.get(block.key) === block.images) {
            const patch = { ...block };
            delete patch.images;
            patched.push(patch);
          } else {
            changed.push(block);
          }
        }
        emitUpdate(entry, {
          append: appended,
          changed,
          ...(patched.length ? { patched } : {}),
          ...(removed.length ? { removed } : {}),
        });
      }
    } catch (error) {
      try { await handle?.close(); } catch { /* already closed */ }
      if (error?.code !== 'ENOENT') emitter.emit('error', error);
    }
  };

  const scheduleRead = (entry) => {
    if (entry.reading) { entry.readAgain = true; return; }
    entry.reading = true;
    clearTimeout(entry.readTimer);
    entry.readTimer = setTimeout(async () => {
      await readNew(entry);
      entry.reading = false;
      if (entry.readAgain) {
        entry.readAgain = false;
        scheduleRead(entry);
      }
    }, 120);
  };

  const armWatch = (entry) => {
    try {
      entry.watcher?.close();
      entry.watcher = watchFactory(entry.path, () => scheduleRead(entry));
      entry.watcher.on('error', () => { /* file replaced; dir watcher re-arms */ });
      entry.dirWatcher?.close();
      entry.dirWatcher = null;
      return true;
    } catch {
      // Transcript not on disk yet (fresh session): watch the directory until
      // the file appears, then re-arm.
      try {
        entry.dirWatcher?.close();
        entry.dirWatcher = watchFactory(path.dirname(entry.path), (_ev, name) => {
          if (name === path.basename(entry.path)) {
            if (armWatch(entry)) scheduleRead(entry);
          }
        });
        entry.dirWatcher.on('error', () => {});
      } catch { /* project dir absent too; poll covers it */ }
      return false;
    }
  };

  // ONE INITIALIZATION PER SESSION (2026-10-21, second Sol review). The open
  // map was checked, then the metadata lookup awaited, so two overlapping opens
  // (a phone reconnecting while its old open was still resolving) each built an
  // entry; the later one overwrote the map and the earlier one's watcher and
  // poller ran on with nothing able to close them. An open that finds another
  // still initializing waits for it, then takes a reference on that entry.
  const initializing = new Map(); // sessionId -> promise of the first opener's result
  const openTranscript = async (sessionId, hints = {}) => {
    const existing = open.get(sessionId);
    if (existing) {
      existing.refs += 1;
      if (hints.window) existing.windowBlocks = normalizeWindowBlocks(hints.window);
      emitUpdate(existing, { replace: existing.parser.blocks });
      return { ok: true, sessionId };
    }
    const inFlight = initializing.get(sessionId);
    if (inFlight) {
      await inFlight.catch(() => null);
      return openTranscript(sessionId, hints);
    }
    const first = initializeTranscript(sessionId, hints);
    initializing.set(sessionId, first);
    try {
      return await first;
    } finally {
      if (initializing.get(sessionId) === first) initializing.delete(sessionId);
    }
  };

  const initializeTranscript = async (sessionId, hints) => {
    let meta = null;
    try { meta = await getSessionMeta(sessionId); } catch { meta = null; }
    const provider = hints.provider || meta?.provider || 'claude';
    const transcriptPath = meta?.path || await findProviderTranscript({ provider, sessionId, cwd: hints.cwd || meta?.cwd });
    if (!transcriptPath) return { ok: false, sessionId, reason: 'transcript path unknown', provider };
    const entry = {
      sessionId,
      path: transcriptPath,
      provider,
      refs: 1,
      offset: 0,
      // The FIXED byte position where the initial tail read started (0 for a
      // file under MAX_INITIAL_BYTES, else stat.size - MAX_INITIAL_BYTES at
      // open time). Unlike `entry.offset`, which is a moving read cursor that
      // advances to the current end of file after every live read (so it is
      // NOT "is there a skipped prefix" once the entry has been open a
      // while), this never moves for the entry's lifetime except on a
      // truncation/rewrite, when it is recomputed alongside `entry.offset`.
      // page() uses this, never `entry.offset`, to decide whether older
      // blocks exist only in the file (MOBILE-3).
      tailStartOffset: 0,
      parser: new TranscriptParser(provider, hints.model, { loadLocalImages: true }),
      lineBuffer: new LineBuffer(),
      lastMtimeMs: null,
      needsReplace: true,
      skipFirstPartial: false,
      watcher: null,
      dirWatcher: null,
      reading: false,
      readAgain: false,
      readTimer: null,
      pollTimer: null,
      teedContextPct: null, // authoritative pct from statusline tee file; null = not available
      teeWindowTeacherPct: null, // pairable tee pct that can teach the window size
      // Absent (undefined/null) means today's desktop behaviour, unchanged:
      // every `replace` payload carries the full live block list. Set only
      // when `hints.window` was requested (MOBILE-3).
      windowBlocks: hints.window ? normalizeWindowBlocks(hints.window) : null,
      sentImages: new Map(), // block key -> images array last sent (see noteSentImages)
    };
    open.set(sessionId, entry);
    // The learned window survives restarts: load it before the first read so
    // a cold open with an outgrown tee still prices tokens honestly.
    try {
      const learned = JSON.parse(await fsp.readFile(path.join(contextCacheDir, `${sessionId}.learned.json`), 'utf8'));
      const w = learned?.window_tokens;
      if (Number.isFinite(w) && w >= 50_000 && w <= 5_000_000) entry.parser.setLearnedWindow(w);
    } catch { /* nothing learned yet */ }
    try {
      const stat = await fsp.stat(entry.path);
      if (stat.size > MAX_INITIAL_BYTES) {
        entry.offset = stat.size - MAX_INITIAL_BYTES;
        entry.tailStartOffset = entry.offset;
        entry.skipFirstPartial = true; // first read lands mid-line
        await seedPrefixImages(entry, await seedOpeningBlock(entry));
      }
    } catch { /* not on disk yet */ }
    armWatch(entry);
    // Belt over the watch: fs.watch misses events on some filesystems and the
    // working shimmer needs an mtime clock anyway.
    entry.pollTimer = setInterval(() => scheduleRead(entry), 5000);
    entry.pollTimer.unref?.();
    await readNew(entry);
    if (entry.needsReplace) {
      // Empty/absent file: still tell the renderer the tile is open.
      entry.needsReplace = false;
      emitUpdate(entry, { replace: entry.parser.blocks });
    }
    return { ok: true, sessionId };
  };

  const closeTranscript = (sessionId) => {
    const entry = open.get(sessionId);
    if (!entry) return { ok: true };
    entry.refs -= 1;
    if (entry.refs > 0) return { ok: true };
    open.delete(sessionId);
    clearTimeout(entry.readTimer);
    clearInterval(entry.pollTimer);
    entry.watcher?.close();
    entry.dirWatcher?.close();
    return { ok: true };
  };

  // Release every open transcript's watchers, pollers and refcounts. Used two
  // ways with one crucial difference. A renderer reload or crash resets the
  // renderer's own open-set to empty while main still holds every refcount from
  // the previous life, stranding an fs watcher and a 5s poller per session; the
  // restored page re-opens what it wants, so dropAll() frees the strays and the
  // provider keeps serving. closeAll() is the real-shutdown path: it ALSO
  // latches `closed`, which stops every future emit, correct at process exit,
  // fatal on a reload. Using closeAll for a reload left every tile on "Loading
  // transcript…" until the app was reopened (live-caught 2026-09-05).
  const dropAll = () => {
    for (const sessionId of [...open.keys()]) {
      const entry = open.get(sessionId);
      entry.refs = 1;
      closeTranscript(sessionId);
    }
  };

  const close = () => {
    closed = true;
    dropAll();
  };

  // MOBILE-3: page backwards through blocks older than `beforeBlockId`. This
  // NEVER re-reads the tail region the live entry owns; it only reads further
  // BACK in the file, either from blocks already resident in the live parser
  // (fast path, no I/O) or, once those run out, from an independent read of
  // the skipped prefix (readArchiveBlocksBeforeOffset). Deliberately returns
  // no `header`/percentage: a partial archive read must never be priced as
  // if it were the whole session (the context-gauge invariant applies here
  // exactly as it does to the live header).
  const pageTranscript = async (sessionId, params = {}) => {
    const entry = open.get(sessionId);
    if (!entry) return { ok: false, sessionId, reason: 'transcript is not open' };
    const beforeBlockId = params.beforeBlockId;
    if (typeof beforeBlockId !== 'string' || !beforeBlockId) {
      return { ok: false, sessionId, reason: 'beforeBlockId is required' };
    }
    const count = Math.max(1, Math.min(MAX_BLOCKS, Number.isFinite(params.count)
      ? Math.floor(params.count)
      : (entry.windowBlocks || DEFAULT_WINDOW_BLOCKS)));

    // Archive-origin cursor ("a<offset>"): continue reading backward from
    // exactly where the previous page left off.
    const archiveMatch = /^a(\d+)$/.exec(beforeBlockId);
    if (archiveMatch) {
      const endOffset = Number(archiveMatch[1]);
      const { blocks, hasMore } = await readArchiveBlocksBeforeOffset(entry.path, entry.provider, endOffset, count);
      return { ok: true, sessionId, blocks, hasMore };
    }

    // Live cursor ("b<seq>"): try the blocks already resident in the live
    // parser first (no file I/O). A key that isn't resident (evicted by the
    // live entry's own MAX_BLOCKS trim, or simply unrecognized) is treated as
    // "older than anything currently loaded" and falls to the tail boundary.
    const idx = entry.parser.blocks.findIndex((block) => block.key === beforeBlockId);
    if (idx < 0) {
      if (entry.tailStartOffset > 0) {
        const { blocks, hasMore } = await readArchiveBlocksBeforeOffset(entry.path, entry.provider, entry.tailStartOffset, count);
        return { ok: true, sessionId, blocks, hasMore };
      }
      return { ok: true, sessionId, blocks: [], hasMore: false };
    }

    const inMemory = entry.parser.blocks.slice(Math.max(0, idx - count), idx);
    if (inMemory.length >= count || entry.tailStartOffset === 0) {
      const hasMore = inMemory.length >= count && (idx - count > 0 || entry.tailStartOffset > 0);
      return { ok: true, sessionId, blocks: inMemory, hasMore };
    }
    // The live parser ran out before the page was full; fill the remainder
    // from the skipped prefix, ending exactly at the tail's own FIXED start
    // offset so nothing is skipped or double-counted between the two sources.
    const remainder = count - inMemory.length;
    const archive = await readArchiveBlocksBeforeOffset(entry.path, entry.provider, entry.tailStartOffset, remainder);
    return { ok: true, sessionId, blocks: [...archive.blocks, ...inMemory], hasMore: archive.hasMore };
  };

  return {
    emitter,
    open: openTranscript,
    page: pageTranscript,
    refresh: async (sessionId) => {
      const entry = open.get(sessionId);
      if (!entry) return { ok: false, reason: 'transcript is not open' };
      await readNew(entry);
      return { ok: true };
    },
    close: closeTranscript,
    closeAll: close,
    dropAll,
    openCount: () => open.size,
  };
}

module.exports = {
  createTranscriptProvider,
  isCompactContinuation,
  TranscriptParser,
  LineBuffer,
  modelDisplay,
  usageTokens,
  actionForToolUse,
  userTextFor,
  imageFromPart,
  imagesFromContent,
  buildDiffPreview,
  actionForApplyPatch,
  parseApplyPatch,
  codexActionFor,
  readLocalImage,
  localImageCacheStats: () => ({ ...localImageStats, entries: localImageCache.size, bytes: localImageCacheBytes }),
  readPrefixImageBlocks,
  transcriptPathFor,
  findProviderTranscript,
  readTranscriptTailRecords,
  readTranscriptLastSignal,
  readTailLines,
  extractHandoffPath,
  waitForHandoffPath,
  readArchiveBlocksBeforeOffset,
  DEFAULT_WINDOW_BLOCKS,
  MAX_BLOCKS,
  MAX_IMAGE_BLOCKS,
  MAX_INITIAL_BYTES,
};
