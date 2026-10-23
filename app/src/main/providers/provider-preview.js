'use strict';

// The text preview for a codex/cursor session, in the same shape the history
// index prints for a claude one. The claude index never holds these ids, so
// asking it answered "session ... not in index yet" for every codex batch
// worker. The conversation comes from the REAL TranscriptParser, so a
// rollout's injected scaffolding (developer/user `response_item` lines) never
// reaches the preview: only UserMessage/AgentMessage items do.
//
// BOUNDED READS ONLY (the main process never reads a whole transcript; see
// docs/claude/views.md). A codex rollout runs to hundreds of MB, so a large
// file is read as a head (the first prompt and the start time) plus a tail
// (recent prompts and the last reply), never in between.

const fs = require('node:fs');
const readline = require('node:readline');
const { TranscriptParser, readTailLines } = require('./transcript.js');
const { projectLabelForCwd } = require('../../shared/project-label.cjs');

const RECENT_PROMPTS = 5;
const REPLY_MAX = 1200;
// A file this small is read once, start to end, through the tail reader.
const WHOLE_MAX_BYTES = 4 * 1024 * 1024;
// The head: stops at the first user prompt, or at either cap.
const HEAD_BYTES = 4 * 1024 * 1024;
const HEAD_LINES = 200;
// The tail: grows until it holds this many records, capped.
const TAIL_MIN_LINES = 400;
const TAIL_MAX_BYTES = 8 * 1024 * 1024;

function oneLine(text, max = 300) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function humanSize(value) {
  let number = Number(value) || 0;
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (number < 1024 || unit === 'GB') return unit === 'B' ? `${number.toFixed(0)} ${unit}` : `${number.toFixed(1)} ${unit}`;
    number /= 1024;
  }
  return '';
}

function formatMs(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : null;
}

// A codex rollout's conversation lines all carry one of these markers; the
// filter only skips JSON.parse on lines that cannot contribute (token counts,
// tool outputs), the parser still decides what each kept line means.
const CODEX_KEEP = ['"item_completed"', '"user_message"', '"agent_message"', '"session_meta"', '"turn_context"', '"task_complete"'];

function createFolder(provider) {
  const parser = new TranscriptParser(provider);
  let startedMs = 0;
  const apply = (line) => {
    if (!line || !line.trim()) return;
    if (provider === 'codex' && !CODEX_KEEP.some((marker) => line.includes(marker))) return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    if (!startedMs && obj.type === 'session_meta') startedMs = Date.parse(obj.payload?.timestamp || obj.timestamp) || 0;
    try { parser.applyLine(obj); } catch { /* one odd record does not void the preview */ }
  };
  return {
    apply,
    users: () => parser.blocks.filter((block) => block.kind === 'user' && block.text),
    replies: () => parser.blocks.filter((block) => block.kind === 'assistant' && block.text),
    startedMs: () => startedMs,
  };
}

async function readHead(file, provider) {
  const folder = createFolder(provider);
  const stream = fs.createReadStream(file, { encoding: 'utf8', end: HEAD_BYTES - 1 });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  try {
    for await (const line of lines) {
      folder.apply(line);
      if (++count >= HEAD_LINES || folder.users().length) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return folder;
}

async function buildProviderPreview({ id, meta, row = null }) {
  if (!meta?.path) throw new Error(`no transcript path for ${id}`);
  const provider = meta.provider || row?.provider || 'codex';
  const stat = await fs.promises.stat(meta.path);
  const whole = stat.size <= WHOLE_MAX_BYTES;
  const tail = createFolder(provider);
  const tailLines = await readTailLines(meta.path, whole
    ? { startBytes: WHOLE_MAX_BYTES, maxBytes: WHOLE_MAX_BYTES, minLines: Infinity }
    : { minLines: TAIL_MIN_LINES, maxBytes: TAIL_MAX_BYTES });
  for (const line of tailLines) tail.apply(line);
  const head = whole ? tail : await readHead(meta.path, provider);
  const first = head.users()[0] || null;
  const tailUsers = tail.users();
  const replies = tail.replies();
  let startedMs = row?.lineage?.startedMs || head.startedMs() || 0;
  if (!startedMs) startedMs = Date.parse(first?.ts || '') || 0;
  const cwd = meta.cwd || row?.cwd || null;
  const title = row?.title || oneLine(first?.text, 80) || `(${provider} session)`;
  const project = row?.project || (cwd ? projectLabelForCwd(cwd) : null) || '(unknown)';
  const out = [title, '─'.repeat(40), `provider     ${provider}`,
    `project      ${project}`, `directory    ${cwd || '(unknown)'}`];
  if (formatMs(startedMs)) out.push(`started      ${formatMs(startedMs)}`);
  out.push(`last active  ${formatMs(stat.mtimeMs)}`, `size         ${humanSize(stat.size)}`, `session id   ${id}`);
  if (first) out.push('', 'first prompt:', `  ${oneLine(first.text, 400)}`);
  // A small file was read once, so its first prompt is tailUsers[0]; a split
  // read can overlap the head when the file is under head + tail.
  const recent = (whole ? tailUsers.slice(1) : tailUsers.filter((block) => block.text !== first?.text)).slice(-RECENT_PROMPTS);
  if (recent.length) out.push('', 'recent prompts:', ...recent.map((block) => `  • ${oneLine(block.text)}`));
  const last = replies.at(-1);
  if (last) {
    const text = String(last.text).trim();
    out.push('', 'last reply:', ...(text.length > REPLY_MAX ? `${text.slice(0, REPLY_MAX - 1)}…` : text).split('\n').map((line) => `  ${line}`));
  }
  if (!first && !tailUsers.length && !replies.length) out.push('', '(no conversation recorded yet)');
  return `${out.join('\n')}\n`;
}

module.exports = { buildProviderPreview, WHOLE_MAX_BYTES, TAIL_MAX_BYTES, HEAD_BYTES };
