'use strict';

const os = require('node:os');
const { Terminal } = require('@xterm/headless');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

// ConPTY's own cursor arithmetic is the contract this model has to keep, and
// the width table is half of it (live-caught 2026-09-03 off Pat's Data-Mapper
// pane, reproduced against the real CLI in an isolated daemon). ConPTY writes a
// full-width row and TRUSTS the terminal to wrap; it counts `❌` and `✅` as two
// cells, xterm-headless's default Unicode 6 table counts them as one, so the
// modeled row ends a cell short, never wraps, and the next row's first
// character lands on THIS row's last column. Every such row shifts everything
// under it one more column left until ConPTY next positions the cursor
// absolutely, which is what turned `  1. Reassemble…` into `1` at the end of
// one row and `. Reassemble…` at the start of the next and made the question
// card lose its first three options. Unicode 11 widths are what VS Code pairs
// with ConPTY for the same reason.
function windowsPtyCompat() {
  if (process.platform !== 'win32') return undefined;
  const build = Number(String(os.release()).split('.')[2]);
  return { backend: 'conpty', ...(Number.isFinite(build) ? { buildNumber: build } : {}) };
}

// CLAUDE'S PROMPT SUGGESTION (2026-10-05). After a turn, Claude Code can draw a
// predicted next prompt in its composer as DIM text that Tab accepts. It never
// reaches the transcript and an ANSI-stripped scrape cannot tell it from a typed
// draft, so it is read here, where the cells still carry their attributes. The
// composer is the box under a full-width divider whose first row starts "❯ ";
// the suggestion is that box's text when EVERY visible cell after the glyph is
// dim (one typed character means it is a draft, not a suggestion). A fresh
// session's empty composer draws a dim `Try "…"` hint the same way, which is a
// placeholder, not a prediction, so it is dropped. Measured against CLI 2.1.289.
const DIVIDER_RE = /^\s*─{8,}\s*$/;
// The glyph is followed by a NO-BREAK SPACE (U+00A0) in the real CLI; JS \s covers both.
const COMPOSER_RE = /^(\s*)❯\s/;
const PLACEHOLDER_RE = /^Try ".*"$/;

function composerSuggestion(terminal) {
  const buffer = terminal.buffer.active;
  const top = buffer.viewportY;
  const rows = [];
  for (let y = 0; y < terminal.rows; y += 1) rows.push(buffer.getLine(top + y));
  const text = (line) => line?.translateToString(true) || '';
  const cell = buffer.getNullCell();
  for (let y = rows.length - 1; y > 0; y -= 1) {
    const match = COMPOSER_RE.exec(text(rows[y]));
    if (!match || !DIVIDER_RE.test(text(rows[y - 1]))) continue;
    const parts = [];
    for (let row = y; row < rows.length && !DIVIDER_RE.test(text(rows[row])); row += 1) {
      const line = rows[row];
      if (!line) break;
      const start = row === y ? match[1].length + 2 : 0;
      let chunk = '';
      for (let x = start; x < terminal.cols; x += 1) {
        line.getCell(x, cell);
        const ch = cell.getChars();
        if (ch && ch.trim() && !cell.isDim()) return null;
        chunk += ch || ' ';
      }
      if (chunk.trim()) parts.push(chunk.trim());
    }
    const suggestion = parts.join(' ').replace(/\s+/g, ' ').trim();
    return suggestion && !PLACEHOLDER_RE.test(suggestion) ? suggestion : null;
  }
  return null;
}

// CLAUDE'S PROGRAM STATUS (OSC 7501, CLI 2.1.295+). The CLI reports what it is
// doing to the terminal, so Harbor does not have to guess it off the screen:
//   ESC ] 7501 ; state=<s>:app=claude-code[:id=..][:kind=..][:progress=N]
//                [:title=<base64>][:msg=<base64>] BEL|ST
// It only does so after the terminal answers its startup probe `7501;?` with
// an OSC 7501 whose data starts with "?" (within ~2 s), which is the keeper's
// job (onProbe). States measured against CLI 2.1.301 in a real pty: `idle` at
// start and after an interrupt or a denied prompt, `working` (msg = the
// current step, e.g. "Printing probe-ok via echo"), `blocked` with
// kind=permission and msg "approve Write: <path>", `done` when a turn ends,
// and `clear` on exit. Unknown states and kinds pass through as written.
//
// THE REPLY IS NOT THE PROBE. The CLI only checks that the answer's data
// STARTS with "?", so the keeper answers `?ok`. Answering with the probe's own
// bytes would let a tty that echoes input (the CLI gone back to a shell with
// echo on, `cat`, a misbehaving program) hand the answer straight back as a
// fresh probe, and the keeper would answer that too: a loop. Only the exact
// probe `?` is answered, and at most once per PROBE_ANSWER_INTERVAL_MS, so
// even an echo that rewrites the data cannot spin. The CLI probes once at
// start.
const PROGRAM_STATUS_OSC = 7501;
const PROGRAM_STATUS_PROBE = '?';
const PROGRAM_STATUS_REPLY = '\x1b]7501;?ok\x1b\\';
const PROBE_ANSWER_INTERVAL_MS = 500;
// The fields that make a status a different status. The keeper persists and
// the daemon reports exactly these (plus the seq they earn); `title` and
// `progress` ride along in memory for the `screen` verb only, so a change in
// them alone must not rewrite the state file or burn a seq.
const statusIdentity = (status) => (status ? [status.state, status.kind ?? null, status.msg ?? null] : null);

