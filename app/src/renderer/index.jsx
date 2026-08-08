import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Sidebar } from './sidebar/Sidebar.jsx';
import { Stage } from './stage/Stage.jsx';
import { TitleBar } from './TitleBar.jsx';
import { ResizeGrips } from './ResizeGrips.jsx';
import { OrchPanel } from './orchestration/OrchPanel.jsx';
import { OrchProjectPicker } from './orchestration/OrchProjectPicker.jsx';
import { ArtifactsView } from './artifacts/ArtifactsView.jsx';
import { TasksView } from './tasks/TasksView.jsx';
import { useTasks, useToday } from './tasks/use-tasks.js';
import tasksModel from '../shared/tasks-model.cjs';
import { HelpOverlay } from './HelpOverlay.jsx';
import { ContextMenu } from './ContextMenu.jsx';
import { NewSessionConfig } from './NewSessionConfig.jsx';
import { useTerminalBridge } from './terminal/useTerminalBridge.js';
import { emptyDraft, useDraftStore } from './draft-store.js';
import { useFileDrop } from './use-file-drop.js';
import { useVoiceAgent } from './voice/useVoiceAgent.js';
import voiceToolsModule from './voice/voice-tools.cjs';
import { createStallContext, installPerfWatch } from './perf-watch.js';
import { planProvisionalUpgrades } from './stage/provisional-upgrade.cjs';
import { terminalView } from './stage/terminal-view.cjs';
import { mergeLaunchMeta, withLaunchFacts } from './stage/launch-meta.cjs';
import { externalLiveFromHeader } from '../shared/session-liveness.js';
import { ProfilesProvider, useProfiles, normalizeProfileHome } from './providers.js';
import { SetupGate } from './setup/SetupWizard.jsx';
import gridNav from './stage/grid-nav.cjs';
import './styles.css';

const TILE_STORE_KEY = 'harbor-slate-stage';
const VIEW_STORE_KEY = 'harbor-view';
const VIEWS = ['agents', 'tasks', 'orch', 'artifacts'];
const NEW_SESSION_DEFAULT_KEY = 'harbor-new-session-default';
// Bump to re-seed the saved new-session default from the fallback below.
const NEW_SESSION_DEFAULT_VERSION = 2;
// Pat asked for opus + xhigh as the new-session default (2026-07-27). The model
// stays the ALIAS, never a pinned id, so a new flagship needs no Harbor change.
const FALLBACK_NEW_SESSION_DEFAULT = {
  provider: 'claude', model: 'opus', effort: 'xhigh', v: NEW_SESSION_DEFAULT_VERSION,
};
const MAX_TILES = 16;
const VOICE_TOOL_NAMES = voiceToolsModule.TOOL_NAMES;

function readNewSessionDefault() {
  try {
    const stored = JSON.parse(localStorage.getItem(NEW_SESSION_DEFAULT_KEY) || 'null');
    // The old default (effort "high") was written to localStorage the first time
    // this ever ran, so it is indistinguishable from a deliberate save. The
    // version stamp re-seeds it ONCE to the asked-for opus + xhigh; anything
    // saved from the popover after this keeps sticking, because it arrives
    // carrying the current version.
    const stale = !stored || typeof stored !== 'object'
      || stored.v !== NEW_SESSION_DEFAULT_VERSION;
    const value = stale
      ? { ...FALLBACK_NEW_SESSION_DEFAULT, ...(stored?.account ? { account: stored.account } : {}) }
      : { ...FALLBACK_NEW_SESSION_DEFAULT, ...stored };
    localStorage.setItem(NEW_SESSION_DEFAULT_KEY, JSON.stringify(value));
    return value;
  } catch {
    return FALLBACK_NEW_SESSION_DEFAULT;
  }
}

function startLagMonitor(processName) {
  let expected = performance.now();
  const samples = [];
  const tick = () => {
    const now = performance.now();
    const lag = Math.max(0, now - expected - 16);
    samples.push(lag);
    if (samples.length > 600) samples.shift();
    expected = now + 16;
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
  window.__harborLagReport = () => {
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const avg = sorted.reduce((sum, v) => sum + v, 0) / (sorted.length || 1);
    return { process: processName, count: sorted.length, avgMs: avg, p95Ms: p95 };
  };
}

function DaemonBanner() {
  const [banner, setBanner] = useState(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    window.harbor.daemon?.getBanner().then(setBanner).catch(() => {});
    return window.harbor.daemon?.onBanner(setBanner);
  }, []);

  if (!banner || banner === 'ok') return null;
  const retry = async () => {
    setRetrying(true);
    try { setBanner(await window.harbor.daemon.retry()); } finally { setRetrying(false); }
  };
  return (
    <div className="daemon-banner" data-degraded="true" role="status">
      <span className="daemon-banner-text">
        {String(banner.error || '').startsWith('protocol_mismatch') || String(banner.error || '').startsWith('schema_version')
          ? `herdr changed underneath the harbor (${banner.error}); terminals are paused until a compatibility pass.`
          : `Terminal daemon unreachable (${String(banner.error || 'unknown')}). Session history still works; live terminals need the daemon.`}
      </span>
      <button className="daemon-banner-retry" onClick={retry} disabled={retrying}>
        {retrying ? 'Reconnecting...' : 'Reconnect (restarts the app)'}
      </button>
    </div>
  );
}

// A rebuild landed in dist/ while this window is running: say so, one click to
// load it. Closes the stale-build-on-screen gap for renderer changes.
function UpdateBanner() {
  const [visible, setVisible] = useState(false);
  useEffect(() => window.harbor.win?.onUpdateAvailable?.(() => setVisible(true)), []);
  if (!visible) return null;
  return (
    <div className="update-banner" role="status">
      <span>A newer Harbor build is on disk. Restart to use it (applies every fix, not just the UI).</span>
      <span className="update-banner-actions">
        <button type="button" className="update-banner-btn" onClick={() => window.harbor.win?.menuAction?.('restart')}>
          Restart now
        </button>
        <button type="button" className="update-banner-dismiss" aria-label="Dismiss" onClick={() => setVisible(false)}>
          &times;
        </button>
      </span>
    </div>
  );
}

function restoreTiles() {
  try {
    const raw = JSON.parse(localStorage.getItem(TILE_STORE_KEY) || 'null');
    if (!raw || !Array.isArray(raw.tiles)) return { tiles: [], selectedId: null, focusedId: null };
    const used = new Set();
    const seenSessionIds = new Set();
    const tiles = raw.tiles.slice(0, MAX_TILES).map((t, i) => {
      const sessionId = String(t.sessionId);
      if (seenSessionIds.has(sessionId)) return null;
      seenSessionIds.add(sessionId);
      let slot = Number.isInteger(t.slot) && t.slot >= 0 && t.slot < MAX_TILES && !used.has(t.slot)
        ? t.slot : null;
      if (slot === null) { slot = 0; while (used.has(slot)) slot += 1; }
      used.add(slot);
      return { sessionId, tty: false, lastSel: 0, slot };
    }).filter(Boolean);
    return {
      tiles,
      selectedId: raw.selectedId || raw.tiles[0]?.sessionId || null,
      focusedId: tiles.some((t) => t.sessionId === raw.focusedId) ? raw.focusedId : null,
    };
  } catch {
    return { tiles: [], selectedId: null, focusedId: null };
  }
}

