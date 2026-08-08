'use strict';

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
const { listHomeDirs } = require('../config/homes.js');


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

// Config homes to look for a statusline liveness beacon in. Cached for a minute
// because the tail calls this on every read and a home is created about as often
// as an account is: `HARBOR_BEACON_HOMES` (path-delimited) pins it for harnesses.
let beaconHomesCache = { at: 0, dirs: [] };
function beaconHomes(now = Date.now()) {
  const pinned = process.env.HARBOR_BEACON_HOMES;
  if (pinned) return pinned.split(path.delimiter).filter(Boolean);
  if (now - beaconHomesCache.at < 60_000) return beaconHomesCache.dirs;
  // `listHomeDirs` already swallows its own readdir failure and returns [], so
  // the only reason this is empty is a home directory nothing can read, in which
  // case the conventional home is the one honest guess left.
  const found = listHomeDirs(os.homedir(), fs.readdirSync);
  const dirs = found.length ? found : [path.join(os.homedir(), '.claude')];
  beaconHomesCache = { at: now, dirs };
  return dirs;
}

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

// Model id -> display name + chip tint. Unknown ids fall back to a cleaned-up
// id so a new model never renders blank.
const MODEL_DISPLAY = [
  [/^claude-fable-5/, { name: 'Fable 5', tone: 'fable' }],
  [/^claude-mythos-5/, { name: 'Mythos 5', tone: 'fable' }],
  [/^claude-opus-5/, { name: 'Opus 5', tone: 'opus' }],
  [/^claude-opus-4-8/, { name: 'Opus 4.8', tone: 'opus' }],
  [/^claude-opus-4-7/, { name: 'Opus 4.7', tone: 'opus' }],
  [/^claude-opus-4-6/, { name: 'Opus 4.6', tone: 'opus' }],
  [/^claude-opus-4-5/, { name: 'Opus 4.5', tone: 'opus' }],
  [/^claude-opus-4-1/, { name: 'Opus 4.1', tone: 'opus' }],
  [/^claude-opus-4/, { name: 'Opus 4', tone: 'opus' }],
  [/^claude-sonnet-5/, { name: 'Sonnet 5', tone: 'sonnet' }],
  [/^claude-sonnet-4-6/, { name: 'Sonnet 4.6', tone: 'sonnet' }],
  [/^claude-sonnet-4-5/, { name: 'Sonnet 4.5', tone: 'sonnet' }],
  [/^claude-sonnet-4/, { name: 'Sonnet 4', tone: 'sonnet' }],
  [/^claude-haiku-4-5/, { name: 'Haiku 4.5', tone: 'haiku' }],
  [/^claude-3-5-haiku/, { name: 'Haiku 3.5', tone: 'haiku' }],
];

function modelDisplay(modelId) {
  if (!modelId) return null;
  for (const [re, display] of MODEL_DISPLAY) {
    if (re.test(modelId)) return { id: modelId, ...display };
  }
  const cleaned = String(modelId).replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-/g, ' ');
  return { id: modelId, name: cleaned.replace(/\b\w/g, (c) => c.toUpperCase()), tone: 'other' };
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
  for (const [re, display] of MODEL_DISPLAY) {
    if (display.name.toLowerCase() === name.toLowerCase()) {
      return { id: re.source.replace(/^\^/, ''), ...display };
    }
  }
  return { id: null, name, tone: 'other' };
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

function cursorProjectDir(cwd) {
  return String(cwd || '').replace(/^\/+/, '').replace(/[^a-zA-Z0-9]/g, '-');
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
  const stripped = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
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
};

