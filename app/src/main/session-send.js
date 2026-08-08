'use strict';

// The command bar's engine. A tile's session may be (a) live in a herdr pane,
// (b) historical (resumable), or (c) live somewhere Harbor cannot reach (a
// terminal outside herdr). This module resolves which, acquires pty control,
// and delivers the composed text; resuming first when needed and refusing
// honestly when it cannot deliver (a silently dropped prompt is the one
// unforgivable failure mode here).

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseMenu, menuArrowToward, MENU_KEYS } = require('./menu-parse.js');
const { mergeAsk } = require('./ask-question.js');
const { readCodexRolloutCwd: codexRolloutCwd } = require('./providers/provider-session-link.js');

// Claude Code's project-dir munge: every non-alphanumeric cwd character
// becomes '-' ('/home/you/dev/harbor' -> '-home-you-dev-harbor').
function claudeProjectDir(cwd, home = os.homedir()) {
  return path.join(home, '.claude', 'projects', String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-'));
}

function codexDayDir(home, date) {
  return path.join(
    home, '.codex', 'sessions',
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  );
}

function providerTranscriptDirs(provider, cwd, home = os.homedir(), date = new Date()) {
  if (provider === 'codex') {
    // Yesterday too: a session launched before midnight writes its rollout
    // into the NEXT day's directory, and a scan of today alone would then
    // count every one of yesterday's rollouts as brand new.
    const yesterday = new Date(date.getTime() - 24 * 60 * 60_000);
    return [codexDayDir(home, date), codexDayDir(home, yesterday)];
  }
  if (provider === 'cursor') {
    const project = String(cwd || '').replace(/^\/+/, '').replace(/[^a-zA-Z0-9]/g, '-');
    return [path.join(home, '.cursor', 'projects', project, 'agent-transcripts')];
  }
  return [claudeProjectDir(cwd, home)];
}

async function transcriptFiles(provider, cwd) {
  const files = [];
  for (const dir of providerTranscriptDirs(provider, cwd)) {
    if (provider === 'cursor') {
      const ids = await fs.readdir(dir).catch(() => []);
      for (const id of ids) files.push({ id, file: path.join(dir, id, `${id}.jsonl`) });
    } else {
      const names = await fs.readdir(dir).catch(() => []);
      for (const name of names.filter((item) => item.endsWith('.jsonl'))) {
        const id = provider === 'codex'
          ? name.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i)?.[1]
          : name.slice(0, -6);
        if (id) files.push({ id, file: path.join(dir, name) });
      }
    }
  }
  return files;
}

// Provisional session<->pane links. The sidebar model learns pane<->session
// pairs from herdr agent detection, which lags 60-150s on a busy daemon; the
// launch flows KNOW the pairing the moment the fresh pane appears (snapshot
// diff), so they record it here and the renderer merges it immediately.
function createLinkRegistry({ ttlMs = 15 * 60_000 } = {}) {
  const emitter = new EventEmitter();
  const links = new Map(); // sessionId -> { paneId, workspaceId, at }
  const prune = () => {
    const cutoff = Date.now() - ttlMs;
    for (const [id, link] of links) if (link.at < cutoff) links.delete(id);
  };
  return {
    emitter,
    set(sessionId, { paneId, workspaceId }) {
      if (!sessionId || !paneId) return;
      links.set(sessionId, { paneId, workspaceId: workspaceId || null, at: Date.now() });
      emitter.emit('update');
    },
    dropPane(paneId) {
      for (const [id, link] of links) {
        if (link.paneId === paneId) links.delete(id);
      }
      emitter.emit('update');
    },
    get(sessionId) {
      prune();
      return links.get(sessionId) || null;
    },
    all() {
      prune();
      return Object.fromEntries([...links].map(([id, l]) => [id, { paneId: l.paneId, workspaceId: l.workspaceId }]));
    },
  };
}

// A dialog can be as tall as the pane, and panes are grown to 60 rows so
// Claude's dialogs fit in them (terminalBridge.ensureDialogSize). Reading fewer
// lines than the pane is tall would re-create the very clipping the resize
// removed, one layer further out. EVERY parseMenu read uses this: the card and
// the send-refusal must never disagree about whether a menu is on screen.
const MENU_READ_LINES = 90;

// "Claude has stopped repainting", without demanding two BYTE-identical reads.
// The composer footer carries live numbers (cost, context, elapsed) and the
// status line re-renders on its own, so byte equality made settling a matter of
// luck; and any pane resize during the wait changes the wrap width, which broke
// it outright. Compare what the screen SAYS: drop the trailing status lines and
// collapse whitespace.
function settleKey(screen) {
  const lines = String(screen || '').split('\n');
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  // The last two rendered lines are the model/cost status line and the mode
  // hint; both tick on their own while nothing is actually happening.
  return lines.slice(0, Math.max(0, lines.length - 2)).join('\n').replace(/[ \t]+/g, ' ').trim();
}


// Claude draws its COMPOSER inside a box: a full-width divider immediately
// above the "❯" line. That divider, not the pointer, is what tells a composer
// apart from a dialog, and both halves of that were live-caught on 2026-07-28.
//
// The pointer alone is not enough in EITHER direction. Pat's window put a
// "needs your answer" panel over a session that was simply idle with a draft
// typed into it ("❯ push the guard"), because the old test demanded a LONE
// pointer and a composer with text in it did not match. And widening it to
// "any ❯ line" would have broken the other way on the /rewind dialog that was
// on that very pane an hour later, whose selected row is "❯ (current)": no
// number, no chrome, and it genuinely does need an answer.
const DIVIDER_LINE_RE = /^\s*[─━—_]{8,}\s*$/;
const NUMBERED_ROW_RE = /^\s*(?:❯\s*)?\d+\.\s+\S/;
function isComposerLine(lines, i) {
  const line = lines[i] ?? '';
  if (!/^\s*❯(?:\s|$)/.test(line)) return false;
  if (NUMBERED_ROW_RE.test(line)) return false;        // a menu row, not a prompt
  if (/^\s*❯\s*$/.test(line)) return true;             // an empty composer
  return DIVIDER_LINE_RE.test(lines[i - 1] ?? '');     // else require the box edge
}

// Chrome only a dialog draws.
const BLOCKED_CHROME_RE = /(Press Enter to continue|Enter to select|Enter to confirm|Tab to amend|ctrl\+e to explain|(?:Tab\/Arrow|↑\/↓|Arrow keys)[^\n]*navigate|Resuming the full session will consume|Resume from summary)/i;
// A confirmation question, which a dialog draws on its OWN line. Claude's prose
// says "do you want me to ..." mid-sentence constantly ("Ready to dig in, or do
// you want me to dive deeper on anything?"), and matching that inside a
// sentence is half of why Pat got an answer panel over an idle session.
//
// Compaction belongs in the SAME family and was left out of that fix, which
// locked Pat's composer on 2026-08-02: a running compaction draws "Compacting
// conversation history…" as its own status line, but Claude's ※ recap wrote
// "The handoff is written; next is compacting", and the composer footer of a
// nearly-full session reads "Context left until auto-compact: 16%" beside a
// perfectly usable prompt. Matching those two words anywhere on the screen made
// a session that is TALKING about compaction indistinguishable from one that is
// DOING it, and a session near its limit talks about nothing else. Anchored to
// the start of a line, after the spinner/bullet glyphs Claude draws status
// lines with.
const CONFIRM_LINE_RE = /^[\s│┃|>*-]*(?:Do you want|Do you trust)\b/im;
const COMPACTION_LINE_RE = /^[\s│┃|>*·⏺✻✳*⣾⣽⣻⢿⡿⣟⣯⣷-]*(?:Compacting|Auto-compact)/im;
// A SELECTED OPTION ROW IS MENU CHROME NOTHING ELSE DRAWS, so it identifies a
// blocker without needing to recognise that blocker's footer. Live-caught
// 2026-08-06 on the screen every brand-new install sees first: Claude's theme
// picker offers seven numbered options under a pointer, and its footer says
// "Syntax theme: Monokai Extended (ctrl+t to disable)", which matches nothing in
// BLOCKED_CHROME_RE. Worse, it renders a code sample BELOW the options, so the
// ten-line tail classifyBlocked reads did not even contain them. The result was
// the one state that must not exist: no composer, no card, no panel. A new user
// s very first session is a blank window.
//
// Anchored to the line start and requiring the NUMBER, deliberately: an
// unanchored pointer matches Claude's own prose bullets, and a bare number
// matches numbered paragraphs (the security notice numbers its two). Neither
// mistake is available to this shape.
const POINTER_ROW_RE = /^[\s│┃|]*❯\s*\d+[.)]\s+\S/m;