function readStoredView() {
  try {
    const stored = localStorage.getItem(VIEW_STORE_KEY);
    return VIEWS.includes(stored) ? stored : 'agents';
  } catch {
    return 'agents';
  }
}

function App() {
  const { profiles, defaultProfileId } = useProfiles();
  const [sidebarModel, setSidebarModel] = useState({ projects: [], liveProjects: [] });
  const [sidebarModelLoaded, setSidebarModelLoaded] = useState(false);
  const [view, setViewState] = useState(readStoredView);
  // Defaults TRUE so the tab never flickers away for the overwhelming majority
  // who have orchestration on; only an explicit false from config removes it.
  const [orchEnabled, setOrchEnabled] = useState(true);
  const [orchProject, setOrchProject] = useState(null);
  const [orchSummaries, setOrchSummaries] = useState({});
  const [helpOpen, setHelpOpen] = useState(false);
  const [links, setLinks] = useState({});
  const [stage, setStage] = useState(restoreTiles);
  const [transcripts, setTranscripts] = useState(() => new Map());
  const [sendStates, setSendStates] = useState(() => new Map());
  const [configRequest, setConfigRequest] = useState(null);
  const searchRef = useRef(null);
  const pinnedTestModelRef = useRef(false);
  // Facts about launches this window initiated (account, cwd, model, effort),
  // keyed by the launched id; synthesis source for windows the model can't
  // describe yet. A ref, because most readers are event handlers, so anything
  // RENDERED from it needs an explicit version bump to repaint (the alternative,
  // waiting for the next sidebar update to churn the memo, is how a chip sits
  // stale for seconds after Harbor already knows better).
  const launchMetaRef = useRef(new Map());
  const [launchFactsVersion, setLaunchFactsVersion] = useState(0);
  const bumpLaunchFacts = useCallback(() => setLaunchFactsVersion((n) => n + 1), []);
  // The launch carries an ALIAS ('opus'); the chip should read like every other
  // chip ('Opus 5'). The new-session registry is where that label already comes
  // from, so the popover and the chip cannot disagree about what a model is
  // called, and an unknown value renders as itself rather than as nothing.
  const [newSessionOptions, setNewSessionOptions] = useState(null);
  useEffect(() => {
    window.harbor.session.newOptions().then(setNewSessionOptions).catch(() => {});
  }, []);
  const modelLabel = useCallback((model, provider = 'claude') => {
    if (!model || model === 'default') return null;
    const rows = newSessionOptions?.providers?.[provider]?.models || [];
    return rows.find((row) => row.value === model)?.label || String(model);
  }, [newSessionOptions]);
  const bridge = useTerminalBridge();
  const { getDraft, patchDraft, clearDraft, renameDraft } = useDraftStore();
  // Tasks live at the app root rather than inside their view, because the tab
  // itself carries the "something is due" badge and has to know without the
  // view being open.
  const tasks = useTasks();
  const today = useToday();
  const taskAlert = useMemo(() => {
    if (!tasks.doc) return 0;
    const stats = tasksModel.counts(tasks.doc, today);
    return stats.overdue + stats.dueToday;
  }, [tasks.doc, today]);

  const { tiles, selectedId } = stage;

  const setView = useCallback((next) => {
    if (!VIEWS.includes(next)) return;
    if (next === 'orch' && !orchEnabled) return;
    setViewState(next);
    try { localStorage.setItem(VIEW_STORE_KEY, next); } catch { /* view just won't restore */ }
  }, [orchEnabled]);

  // Orchestration is optional. Read what setup decided, and if it is off, make
  // the Orch view unreachable rather than merely unadvertised: a stored view of
  // 'orch' from before it was disabled would otherwise restore straight into a
  // panel with no launcher behind it, which is exactly the dead end the tab was
  // removed to prevent.
  useEffect(() => {
    let active = true;
    window.harbor.setup?.state?.()
      .then((state) => { if (active) setOrchEnabled(state?.orchestrationEnabled !== false); })
      .catch(() => { /* absent channel means an older config: leave it enabled */ });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (orchEnabled || view !== 'orch') return;
    setOrchProject(null);
    setViewState('agents');
    try { localStorage.setItem(VIEW_STORE_KEY, 'agents'); } catch { /* best effort */ }
  }, [orchEnabled, view]);

  // The rail chip and the in-window Orch buttons land directly on a project's
  // panel; the title-bar toggle lands on the picker.
  const openOrch = useCallback((proj) => {
    if (!orchEnabled) return;
    setOrchProject(proj || null);
    setViewState('orch');
    try { localStorage.setItem(VIEW_STORE_KEY, 'orch'); } catch { /* best effort */ }
  }, [orchEnabled]);

  useEffect(() => { startLagMonitor('renderer'); }, []);
  useEffect(() => { readNewSessionDefault(); }, []);

  // Input flight recorder: every pointer gesture and drag decision lands in
  // ~/.cache/harbor/input-diag.jsonl so a "drag does nothing" report can be
  // read from disk instead of guessed at. Tiny, silent, always on.
  useEffect(() => {
    const buffer = [];
    window.__harborDiag = { push: (e) => { buffer.push({ ...e, at: Date.now() }); } };
    const rec = (e) => buffer.push({
      k: e.type,
      pointerType: e.pointerType,
      button: e.button,
      target: String(e.target?.className || e.target?.nodeName || '?').slice(0, 50),
      x: Math.round(e.clientX || 0),
      y: Math.round(e.clientY || 0),
      at: Date.now(),
    });
    for (const t of ['pointerdown', 'pointerup', 'pointercancel']) window.addEventListener(t, rec, true);
    const timer = setInterval(() => {
      if (!buffer.length) return;
      const batch = buffer.splice(0, buffer.length);
      window.harbor.diag?.log(batch);
    }, 1500);
    return () => {
      clearInterval(timer);
      for (const t of ['pointerdown', 'pointerup', 'pointercancel']) window.removeEventListener(t, rec, true);
      delete window.__harborDiag;
    };
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'F1') {
        event.preventDefault();
        event.stopPropagation();
        setHelpOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    window.__openOrchForTest = (proj) => openOrch(proj);
    if (window.harbor.e2e) {
      // A test-injected model is sticky: real sidebar pushes must not clobber
      // it mid-test (the harness daemon publishes within milliseconds of boot).
      window.__setSidebarModelForTest = (model) => {
        pinnedTestModelRef.current = model != null;
        // null releases the pin and restores reality, so a fabrication cannot
        // leak a stale model into every scenario that runs after it.
        if (model != null) setSidebarModel(model);
        else window.harbor.sidebar.getState().then((state) => setSidebarModel(state.model)).catch(() => {});
      };
      window.__setTranscriptForTest = (sessionId, data) => {
        setTranscripts((prev) => {
          const next = new Map(prev);
          next.set(sessionId, {
            blocks: data?.blocks || [],
            header: data?.header || null,
            missing: data?.missing,
          });
          return next;
        });
      };
    }
    return () => {
      delete window.__openOrchForTest;
      delete window.__setSidebarModelForTest;
      delete window.__setTranscriptForTest;
    };
  }, [openOrch]);

  useEffect(() => {
    window.harbor.sidebar.getState().then((state) => {
      if (!pinnedTestModelRef.current) {
        setSidebarModel(state.model);
        setSidebarModelLoaded(true);
      }
    }).catch(() => setSidebarModelLoaded(true));
    return window.harbor.sidebar.onUpdate((state) => {
      if (!pinnedTestModelRef.current) {
        setSidebarModel(state.model);
        setSidebarModelLoaded(true);
      }
    });
  }, []);

  useEffect(() => {
    window.harbor.links.get().then(setLinks).catch(() => {});
    return window.harbor.links.onUpdate(setLinks);
  }, []);

  // Every session by id, workers included: tiles resolve their session facts
  // (title, project, account, live pane) straight from the sidebar model.
  const sessionsById = useMemo(() => {
    const map = new Map();
    for (const project of sidebarModel.projects || []) {
      for (const session of project.sessions || []) map.set(session.id, session);
    }
    return map;
  }, [sidebarModel]);

  const resolvePane = useCallback((session) => {
    if (session?.paneId) return { paneId: session.paneId, workspaceId: session.workspaceId };
    const link = links[session?.id];
    return link ? { paneId: link.paneId, workspaceId: link.workspaceId } : null;
  }, [links]);

  // "Live outside Harbor": the transcript is hot but no herdr pane exists;
  // a Ptyxis-run claude. The header policy (beacon-dead outranks a stale
  // working flag) lives in shared/session-liveness so it is unit-tested.
  const isExternalLive = useCallback((session) => {
    if (resolvePane(session)) return false;
    return externalLiveFromHeader(transcripts.get(session.id)?.header, Date.now());
  }, [resolvePane, transcripts]);

  // ---- stage state ----
  const persist = (next) => {
    try {
      localStorage.setItem(TILE_STORE_KEY, JSON.stringify({
        tiles: next.tiles.map((t) => ({ sessionId: t.sessionId, slot: t.slot })),
        selectedId: next.selectedId,
        focusedId: next.focusedId || null,
      }));
    } catch { /* storage full/blocked: stage just won't restore */ }
  };

  const setStagePersist = (updater) => {
    setStage((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      persist(next);
      return next;
    });
  };

  const openSession = useCallback((session) => {
    if (!session?.id || session.isWindowsEra) return;
    // Opening a window from any view lands on the stage; a window opened into
    // a hidden view would read as a dead click.
    setView('agents');
    setStagePersist((prev) => {
      const existing = prev.tiles.find((t) => t.sessionId === session.id);
      if (existing) {
        return { ...prev, selectedId: session.id, tiles: prev.tiles.map((t) => (t === existing ? { ...t, lastSel: Date.now() } : t)) };
      }
      let tiles = [...prev.tiles];
      if (tiles.length >= MAX_TILES) {
        // Replace the least-recently-selected window that is not on screen as
        // the active one.
        const evictable = [...tiles].filter((t) => t.sessionId !== prev.selectedId)
          .sort((a, b) => (a.lastSel || 0) - (b.lastSel || 0));
        const evict = evictable[0] || tiles[0];
        tiles = tiles.filter((t) => t !== evict);
      }
      const usedSlots = new Set(tiles.map((t) => t.slot));
      let slot = 0; while (usedSlots.has(slot)) slot += 1;
      tiles.push({ sessionId: session.id, tty: false, lastSel: Date.now(), slot });
      return { ...prev, tiles, selectedId: session.id };
    });
  }, [setView]);

  const closeTile = useCallback((sessionId) => {
    setStagePersist((prev) => {
      // Preserve the survivors' current visual order (including drag swaps),
      // then remove any gap left by the closed window. Sparse slots are useful
      // while arranging windows, but should not survive a close.
      const tiles = prev.tiles
        .filter((t) => t.sessionId !== sessionId)
        .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
        .map((tile, slot) => (tile.slot === slot ? tile : { ...tile, slot }));
      const selectedId = prev.selectedId === sessionId
        ? (tiles[tiles.length - 1]?.sessionId || null)
        : prev.selectedId;
      const focusedId = prev.focusedId === sessionId ? null : prev.focusedId;
      return { ...prev, tiles, selectedId, focusedId };
    });
  }, []);

  const selectTile = useCallback((sessionId) => {
    setStagePersist((prev) => (prev.selectedId === sessionId
      ? prev
      : {
        ...prev,
        selectedId: sessionId,
        // In focus mode, switching windows (Ctrl+N, rail click) moves the
        // focus with the selection: the alternative is selecting an invisible
        // window, which reads as a dead command bar.
        focusedId: prev.focusedId ? sessionId : prev.focusedId,
        tiles: prev.tiles.map((t) => (t.sessionId === sessionId ? { ...t, lastSel: Date.now() } : t)),
      }));
  }, []);

  const toggleFocus = useCallback((sessionId) => {
    setStagePersist((prev) => ({
      ...prev,
      focusedId: prev.focusedId === sessionId ? null : sessionId,
      selectedId: sessionId,
      tiles: prev.tiles.map((t) => (t.sessionId === sessionId ? { ...t, lastSel: Date.now() } : t)),
    }));
  }, []);

  // Harness hook: open a session window by id without depending on which rows
  // the virtualized rail currently renders.
  useEffect(() => {
    window.__harborOpenSession = (id) => openSession({ id });
    return () => { delete window.__harborOpenSession; };
  }, [openSession]);

  const toggleTty = useCallback((sessionId) => {
    setStagePersist((prev) => ({
      ...prev,
      tiles: prev.tiles.map((t) => (t.sessionId === sessionId ? { ...t, tty: !t.tty } : t)),
    }));
  }, []);

  // Drop tiles whose session disappeared from the model (validated once real
  // data is in; a restored stage may reference deleted transcripts). Synthetic
  // windows are exempt: pane-keyed provisionals and just-launched sessions are
  // NEVER in the model yet; culling them killed the fresh-session flow
  // (live-caught).
  const modelReady = sidebarModelLoaded;
  useEffect(() => {
    if (!modelReady) return;
    setStagePersist((prev) => {
      const tiles = prev.tiles.filter((t) => {
        const id = String(t.sessionId);
        if (id.startsWith('pane:') || id.startsWith('live:')) return true;
        if (launchMetaRef.current.has(id)) return true;
        return sessionsById.has(id);
      });
      if (tiles.length === prev.tiles.length) return prev;
      const selectedId = tiles.some((t) => t.sessionId === prev.selectedId)
        ? prev.selectedId
        : (tiles[tiles.length - 1]?.sessionId || null);
      const focusedId = tiles.some((t) => t.sessionId === prev.focusedId)
        ? prev.focusedId
        : null;
      return { ...prev, tiles, selectedId, focusedId };
    });
  }, [modelReady, sessionsById]);

  // A provisional window adopts its real session id from the MODEL, not only
  // from the launch that opened it.
  //
  // A new session opens as a `pane:<paneId>` window Pat can type into at once,
  // and the id upgrade was emitted only by the launch flow, which watches for a
  // fresh transcript for 45 seconds and then gives up. Live-caught 2026-07-28,
  // and it looked exactly like lost work: he composed for twenty minutes, and
  // by the time he pressed Enter nobody was watching. The send landed and a
  // real session went to work on it, but the window kept the provisional id,
  // and provisional ids are excluded from transcript subscriptions, so it sat
  // on "Fresh session. Type below to start it." while his message ran out of
  // sight.
  //
  // The sidebar model carries the daemon's own pane-to-session pairing and
  // arrives continuously, so reading it here has no timeout to outlive and no
  // startup race to lose: a window already sitting wrong heals on the next
  // update. Doing this in the renderer instead of over IPC is deliberate; the
  // main-side version announced the pairing once, before the renderer had
  // restored its stage, and then never again.
  useEffect(() => {
    if (!modelReady) return;
    setStagePersist((prev) => {
      const plan = planProvisionalUpgrades({ ...prev, sessions: sessionsById.values() });
      if (!plan) return prev;
      for (const [from, to] of plan.renames) renameDraft(from, to);
      return { ...prev, tiles: plan.tiles, selectedId: plan.selectedId, focusedId: plan.focusedId };
    });
  }, [modelReady, sessionsById, renameDraft]);

  // ---- transcript subscriptions follow the open tile set ----
  const openTranscriptsRef = useRef(new Set());
  const [transcriptRetry, setTranscriptRetry] = useState(0);
  useEffect(() => {
    const want = new Set(tiles.map((t) => t.sessionId)
      .filter((id) => !String(id).startsWith('live:') && !String(id).startsWith('pane:')));
    for (const id of want) {
      if (!openTranscriptsRef.current.has(id)) {
        openTranscriptsRef.current.add(id);
        const session = sessionsById.get(id);
        const launch = launchMetaRef.current.get(id);
        window.harbor.transcript.open({
          sessionId: id,
          provider: session?.provider || launch?.provider || 'claude',
          cwd: session?.cwd || launch?.cwd || null,
          model: launch?.model || null,
        }).then((res) => {
          // No transcript on disk (a live session that has not spoken yet):
          // say so instead of showing "Loading…" forever.
          if (res && res.ok === false) {
            setTranscripts((prev) => {
              const next = new Map(prev);
              if (!next.has(id)) next.set(id, { blocks: [], header: null, missing: true });
              return next;
            });
            // ...but "not yet" is not "never". A brand-new session writes its
            // transcript on its FIRST MESSAGE, so an open attempted before that
            // legitimately fails, and this used to be permanent: the id stayed
            // in the open set, nothing retried, and the window sat on "No
            // transcript yet" while the session filled up out of sight
            // (live-caught twice on 2026-07-28). Forget it so the next pass
            // tries again.
            openTranscriptsRef.current.delete(id);
          }
        }).catch(() => { openTranscriptsRef.current.delete(id); });
      }
    }
    for (const id of [...openTranscriptsRef.current]) {
      if (!want.has(id)) {
        openTranscriptsRef.current.delete(id);
        window.harbor.transcript.close({ sessionId: id }).catch(() => {});
        setTranscripts((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
      }
    }
  }, [tiles, sessionsById, transcriptRetry]);

  // Re-run the open pass on a slow tick, so a transcript that appears after its
  // window opened is picked up even when nothing else in the model changes.
  useEffect(() => {
    const timer = setInterval(() => setTranscriptRetry((n) => n + 1), 3000);
    return () => clearInterval(timer);
  }, []);

  // Renderer stall capture: cheap always-on, so the next freeze Pat hits leaves
  // a measurement behind (see perf-watch.js).
  const stallContext = useRef(null);
  if (!stallContext.current) stallContext.current = createStallContext();
  useEffect(() => installPerfWatch(stallContext.current), []);

  useEffect(() => window.harbor.transcript.onUpdate((update) => {
    stallContext.current.noteTranscript();
    setTranscripts((prev) => {
      const next = new Map(prev);
      const current = next.get(update.sessionId) || { blocks: [], header: null };
      let blocks = current.blocks;
      if (update.replace) {
        blocks = update.replace;
      } else {
        if (update.append?.length) blocks = [...blocks, ...update.append];
        if (update.changed?.length) {
          const byKey = new Map(update.changed.map((b) => [b.key, b]));
          blocks = blocks.map((b) => byKey.get(b.key) || b);
        }
      }
      next.set(update.sessionId, { blocks, header: update.header || current.header });
      return next;
    });
  }), []);

  // ---- send status ----
  useEffect(() => window.harbor.session.onSendStatus((status) => {
    stallContext.current?.noteStatus();
    if (window.__harborUiDebug) console.log('[ui] status arrived', JSON.stringify(status), Date.now());
    setSendStates((prev) => {
      const next = new Map(prev);
      next.set(status.sessionId, status);
      return next;
    });
    if (status.phase === 'sent') {
      setTimeout(() => setSendStates((prev) => {
        if (prev.get(status.sessionId)?.phase !== 'sent') return prev;
        const next = new Map(prev);
        next.delete(status.sessionId);
        return next;
      }), 2500);
    }
  }), []);

  // A launch the main process completed (new session or resume) opens its
  // window without further clicks; the fresh session is never invisible.
  // New sessions arrive twice: a provisional pane-keyed window first (Claude
  // writes no transcript until the first message), then an in-place UPGRADE
  // to the real session id once the transcript materializes.
  useEffect(() => window.harbor.session.onLaunched((info) => {
    // The upgrade carries the launch config FORWARD onto the real id. A window
    // learns that id two ways, and only one of them knows what it was launched
    // with: the launch flow's own event has model/effort, the daemon's
    // pane-to-session pairing has neither and can arrive first (2026-08-02, Pat:
    // "i cant even see what model im in for these new sessions"). Merging keeps
    // the chip honest for the whole stretch before the first message writes a
    // transcript to read it from.
    launchMetaRef.current.set(info.sessionId, mergeLaunchMeta(
      launchMetaRef.current.get(info.replacesKey || info.sessionId),
      info,
    ));
    bumpLaunchFacts();
    if (info.replacesKey) {
      // The draft moves WITH the window. Drafts key to the session id, so an
      // id upgrade orphaned whatever Pat had typed into the provisional window
      // and the composer, reading the new id, blanked itself mid-sentence
      // (2026-07-27). This runs before the id swap so the text is already under
      // the new key when the composer re-reads it.
      renameDraft(info.replacesKey, info.sessionId);
      setStage((prev) => {
        // Pat closed the provisional window: do not resurrect it.
        if (!prev.tiles.some((t) => t.sessionId === info.replacesKey)) return prev;
        // A window for the real id may ALREADY be open (he reopened the session
        // from the rail while its launch was still provisional). Upgrading
        // blindly then leaves two windows claiming one session, which is a
        // broken state: two transcripts of the same file, two composers, two
        // drafts, and every `[data-session-id]` lookup ambiguous. The upgraded
        // window wins the id and the older duplicate goes, because the upgraded
        // one is the one Pat has been typing into. Gate-caught 2026-07-28.
        const upgraded = prev.tiles
          .filter((t) => t.sessionId !== info.sessionId || t.sessionId === info.replacesKey)
          .map((t) => (t.sessionId === info.replacesKey ? { ...t, sessionId: info.sessionId } : t));
        const next = {
          ...prev,
          tiles: upgraded,
          selectedId: prev.selectedId === info.replacesKey || prev.selectedId === info.sessionId
            ? info.sessionId
            : prev.selectedId,
        };
        persist(next);
        return next;
      });
      return;
    }
    openSession({ id: info.sessionId, provider: info.provider });
  }), [openSession, renameDraft]);

  // openSession needs real session facts once the model catches up; a launched
  // id may not be in the model yet. Synthesize a minimal session row until the
  // indexer emits it.
  const sessionsWithSynthetic = useMemo(() => {
    const map = new Map(sessionsById);
    for (const tile of tiles) {
      const raw = launchMetaRef.current.get(tile.sessionId);
      const meta = raw && raw.model && !raw.modelLabel
        ? { ...raw, modelLabel: modelLabel(raw.model, raw.provider || 'claude') }
        : raw;
      const known = map.get(tile.sessionId);
      if (known) {
        // A row the model DOES describe still says nothing about the model or
        // effort: the rail is about identity. Fill those from the launch (never
        // overwrite; a real fact outranks the argv), or a window whose id has
        // upgraded loses the only description it had.
        map.set(tile.sessionId, withLaunchFacts(known, meta));
        continue;
      }
      map.set(tile.sessionId, {
        id: tile.sessionId,
        project: meta?.cwd ? meta.cwd.split('/').filter(Boolean).pop() : '…',
        title: 'New session',
        home: normalizeProfileHome(meta?.account, profiles.length ? profiles : null) || defaultProfileId,
        provider: meta?.provider || 'claude',
        model: meta?.model || null,
        modelLabel: meta?.modelLabel || null,
        effort: meta?.effort || null,
        cwd: meta?.cwd || null,
        isLive: false,
        paneId: null,
        workspaceId: null,
        isChildTask: false,
        childTitle: null,
      });
    }
    return map;
  }, [sessionsById, tiles, profiles, defaultProfileId, launchFactsVersion, modelLabel]);

  const summaryWorkspaces = useMemo(() => [...new Set(tiles.map((tile) => (
    sessionsWithSynthetic.get(tile.sessionId)?.cwd
  )).filter(Boolean))], [sessionsWithSynthetic, tiles]);
  const summaryWorkspaceKey = summaryWorkspaces.join('\n');

  useEffect(() => {
    let active = true;
    const unsubscribe = window.harbor.orchestration.onSummaries((summaries) => {
      if (active) setOrchSummaries(summaries || {});
    });
    window.harbor.orchestration.watchSummaries({ workspaces: summaryWorkspaces })
      .then((summaries) => { if (active) setOrchSummaries(summaries || {}); })
      .catch(() => { if (active) setOrchSummaries({}); });
    return () => {
      active = false;
      unsubscribe();
      window.harbor.orchestration.unwatchSummaries().catch(() => {});
    };
  }, [summaryWorkspaceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- control discipline: the selected tile's pane holds control ----
  const prevControlRef = useRef(null);
  const selectedSession = sessionsWithSynthetic.get(selectedId) || null;
  const selectedPaneId = selectedSession ? resolvePane(selectedSession)?.paneId || null : null;
  useEffect(() => {
    const session = selectedSession;
    const pane = session ? resolvePane(session) : null;
    if (pane?.paneId) {
      if (prevControlRef.current !== pane.paneId) {
        prevControlRef.current = pane.paneId;
        window.harbor.pane.focus({ paneId: pane.paneId, workspaceId: pane.workspaceId }).catch(() => {});
      }
    } else if (prevControlRef.current) {
      window.harbor.terminal.blurPane({ paneId: prevControlRef.current }).catch(() => {});
      prevControlRef.current = null;
    }
  }, [selectedSession, selectedPaneId, resolvePane]);

  // ---- rendered terminals are the only pty streams the renderer consumes ----
  // "Rendered" by the SAME rule the tile draws with (terminal-view.cjs): the
  // explicit >_ toggle AND the codex/cursor fallback. Registering only the
  // toggle left every fallback terminal observerless: no backfill, no frames,
  // an empty black box over a live session (2026-08-08).
  const paneSizesRef = useRef(new Map());
  const ttyPaneIds = useMemo(() => tiles
    .filter((t) => {
      const session = sessionsWithSynthetic.get(t.sessionId);
      if (!session) return false;
      return terminalView({
        session,
        data: transcripts.get(session.id) || null,
        pane: resolvePane(session),
        tty: Boolean(t.tty),
      }).showTerminal;
    })
    .map((t) => {
      const session = sessionsWithSynthetic.get(t.sessionId);
      return session ? resolvePane(session)?.paneId : null;
    })
    .filter(Boolean), [tiles, sessionsWithSynthetic, transcripts, resolvePane]);
  const ttyKey = ttyPaneIds.join(',');
  useEffect(() => {
    const panes = ttyPaneIds.map((paneId) => ({
      paneId,
      ...(paneSizesRef.current.get(paneId) || {}),
    }));
    window.harbor.terminal.setVisiblePanes(panes).catch(() => {});
  }, [ttyKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const pendingInputRef = useRef(new Map());
  const xterm = useMemo(() => ({
    onFrame: bridge.onFrame,
    onBackfill: bridge.onBackfill,
    onReset: bridge.onReset,
    onFocusPane: async (paneId, size) => {
      if (size) paneSizesRef.current.set(paneId, size);
      await bridge.focusPane({ paneId, cols: size?.cols, rows: size?.rows });
    },
    onBlurPane: async (paneId) => { await bridge.blurPane({ paneId }); },
    onResizePane: (paneId, size) => {
      paneSizesRef.current.set(paneId, size);
      bridge.resizePane({ paneId, ...size });
    },
    onSendInput: async (paneId, text) => {
      const result = await bridge.sendInput({ paneId, text });
      if (result?.ok === false && /not focused for control/.test(result.reason || '')) {
        const pending = pendingInputRef.current.get(paneId) || { chunks: [], at: Date.now() };
        if (Date.now() - pending.at < 2000) {
          pending.chunks.push(text);
          pendingInputRef.current.set(paneId, pending);
        }
      }
    },
  }), [bridge]);

  useEffect(() => bridge.onControlState(({ paneId, status }) => {
    if (status !== 'controlled') return;
    const pending = pendingInputRef.current.get(paneId);
    pendingInputRef.current.delete(paneId);
    if (pending && Date.now() - pending.at < 2000) {
      for (const chunk of pending.chunks) bridge.sendInput({ paneId, text: chunk });
    }
  }), [bridge]);

  // ---- command bar actions ----
  // Every command-bar dispatch (plain message, /model, /effort) goes through
  // one path so a slash-command that fails to land surfaces the SAME honest
  // error line as a message, instead of index.jsx's old swallowed .catch that
  // let a silently-failed /model read as success.
  const dispatchToSelected = useCallback(async (text, images = []) => {
    const session = sessionsWithSynthetic.get(selectedId);
    if (!session) return false;
    const result = await window.harbor.session.send({
      sessionId: session.id,
      text,
      images,
      pane: resolvePane(session),
      detectedHome: session.home,
      provider: session.provider || 'claude',
    }).catch((error) => ({ ok: false, reason: String(error?.message || error) }));
    if (!result?.ok) {
      setSendStates((prev) => {
        const next = new Map(prev);
        next.set(session.id, { sessionId: session.id, phase: 'error', detail: result?.reason || 'send failed' });
        return next;
      });
      return false;
    }
    return true;
  }, [selectedId, sessionsWithSynthetic, resolvePane]);

  const sendToSelected = useCallback((text, images) => dispatchToSelected(text, images), [dispatchToSelected]);

  const interruptSelected = useCallback(async () => {
    const session = sessionsWithSynthetic.get(selectedId);
    const pane = session ? resolvePane(session) : null;
    if (!pane?.paneId) return { ok: false, reason: 'no live pane to interrupt' };
    return window.harbor.session.interrupt({ paneId: pane.paneId });
  }, [selectedId, sessionsWithSynthetic, resolvePane]);

  const cancelQueuedSend = useCallback(async (sendId) => {
    if (!selectedId || !sendId) return { ok: false, reason: 'queued message not found' };
    return window.harbor.session.cancelSend({ sessionId: selectedId, sendId });
  }, [selectedId]);

  // ---- live voice mode ----------------------------------------------------
  // Pat talks to a realtime OpenAI voice agent that can READ and DRIVE his open
  // Claude sessions (Pat's choice, 2026-07-27; Anthropic has no voice API to
  // speak them directly). These are the only capabilities it gets, and each one
  // reuses the exact path the keyboard uses, so a spoken send carries every
  // guard a typed one does and shows up in the conversation the same way.
  const voiceSessions = useCallback(async () => tiles.map((tile) => {
    const session = sessionsWithSynthetic.get(tile.sessionId);
    if (!session) return null;
    const data = transcripts.get(session.id);
    const header = data?.header || null;
    const state = header?.blocked ? 'waiting on you'
      : header?.working ? 'working'
        : session.isLive || resolvePane(session) ? 'ready' : 'not running';
    return {
      id: session.id,
      project: !session.project || session.project === '~' ? 'home' : session.project,
      title: session.isChildTask && session.childTitle ? session.childTitle : session.title,
      state,
      model: header?.model?.name || session.model || null,
      contextPct: typeof header?.contextPct === 'number' ? header.contextPct : null,
      selected: session.id === selectedId,
    };
  }).filter(Boolean), [tiles, sessionsWithSynthetic, transcripts, resolvePane, selectedId]);

  const voiceRead = useCallback(async (sessionId, limit) => {
    const blocks = transcripts.get(sessionId)?.blocks || [];
    return blocks
      .filter((block) => (block.kind === 'user' || block.kind === 'assistant') && block.text)
      .slice(-limit)
      .map((block) => ({ who: block.kind === 'user' ? 'pat' : 'claude', text: String(block.text).slice(0, 1200) }));
  }, [transcripts]);

  const voiceSend = useCallback(async (sessionId, text) => {
    const session = sessionsWithSynthetic.get(sessionId);
    if (!session) return { ok: false, reason: 'that session window is not open any more' };
    return window.harbor.session.send({
      sessionId: session.id,
      text,
      images: [],
      pane: resolvePane(session),
      detectedHome: session.home,
      provider: session.provider || 'claude',
    }).catch((error) => ({ ok: false, reason: String(error?.message || error) }));
  }, [sessionsWithSynthetic, resolvePane]);

  const voiceInterrupt = useCallback(async (sessionId) => {
    const session = sessionsWithSynthetic.get(sessionId);
    const pane = session ? resolvePane(session) : null;
    if (!pane?.paneId) return { ok: false, reason: 'that session has no live pane to interrupt' };
    return window.harbor.session.interrupt({ paneId: pane.paneId });
  }, [sessionsWithSynthetic, resolvePane]);

  const voiceSelect = useCallback(async (sessionId) => {
    setStage((prev) => {
      if (!prev.tiles.some((tile) => tile.sessionId === sessionId)) return prev;
      const next = { ...prev, selectedId: sessionId };
      persist(next);
      return next;
    });
  }, []);

  const voice = useVoiceAgent({
    getSessions: voiceSessions,
    readSession: voiceRead,
    sendToSession: voiceSend,
    interruptSession: voiceInterrupt,
    selectSession: voiceSelect,
  });

  // E2E seam: the harness has no microphone, so a drive injects what Pat would
  // have SAID over the live data channel and then asserts on the real tool calls
  // that follow. Only the speech is substituted; the connection, the model and
  // every tool are the real thing.
  useEffect(() => {
    if (!window.harbor?.e2e) return undefined;
    window.__harborVoice = voice;
    // The audited tool surface, so a spec can assert the model is never handed
    // anything that could close a window or kill a process.
    window.__harborVoiceTools = VOICE_TOOL_NAMES;
    return () => { delete window.__harborVoice; delete window.__harborVoiceTools; };
  }, [voice]);

  // Notice a session settling so the voice can report back on what it started.
  // Keyed on the working flag going false, read from the transcript rather than
  // from herdr's agent status, because agent detection lags 60-150s and the
  // whole point is to hear the outcome promptly.
  const wasWorkingRef = useRef(new Map());
  useEffect(() => {
    const previous = wasWorkingRef.current;
    const next = new Map();
    for (const [sessionId, data] of transcripts) {
      const working = Boolean(data?.header?.working);
      next.set(sessionId, working);
      if (previous.get(sessionId) === true && !working) {
        const blocks = data?.blocks || [];
        const last = [...blocks].reverse().find((block) => block.kind === 'assistant' && block.text);
        const session = sessionsWithSynthetic.get(sessionId);
        voice.sessionSettled(sessionId, session?.title || 'a session', last?.text || '');
      }
    }
    wasWorkingRef.current = next;
  }, [transcripts, sessionsWithSynthetic, voice]);

  // A failed resume used to be swallowed whole (.catch(() => {}) plus an
  // ignored result), so a resume that refused looked identical to one that
  // worked: nothing on screen either way. It reports like a send now.
  const resumeSelected = useCallback(async () => {
    const session = sessionsWithSynthetic.get(selectedId);
    if (!session) return;
    const result = await window.harbor.session.send({
      sessionId: session.id,
      text: '',
      resumeOnly: true,
      pane: resolvePane(session),
      detectedHome: session.home,
      // Was omitted, so resuming a dead codex or cursor session was driven as
      // claude: the wrong resume binary aimed at a foreign session id.
      provider: session.provider || 'claude',
    }).catch((error) => ({ ok: false, reason: String(error?.message || error) }));
    if (result?.ok) return;
    setSendStates((prev) => {
      const next = new Map(prev);
      next.set(session.id, {
        sessionId: session.id,
        phase: 'error',
        detail: result?.reason || 'resume failed',
      });
      return next;
    });
  }, [selectedId, sessionsWithSynthetic, resolvePane]);

  const takeoverSelected = useCallback(async (draft = '', images = []) => {
    const session = sessionsWithSynthetic.get(selectedId);
    if (!session) return false;
    const result = await window.harbor.session.takeover({ sessionId: session.id })
      .then(() => ({ ok: true }))
      .catch((error) => ({ ok: false, reason: String(error?.message || error) }));
    if (!result.ok) {
      setSendStates((prev) => {
        const next = new Map(prev);
        next.set(session.id, { sessionId: session.id, phase: 'error', detail: result.reason });
        return next;
      });
      return false;
    }
    if (draft || images.length) return dispatchToSelected(draft, images);
    return true;
  }, [selectedId, sessionsWithSynthetic, dispatchToSelected]);

  // A /model or /effort switch is only "requested" until the transcript header
  // chip flips (the parser reads the CLI's "Set model to X" confirmation).
  const switchModel = useCallback((alias) => dispatchToSelected(`/model ${alias}`), [dispatchToSelected]);
  const switchEffort = useCallback((level) => dispatchToSelected(`/effort ${level}`), [dispatchToSelected]);

  // Reconfiguring an EXISTING session's model/effort IS a message, not a new
  // launch: a session in an outside terminal is adopted first, a dead one
  // resumes first, a drivable one takes it directly. The adopt/resume happens
  // ONCE (on the first delivery), then both switches deliver into the now-live
  // pane the main side resolves from its link registry, so a model+effort
  // change never tries to adopt twice. Without this, changing an outside
  // session's model launched a brand-new session instead (live-caught
  // 2026-07-20, Pat: "the only route is to create a new session").
  const reconfigureSelected = useCallback(async ({ model, effort } = {}) => {
    const session = sessionsWithSynthetic.get(selectedId);
    if (!session) return false;
    if (isExternalLive(session)) {
      const adopted = await takeoverSelected('');
      if (!adopted) return false;
    }
    let ok = true;
    if (model) ok = Boolean(await dispatchToSelected(`/model ${model}`)) && ok;
    if (effort) ok = Boolean(await dispatchToSelected(`/effort ${effort}`)) && ok;
    // A session with no transcript yet (a new one, which is exactly where this
    // matters) has nothing to report the switch back from, so what was applied
    // is recorded here. Only on success, and only what was actually sent: a
    // chip claiming a model the send refused would be worse than the old
    // silence.
    if (ok && (model || effort)) {
      launchMetaRef.current.set(session.id, mergeLaunchMeta(
        launchMetaRef.current.get(session.id),
        {
          model: model || null,
          modelLabel: model ? modelLabel(model, session.provider || 'claude') : null,
          effort: effort || null,
        },
      ));
      bumpLaunchFacts();
    }
    return ok;
  }, [selectedId, sessionsWithSynthetic, isExternalLive, takeoverSelected, dispatchToSelected,
    modelLabel, bumpLaunchFacts]);

  const runWorkflow = useCallback(async (id) => {
    const session = sessionsWithSynthetic.get(selectedId);
    if (!session) return false;
    const header = transcripts.get(session.id)?.header || null;
    const result = await window.harbor.session.runWorkflow({
      id,
      current: {
        sessionId: session.id,
        cwd: session.cwd,
        account: session.home,
        provider: session.provider || 'claude',
        model: header?.model?.id || null,
        effort: header?.effort || 'default',
        pane: resolvePane(session),
      },
    }).catch((error) => ({ ok: false, reason: String(error?.message || error) }));
    if (!result?.ok) {
      setSendStates((prev) => {
        const next = new Map(prev);
        next.set(session.id, { sessionId: session.id, phase: 'error', detail: result?.reason || 'workflow failed' });
        return next;
      });
      return false;
    }
    return true;
  }, [selectedId, sessionsWithSynthetic, transcripts, resolvePane]);

  const openNewSession = useCallback(async (input) => {
    const request = typeof input === 'string' ? { account: input } : (input || {});
    let folder = request.folder;
    let sessionId = request.sessionId;
    if (!folder && !sessionId && selectedId) {
      const selected = sessionsWithSynthetic.get(selectedId);
      folder = selected?.cwd || null;
      sessionId = folder ? null : selected?.id;
    }
    if (!folder && sessionId) {
      folder = sessionsWithSynthetic.get(sessionId)?.cwd || null;
      if (!folder) folder = await window.harbor.session.newFolder({ sessionId });
    }
    if (!folder) folder = await window.harbor.session.pickFolder();
    if (!folder) return;
    if (request.immediate) {
      // An immediate launch skips the popover, so anything the caller did not
      // name comes from the SAVED default rather than from bin/ai's own
      // fallbacks: buildNewArgv defaults model to null and effort to
      // 'default', which is not the opus + xhigh a one-click launch is
      // supposed to mean. The rail passes all three; a window's + button
      // passes only the account it inherited, and gets the rest from here so
      // there is exactly one place the default lives.
      const defaults = readNewSessionDefault();
      return window.harbor.session.newInProject({
        account: request.account || defaults.account,
        provider: request.provider || defaults.provider,
        model: request.model || defaults.model,
        effort: request.effort || defaults.effort,
        folder,
        sessionId,
      });
    }
    const defaults = readNewSessionDefault();
    setConfigRequest({ ...defaults, account: request.account || defaults.account, folder });
  }, [selectedId, sessionsWithSynthetic]);

  // Opening a window's config SELECTS that window first, so the modal's live
  // model/effort changes (which target the selected session) always land on
  // the window whose chip was clicked, not whatever was selected before.
  const openSessionConfig = useCallback((request) => {
    if (request.session?.id) selectTile(request.session.id);
    setConfigRequest(request);
  }, [selectTile]);

  // Windows OWN grid cells. Dropping into an empty cell moves the window
  // there (the vacated cell becomes a hole); dropping onto another window
  // swaps the two. This is what "move these around as needed" means; the old
  // order-packing model could not even represent bottom-left -> bottom-right
  // with three windows open (live-caught by Pat, repeatedly).
  const placeTile = useCallback((sessionId, cell) => {
    if (!Number.isInteger(cell) || cell < 0 || cell >= MAX_TILES) return;
    setStagePersist((prev) => {
      const source = prev.tiles.find((t) => t.sessionId === sessionId);
      if (!source || source.slot === cell) return prev;
      const tiles = prev.tiles.map((t) => {
        if (t.sessionId === sessionId) return { ...t, slot: cell };
        if (t.slot === cell) return { ...t, slot: source.slot };
        return t;
      });
      return { ...prev, tiles };
    });
  }, []);

  // ---- keyboard: ^1-9 select tiles, Alt+arrows move spatially, ^K search ----
  const ARROW_DIRECTIONS = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  };
  useEffect(() => {
    const onKey = (event) => {
      if (event.metaKey) return;
      // Alt+arrows move the selection around the stage grid (Pat, 2026-07-25;
      // moved off Ctrl the same day because the auto-focused composer needs
      // Ctrl+arrows for word-jump). Capture-phase and preventDefault so the
      // shortcut works even with focus in the composer or a terminal.
      if (event.altKey && !event.ctrlKey && !event.shiftKey && ARROW_DIRECTIONS[event.key]) {
        if (view !== 'agents' || tiles.length === 0) return;
        const slots = tiles.map((t, i) => (Number.isInteger(t.slot) ? t.slot : i));
        const selectedTile = tiles.find((t) => t.sessionId === selectedId);
        event.preventDefault();
        event.stopPropagation();
        if (!selectedTile) {
          const first = [...tiles].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))[0];
          if (first) selectTile(first.sessionId);
          return;
        }
        const { cols, rows } = gridNav.gridDimensions(Math.max(tiles.length, Math.max(...slots) + 1));
        const target = gridNav.navigateSlot({
          slots,
          fromSlot: Number.isInteger(selectedTile.slot) ? selectedTile.slot : 0,
          direction: ARROW_DIRECTIONS[event.key],
          cols,
          rows,
        });
        if (target === null) return;
        const targetTile = tiles.find((t, i) => (Number.isInteger(t.slot) ? t.slot : i) === target);
        if (targetTile) selectTile(targetTile.sessionId);
        return;
      }
      if (!event.ctrlKey || event.altKey) return;
      if (event.key >= '1' && event.key <= '9') {
        const bySlot = [...tiles].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
        const tile = bySlot[Number(event.key) - 1];
        if (tile) {
          event.preventDefault();
          event.stopPropagation();
          selectTile(tile.sessionId);
        }
      } else if (event.key === 'k' || event.key === 'K') {
        event.preventDefault();
        event.stopPropagation();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [tiles, selectTile, view, selectedId]);

  // ---- title bar data ----
  const liveSessions = useMemo(() => {
    const list = [];
    for (const project of sidebarModel.projects || []) {
      for (const session of project.sessions || []) {
        if (session.isLive) list.push(session);
      }
    }
    return list;
  }, [sidebarModel]);
  const liveCount = liveSessions.filter((s) => !s.isChildTask).length;
  const workers = liveSessions.filter((s) => s.isChildTask && s.paneId);
  const openSessionIds = useMemo(() => new Set(tiles.map((t) => t.sessionId)), [tiles]);
  const selectedDraft = selectedId ? getDraft(selectedId) : emptyDraft();
  const onDraftChange = useCallback((patch) => {
    if (!selectedId) return;
    patchDraft(selectedId, patch);
  }, [patchDraft, selectedId]);
  const onDraftClear = useCallback(() => {
    if (!selectedId) return;
    clearDraft(selectedId);
  }, [clearDraft, selectedId]);

  const drop = useFileDrop({
    sessionId: selectedId,
    sessionTitle: selectedSession?.title || null,
    getDraft,
    patchDraft,
  });

  return (
    <div className="app-root" data-dropping={drop.active ? drop.prompt.kind : undefined}>
      <div className="aurora" aria-hidden="true" />
      <TitleBar
        onOpenHelp={() => setHelpOpen(true)}
        onNewSession={openNewSession}
        profiles={profiles}
        liveCount={liveCount}
        workers={workers}
        onOpenWorker={openSession}
      />
      <ResizeGrips />
      <ContextMenu />
      {helpOpen ? <HelpOverlay onClose={() => setHelpOpen(false)} /> : null}
      {configRequest ? (
        <NewSessionConfig
          request={configRequest}
          onClose={() => setConfigRequest(null)}
          onStart={(payload) => window.harbor.session.newInProject(payload)}
          onReconfigure={reconfigureSelected}
        />
      ) : null}
      <main className="app-shell">
        <Sidebar
          onOpenOrch={openOrch}
          onOpenSession={openSession}
          onCloseSession={closeTile}
          openSessionIds={openSessionIds}
          selectedSessionId={selectedId}
          searchRef={searchRef}
          onNewSession={openNewSession}
          view={view}
          onViewChange={setView}
          orchEnabled={orchEnabled}
          taskAlert={taskAlert}
        />
        <section className="workspace">
          <UpdateBanner />
          <DaemonBanner />
          <div className="center-pane" aria-label="Workspace">
            {view === 'orch' ? (
              orchProject ? (
                <OrchPanel
                  project={orchProject}
                  onClose={() => { setOrchProject(null); setView('agents'); }}
                />
              ) : (
                <OrchProjectPicker projects={sidebarModel.projects} onPick={setOrchProject} />
              )
            ) : view === 'tasks' ? (
              <TasksView
                doc={tasks.doc}
                today={today}
                recovery={tasks.recovery}
                error={tasks.error}
                notice={tasks.notice}
                dismissNotice={tasks.dismissNotice}
                mutate={tasks.mutate}
              />
            ) : view === 'artifacts' ? (
              <ArtifactsView sessionsById={sessionsWithSynthetic} />
            ) : (
              <Stage
                tiles={tiles}
                sessionsById={sessionsWithSynthetic}
                transcripts={transcripts}
                selectedId={selectedId}
                resolvePane={resolvePane}
                sendStates={sendStates}
                externalControl={bridge.state.externalControl || {}}
                focusedId={stage.focusedId || null}
                onSelect={selectTile}
                onPlace={placeTile}
                onClose={closeTile}
                onToggleTty={toggleTty}
                onToggleFocus={toggleFocus}
                onNewSession={openNewSession}
                onSend={sendToSelected}
                onInterrupt={interruptSelected}
                liveVoice={voice}
                onCancelQueued={cancelQueuedSend}
                onResume={resumeSelected}
                onTakeover={takeoverSelected}
                onModelSwitch={switchModel}
                onEffortSwitch={switchEffort}
                onRunWorkflow={runWorkflow}
                onOpenConfig={openSessionConfig}
                orchSummaries={orchSummaries}
                onOpenOrch={(session) => openOrch({
                  label: session.project || 'Project',
                  sessions: [session],
                  queueId: orchSummaries[session.cwd]?.queueId || null,
                })}
                draft={selectedDraft}
                onDraftChange={onDraftChange}
                onDraftClear={onDraftClear}
                xterm={xterm}
                isExternalLive={isExternalLive}
              />
            )}
          </div>
        </section>
      </main>
      {drop.active ? (
        <div className={`drop-zone drop-zone-${drop.prompt.kind}`} aria-hidden="true">
          <div className="drop-zone-card">
            <span className="drop-zone-glyph">{drop.prompt.kind === 'refused' ? '✕' : '⤓'}</span>
            <span className="drop-zone-text">{drop.prompt.text}</span>
          </div>
        </div>
      ) : null}
      {drop.report ? (
        <div className="drop-toast" role="status">{drop.report}</div>
      ) : null}
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ProfilesProvider>
      <App />
      {/* Deliberately a SIBLING of App, not a gate around it: first run must
          not entangle itself with the rail, the stage or their persisted
          state, and the wizard is a full-surface overlay either way. */}
      <SetupGate />
    </ProfilesProvider>
  </React.StrictMode>,
);