function decodeStatusText(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const text = Buffer.from(value, 'base64').toString('utf8').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return text ? text.slice(0, 512) : null;
  } catch { return null; }
}

// One status report -> { state, kind, title, msg, progress }, null for
// `clear`, or undefined for a report that does not speak for the session.
// A per-id report (`id=...`) describes a sub-task, not the session, and is
// ignored: only the CLI's main status (no id) speaks for the session.
function parseProgramStatus(data) {
  const fields = {};
  for (const part of String(data).split(':')) {
    const at = part.indexOf('=');
    if (at > 0) fields[part.slice(0, at)] = part.slice(at + 1);
  }
  if (!fields.state || fields.id) return undefined;
  if (fields.state === 'clear') return null;
  const progress = Number.parseInt(fields.progress, 10);
  return {
    state: fields.state,
    kind: fields.kind || null,
    title: decodeStatusText(fields.title),
    msg: decodeStatusText(fields.msg),
    progress: Number.isFinite(progress) ? progress : null,
  };
}

class ScreenModel {
  constructor({ cols, rows, scrollback = 10000 }) {
    this.terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true, windowsPty: windowsPtyCompat() });
    this.terminal.loadAddon(new Unicode11Addon());
    this.terminal.unicode.activeVersion = '11';
    this.pending = Promise.resolve();
    this.programStatus = null;
    // A sequence number stamped on every status CHANGE (a repeat of the same
    // report keeps it). The CLI's `msg` is ELIDED ("approve Write:
    // …/work/probe.txt"), so two prompts with the same path tail read as one
    // prompt by text alone; the seq tells them apart. Monotonic for the
    // keeper's life, which is the pane's life.
    this.statusSeq = 0;
    this.onProbe = null;
    this.onStatus = null;
    this.now = Date.now;
    this.lastProbeAnsweredAt = -Infinity;
    // xterm's parser owns the framing: a report split across pty chunks, or
    // ended by BEL or ST, reaches this handler whole, and never lands on the
    // modeled screen.
    this.terminal.parser.registerOscHandler(PROGRAM_STATUS_OSC, (data) => {
      if (data.startsWith('?')) {
        // Our own `?ok` echoed back, or anything else that is not the bare
        // probe, is never answered.
        if (data !== PROGRAM_STATUS_PROBE) return true;
        const at = this.now();
        if (at - this.lastProbeAnsweredAt < PROBE_ANSWER_INTERVAL_MS) return true;
        this.lastProbeAnsweredAt = at;
        this.onProbe?.();
        return true;
      }
      const status = parseProgramStatus(data);
      if (status === undefined) return true;
      if (JSON.stringify(statusIdentity(status)) === JSON.stringify(statusIdentity(this.programStatus))) {
        // Same status; only title/progress may have moved. Keep them current
        // for a `screen` read, without a seq or a persist.
        if (status && this.programStatus) this.programStatus = { ...status, seq: this.programStatus.seq };
        return true;
      }
      this.statusSeq += 1;
      this.programStatus = status ? { ...status, seq: this.statusSeq } : null;
      this.onStatus?.(this.programStatus);
      return true;
    });
  }

  write(data) {
    this.pending = this.pending.then(() => new Promise((resolve) => this.terminal.write(data, resolve)));
    return this.pending;
  }

  resize(cols, rows) {
    this.terminal.resize(cols, rows);
  }

  async read(scrollback = 0) {
    await this.pending;
    const buffer = this.terminal.buffer.active;
    const visibleStart = buffer.viewportY;
    const first = Math.max(0, visibleStart - Math.max(0, scrollback));
    const last = Math.min(buffer.length, visibleStart + this.terminal.rows);
    const lines = [];
    const visible = [];
    for (let index = first; index < last; index += 1) {
      const line = buffer.getLine(index)?.translateToString(true) || '';
      lines.push(line);
      if (index >= visibleStart) visible.push(line);
    }
    return {
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      text: lines.join('\n'),
      visible: visible.join('\n'),
      scrollback_lines: visibleStart,
      suggestion: safeSuggestion(this.terminal),
      status: this.programStatus,
    };
  }
}

// Every pane read in Harbor (dialog detection, menus, sends, the raw terminal)
// comes through read() above. The suggestion is a convenience, so a fault in
// reading it is "no suggestion", never a failed read.
function safeSuggestion(terminal) {
  try { return composerSuggestion(terminal); } catch { return null; }
}

module.exports = { ScreenModel, windowsPtyCompat, composerSuggestion, parseProgramStatus, PROGRAM_STATUS_REPLY, PROBE_ANSWER_INTERVAL_MS };