class TranscriptParser {
  constructor(provider = 'claude', seedModel = null) {
    this.provider = provider;
    this.blocks = [];
    this.pendingTools = new Map(); // tool_use id -> action block
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
      let dropIndex = this.blocks.findIndex((item) => item.kind !== 'user' && !item.images?.length);
      if (dropIndex < 0) dropIndex = this.blocks.findIndex((item) => item.kind === 'user' && !item.images?.length);
      if (dropIndex < 0) dropIndex = 0; // only image-bearing blocks remain
      const [dropped] = this.blocks.splice(dropIndex, 1);
      if (dropped?.toolId) this.pendingTools.delete(dropped.toolId);
    }
    return block;
  }

  // Returns the keys of blocks that CHANGED in place (tool results resolving
  // an earlier action row) so the renderer can re-render them.
  applyLine(obj) {
    const changed = [];
    if (!obj || typeof obj !== 'object') return changed;
    if (this.provider === 'codex') return this.applyCodexLine(obj);
    if (this.provider === 'cursor') return this.applyCursorLine(obj);
    if (obj.isSidechain) return changed;
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
          this.push({ kind: 'user', text: user.text, command: user.command, ts });
          this.header.lastSignal = 'user-turn';
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
              lastUserInLine = this.push({ kind: 'user', text: user.text, command: user.command, ts });
              this.header.lastSignal = 'user-turn';
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
        const block = this.push({ kind: 'user', text: user.text, command: user.command, ts, queued: true });
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
        }
        // thinking blocks never render; the working shimmer covers "busy".
      }
      const terminalStop = message.stop_reason === 'end_turn'
        || message.stop_reason === 'stop_sequence';
      if (this.pendingTools.size) this.header.lastSignal = 'tool-pending';
      else this.header.lastSignal = terminalStop ? 'idle' : 'user-turn';
      return changed;
    }

    return changed;
  }

  applyCodexLine(obj) {
    const changed = [];
    const payload = obj.payload || {};
    const ts = obj.timestamp || null;
    if (ts) this.header.lastEventTs = ts;
    if (obj.type === 'turn_context' && payload.model) this.header.model = modelDisplay(payload.model);
    if (obj.type === 'event_msg' && payload.type === 'user_message' && payload.message) {
      this.push({ kind: 'user', text: clipProse(payload.message), ts });
      this.header.lastSignal = 'user-turn';
    } else if (obj.type === 'event_msg' && payload.type === 'agent_message' && payload.message) {
      this.push({ kind: 'assistant', text: clipProse(payload.message), ts });
      this.header.lastSignal = 'idle';
    } else if (obj.type === 'event_msg' && payload.type === 'item_completed') {
      // Codex 0.147.0 stopped writing user_message/agent_message and moved the
      // conversation into this item stream, the same items its own UI renders
      // (found 2026-08-08: Pat's real 4.5MB review parsed to 16 tool actions
      // and zero text). Only the two message kinds are taken: CommandExecution
      // mirrors the custom_tool_call lines already rendered above, and the
      // response_item message lines are NOT the conversation, they carry the
      // injected scaffolding (skills instructions, AGENTS.md,
      // environment_context) that would bury the real prompt. Part type casing
      // differs by role in the real bytes ('text' vs 'Text'), so any part
      // carrying a text string counts.
      const item = payload.item || {};
      if (item.type === 'UserMessage' || item.type === 'AgentMessage') {
        const text = (Array.isArray(item.content) ? item.content : [])
          .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
          .filter(Boolean)
          .join('\n')
          .trim();
        if (text) {
          const user = item.type === 'UserMessage';
          this.push({ kind: user ? 'user' : 'assistant', text: clipProse(text), ts });
          this.header.lastSignal = user ? 'user-turn' : 'idle';
        }
      }
    } else if (obj.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(payload.type)) {
      let name = payload.name || 'Tool';
      let input = payload.arguments ?? payload.input ?? {};
      if (typeof input === 'string') {
        const snippet = codexToolSnippet(input);
        if (snippet) ({ name, input } = snippet);
        else { try { input = JSON.parse(input); } catch { input = { command: input }; } }
      }
      if (input.cmd && !input.command) input.command = input.cmd;
      const tool = { name, input };
      const action = this.push({ kind: 'action', toolId: payload.call_id || payload.id || null, status: 'run', ts, ...actionForToolUse(tool) });
      if (action.toolId) this.pendingTools.set(action.toolId, action);
      this.header.lastSignal = 'tool-pending';
    } else if (obj.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(payload.type)) {
      const action = this.pendingTools.get(payload.call_id);
      if (action) {
        action.status = /Process exited with code [1-9]|error/i.test(String(payload.output || '')) ? 'err' : 'ok';
        this.pendingTools.delete(payload.call_id);
        changed.push(action.key);
      }
    } else if (obj.type === 'event_msg' && ['task_complete', 'task_completed'].includes(payload.type)) {
      this.header.lastSignal = 'idle';
    }
    return changed;
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
// available without parsing every old text/tool event.
async function readPrefixImageBlocks(filePath, endOffset, provider = 'claude') {
  if (endOffset <= 0) return [];
  const stream = fs.createReadStream(filePath, { start: 0, end: endOffset - 1, encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const images = [];
  for await (const line of lines) {
    if (!/"type"\s*:\s*"image"/.test(line)) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const parser = new TranscriptParser(provider);
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
  const watchFactory = options.watchFactory || ((target, listener) => fs.watch(target, listener));
  const readProcessCmdline = options.readProcessCmdline
    || ((pid) => fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
  const yieldToEventLoop = options.yieldToEventLoop
    || (() => new Promise((resolve) => setImmediate(resolve)));
  const emitter = new EventEmitter();
  const open = new Map(); // sessionId -> entry
  let closed = false;

  const seedPrefixImages = async (entry) => {
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
    for (const block of blocks) entry.parser.push(block);
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
    let processAlive = null;
    if (entry.ownerPid) {
      try {
        const cmd = readProcessCmdline(entry.ownerPid);
        processAlive = /(^|\0|\/)claude(\0|$)/.test(cmd) || cmd.includes('claude');
      } catch { processAlive = false; }
    } else if (entry.beaconMs != null) {
      processAlive = (Date.now() - entry.beaconMs) < 10 * 60 * 1000;
    }
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
        entry.parser = new TranscriptParser(entry.provider);
        entry.lineBuffer = new LineBuffer();
        entry.needsReplace = true;
        entry.skipFirstPartial = false;
        if (stat.size > MAX_INITIAL_BYTES) {
          entry.offset = stat.size - MAX_INITIAL_BYTES;
          entry.tailStartOffset = entry.offset;
          entry.skipFirstPartial = true;
          await seedPrefixImages(entry);
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
      entry.beaconMs = null;
      for (const home of beaconHomes()) {
        try {
          const b = await fsp.stat(path.join(home, 'statusline-state', `${entry.sessionId}.json`));
          entry.beaconMs = Math.max(entry.beaconMs || 0, b.mtimeMs);
        } catch { /* no beacon in this home */ }
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
      } else if (before && [...keysBefore].some((key) => !currentKeys.has(key))) {
        // The bounded window slid. Image retention can evict a non-front row,
        // so replace wholesale whenever any previously rendered key vanished.
        emitUpdate(entry, { replace: blocks });
      } else {
        // Appended rows are the ones minted this read (seq is monotonic);
        // changed rows are earlier action rows whose tool result just landed.
        const appended = blocks.filter((b) => Number(b.key.slice(1)) >= seqBefore);
        const changed = blocks.filter((b) => changedKeys.has(b.key) && Number(b.key.slice(1)) < seqBefore);
        emitUpdate(entry, { append: appended, changed });
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

  const openTranscript = async (sessionId, hints = {}) => {
    const existing = open.get(sessionId);
    if (existing) {
      existing.refs += 1;
      if (hints.window) existing.windowBlocks = normalizeWindowBlocks(hints.window);
      emitUpdate(existing, { replace: existing.parser.blocks });
      return { ok: true, sessionId };
    }
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
      parser: new TranscriptParser(provider, hints.model),
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
        await seedPrefixImages(entry);
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

  const close = () => {
    closed = true;
    for (const sessionId of [...open.keys()]) {
      const entry = open.get(sessionId);
      entry.refs = 1;
      closeTranscript(sessionId);
    }
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
  transcriptPathFor,
  findProviderTranscript,
  extractHandoffPath,
  waitForHandoffPath,
  readArchiveBlocksBeforeOffset,
  DEFAULT_WINDOW_BLOCKS,
  MAX_BLOCKS,
  MAX_IMAGE_BLOCKS,
  MAX_INITIAL_BYTES,
};
