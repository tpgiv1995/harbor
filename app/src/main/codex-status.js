'use strict';

// CODEX GETS A PROGRAM STATUS TOO (2026-10-15). Every "needs you" surface in
// Harbor (the toast, the dock/taskbar count, the rail's amber cue, the window's
// quick Allow/Deny, a notification click opening the right window) keys on a
// pane's agent_status, and that status only ever came from Claude's OSC 7501
// report (daemon/screen.js -> keeper -> daemon list -> pane.agent_status_changed).
// Codex never emits 7501, so a Codex pane finishing, failing, or stopping on an
// approval was silent.
//
// This source synthesizes the same pane.agent_status_changed event for Codex
// panes and feeds it through the exact path a Claude status takes
// (sidebarBridge.onPaneAgentStatus -> notifier), so nothing downstream needs a
// Codex branch. The status is decided from TWO sources, each used for what only
// it can answer:
//
//   the ROLLOUT (codex-state.js)  working vs finished, finished-with-error vs
//                                 aborted, and a pending request_user_input
//                                 question (written before it is answered).
//                                 Codex's own durable record: it does not depend
//                                 on how the pane was launched, so panes started
//                                 by an older Harbor and resumed sessions report
//                                 too, and it survives an app restart.
//   the SCREEN (codex-screen.js)  approval prompts, which are written nowhere
//                                 until they are resolved (measured), and any
//                                 other picker. Read only while a turn is in
//                                 flight (or a question is pending), or while
//                                 the rollout holds no turn boundary at all;
//                                 an anchored rollout that says idle with no
//                                 question settles the status (an approval is
//                                 only ever up mid-turn) without a read. It
//                                 also overrules a rollout that says
//                                 "working" or "question
//                                 pending" when the TUI is plainly at rest: a
//                                 turn killed mid-tool, or a question left open
//                                 when the process died, never writes its end,
//                                 so after a resume the rollout alone would say
//                                 working (or blocked) forever.
//
// Why not Codex's own notifications. 0.160.0 can emit OSC 9 ("Approval
// requested: …", the last agent message at turn end; tui.notifications +
// notification_method=osc9 + notification_condition=always), measured in a pty.
// They need launch-time `-c` flags (so every pane already running stays
// silent), they report no WORKING state at all (and notify only fires on a
// working -> idle/blocked transition), a failed turn's toast is just its last
// text, and acting on them means new keeper code that only reaches new panes
// after a daemon handover. The terminal title Codex sets (OSC 0, "[ ! ] Action
// Required | …", a spinner while busy) was measured too: the spinner was absent
// for an entire 25 s turn, so it cannot carry working state either.

const { initialState, foldCodexRecords, readRolloutSlice, isTurnAnchor } = require('./codex-state.js');
const { parseCodexMenu, isCodexWorking, isCodexIdle } = require('./codex-screen.js');

