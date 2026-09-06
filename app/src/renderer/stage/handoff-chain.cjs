'use strict';
// The one-click handoff chain: /handoff -> /compact -> /pickup, driven into
// ONE session. Pure planner; the composition root owns the clock (1s ticks
// from the transcript store) and the sends (window.harbor.session.send by the
// chain's own session id, so switching windows mid-chain can never retarget
// it). Two deliberate design points:
//   - Step completion is read from the transcript's working flag (a turn seen
//     STARTING, then quiet for quietTicks), never from the daemon's lagging
//     agent status. Blocked ticks pause the quiet count instead of failing,
//     because a permission prompt mid-turn is ordinary and Pat answers it in
//     the window.
//   - /compact completion is proven by the send path ACCEPTING /pickup. The
//     send guards already refuse while compaction chrome is on screen
//     (classifyBlocked), so the chain retries /pickup on a delay rather than
//     re-deriving that classifier here. /pickup needs no path argument: the
//     pickup command itself loads the newest handoff file.
// A chain that cannot proceed FAILS with the reason it saw; it never sends
// blind into a session it can no longer read (a closed window stops it).

const DEFAULT_CONFIG = {
  startDeadlineMs: 90_000, // /handoff must visibly start a turn
  stepDeadlineMs: 15 * 60_000, // per step: handoff turn, then compact+pickup
  quietTicks: 3, // consecutive idle ticks that mean the turn finished
  retryDelayMs: 4_000, // between refused /pickup attempts
  compactGraceMs: 8_000, // head start for compaction chrome to appear
};

function createChain({ sessionId, now, config = {} }) {
  return {
    sessionId,
    config: { ...DEFAULT_CONFIG, ...config },
    status: 'active', // 'active' | 'done' | 'failed'
    step: 'handoff', // 'handoff' | 'compact' | 'pickup'
    phase: 'send', // 'send' | 'sent-wait' | 'await-start' | 'running' | 'pickup-wait' | 'pickup-sent'
    quiet: 0,
    stepAt: now,
    lastAttemptAt: null,
    lastReason: null,
    reason: null,
  };
}

const failed = (state, reason) => ({ ...state, status: 'failed', reason });

function chainTick(state, { now, working, blocked, missing }) {
  if (state.status !== 'active') return { state, action: null };
  if (missing) {
    return { state: failed(state, 'the session window closed; chain stopped'), action: null };
  }
  const cfg = state.config;
  const elapsed = now - state.stepAt;

  if (state.phase === 'send') {
    return {
      state: { ...state, phase: 'sent-wait', stepAt: now },
      action: { type: 'send', text: '/handoff' },
    };
  }
  if (state.phase === 'sent-wait') {
    if (elapsed > cfg.stepDeadlineMs) {
      return { state: failed(state, `the /${state.step} send never resolved`), action: null };
    }
    return { state, action: null };
  }
  if (state.phase === 'await-start') {
    // Blocked counts as started: a permission prompt means the turn is real.
    if (working || blocked) {
      return { state: { ...state, phase: 'running', quiet: 0 }, action: null };
    }
    if (elapsed > cfg.startDeadlineMs) {
      return { state: failed(state, 'the handoff turn never started; nothing was compacted'), action: null };
    }
    return { state, action: null };
  }
  if (state.phase === 'running') {
    if (elapsed > cfg.stepDeadlineMs) {
      return { state: failed(state, 'the handoff turn did not finish within the deadline'), action: null };
    }
    if (working || blocked) {
      return { state: { ...state, quiet: 0 }, action: null };
    }
    const quiet = state.quiet + 1;
    if (quiet < cfg.quietTicks) {
      return { state: { ...state, quiet }, action: null };
    }
    return {
      state: { ...state, step: 'compact', phase: 'sent-wait', quiet: 0, stepAt: now },
      action: { type: 'send', text: '/compact' },
    };
  }
  if (state.phase === 'pickup-wait') {
    if (elapsed > cfg.stepDeadlineMs) {
      const why = state.lastReason
        ? `/pickup was refused until the deadline: ${state.lastReason}`
        : 'compaction never finished within the deadline';
      return { state: failed(state, why), action: null };
    }
    if (working) return { state, action: null };
    const since = state.lastAttemptAt == null ? elapsed : now - state.lastAttemptAt;
    const wait = state.lastAttemptAt == null ? cfg.compactGraceMs : cfg.retryDelayMs;
    if (since < wait) return { state, action: null };
    return {
      state: { ...state, phase: 'pickup-sent', lastAttemptAt: now },
      action: { type: 'send', text: '/pickup' },
    };
  }
  // 'pickup-sent': waiting on the send result.
  return { state, action: null };
}

function chainSendResult(state, { ok, reason, now }) {
  if (state.status !== 'active') return state;
  if (state.phase === 'sent-wait') {
    if (!ok) {
      return failed(state, `/${state.step} was refused: ${reason || 'send failed'}`);
    }
    if (state.step === 'handoff') {
      return { ...state, phase: 'await-start', stepAt: now };
    }
    // /compact accepted: from here, an accepted /pickup is the completion proof.
    return { ...state, phase: 'pickup-wait', stepAt: now, lastAttemptAt: null, lastReason: null };
  }
  if (state.phase === 'pickup-sent') {
    if (ok) {
      return { ...state, status: 'done', step: 'pickup', phase: 'pickup-sent' };
    }
    return { ...state, phase: 'pickup-wait', lastReason: reason || 'send refused' };
  }
  return state;
}

function describeChain(state) {
  if (!state) return null;
  if (state.status === 'failed') return `handoff chain failed: ${state.reason}`;
  if (state.status === 'done') return 'handoff chain done: /pickup delivered';
  if (state.step === 'handoff') {
    if (state.phase === 'send' || state.phase === 'sent-wait') return 'handoff chain: sending /handoff';
    if (state.phase === 'await-start') return 'handoff chain: waiting for /handoff to start';
    return 'handoff chain: /handoff running';
  }
  if (state.phase === 'sent-wait') return 'handoff chain: sending /compact';
  if (state.phase === 'pickup-sent' || state.lastAttemptAt != null) {
    return 'handoff chain: compacting, delivering /pickup when ready';
  }
  return 'handoff chain: /compact running';
}

module.exports = {
  DEFAULT_CONFIG, createChain, chainTick, chainSendResult, describeChain,
};