const isBlockedScreen = (text) => BLOCKED_CHROME_RE.test(text)
  || CONFIRM_LINE_RE.test(text)
  || COMPACTION_LINE_RE.test(text)
  || POINTER_ROW_RE.test(text);

function createSessionSend(deps) {
  const {
    snapshot, // async () => normalized { panes: [], workspaces: [] }
    readPane, // async (paneId) => text
    terminalBridge,
    launchActions,
    getSessionMeta,
    links,
    projectLabelForCwd,
    setXClipboardImage,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    captureDir: suppliedCaptureDir,
  } = deps;
  // Same isolation-surface rule as artifact-thumbs and artifacts: the env
  // override outranks anything composed in. As a destructuring DEFAULT this
  // read `deps.captureDir ?? env`, so the moment the composition root passed a
  // captureDir from config the HARBOR_UNRECOGNIZED_DIR escape would go dead and
  // a harness would start writing into the real capture store. Nothing passes
  // it today, which is why this was latent; a unit test that supplies its own
  // directory still gets it, because env is unset there.
  const captureDir = process.env.HARBOR_UNRECOGNIZED_DIR
    || suppliedCaptureDir
    || path.join(os.homedir(), '.cache/harbor/unrecognized-dialogs');
  const emitter = new EventEmitter();
  const inFlight = new Set(); // session ids currently draining one item
  const queues = new Map(); // sessionId -> FIFO send items
  let nextSendId = 1;

  const textPreview = (text, images = []) => {
    const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (normalized) return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
    const count = Array.isArray(images) ? images.filter(Boolean).length : 0;
    return count === 1 ? '[1 image]' : `[${count} images]`;
  };

  const getQueueState = (sessionId) => {
    const items = (queues.get(sessionId) || []).map((item) => ({
      id: item.id,
      status: item.status,
      textPreview: item.textPreview,
    }));
    return { count: items.length, items };
  };

  // Every send leaves a trace on disk. Live-caught 2026-07-28: Pat sent the same
  // message to a session twice and it landed nowhere, not in that session's
  // transcript, not in another's, not even as text in the pane's composer, and
  // there was no way to tell afterwards WHICH decision dropped it. Forensics on
  // a send that leaves no evidence is guesswork, and guessing is what he has
  // been on the receiving end of. Phases and reasons only, never message text
  // (the same rule the freeze log follows), bounded, and it can never break a
  // send: a logging failure is swallowed.
  const sendLogFile = deps.sendLogFile
    ?? path.join(os.homedir(), '.cache/harbor/send-log.jsonl');
  const logSend = (record) => {
    if (process.env.HARBOR_NO_SEND_LOG === '1') return;
    (async () => {
      try {
        await fs.mkdir(path.dirname(sendLogFile), { recursive: true });
        try {
          const stat = await fs.stat(sendLogFile);
          if (stat.size > 1024 * 1024) await fs.rename(sendLogFile, `${sendLogFile}.1`);
        } catch { /* no file yet */ }
        await fs.appendFile(sendLogFile, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
      } catch { /* logging must never break a send */ }
    })();
  };

  const status = (sessionId, phase, detail = null) => {
    logSend({ sessionId, phase, detail });
    emitter.emit('status', { sessionId, phase, detail, queue: getQueueState(sessionId) });
  };

  const paneIdSet = async () => {
    try {
      const snap = await snapshot();
      return new Set((snap.panes || []).map((p) => p.pane_id));
    } catch {
      return null;
    }
  };

  // Snapshot-diff pane discovery (the mechanism the +T proof live-verified):
  // the fresh pane exists in the daemon within seconds of a launch, long
  // before agent detection names it.
  const findFreshPane = async ({ preIds, cwd, timeoutMs }) => {
    timeoutMs = timeoutMs ?? Number(process.env.HARBOR_FRESH_PANE_TIMEOUT_MS || 45_000);
    if (!preIds) return null;
    const label = projectLabelForCwd ? projectLabelForCwd(cwd) : null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(1000);
      try {
        const snap = await snapshot();
        const wsIds = new Set((snap.workspaces || [])
          .filter((w) => !label || w.label === label)
          .map((w) => w.workspace_id));
        const fresh = (snap.panes || []).find(
          (p) => !preIds.has(p.pane_id) && wsIds.has(p.workspace_id),
        );
        if (fresh) return { paneId: fresh.pane_id, workspaceId: fresh.workspace_id };
      } catch { /* daemon hiccup; keep polling */ }
    }
    return null;
  };

  // A brand-new session's id is unknowable until Claude writes its transcript
  //; which happens on the FIRST MESSAGE, not at boot (live-caught). Poll
  // fast at first (the common case: Pat types right away), then back off.
  const findFreshTranscript = async ({ cwd, provider = 'claude', sinceMs, knownIds = new Set(), timeoutMs = 45_000 }) => {
    const start = Date.now();
    const deadline = start + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const candidates = await transcriptFiles(provider, cwd);
        for (const { id, file } of candidates) {
          if (knownIds.has(id)) continue;
          try {
            const stat = await fs.stat(file);
            if (stat.mtimeMs < sinceMs - 2000) continue;
            // Codex keeps every rollout in one dated tree, so the folder says
            // nothing about which session it is. A codex-worker fleet writing
            // in the same project would otherwise hand this pane a delegate's
            // id; the rollout's own session_meta.cwd is the honest test.
            if (provider === 'codex' && cwd && await codexRolloutCwd(file) !== cwd) continue;
            return id;
          } catch { /* raced a delete */ }
        }
      } catch { /* project dir not created yet */ }
      await sleep(Date.now() - start < 45_000 ? 700 : 3000);
    }
    return null;
  };

  const listTranscriptIds = async (cwd, provider = 'claude') => {
    try {
      return new Set((await transcriptFiles(provider, cwd)).map(({ id }) => id));
    } catch {
      return new Set();
    }
  };

  // Claude is "ready" when the pane has settled on a frame that shows the
  // composer chrome. Two consecutive identical reads containing the composer
  // prompt beat any fixed sleep; the cap keeps a wedged boot from hanging us.
  // Current Claude Code draws a flat-rule composer with a "❯" prompt (read
  // from a REAL pane 2026-07-18); older builds boxed it with ╭╰ and ">".
  const waitForClaudeReady = async (paneId, { timeoutMs = 30_000 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let prev = null;
    while (Date.now() < deadline) {
      await sleep(800);
      let text = null;
      try { text = await readPane(paneId); } catch { continue; }
      if (!text) continue;
      if (isBlockedScreen(text)) {
        prev = text;
        continue;
      }
      const hasComposer = /[❯╭╰]/.test(text) || /^\s*>\s*$/m.test(text);
      if (hasComposer && prev === text) return true;
      prev = text;
    }
    return false;
  };

  // Codex/cursor readiness after a resume: their TUIs draw different composer
  // chrome than claude, so readiness is SETTLEMENT, not glyphs: two identical
  // consecutive non-empty reads whose tail is not a bare shell prompt (a
  // failed resume drops back to the shell, and typing there would execute).
  // deliver() re-runs the dead-shell guard right before the bytes go anyway.
  // Panes this process has already typed into successfully. A pane Harbor just
  // LAUNCHED is still booting its TUI, and the first bytes sent into it are
  // swallowed; a pane that has taken a message before is by definition past
  // that. See deliver().
  const deliveredPanes = new Set();

  const waitForProviderReady = async (paneId, { timeoutMs = 45_000 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let prev = null;
    while (Date.now() < deadline) {
      await sleep(800);
      let text = null;
      try { text = await readPane(paneId); } catch { continue; }
      if (!text || !text.trim()) { prev = text; continue; }
      if (SHELL_PROMPT_TAIL_RE.test(lastNonBlankLine(text))) { prev = text; continue; }
      if (prev === text) return true;
      prev = text;
    }
    return false;
  };

  // A blocking prompt (permission/trust dialog, compaction) OR an interactive
  // numbered SELECT MENU replaces the composer; typing into it eats the message
  // and a blind Enter picks whatever the menu/dialog offers (live-caught: Pat's
  // message became /compact at the auto-compact boundary; and messages sent to a
  // session parked on a "1. …/2. …" choice menu silently vanished and reported
  // "could not confirm the message reached the session"). Claude draws those
  // menus with an "Enter to select … to navigate" footer the composer never
  // shows. That MUST be tested BEFORE the bare composer glyph, because a
  // highlighted menu row also carries a "❯" and would otherwise read as safe.
  // Order: refuse on a dialog/menu; else a visible composer proceeds; else a
  // plain shell (no Claude chrome) passes through.
  const COMPOSER_RE = /[❯╭]/;

  // A crashed CLI leaves its pane at a bare shell prompt, where typed text is
  // EXECUTED by the shell (live-caught 2026-07-22: a Bun segfault dropped
  // claude back to bash, and the next send ran as a bash command). The
  // signature is tail-anchored: no agent UI ever leaves the last non-blank
  // line ending in a naked $, % or #, while a prompt with a command typed
  // after it does not match.
  const SHELL_PROMPT_TAIL_RE = /[$%#]\s*$/;
  const lastNonBlankLine = (text) => {
    const lines = String(text || '').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].trim()) return lines[i];
    }
    return '';
  };
  // Provider-agnostic (codex and cursor crash back to bash the same way): a
  // shell-prompt tail with no working-turn footer means the CLI is gone.
  const assertNotDeadShell = async (paneId, knownScreen = null) => {
    let screen = knownScreen;
    if (screen == null) {
      try { screen = await readPane(paneId); } catch { return; /* unreadable: no evidence to refuse on */ }
    }
    if (!screen) return;
    const bottom = screen.split('\n').slice(-10).join('\n');
    if (/esc to interrupt/i.test(bottom)) return; // a working turn, never a dead shell
    if (SHELL_PROMPT_TAIL_RE.test(lastNonBlankLine(bottom))) {
      const error = new Error('the CLI exited in this pane and left a shell prompt; the send was refused so your text would not run in the shell. Your text is kept');
      error.code = 'DEAD_SHELL';
      throw error;
    }
  };

  const assertComposerSafe = async (paneId) => {
    // The refusal is the SAME decision as the card (classifyBlocked), not a
    // second one that happens to agree most of the time. It used to be its own
    // code on its own read: 16 lines instead of 90, sliced without trimming the
    // trailing blank line, and with no resolution-tail test at all. On
    // 2026-08-02 that cost Pat his composer for good: the blocker text matched
    // one line above the fold in the send's window and one line outside the
    // card's, so the send refused and told him to "use the answer panel in its
    // window" while the window, correctly, drew no panel. A refusal the card
    // does not panel is precisely the dead end the panel exists to prevent
    // (Pat mandate 2026-07-21), and the only way to keep the two honest is for
    // there to be one of them.
    //
    // ONE read answers every question below. Reading twice is not just slower:
    // a pane repaints between reads, so the guard would be judging one frame
    // and the composer test another.
    const screen = await readScreen(paneId, MENU_READ_LINES);
    if (!screen) return; // unreadable: no evidence to refuse on
    if (classifyBlocked(screen)) {
      // When the blocker parses as an answerable question, the window shows
      // the labeled card; otherwise the window shows the fallback answer
      // panel (raw screen + direct keys). Either way the answer lives in the
      // window: a blocked pane is never a dead end (Pat mandate 2026-07-21).
      let menu = null;
      try { menu = await readMenu(paneId); } catch { /* refuse with the generic guidance */ }
      if (menu) {
        throw new Error('the session is asking a question in its window; answer it there first. Your text is kept');
      }
      throw new Error('the session is showing a prompt Harbor cannot fully read; use the answer panel in its window. Your text is kept');
    }
    const bottom = screen.split('\n').slice(-10).join('\n');
    if (COMPOSER_RE.test(bottom)) return;
    // A bare shell prompt at the tail means the CLI exited and anything typed
    // would RUN IN THE SHELL; refuse, never pass through. runSend catches the
    // DEAD_SHELL code and falls through to resume-then-send for resumable
    // sessions. (Other unrecognized screens still pass: an unreadable or
    // exotic frame is not evidence of a shell.)
    await assertNotDeadShell(paneId, screen);
  };

  // A leading-slash send is a slash COMMAND, not a message, and the current
  // CLI (2.1.214, live-verified) does NOT append a confirmable transcript event
  // for a bare /model or /effort: the switch only manifests on the NEXT
  // assistant message (its model id / effort stamp). So a slash command cannot
  // be hard-confirmed against the transcript, and hard-confirming one is the
  // exact bug that made a LANDED /model read as "send failed" (live-caught).
  // Slash commands are therefore confirmed BEST-EFFORT and treated as
  // "requested": if a build ever does write the command-name form we catch it,
  // but an absent confirmation is success, not failure. The real protection
  // against a silently-eaten slash command is assertComposerSafe (run before
  // any byte is sent); the real proof it took effect is the header model chip
  // flipping / the next effort stamp, both observed by the renderer.
  const isSlashCommand = (text) => String(text ?? '').trimStart().startsWith('/');
  const confirmNeedle = (text) => {
    const trimmed = String(text ?? '').trimStart();
    if (trimmed.startsWith('/')) {
      const base = trimmed.split(/\s+/, 1)[0]; // '/model'
      return `<command-name>${base}</command-name>`;
    }
    return JSON.stringify(text).slice(1, -1).slice(0, 60);
  };

  // Busy Claude sessions persist accepted input as a queue event rather than
  // a normal user turn. Match it the same way the transcript renderer pairs
  // enqueue/queued_command records: whitespace-normalized human text.
  const confirmsQueuedDelivery = (chunk, text) => {
    const expected = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!expected) return false;
    for (const line of String(chunk || '').split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'queue-operation'
          && obj.operation === 'enqueue'
          && String(obj.content ?? '').replace(/\s+/g, ' ').trim() === expected) return true;
      } catch { /* an incomplete/non-JSON line cannot confirm delivery */ }
    }
    return false;
  };

  // "Bytes written" is not "message received": confirm the sent text actually
  // landed in the session's transcript after the optimistic sent state. For a
  // real message an unconfirmed send becomes an honest background ERROR; for a
  // slash command (optional) an absent transcript event remains best-effort.
  // Returns true when confirmed, false when optional-and-unconfirmed.
  const prepareDeliveryConfirmation = async (sessionId) => {
    if (process.env.HARBOR_SKIP_DELIVERY_CONFIRM === '1') return { skip: true };
    if (String(sessionId).startsWith('pane:')) return { skip: true };
    const meta = await getSessionMeta(sessionId).catch(() => null);
    if (!meta?.path) return { skip: true };
    let preSize = 0;
    try { preSize = (await fs.stat(meta.path)).size; } catch { preSize = 0; }
    return { path: meta.path, preSize };
  };

  const confirmDelivery = async (
    sessionId,
    text,
    { timeoutMs, optional = false, prepared = null } = {},
  ) => {
    if (prepared?.skip) return true;
    if (process.env.HARBOR_SKIP_DELIVERY_CONFIRM === '1') return true;
    if (String(sessionId).startsWith('pane:')) return true; // no transcript yet by definition
    let transcriptPath = prepared?.path || null;
    if (!transcriptPath) {
      const meta = await getSessionMeta(sessionId).catch(() => null);
      transcriptPath = meta?.path || null;
    }
    if (!transcriptPath) return true; // nothing to confirm against
    const envTimeout = process.env.HARBOR_CONFIRM_TIMEOUT_MS
      ? Number(process.env.HARBOR_CONFIRM_TIMEOUT_MS) : null;
    const budget = timeoutMs ?? envTimeout ?? (optional ? 3000 : 9000);
    const needle = confirmNeedle(text);
    let preSize = prepared?.preSize;
    if (preSize == null) {
      try { preSize = (await fs.stat(transcriptPath)).size; } catch { preSize = 0; }
    }
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      await sleep(500);
      try {
        const stat = await fs.stat(transcriptPath);
        if (stat.size > preSize) {
          const handle = await fs.open(transcriptPath, 'r');
          const length = stat.size - preSize;
          const buffer = Buffer.alloc(Math.min(length, 1024 * 1024));
          await handle.read(buffer, 0, buffer.length, preSize);
          await handle.close();
          const chunk = buffer.toString('utf8');
          if (chunk.includes(needle) || confirmsQueuedDelivery(chunk, text)) return true;
        }
      } catch { /* keep polling */ }
    }
    if (optional) return false; // slash command: delivered into a safe composer, requested
    throw new Error('could not confirm the message reached the session. Check the window before resending');
  };

  // Control is acquired on tile focus and released on blur, and both travel
  // async through the bridge; a send must OWN its precondition instead of
  // assuming ambient focus state (a menu click can blur the tile between the
  // check and the write, which surfaced as a flaky 'pane is not focused for
  // control' refusal). Acquire, wait for it to land, retry once on refusal.
  const controlSettled = (paneId) => terminalBridge.getState().controlledPaneId === paneId
    && (terminalBridge.controlReady ? terminalBridge.controlReady(paneId) : true);

  const acquireControl = async (paneId, workspaceId) => {
    if (controlSettled(paneId)) return;
    if (terminalBridge.getState().controlledPaneId !== paneId) {
      await terminalBridge.requestFocusPane({ paneId, workspaceId }).catch(() => {});
    }
    // Wait for the attach to COMPLETE (first frame from the control child),
    // not just for the optimistic acquire: input written pre-grant is dropped
    // silently by the daemon.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (controlSettled(paneId)) return;
      await sleep(50);
    }
  };

  const typeInto = async (paneId, workspaceId, payload) => {
    let result = terminalBridge.sendInput(paneId, payload);
    if (result?.ok === false) {
      await acquireControl(paneId, workspaceId);
      result = terminalBridge.sendInput(paneId, payload);
    }
    if (result?.ok === false) throw new Error(result.reason || 'input refused');
  };

  // Claude numbers pasted images cumulatively per session (#1, #2, #3…), and a
  // SENT image turn leaves TWO markers in the recent viewport (the prompt-echo
  // line and the "⎿ [Image #N]" attachment line). A raw COUNT delta is
  // therefore fragile: pasting the next image grows the composer and scrolls
  // those old markers off the top of readPane's 16-line window, so the count
  // can DROP even though the new image attached, live-caught as a real paste
  // falsely reported "never confirmed the image attachment." Track the highest
  // number instead: the freshly pasted image is always the highest #N in the
  // session, so a strictly-greater max is the robust "a new image landed"
  // signal, immune to older markers scrolling out of view.
  const maxImageMarker = (screen) => (String(screen || '').match(/\[Image #(\d+)\]/g) || [])
    .reduce((max, marker) => Math.max(max, Number(marker.match(/\d+/)[0])), 0);

  const waitForImageMarker = async (paneId, beforeMax, { timeoutMs = 12000 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(100);
      let screen = '';
      try { screen = await readPane(paneId); } catch { continue; }
      if (maxImageMarker(screen) > beforeMax) return;
    }
    throw new Error(`Claude never confirmed the image attachment; image and text were NOT sent (no marker beyond #${beforeMax} within ${timeoutMs}ms)`);
  };

  // Cached Claude conversations may ask for a second confirmation after a
  // /model or /effort command has already been submitted. This is deliberately
  // separate from assertComposerSafe: that guard protects text before send;
  // this narrowly-scoped handler resolves only Claude's known switch prompt.
  const SWITCH_COMMAND_RE = /^\/(model|effort)(?:\s|$)/i;
  const SWITCH_CONFIRM_RE = /Switching to[^\n]*means the full history gets re-read on your next message\.[\s\S]{0,240}?1\.\s*Yes[\s\S]{0,120}?2\.\s*No/i;

  const resolveClaudeSwitchConfirm = async (paneId, workspaceId, text, provider) => {
    if (provider !== 'claude' || !SWITCH_COMMAND_RE.test(String(text || '').trim())) return false;

    let dialogSeen = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (attempt > 0) await sleep(500);
      let screen = '';
      try { screen = await readPane(paneId); } catch { continue; }
      if (!SWITCH_CONFIRM_RE.test(screen)) continue;
      dialogSeen = true;
      await typeInto(paneId, workspaceId, '1');
      await typeInto(paneId, workspaceId, '\r');
      break;
    }
    if (!dialogSeen) return false;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (attempt > 0) await sleep(250);
      try {
        const screen = await readPane(paneId);
        if (!SWITCH_CONFIRM_RE.test(screen)) return true;
      } catch { /* keep verifying until the bounded retry is exhausted */ }
    }
    throw new Error('could not confirm the Claude model/effort switch; answer the open dialog via the >_ terminal');
  };

  // No default. A silent `= 'claude'` here is what let a codex pane be driven
  // down the claude path: wrong readiness test, wrong composer guard, and a
  // Claude chip on a gpt-5.6-sol session. Callers resolve it explicitly.
  const deliver = async (paneId, workspaceId, text, images = [], provider = 'claude') => {
    // Lease the pane's control for the whole keystroke sequence: a renderer
    // blur mid-send defers until the lease drops instead of yanking control.
    terminalBridge.holdControl?.(paneId);
    try {
      const t0 = Date.now();
      await acquireControl(paneId, workspaceId);
      debug('deliver: control after', Date.now() - t0, 'ms; controlled =', terminalBridge.getState().controlledPaneId);
      if (provider === 'claude') await assertComposerSafe(paneId);
      else await assertNotDeadShell(paneId);

      // A FRESH non-claude pane is still starting its TUI, and codex swallows
      // whatever arrives before it is listening. Live-caught 2026-08-08: a new
      // codex session took `/home/…/Census Tool - overview … - 2026-08-05.pdf,
      // 2 pages, current` and the rollout recorded it as
      // `026-08-05.pdf, 2 pages, curren…`. The leading characters were eaten and
      // codex answered the mangled remainder, so it read as a dropped message
      // while the send log honestly said `sent`: the bytes DID leave.
      //
      // waitForProviderReady existed already and was wired only to the RESUME
      // path, which is why resuming a codex session was safe and starting one
      // was not. assertNotDeadShell above is a refusal check, not a wait: it
      // returns immediately unless the pane is sitting at a shell prompt.
      //
      // Bounded, first-delivery-only, and NON-FATAL on purpose. Settling needs
      // two identical reads, which a pane mid-turn never produces, so making
      // this a hard gate would refuse sends into a busy codex. Not settling
      // leaves exactly the old behaviour.
      // EVERY provider, not just the non-claude ones. The first version of this
      // gate keyed on `provider !== 'claude'`, which made it useless in exactly
      // the case it was written for: `provider` arrives with a silent default of
      // 'claude' (see resolveProvider), so a codex pane whose provider had not
      // resolved yet was treated as claude and skipped the wait. A guard that a
      // wrong default can switch off is not a guard.
      //
      // It is also correct on its own terms: assertComposerSafe is a single READ,
      // a refusal check rather than a wait, so a freshly launched claude pane has
      // the same exposure. Claude's TUI merely comes up faster, which is why
      // codex is where it became visible.
      // Scoped to non-claude, and the reason matters. The gate cannot be allowed
      // to depend on `provider` being right, because a silent default is exactly
      // what broke this: see resolveProvider below, which is why an unresolved
      // provider is no longer able to masquerade as claude.
      //
      // Claude has the same shape of exposure (assertComposerSafe is a single
      // READ, a refusal check rather than a wait) and is NOT covered here. Its
      // TUI comes up faster so it has not been caught in the wild, and adding a
      // settle to that path changes what four existing specs' staged screens
      // feed the guard. Tracked in docs/BACKLOG.md rather than half-done.
      if (provider !== 'claude' && !deliveredPanes.has(paneId)) {
        const settled = await waitForProviderReady(paneId, { timeoutMs: 15_000 });
        if (!settled) debug('deliver: fresh', provider, 'pane never settled; sending anyway');
      }
      debug('deliver: composer safe after', Date.now() - t0, 'ms');
      // Images have TWO delivery routes, and which one is available depends on
      // whether there is a clipboard to put them on.
      //
      // The desktop pastes: setXClipboardImage + Ctrl+V, which attaches the
      // image INLINE, and inline is the better result (it is what the transcript
      // records, and it is why f71f39b moved off pasting a path in the first
      // place).
      //
      // harbor-server has no clipboard. It is headless by definition, so there
      // is no X selection to own, and it never passed setXClipboardImage at all.
      // Sending an image from the PHONE therefore died on
      // "setXClipboardImage is not a function" for as long as the phone client
      // has existed: the upload succeeded, the file landed on disk, and the send
      // threw. Nothing in the mobile gate caught it, because that gate stubs the
      // pty boundary and so never reaches this line.
      //
      // With no clipboard, the honest delivery is the path: Claude reads the
      // file, which is the same route `+ add files` already uses for every
      // non-image attachment. It is a Read rather than an inline attachment, so
      // it is deliberately NOT the desktop's behaviour, only the one that works
      // where a clipboard cannot exist.
      const canPaste = typeof setXClipboardImage === 'function';
      const pathOnlyImages = [];
      for (const imagePath of images) {
        if (!canPaste) { pathOnlyImages.push(imagePath); continue; }
        let beforeMax = 0;
        try { beforeMax = maxImageMarker(await readPane(paneId)); } catch { /* polling still verifies an increase */ }
        await setXClipboardImage(imagePath);
        await typeInto(paneId, workspaceId, '\x16');
        await waitForImageMarker(paneId, beforeMax);
      }
      if (pathOnlyImages.length) {
        const prefix = pathOnlyImages.length === 1 ? 'Image:' : 'Images:';
        const line = `${prefix} ${pathOnlyImages.join(' ')}`;
        text = text ? `${line}\n${text}` : line;
      }
      // Slash command tokens must be typed raw so the CLI parses them. The
      // trailing space closes its popup; any remainder keeps the normal
      // single-line/raw or multi-line/bracketed-paste behavior.
      if (text) {
        if (isSlashCommand(text)) {
          const trimmed = String(text).trim();
          const token = trimmed.split(/\s+/, 1)[0];
          const remainder = trimmed.slice(token.length).trimStart();
          await typeInto(paneId, workspaceId, `${token} `);
          if (remainder) {
            const payload = remainder.includes('\n')
              ? `\x1b[200~${remainder}\x1b[201~`
              : remainder;
            await typeInto(paneId, workspaceId, payload);
          }
        } else {
          const payload = text.includes('\n')
            ? `\x1b[200~${text}\x1b[201~`
            : text;
          await typeInto(paneId, workspaceId, payload);
        }
        debug('deliver: text written');
      }
      await sleep(160);
      await typeInto(paneId, workspaceId, '\r');
      deliveredPanes.add(paneId);
      debug('deliver: enter written');
      await resolveClaudeSwitchConfirm(paneId, workspaceId, text, provider);
    } finally {
      terminalBridge.releaseControlHold?.(paneId);
    }
  };

  // ---- interactive menu handling (command-bar answers, no >_ detour) --------
  // A session parked on a numbered SELECT MENU has no composer to write into, so
  // instead of refusing the send we let the command bar surface the menu and
  // answer it here. readMenu reads a taller scrape (menus are multi-line) and
  // parses it; answerMenu drives the highlight to the target and selects it.

  // Read the recent scrape first, then the visible grid. Both are needed, for
  // reasons that were each learned the hard way:
  //
  //   recent   a one-shot dialog whose top scrolled into scrollback still has
  //            its opening lines here (gate-caught 2026-07-21).
  //   visible  a pty RESIZE empties herdr's recent buffer, and a full-screen
  //            redraw ("\x1b[2J") writes over the screen without pushing a
  //            single line into scrollback, so a dialog that is plainly on the
  //            screen can have no recent bytes at all. Measured 2026-07-27
  //            against a real pane right after Harbor grew it: recent came back
  //            0 bytes while visible held the whole dialog. Reading only recent
  //            would make the card vanish exactly when the pane was fixed.
  const readScreen = async (paneId, lines) => {
    for (const source of ['recent', 'visible']) {
      let screen = '';
      try { screen = await readPane(paneId, lines, source); } catch { return ''; }
      if (screen.trim()) return screen;
    }
    return '';
  };

  const readMenu = async (paneId) => {
    for (const source of ['recent', 'visible']) {
      let screen = '';
      try { screen = await readPane(paneId, MENU_READ_LINES, source); } catch { return null; }
      const menu = parseMenu(screen);
      if (menu) return menu;
    }
    return null;
  };

  // ---- the no-dead-end guard (Pat mandate 2026-07-21) ---------------------
  // Six dialog shapes were each fixed only after Pat hit them live. The
  // structural inversion: a blocked pane whose screen the parser does NOT
  // recognize still yields an answerable in-window panel (the raw screen tail
  // plus direct keys), and the screen self-captures as a fixture so the next
  // labeled-card fix starts from real bytes instead of a live incident.
  // Trigger: known blocker text on screen (instant), or the engine-level
  // blocked signal (shape-independent, covers dialogs that do not exist yet)
  // as long as the screen is not a healthy composer/working turn, because
  // agent_status lags 60-150s and must never ghost keys over a recovered
  // session.
  const FALLBACK_SCREEN_LINES = 14;
  const capturedScreens = new Set();
  const captureUnrecognized = async (paneId, screen) => {
    try {
      const hash = crypto.createHash('sha1').update(screen).digest('hex').slice(0, 12);
      if (capturedScreens.has(hash)) return;
      capturedScreens.add(hash);
      await fs.mkdir(captureDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safePane = String(paneId).replace(/[^\w-]/g, '_');
      await fs.writeFile(path.join(captureDir, `${stamp}-${safePane}-${hash}.txt`), screen);
    } catch { /* the capture must never break the poll */ }
  };
  // "Is this pane blocked right now" has exactly ONE answer, and both the
  // in-window answer card and the send refusal read it from here. Returns the
  // screen when the pane is blocked, null when there is nothing to answer.
  //
  // Read the recent scrape, not the visible grid: linking a pane resizes
  // it, and a one-shot dialog does not redraw, so a LIVE dialog's opening
  // lines can exist only in scrollback (gate-caught 2026-07-21). Live vs
  // dead is decided by the TAIL instead: a resolution tail (shell prompt,
  // lone-pointer composer, working turn) means the dialog above is a
  // ghost, whatever blocker text sits in the scrollback.
  const classifyBlocked = (screen, blockedHint = false) => {
    if (!screen.trim()) return null;
    let lines = screen.split('\n');
    while (lines.length && !lines.at(-1).trim()) lines = lines.slice(0, -1);
    const bottomLines = lines.slice(-10);
    const bottom = bottomLines.join('\n');
    const lastText = [...bottomLines].reverse().find((line) => line.trim()) || '';
    const resolved = bottomLines.some((_line, i) => isComposerLine(bottomLines, i))
      || /esc to interrupt/i.test(bottom)
      || SHELL_PROMPT_TAIL_RE.test(lastText); // a bare shell prompt: claude exited, status lags
    if (resolved) return null;
    // Resolution is decided by the TAIL (a stale answered menu above a live
    // composer must not raise a ghost card), but the BLOCKER itself may sit
    // further up: the theme picker draws its options above a preview block. So
    // the tail answers "is this over?" and the whole screen answers "is there
    // something to answer?". A composer in the tail already short-circuits
    // above, which is what keeps the ghost-card rule intact.
    if (!(isBlockedScreen(bottom) || POINTER_ROW_RE.test(screen) || blockedHint)) return null;
    return { lines };
  };

  // CLAUDE'S FIRST-RUN GATE IS NOT A QUESTION, so Harbor stops making it one
  // (live-caught 2026-08-06). A brand new session on a config home that has not
  // completed onboarding does not open at a composer: it opens on a chain of
  // notices, each ending "Press Enter to continue…", and only after those does
  // it reach the real trust dialog. Nothing advanced them, so the window sat on
  // "No transcript yet", the command bar had nowhere to type, and two sends of
  // /acclimate went into a session that had never started. From the outside that
  // is indistinguishable from Harbor being broken, which is exactly what it was.
  //
  // Advancing is safe for these and ONLY these, so the test is deliberately
  // narrow and every clause is load-bearing:
  //   - the tail asks to continue, and
  //   - it carries one of Claude's own first-run markers, and
  //   - there is NO choice on screen: no numbered option, no pointer, no
  //     yes/no. The trust dialog and the pre-approved-permissions dialog both
  //     have options, so both keep going to the human, which is the point.
  // An informational notice has exactly one outcome; pressing it is not a
  // decision taken on the user's behalf.
  const FIRST_RUN_MARKER_RE = /(Welcome to Claude Code|Security notes:|Login successful)/i;
  const CONTINUE_RE = /Press Enter to continue/i;
  // NUMBERED PROSE IS NOT A CHOICE. The security notice numbers its two
  // paragraphs ("1. Claude can make mistakes."), and keying on a bare numbered
  // line therefore classified an informational screen as a decision and left the
  // dead end in place. A real choice draws a POINTER at its selected row or
  // says in its footer that Enter confirms a selection; the trust dialog does
  // both, plus names its own affirmative, so it stays excluded three ways over.
  const HAS_CHOICE_RE = /(^\s*❯|Enter to confirm|Enter to select|\(y\/n\)|Yes, I trust)/m;

  const isFirstRunNotice = (screen) => {
    if (!screen || !CONTINUE_RE.test(screen)) return false;
    if (!FIRST_RUN_MARKER_RE.test(screen)) return false;
    return !HAS_CHOICE_RE.test(screen);
  };

  const readFallback = async (pane, blockedHint) => {
    const paneId = pane.paneId;
    const screen = await readScreen(paneId, MENU_READ_LINES);
    const blocked = classifyBlocked(screen, blockedHint);
    if (!blocked) return null;
    // Claude's own first-run notices are handled here rather than shown: one
    // Enter per poll, using the screen this function already read, so the poll
    // costs no extra pane read and a notice chain clears itself within a second
    // or two. Returning null means no panel flashes for something Harbor is
    // dealing with; the next poll sees whatever the notice revealed, which for
    // the last one is the trust dialog, and THAT gets a card.
    if (isFirstRunNotice(screen)) {
      await answerMenu(paneId, pane.workspaceId, { type: 'key', key: 'enter' }).catch(() => {});
      return null;
    }
    await captureUnrecognized(paneId, screen);
    let tail = blocked.lines;
    while (tail.length && !tail.at(-1).trim()) tail = tail.slice(0, -1);
    return { fallback: true, screen: tail.slice(-FALLBACK_SCREEN_LINES) };
  };

  // Navigate to targetIndex and press Enter, or cancel with Esc. Selection is a
  // self-correcting loop: re-read the highlight, step one arrow toward the
  // target, repeat. A mis-parsed starting row therefore cannot select the wrong
  // option (we only press Enter once the "❯" is verified on the target).
  // Direct keys for the fallback panel: the human reads the raw screen in the
  // window and drives the dialog exactly as they would in the terminal, so no
  // parse is required and nothing is ever implied (Enter only when pressed).
  // "tab" is also the recognized card's question switcher: a batched
  // AskUserQuestion carries several questions behind one tab strip, and
  // without it the window can only ever answer the question that happens to
  // be showing. It is offered ONLY when the footer says Tab switches
  // questions, never on a permission prompt where Tab means amend.
  const FALLBACK_KEYS = Object.freeze({
    up: MENU_KEYS.up,
    down: MENU_KEYS.down,
    enter: MENU_KEYS.enter,
    esc: MENU_KEYS.cancel,
    space: ' ',
    tab: '\t',
  });

  const answerMenu = async (paneId, workspaceId, action = {}) => {
    terminalBridge.holdControl?.(paneId);
    try {
      await acquireControl(paneId, workspaceId);

      if (action.type === 'key') {
        const bytes = FALLBACK_KEYS[action.key];
        if (!bytes) return { ok: false, reason: `unknown key ${action.key}` };
        await typeInto(paneId, workspaceId, bytes);
        return { ok: true, action: 'key', key: action.key };
      }
      if (action.type === 'raw') {
        const text = String(action.text || '');
        if (!text) return { ok: false, reason: 'nothing to type' };
        const payload = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
        await typeInto(paneId, workspaceId, payload);
        return { ok: true, action: 'raw' };
      }

      const menu = await readMenu(paneId);
      if (!menu) return { ok: false, reason: 'the menu is no longer on screen' };

      if (action.type === 'cancel') {
        await typeInto(paneId, workspaceId, MENU_KEYS.cancel);
        return { ok: true, action: 'cancel' };
      }

      // A multi-select question confirms with Enter once the ticks are right;
      // the card asks for this explicitly, so nothing is ever submitted by a
      // click that only meant "tick this one".
      if (action.type === 'submit') {
        await typeInto(paneId, workspaceId, MENU_KEYS.enter);
        return { ok: true, action: 'submit' };
      }

      const target = Number(action.index);
      const option = menu.options.find((o) => o.index === target);
      // An option the pane has scrolled off the top is still answerable: the
      // card knows it exists because the transcript listed it, and the walk
      // below only presses Enter once the "❯" has been SEEN on that number, so
      // a row we cannot currently read can never be selected by mistake. It
      // used to be refused outright, which is what left Pat arrowing through a
      // card that was showing him the option he wanted (2026-07-27).
      const firstVisible = menu.options[0]?.index ?? 1;
      const clippedAbove = !option && menu.clipped && target >= 1 && target < firstVisible;
      if (!option && !clippedAbove) return { ok: false, reason: `option ${action.index} is not on the menu` };

      // For a free-text option, land on it, open it, then deliver the prose.
      // Only a row we can read can be known to take text; a clipped one is a
      // transcript option, which is never the "Type something" row.
      if (action.type === 'text' && !option?.isText) {
        return { ok: false, reason: `option ${target} does not take typed text` };
      }

      // Drive the highlight onto the target (bounded; menus are short). Walk
      // by the option NUMBER under the "❯", re-read each step: an option's
      // position in the visible run shifts when the list scrolls or its top
      // is clipped by the viewport, so positions computed once would press
      // Enter on the wrong option. Options render in ascending order, so the
      // number ordering is the visual ordering.
      const selectedNumber = (m) => m.options.find((o) => o.selected)?.index ?? null;
      const maxSteps = menu.options.at(-1).index * 2 + 2;
      for (let step = 0; step < maxSteps; step += 1) {
        const current = await readMenu(paneId);
        if (!current) return { ok: false, reason: 'the menu closed before it was answered' };
        const currentNumber = selectedNumber(current);
        if (currentNumber === target) break;
        const arrow = menuArrowToward(currentNumber, target);
        // Pointer not visible (first open, or parked in a clipped top): step
        // toward where the target is known to be. Options end at the footer,
        // so below the visible run there is nothing, and ↓ is the move that
        // reveals a "❯" parked above; but when the TARGET itself sits above
        // the visible run, ↑ is the one going toward it.
        const blindArrow = target < firstVisible ? MENU_KEYS.up : MENU_KEYS.down;
        await typeInto(paneId, workspaceId, arrow ?? blindArrow);
        await sleep(60);
      }
      const landed = await readMenu(paneId);
      if (!landed || selectedNumber(landed) !== target) {
        return { ok: false, reason: 'could not move the menu highlight to that option' };
      }

      // Tick a multi-select row. Space toggles, and the row draws its own state,
      // so the flip is CONFIRMED by re-reading the checkbox rather than assumed.
      // Nothing is submitted here; that is a separate, deliberate action.
      if (action.type === 'toggle') {
        const before = landed.options.find((o) => o.index === target)?.checked;
        await typeInto(paneId, workspaceId, FALLBACK_KEYS.space);
        await sleep(120);
        const after = await readMenu(paneId);
        const now = after?.options.find((o) => o.index === target)?.checked;
        if (after && before != null && now === before) {
          return { ok: false, reason: `option ${target} did not change state` };
        }
        return { ok: true, action: 'toggle', index: target, checked: now ?? null };
      }

      // Attach a note to this answer, using the key the FOOTER advertises rather
      // than an assumed one. Landing on the row first is what makes the note
      // attach to the intended option.
      if (action.type === 'notes') {
        const key = landed.notesKey || menu.notesKey;
        if (!key) return { ok: false, reason: 'this dialog does not offer notes' };
        await typeInto(paneId, workspaceId, key);
        await sleep(180);
        const text = String(action.text || '');
        if (text) {
          const payload = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
          await typeInto(paneId, workspaceId, payload);
          await sleep(120);
          await typeInto(paneId, workspaceId, MENU_KEYS.enter);
        }
        return { ok: true, action: 'notes', index: target };
      }

      await typeInto(paneId, workspaceId, MENU_KEYS.enter);

      // A "Type something" option opens a composer; deliver the prose into it.
      if (action.type === 'text' && action.text) {
        await sleep(200);
        const payload = String(action.text).includes('\n')
          ? `\x1b[200~${action.text}\x1b[201~` : String(action.text);
        await typeInto(paneId, workspaceId, payload);
        await sleep(160);
        await typeInto(paneId, workspaceId, MENU_KEYS.enter);
      }
      return { ok: true, action: 'select', index: target };
    } finally {
      terminalBridge.releaseControlHold?.(paneId);
    }
  };

  const waitForResumedClaudeReady = async (paneId, workspaceId, { timeoutMs = 30_000 } = {}) => {
    // Size the pane BEFORE settling, not during. A resize changes the wrap
    // width and empties herdr's recent buffer, so one landing mid-wait makes
    // every read differ from the last and the settle test can never pass. That
    // is what turned an adopt into "session adopted, but Claude never became
    // ready" on 2026-07-28: the session had been killed and resumed, so the
    // message was already unsendable by the time the wait gave up.
    await terminalBridge?.ensureDialogSize?.(paneId).catch?.(() => {});
    const deadline = Date.now() + timeoutMs;
    let prev = null;
    while (Date.now() < deadline) {
      await sleep(800);
      const screen = await readScreen(paneId, MENU_READ_LINES);
      if (!screen) continue;
      const menu = parseMenu(screen);
      const fullOption = menu?.options.find((option) => option.index === 2);
      if (fullOption?.label === 'Resume full session as-is') {
        const answered = await answerMenu(paneId, workspaceId, { type: 'select', index: 2 });
        if (!answered.ok) throw new Error(`could not answer the Claude resume dialog: ${answered.reason}`);
        prev = null;
        continue;
      }
      if (isBlockedScreen(screen)) {
        prev = screen;
        continue;
      }
      const hasComposer = /[❯╭╰]/.test(screen) || /^\s*>\s*$/m.test(screen);
      const settled = settleKey(screen);
      if (hasComposer && prev === settled) return true;
      prev = settled;
    }
    return false;
  };

  // Permission mode is NOT carried on the statusline stdin in 2.1.214, so the
  // only honest read is scraping the composer footer the CLI draws it in. Best
  // effort: an unreadable pane yields a null mode rather than a guess.
  const PERMISSION_MODE_RES = [
    [/bypass(?:ing)? permissions? on/i, 'bypass'],
    [/plan mode on/i, 'plan'],
    [/accept edits on/i, 'accept-edits'],
  ];
  const readPermissionMode = async (paneId) => {
    let screen = '';
    try { screen = await readPane(paneId); } catch { return { mode: null }; }
    if (!screen) return { mode: null };
    const bottom = screen.split('\n').slice(-8).join('\n');
    for (const [re, mode] of PERMISSION_MODE_RES) if (re.test(bottom)) return { mode };
    return { mode: 'default' };
  };

  // Cycle the permission mode the only way the CLI exposes it: shift+tab
  // (ESC [ Z). We do not fake a "set bypass" button (bypass can be
  // org-disabled); we cycle and re-scrape so the UI reports the landed mode.
  const cyclePermissionMode = async (paneId, workspaceId) => {
    const state = terminalBridge.getState();
    if (state.controlledPaneId !== paneId) {
      await terminalBridge.requestFocusPane({ paneId, workspaceId }).catch(() => {});
    }
    const result = terminalBridge.sendInput(paneId, '\x1b[Z');
    if (result?.ok === false) throw new Error(result.reason || 'input refused');
    await sleep(400);
    return readPermissionMode(paneId);
  };

  // Trust but VERIFY every candidate pane; including the renderer's, whose
  // model/link state can lag a pane's death by minutes. A dead pane must fall
  // through to the resume path, not eat the message (live-caught). Pane
  // EXISTENCE is not session liveness (live-caught 2026-07-22: a Bun segfault
  // dropped claude back to bash and the pane outlived the session by 90
  // minutes, so the send typed into the SHELL, which executed it). A pane the
  // snapshot says is OWNED BY ANOTHER SESSION is rejected here; a pane with
  // no detected agent still resolves (agent detection lags a fresh launch by
  // 60-150s), and deliver()'s shell-prompt refusal is what catches the
  // crashed-to-bash case. Provisional pane-keyed ids skip the ownership test:
  // the pane IS their identity.
  const resolvePane = async (sessionId, modelPane) => {
    // Queued payloads preserve the renderer's pane as it existed when Enter
    // was pressed. A resume completed by an earlier queue item updates this
    // registry, so that link is newer than the captured payload and must win.
    const candidate = links.get(sessionId) || (modelPane?.paneId ? modelPane : null);
    if (!candidate) return null;
    let pane = null;
    try {
      const snap = await snapshot();
      pane = (snap.panes || []).find((p) => p.pane_id === candidate.paneId) || null;
    } catch {
      return candidate; // daemon hiccup; the send path will surface a real failure
    }
    if (pane) {
      if (String(sessionId).startsWith('pane:')) return candidate;
      const owner = pane.agent_session?.kind === 'id' ? (pane.agent_session.value || null) : null;
      if (!owner || owner === sessionId) return candidate;
    }
    links.dropPane(candidate.paneId);
    return null;
  };

  const debug = (...args) => {
    if (process.env.HARBOR_SEND_DEBUG === '1') console.log('[send-debug]', ...args);
  };

  // A provider is RESOLVED, never defaulted into. `deliver(..., provider =
  // 'claude')` and the renderer's `session.provider || 'claude'` meant a codex
  // pane whose provider had not resolved yet was driven down the claude path:
  // the claude composer guard, the claude readiness test, a claude resume, and
  // a "Claude" chip on a gpt-5.6-sol session (live-caught 2026-08-08). The
  // session's own metadata knows what it is; ask it before assuming.
  const resolveProvider = async (sessionId, supplied) => {
    if (supplied && supplied !== 'claude') return supplied;
    try {
      const meta = await getSessionMeta?.(sessionId);
      if (meta?.provider) return meta.provider;
    } catch { /* fall through to what the caller said */ }
    return supplied || 'claude';
  };

  const runSend = async ({ sessionId, text, images = [], pane, detectedHome, provider, resumeOnly = false }) => {
    provider = await resolveProvider(sessionId, provider);
    const trimmed = String(text ?? '').replace(/\r\n/g, '\n').trim();
    const imagePaths = Array.isArray(images) ? images.filter(Boolean) : [];
    if (!trimmed && imagePaths.length === 0 && !resumeOnly) throw new Error('nothing to send');
    const slash = isSlashCommand(trimmed);
    const target = await resolvePane(sessionId, pane);
    debug('resolved target', JSON.stringify(target), 'link was', JSON.stringify(links.get(sessionId)));
    logSend({
      sessionId,
      phase: 'resolve',
      paneId: target?.paneId || null,
      offered: pane?.paneId || null,
      linked: links.get(sessionId)?.paneId || null,
      chars: trimmed.length,
      images: imagePaths.length,
    });
    if (target) {
      if (resumeOnly) {
        // Resume must PROVE the pane still holds a live CLI before reporting
        // success. A pane whose claude exited survives at a shell prompt with
        // no agent_session, which resolvePane accepts (agent detection lags
        // 60-150s, so an unnamed pane cannot be rejected outright), and the
        // resume then returned ok having done nothing at all: the button
        // looked dead because it WAS dead (Pat, 2026-07-25: "the resume
        // functionality doesn't even work"). A dead shell falls through to a
        // real resume, exactly like the deliver path does.
        let paneAlive = true;
        try {
          await assertNotDeadShell(target.paneId);
        } catch (error) {
          if (error?.code !== 'DEAD_SHELL' || String(sessionId).startsWith('pane:')) throw error;
          paneAlive = false;
          links.dropPane(target.paneId);
        }
        if (paneAlive) {
          status(sessionId, 'sent', 'this session is already live in its pane');
          return { ok: true, paneId: target.paneId, alreadyLive: true };
        }
      } else {
        status(sessionId, 'sending');
        // Capture the transcript boundary before typing. Leaving this promise
        // unresolved lets a fast enqueue land before stat(), hiding the accepted
        // message inside preSize and guaranteeing a false timeout.
        const confirmation = trimmed ? await prepareDeliveryConfirmation(sessionId) : null;
        try {
          await deliver(target.paneId, target.workspaceId, trimmed, imagePaths, provider);
          status(sessionId, 'sent');
          if (trimmed) reconcileDelivery(sessionId, trimmed, slash, confirmation);
          return { ok: true, paneId: target.paneId, delivery: trimmed ? 'confirming' : 'delivered' };
        } catch (error) {
          // A pane at a dead shell prompt is a dead SESSION holding a leftover
          // pty (the CLI crashed or quit): the message must not be lost, so
          // fall through to resume-then-send. A provisional pane-keyed id has
          // no resumable identity; for it the honest refusal stands.
          if (error?.code !== 'DEAD_SHELL' || String(sessionId).startsWith('pane:')) throw error;
          links.dropPane(target.paneId);
        }
      }
    }

    // No pane: resume first, then deliver into the fresh pane. Codex/cursor
    // resume rides bin/ai (codex resume <id> / cursor-agent --resume <id>);
    // claude rides bin/claude-sessions. Never fire a claude resume at a
    // foreign id: a cursor session whose cwd could not be recovered (its
    // transcripts never record one) refuses honestly instead.
    if (provider && provider !== 'claude') {
      const providerMeta = await getSessionMeta(sessionId).catch(() => null);
      if (!providerMeta?.cwd || typeof launchActions.resumeProviderSession !== 'function') {
        throw new Error(`this ${provider} session is not running in a pane and its working folder is unknown; cannot resume it`);
      }
      status(sessionId, 'resuming');
      const providerPreIds = await paneIdSet();
      await launchActions.resumeProviderSession({ provider, cwd: providerMeta.cwd, id: sessionId });
      const providerFresh = await findFreshPane({ preIds: providerPreIds, cwd: providerMeta.cwd });
      if (!providerFresh) throw new Error(`resumed the ${provider} session, but the new pane never appeared`);
      links.set(sessionId, providerFresh);
      await terminalBridge.requestFocusPane({
        paneId: providerFresh.paneId,
        workspaceId: providerFresh.workspaceId,
      }).catch(() => {});
      status(sessionId, 'waiting');
      const providerReady = await waitForProviderReady(providerFresh.paneId);
      if (!providerReady) throw new Error(`${provider} resumed, but its composer never settled; message NOT sent`);
      if (resumeOnly) {
        status(sessionId, 'sent', `${provider} session resumed and ready`);
        return { ok: true, paneId: providerFresh.paneId, resumed: true };
      }
      status(sessionId, 'sending');
      await deliver(providerFresh.paneId, providerFresh.workspaceId, trimmed, imagePaths, provider);
      status(sessionId, 'sent');
      return { ok: true, paneId: providerFresh.paneId, resumed: true, delivery: 'delivered' };
    }
    status(sessionId, 'resuming');
    const meta = await getSessionMeta(sessionId).catch(() => null);
    const preIds = await paneIdSet();
    await launchActions.resumeSession({ id: sessionId, detectedHome });
    const fresh = await findFreshPane({ preIds, cwd: meta?.cwd || null });
    if (!fresh) throw new Error('resumed, but the new pane never appeared');
    links.set(sessionId, fresh);
    await terminalBridge.requestFocusPane({
      paneId: fresh.paneId,
      workspaceId: fresh.workspaceId,
    }).catch(() => {});
    status(sessionId, 'waiting');
    const ready = await waitForResumedClaudeReady(fresh.paneId, fresh.workspaceId);
    if (!ready) throw new Error('session resumed, but Claude never came up; message NOT sent');
    if (resumeOnly) {
      status(sessionId, 'sent', 'session resumed and ready');
      return { ok: true, paneId: fresh.paneId, resumed: true };
    }
    status(sessionId, 'sending');
    const confirmation = trimmed ? await prepareDeliveryConfirmation(sessionId) : null;
    await deliver(fresh.paneId, fresh.workspaceId, trimmed, imagePaths, provider);
    status(sessionId, 'sent');
    if (trimmed) reconcileDelivery(sessionId, trimmed, slash, confirmation);
    return { ok: true, paneId: fresh.paneId, resumed: true, delivery: trimmed ? 'confirming' : 'delivered' };
  };

  // Confirmation is deliberately detached from the user-visible send. A pty
  // write makes the message appear sent immediately; transcript reconciliation
  // can still replace that optimism with an honest error if delivery failed.
  const reconcileDelivery = (sessionId, text, optional, confirmation) => {
    Promise.resolve(confirmation).then((prepared) => (
      confirmDelivery(sessionId, text, { optional, prepared })
    )).catch((error) => {
      status(sessionId, 'error', error.message);
    });
  };

  const drain = async (sessionId) => {
    if (inFlight.has(sessionId)) return;
    inFlight.add(sessionId);
    try {
      while ((queues.get(sessionId) || []).length) {
        const queue = queues.get(sessionId);
        const item = queue[0];
        item.status = 'sending';
        try {
          item.resolve(await runSend(item.payload));
        } catch (error) {
          status(sessionId, 'error', error.message);
          item.reject(error);
        } finally {
          queue.shift();
          if (queue.length === 0) queues.delete(sessionId);
        }
      }
    } finally {
      inFlight.delete(sessionId);
      if ((queues.get(sessionId) || []).length) drain(sessionId);
    }
  };

  // send(): enqueue every payload, then let one per-session drain preserve FIFO.
  const send = (payload) => {
    const { sessionId, text, images = [], pane, resumeOnly = false } = payload;
    debug('send()', JSON.stringify({ sessionId, pane, resumeOnly, inFlight: inFlight.has(sessionId) }));
    const queue = queues.get(sessionId) || [];
    const item = {
      id: `send-${nextSendId++}`,
      status: 'queued',
      textPreview: textPreview(text, images),
      payload,
    };
    const promise = new Promise((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
    });
    queue.push(item);
    queues.set(sessionId, queue);
    if (inFlight.has(sessionId)) status(sessionId, 'queued');
    drain(sessionId);
    return promise;
  };

  const cancelQueued = (sessionId, sendId) => {
    const queue = queues.get(sessionId) || [];
    const index = queue.findIndex((item) => item.id === sendId);
    if (index < 0) return { ok: false, reason: 'queued message not found' };
    const item = queue[index];
    if (item.status !== 'queued') return { ok: false, reason: 'message is already sending' };
    queue.splice(index, 1);
    if (queue.length === 0) queues.delete(sessionId);
    item.resolve({ ok: true, cancelled: true, sendId });
    status(sessionId, 'cancelled', 'Queued message cancelled');
    return { ok: true, cancelledId: sendId };
  };

  // Public menu surface: the command bar polls getMenu for the selected pane and
  // renders it; answerMenu drives the selection. Both are no-ops without a pane.
  // `ask` is the session's live AskUserQuestion payload from its transcript,
  // supplied by the caller (index.js has the transcript provider). It carries
  // the question and every option in full, so a dialog whose top the pty
  // viewport clipped is still readable in the window; see ask-question.js.
  // Absent or unmatched, the card is exactly what the pane alone yielded.

  // Bounded: a notice chain is a handful of screens, and a cap means a screen
  // that keeps matching can never become an infinite keypress loop.

  const getMenu = async ({ pane, blockedHint, ask } = {}) => {
    if (!pane?.paneId) return null;
    // Size the pane for dialogs the first time a window polls it, which is
    // within a second of the window opening and long before Claude asks
    // anything. This is the actual fix for the clipped-question family: a
    // 23-row pane cannot draw a 35-row dialog, and no amount of parsing
    // recovers rows the pane never held.
    terminalBridge?.ensureDialogSize?.(pane.paneId).catch?.(() => {});
    const menu = await readMenu(pane.paneId);
    // A dialog still coming back clipped means the pane is still small (herdr
    // re-laid it out, or the first attempt was refused). Try again, because
    // Ink redraws on SIGWINCH: this heals a dialog that is already on screen.
    if (menu?.clipped) terminalBridge?.ensureDialogSize?.(pane.paneId, { force: true }).catch?.(() => {});
    if (menu) return ask ? mergeAsk(menu, ask) : menu;
    return readFallback(pane, Boolean(blockedHint));
  };
  const answerMenuFor = async ({ pane, action } = {}) => {
    if (!pane?.paneId) return { ok: false, reason: 'no live pane to answer the menu on' };
    return answerMenu(pane.paneId, pane.workspaceId, action);
  };

  return {
    emitter,
    // The ADOPT path lives in actions/takeover.js and emits its own statuses, so
    // none of them reached the send log: when an adopt failed on 2026-07-28 the
    // only record anywhere was a truncated line in Pat's status bar. Adoption
    // kills and resumes a session before it delivers, which makes it the most
    // expensive way for a message not to land, and it now writes the same trace.
    logStatus: (payload) => logSend(payload),
    send,
    getMenu,
    answerMenu: answerMenuFor,
    findFreshPane,
    findFreshTranscript,
    listTranscriptIds,
    waitForClaudeReady,
    waitForResumedClaudeReady,
    waitForProviderReady,
    paneIdSet,
    readPermissionMode,
    cyclePermissionMode,
    confirmNeedle,
    getQueueState,
    cancelQueued,
  };
}

module.exports = {
  createSessionSend,
  createLinkRegistry,
  claudeProjectDir,
  providerTranscriptDirs,
};