const POLL_MS = 1500;
// How sure the screen must be before it overrules the rollout's "working":
// an at-rest TUI on this many consecutive reads with no new rollout record in
// between, or on one read when the rollout has been silent this long. A live
// turn writes records and draws its working line; one that died does neither.
const IDLE_CONFIRM_READS = 3;
const IDLE_QUIET_MS = 10_000;
// The screen read is a 90-line readPane RPC plus a parse, every POLL_MS per
// pane. A pane whose screen keeps being read while its status is settled at
// idle (a rollout stuck on "working" after its turn died, or one with no turn
// boundary in reach) is read only every IDLE_BACKOFF_POLL_MS once it has been
// idle for IDLE_BACKOFF_AFTER_MS; a new rollout record, or a status that is no
// longer idle, puts it straight back on every tick.
const IDLE_BACKOFF_AFTER_MS = 10_000;
const IDLE_BACKOFF_POLL_MS = 6_000;
const clip = (text, max = 160) => {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

// The words a Codex APPROVAL is reported by ("approve: <command>", else its
// question), from one parsed menu. The published status and the one-click
// Allow's live check (session-send.js permission-quick) both come from here, so
// the chip's `expect` and the screen it is checked against cannot drift apart.
function codexApprovalMsg(menu) {
  if (!menu?.permission) return null;
  const command = menu.permission.blocks?.find((block) => block.type === 'code')?.text;
  return clip(command ? `approve: ${command}` : menu.question);
}

// The status a Codex pane is in, from its folded rollout and (when given) the
// screen. Returns { status, kind, msg }.
function codexPaneStatus(state, screen = null) {
  const menu = screen ? parseCodexMenu(screen) : null;
  if (menu?.permission) return { status: 'blocked', kind: 'permission', msg: codexApprovalMsg(menu) };
  if (state.pendingQuestion) {
    const first = state.pendingQuestion.questions[0];
    return { status: 'blocked', kind: 'question', msg: clip(first?.question || first?.header || 'answer a question') };
  }
  if (menu) return { status: 'blocked', kind: menu.codex?.kind || 'question', msg: clip(menu.question || 'answer the prompt') };
  // The working line counts on its own: a turn whose task_started the rollout
  // read could not reach is still working when the TUI says so.
  if (state.turn === 'working' || (screen && isCodexWorking(screen))) return { status: 'working', kind: null, msg: null };
  if (state.turnEnd === 'error') return { status: 'done', kind: 'error', msg: clip(state.turnError?.message || 'the turn failed') };
  if (state.turnEnd === 'complete') return { status: 'done', kind: null, msg: null };
  return { status: 'idle', kind: null, msg: null };
}

function createCodexStatusSource(options = {}) {
  const {
    listPanes,       // () => [{ paneId, workspaceId, sessionId }] live Codex panes
    transcriptPath,  // async (sessionId) => rollout path | null
    readScreen,      // async (paneId) => screen text
    emit,            // (event) => void
    // (sessionId) => void: the rollout path just failed to read (compressed,
    // archived or deleted under a live pane). The resolver must stop handing
    // back that path, or the pane reports nothing until Harbor restarts.
    forgetPath = () => {},
    readSlice = readRolloutSlice,
    intervalMs = POLL_MS,
    setTimer = setInterval,
    clearTimer = clearInterval,
    now = Date.now,
  } = options;
  // paneId -> { sessionId, path, offset, state, last, unanchored, idleReads,
  //            quietSince (ms the status settled idle, else null),
  //            screenAt (ms of the last screen read) }
  const entries = new Map();
  let timer = null;
  let running = false;

  // `agentStatus` is what the rail currently holds for the pane. A daemon resync
  // rebuilds pane state from a snapshot that knows nothing of these synthesized
  // statuses, so a mismatch re-asserts the last one instead of leaving the rail
  // blank until the next real change.
  const tickPane = async ({ paneId, workspaceId, sessionId, agentStatus }) => {
    let entry = entries.get(paneId);
    if (!entry || entry.sessionId !== sessionId) {
      entry = { sessionId, path: null, offset: null, state: initialState(), last: entry?.last || null, seq: entry?.seq || 0, unanchored: false, idleReads: 0, quietSince: null, screenAt: null };
      entries.set(paneId, entry);
    }
    // Resolved every tick, not once (the resolver caches): a session can move
    // to another file under a live pane, and a new path restarts the fold
    // there. A miss keeps the path already held.
    const resolved = await Promise.resolve(transcriptPath(sessionId)).catch(() => null);
    if (resolved && resolved !== entry.path) {
      entry.path = resolved;
      entry.offset = null;
      entry.state = initialState();
      entry.unanchored = false;
      entry.idleReads = 0;
      entry.quietSince = null;
    }
    if (!entry.path) return; // no rollout yet: nothing honest to report
    let fresh = 0;
    let restarted = false;
    try {
      const first = entry.offset == null;
      const slice = readSlice(entry.path, { from: entry.offset });
      if (entry.offset != null && slice.size < entry.offset) { entry.state = initialState(); restarted = true; }
      if (first) restarted = true;
      foldCodexRecords(slice.records, entry.state);
      entry.offset = slice.offset;
      // New records since the last read: the turn is alive. A first read is
      // history, not news, so it never counts as activity.
      fresh = first ? 0 : slice.records.length;
      if (first) entry.unanchored = slice.anchored === false;
      else if (slice.records.some(isTurnAnchor)) entry.unanchored = false;
    } catch {
      // Moved or deleted: resolve again next tick, from scratch.
      entry.path = null;
      try { forgetPath(sessionId); } catch { /* the next resolve still runs */ }
      return;
    }
    const busy = entry.state.turn === 'working' || Boolean(entry.state.pendingQuestion);
    let screen = null;
    let skipped = false;
    if (busy || entry.unanchored) {
      const at = now();
      // Backed off: nothing new in the rollout (so the fold has not moved),
      // the status has sat at idle long enough, and the last read is recent.
      // The previous decision stands; it is re-asserted below if the rail
      // lost it.
      skipped = !fresh && !restarted && Boolean(entry.last) && entry.quietSince != null
        && at - entry.quietSince >= IDLE_BACKOFF_AFTER_MS
        && entry.screenAt != null && at - entry.screenAt < IDLE_BACKOFF_POLL_MS;
      if (!skipped) {
        entry.screenAt = at;
        screen = await Promise.resolve(readScreen(paneId)).catch(() => null);
      }
    }
    // The rollout says a turn (or a question) is open; the screen says the TUI
    // is at rest. Once that is certain, the question is dropped for good (one
    // that comes back is a menu on screen) and the turn reads idle for as long
    // as the screen stays at rest; the fold's own `turn` is left alone so the
    // screen keeps being read and a working line that reappears wins again.
    let atRest = false;
    if (skipped) {
      // idleReads and the settled status carry over unchanged.
    } else if (busy && screen && isCodexIdle(screen)) {
      entry.idleReads = fresh ? 1 : entry.idleReads + 1;
      const quietMs = entry.state.lastRecordMs ? now() - entry.state.lastRecordMs : Infinity;
      atRest = entry.idleReads >= IDLE_CONFIRM_READS || (!fresh && quietMs >= IDLE_QUIET_MS);
    } else {
      entry.idleReads = 0;
    }
    if (atRest) entry.state.pendingQuestion = null;
    const next = skipped ? entry.last
      : atRest ? { status: 'idle', kind: null, msg: null } : codexPaneStatus(entry.state, screen);
    const settled = next.status === 'idle' || next.status === 'done';
    if (!settled || fresh) entry.quietSince = null;
    else if (entry.quietSince == null) entry.quietSince = now();
    const last = entry.last;
    // A NEW prompt gets a new seq, the way the keeper numbers Claude's OSC 7501
    // reports: the msg is clipped and two approvals of one command read the
    // same, so the seq is what a one-click answer and the notifier tell them
    // apart by. New means not blocked before, other words, or rollout records
    // written while blocked (Codex writes nothing while an approval waits, so
    // records mean the last one was answered and this is the next).
    if (next.status === 'blocked' && !skipped
      && (!last || last.status !== 'blocked' || last.kind !== next.kind || last.msg !== next.msg || fresh > 0)) {
      entry.seq += 1;
    }
    const seq = next.status === 'blocked' ? entry.seq : null;
    const same = last && last.status === next.status && last.kind === next.kind && last.msg === next.msg && last.seq === seq;
    if (same && (agentStatus === undefined || agentStatus === next.status)) return;
    entry.last = { ...next, seq };
    emit({
      event: 'pane.agent_status_changed',
      data: {
        pane_id: paneId,
        workspace_id: workspaceId ?? null,
        agent_status: next.status,
        agent_status_kind: next.kind,
        agent_status_msg: next.msg,
        agent_status_seq: seq,
        source: 'codex',
      },
    });
  };

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      let panes = [];
      try { panes = (await listPanes()) || []; } catch { panes = []; }
      const seen = new Set();
      for (const pane of panes) {
        if (!pane?.paneId || !pane.sessionId) continue;
        seen.add(pane.paneId);
        try { await tickPane(pane); } catch { /* one pane never stalls the rest */ }
      }
      for (const paneId of [...entries.keys()]) if (!seen.has(paneId)) entries.delete(paneId);
    } finally {
      running = false;
    }
  };

  return {
    tick,
    start() {
      if (timer) return;
      timer = setTimer(() => { tick().catch(() => {}); }, intervalMs);
      timer?.unref?.();
    },
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
      entries.clear();
    },
    // The seq of the prompt a pane is blocked on now, or null: also null once
    // that prompt has been answered here, so a second click meant for it (the
    // chip, the rail and the phone each have one) can never match the next
    // prompt, which gets a new seq when it is first seen.
    seqFor: (paneId) => {
      const entry = entries.get(paneId);
      if (entry?.last?.status !== 'blocked' || entry.spentSeq === entry.last.seq) return null;
      return entry.last.seq ?? null;
    },
    // A one-click Allow or Deny just answered the pane's prompt.
    answered: (paneId) => {
      const entry = entries.get(paneId);
      if (entry?.last?.status === 'blocked') entry.spentSeq = entry.last.seq;
    },
    _entries: entries,
  };
}

module.exports = {
  createCodexStatusSource, codexPaneStatus, codexApprovalMsg,
  POLL_MS, IDLE_CONFIRM_READS, IDLE_QUIET_MS, IDLE_BACKOFF_AFTER_MS, IDLE_BACKOFF_POLL_MS,
};
