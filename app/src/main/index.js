'use strict';

const { app, BrowserWindow, Menu, ipcMain: electronIpcMain, dialog, clipboard, nativeImage, Notification, powerMonitor, protocol, session, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createSidebarBridge } = require('./sidebar-bridge.js');
const { projectLabelForCwd: sharedProjectLabelForCwd } = require('../shared/project-label.cjs');
const {
  ARTIFACT_SCHEME,
  artifactUrl,
  filePathFromUrlPath,
} = require('../shared/artifact-url.cjs');
const { createHistoryProvider } = require('./providers/history.js');
const { createTitlesProvider, scheduleTitler: scheduleTitlesProvider } = require('./providers/titles.js');
const { createConfigStore } = require('./config/store.js');
const { createLaunchActions } = require('./actions/launch.js');
const {
  createSessionOwnerProbe,
  createTakeoverOwner,
  createTakeoverHandler,
  createSessionOperationGate,
  startResumeFollowup,
} = require('./actions/takeover.js');
const { platform } = require('./platform/index.js');
const {
  resolveContextDir, resolveSignalPolicy, resolveLaunchPolicy, resolveDialogPolicy, resolveSessionStorePolicy,
  createSignalGuard, createDialogGuard, createInjectableExecFile, resolveE2eFakeLaunch,
} = require('./isolation.js');
const {
  createOrchestrationActions,
  checkExecuteMutex,
} = require('./actions/orchestration.js');
const { createTerminalBridge } = require('./terminal-bridge.js');
const { deleteSessionTranscript } = require('./session-delete.js');
const { createControlClient } = require('./session-daemon/factory.js');
const { startLagMonitor } = require('./lag-monitor.js');
const { createGpuTelemetry } = require('./gpu-telemetry.js');
const { createUsageProvider } = require('./providers/usage.js');
const { createWorkflowRuns } = require('./providers/workflow-runs.js');
const { readAccountEmails, createAccountsProvider } = require('./providers/accounts.js');
const {
  configureModelCatalog, createCapabilitiesProvider, newSessionOptions, modelCatalog, MODEL_VERSION_SEED,
} = require('./providers/capabilities.js');
const { compareVersionsDesc } = require('./providers/model-catalog.js');
const { createDelegateProvider, deriveRun, findQueueForWorkspace, queuePath } = require('./providers/delegate.js');
const { createTranscriptProvider, waitForHandoffPath, findProviderTranscript, TranscriptParser } = require('./providers/transcript.js');
const { createAskTranscriptResolver } = require('./ask-transcript-path.js');
const { createPendingAskReader } = require('./providers/pending-ask.js');
const { createSessionSend, createLinkRegistry } = require('./session-send.js');
const { revealNewSessionWindow } = require('./new-session-window.cjs');
const { resolveWorkflowLaunch } = require('./workflows.js');
const {
  startSessionDaemon,
  parseSecondInstanceArgs,
  buildSecondInstancePayload,
} = require('./lifecycle.js');
const { createNotifier } = require('./notify.js');
const { canReceivePush, planRendererRecovery } = require('./renderer-recovery.js');
const { createBootRecovery } = require('./boot-recovery.js');
const { createArtifactsProvider } = require('./providers/artifacts.js');
const { createTaskStore } = require('./providers/tasks.js');
const { createNoteStore } = require('./providers/notes.js');
const { createWhiteboardStore } = require('./providers/whiteboard.js');
const { createArtifactThumbs } = require('./providers/artifact-thumbs.js');
const { createProjectIconProvider } = require('./providers/project-icons.js');
const { createIconGenerator, scheduleIconGen } = require('./providers/icon-gen.js');
const { createDaemonWatchdog } = require('./daemon-watchdog.js');
const { createWedgeRecovery } = require('./wedge-recovery.js');
const {
  createImageWriter,
  createImageReader,
  registerClipboardImageIpc,
} = require('./clipboard-images.js');
const { registerWhisperIpc } = require('./whisper-transcription.js');
const { registerVoiceIpc } = require('./voice-realtime.js');
const { registerContextMenuIpc, attachContextMenu } = require('./context-menu.js');
const { registerSetupIpc } = require('./setup/ipc.js');
const { createRouter } = require('./rpc/router.js');
const { bindIpcMain } = require('./rpc/ipc-transport.js');

const rpcRouter = createRouter();
const ipcMain = {
  handle(method, handler) {
    rpcRouter.register(method, (payload, ctx) => handler(ctx.event, payload));
  },
  on(method, handler) {
    rpcRouter.register(method, (payload, ctx) => handler(ctx.event, payload));
  },
};

// The platform layer owns clipboard and notification capability; it needs the
// Electron bindings injected once, here at the composition root, so the adapters
// stay unit-testable without Electron.
platform.configureElectron({ clipboard, nativeImage, Notification });

let harborConfig = null;
let configStore = null;

function configuredProfileId(id) {
  if (!harborConfig) return id || null;
  return harborConfig.profiles.find((profile) => profile.id === id)?.id
    || harborConfig.profiles.find((profile) => profile.isDefault)?.id
    || harborConfig.profiles[0]?.id
    || null;
}

// The Artifacts view renders agent-produced files through this scheme instead
// of file://, so the ONLY local content reachable from the renderer is what
// the artifacts index explicitly allowlists (the handler refuses everything
// else). Registration must happen before app ready. The scheme NAME and the
// path rule both live in ../shared/artifact-url so the renderer that builds a
// URL and this handler that serves it cannot drift apart.
// Per-project icons come from the user's own directory rather than the bundle,
// so they need a scheme too. Same posture as artifacts: the handler serves only
// a file the index found in that one folder, and never a path composed from
// anything the renderer said.
const ICON_SCHEME = 'harbor-icon';
protocol.registerSchemesAsPrivileged([
  { scheme: ARTIFACT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: ICON_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function broadcastDaemonBanner() {
  sendToRenderer('daemon:banner', daemonBanner);
}

// Ping the session daemon and start it when needed. HARBOR_NO_DAEMON_START=1
// keeps harnesses from touching the real daemon. `recover: true` routes the
// start through `harbor-sessiond recover` (the wedge lane: identity-verified
// put-down of a mute owner, then start) and waits longer, because recover's
// hysteresis and release waits legitimately take ~15-25s where a plain start
// answers in ~1s. Boot-time connects stay plain `start`: there is no wedge
// evidence at boot, and recover's hysteresis would slow every cold start.
async function connectDaemon({ recover = false } = {}) {
  const pingOnce = async () => {
    try {
      await createControlClient({ env: process.env, sessionStorePolicy }).ping();
      return null;
    } catch (error) { return error; }
  };
  let failure = await pingOnce();
  if (failure && process.env.HARBOR_NO_DAEMON_START !== '1') {
    console.log(`session daemon not answering; ${recover ? 'recovering' : 'starting'} via harbor-sessiond`);
    try { startSessionDaemon(undefined, { recover }); } catch (error) {
      console.warn(`harbor-sessiond ${recover ? 'recover' : 'start'} failed:`, error.message);
    }
    const attempts = recover ? 160 : 20;
    for (let attempt = 0; attempt < attempts && failure; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      failure = await pingOnce();
    }
  }
  if (!failure) {
    daemonBanner = 'ok';
    return true;
  }
  daemonBanner = { error: `connect_failed: ${failure.message}` };
  broadcastDaemonBanner();
  return false;
}

// E2E instances must never share the real profile: the renderer persists the
// stage (localStorage) there, and a test run would restore; or clobber;
// Pat's actual open windows.
if (process.env.HARBOR_E2E === '1') {
  // A pinned profile lets a harness keep state that is expensive to rebuild
  // per run (the spellchecker's downloaded .bdic dictionary is the reason this
  // exists). Still never the real profile: the default stays per-pid throwaway.
  app.setPath('userData', process.env.HARBOR_E2E_USER_DATA
    || path.join(os.tmpdir(), `harbor-e2e-${process.pid}`));
}

// A harness has no microphone, and live voice mode needs one. Chromium's fake
// capture device supplies a synthetic stream so the WebRTC handshake, the data
// channel and the tool loop can all be driven for real; only the audio is fake.
// E2E ONLY: Pat's own runs must use his actual microphone and be asked properly.
if (process.env.HARBOR_E2E === '1') {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

const smokeMode = process.argv.includes('--smoke');
// Out-of-band restarts (daemon watchdog, ship-loop relaunches) come up WITHOUT
// taking focus: mutter maps an unfocused window below the focused one, so a
// game keeps the screen. This replaces the accidental protection the game's
// always-on-top used to provide (its focus-denial side effect died with the
// 2026-07-15 toast fix; live-caught 2026-07-24 when a restart landed on the
// game). Pat's own launches and clicks keep normal focus.
const noFocusSteal = process.argv.includes('--no-focus-steal');
const verifyMode = process.argv.includes('--verify-sidebar');
const verifyTerminalMode = process.argv.includes('--verify-terminal');
const verifyMetersMode = process.argv.includes('--verify-meters');
const verifyOrchMode = process.argv.includes('--verify-orch');
const stressMode = process.argv.includes('--stress-terminal');
const e2eMode = process.env.HARBOR_E2E === '1';
const e2eFakeLaunch = resolveE2eFakeLaunch(process.env);
const appStartMs = Date.now();
let coldStartInteractiveMs = null;
const e2eLaunchCalls = [];

let mainWindow = null;
let bootRecovery = null;
let sidebarBridge = null;
let terminalBridge = null;

// Push an IPC message to the renderer only if the window is still alive. A bare
// window.webContents.send(...) guards a null window but NOT a destroyed
// webContents: during a reload or quit, an in-flight pane-stream frame, status,
// or update can arrive after teardown and throw "Object has been destroyed",
// which surfaces as an uncaught-exception dialog (live-caught). Route every
// push through this guard instead.
function sendToRenderer(channel, ...args) {
  rpcRouter.emit(channel, ...args);
}

function getRendererWebContents() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const wc = mainWindow.webContents;
  // isDestroyed() alone is NOT enough: a CRASHED renderer leaves a WebContents
  // that reports itself healthy while the frame underneath is gone, and
  // Electron then prints the failure from inside send() where no try/catch of
  // ours can reach it. That is the 704 log lines of 2026-08-10. See
  // renderer-recovery.js.
  return canReceivePush(wc) ? wc : null;
}
// Assigned at the composition root, but it resolves the SAME policy on demand
// if called before that, so no ordering change can ever leave a native dialog
// unguarded (see main/isolation.js).
let assertDialogAllowed = (what) => createDialogGuard({
  policy: resolveDialogPolicy({
    userDataPath: app.getPath('userData'),
    defaultUserDataPath: path.join(app.getPath('appData'), app.getName()),
  }),
})(what);
let launchActions = null;
let takeoverHandler = null;
// Module scope on purpose: the E2E seam that asks whether a session still has a
// live owner is registered in registerIpc(), which runs long before the probe is
// built, so a function-scoped binding would make that handler a silent no-op.
let sessionOwnerProbe = null;
const sessionOperationGate = createSessionOperationGate();
let orchActions = null;
let delegateProvider = null;
let orchWatcher = null;
let orchSummaryWatchers = [];
let orchSummaryExpiryTimer = null;
let usageProvider = null;
let transcriptProvider = null;
let taskStore = null;
let noteStore = null;
let whiteboardStore = null;
// The live AskUserQuestion, read off the session's transcript file whenever the
// question card polls. Transcript paths are cached per session id; the reader
// caches the parse per file identity.
const pendingAskReader = createPendingAskReader();
// Which transcript the question card reads, and the two rules that keep it
// finding one: the index is a cache rather than the source of truth, and a miss
// is never remembered. Both are proven in test/main/ask-transcript-path.test.js;
// see that module's header for the incident.
const askTranscript = createAskTranscriptResolver({
  getSessionMeta: (sessionId) => sidebarBridge?.getSessionMeta?.(sessionId),
  findTranscript: findProviderTranscript,
});
async function liveAskFor(sessionId) {
  const transcriptPath = await askTranscript.resolve(sessionId);
  if (!transcriptPath) return null;
  return pendingAskReader.read(transcriptPath);
}
let sessionSend = null;
let capabilitiesProvider = null;
let paneLinks = null;
let stopMainLagMonitor = null;
let usageTimer = null;
let daemonWatchdog = null;
let notifier = null;
// Set once the app is on its way out, so a renderer dying as part of the quit
// is not mistaken for a crash worth recovering from.
let shuttingDown = false;
// Renderer deaths in the current streak, for the crash-loop bound.
let rendererDeaths = { count: 0, at: 0 };
let badgeUnsupportedLogged = false;
let daemonBanner = null; // 'ok' | { error, protocol?, schemaVersion? }
let sessionStorePolicy = null;
let pendingNewSessionIntent = null;

function setAppBadgeCount(count) {
  try {
    const supported = app.setBadgeCount(count);
    if (supported === false && !badgeUnsupportedLogged) {
      badgeUnsupportedLogged = true;
      console.warn('taskbar badge count is unsupported by this desktop environment');
    }
  } catch (error) {
    if (!badgeUnsupportedLogged) {
      badgeUnsupportedLogged = true;
      console.warn('taskbar badge count could not be updated:', error.message);
    }
  }
}

// One launch path for every new-session entry point (rail +P/+T, stage slot,
// app menu, Copilot-key chord). Claude Code does NOT write the session JSONL
// until the first message (live-caught 2026-07-18). Claude now receives a
// caller-minted id at launch, so its fresh pane opens on that real id. Codex
// cannot receive an id at launch, so it still opens on a provisional pane key
// and upgrades when the first message materializes its rollout.
async function launchNewSession({ account, cwd, provider = 'claude', model, effort = 'default', command = null, prompt = null }) {
  const [preIds, knownIds] = await Promise.all([
    sessionSend.paneIdSet(),
    provider === 'claude'
      ? Promise.resolve(new Set())
      : sessionSend.listTranscriptIds(cwd, provider),
  ]);
  const sinceMs = Date.now();
  const result = await launchActions.newSession({ account, cwd, provider, model, effort, prompt });
  revealNewSessionWindow({
    result,
    provider,
    cwd,
    account,
    model,
    effort,
    preIds,
    knownIds,
    sinceMs,
    findFreshPane: (args) => sessionSend.findFreshPane(args),
    findFreshTranscript: (args) => sessionSend.findFreshTranscript(args),
    setLink: (id, pane) => paneLinks.set(id, pane),
    focusPane: (pane) => terminalBridge.requestFocusPane(pane),
    emitLaunched: (payload) => {
      // The rail draws its own badge from the sidebar model, not from the
      // window's launch facts, so telling only the renderer left the rail row
      // wearing the default plan's letter for the whole pre-transcript gap.
      sidebarBridge?.noteLaunchedHome?.(payload.sessionId, payload.account);
      sendToRenderer('session:launched', payload);
    },
    onPaneReady: async (sessionId, fresh) => {
      // Effort is applied by the LAUNCH FLAG now (bin/ai passes --effort straight
      // to the claude CLI), not by typing "/effort <level>" once the composer
      // settles. That send was the 5-10s lag after every new session, and it
      // wiped whatever Pat had started typing in the meantime (2026-07-27): the
      // command materialized the transcript, the window's id upgraded from
      // pane:<id> to the real session id, and his draft was keyed to the old one.
      // Nothing here should ever write into a session Pat is already typing into.
      if (command) {
        try {
          const ready = await sessionSend.waitForClaudeReady(fresh.paneId);
          if (!ready) throw new Error(`${provider} did not become ready`);
          const sent = await sessionSend.send({ sessionId, text: command, pane: fresh, provider });
          if (!sent?.ok) throw new Error(sent?.reason || `could not send ${command}`);
        } catch (error) {
          sendToRenderer('send:status', {
            sessionId, phase: 'error', detail: `Preset command failed: ${error.message}`,
          });
        }
      }
    },
    refreshHistory: () => sidebarBridge?.refreshHistory?.() || Promise.resolve(),
  }).catch((error) => {
    console.error('new-session window reveal failed:', error.message);
  });
  return result;
}

function runNewSessionIntent(intent) {
  launchNewSession(intent).catch((err) => {
    console.error('new-session intent failed:', err.message);
    // The user pressed a chord and nothing appeared: say why, once.
    platform.notify('Harbor', `New session failed: ${err.message}`);
  });
}

function broadcastUsageUpdate() {
  if (!mainWindow) return;
  sendToRenderer('usage:update');
}

// THE canonical rule, from shared/project-label.cjs, not a copy of it. Both this
// file and src/server/compose.js kept their own hand-written version, each
// missing the Windows drive-letter branch the shared module has, which is
// exactly the two-labellers-for-one-directory shape that module's header
// records as a live incident (2026-08-05: one folder appeared as two rail
// groups because the sessiond adapter and the history index disagreed).
function projectLabelForCwd(cwd) {
  return sharedProjectLabelForCwd(cwd, os.homedir());
}

const WINDOW_STATE_PATH = path.join(os.homedir(), '.cache', 'harbor', 'window-state.json');

function readWindowState() {
  try { return JSON.parse(require('node:fs').readFileSync(WINDOW_STATE_PATH, 'utf8')); }
  catch { return null; }
}

function persistWindowState(window) {
  try {
    // While maximized, getBounds() is the full screen rect; save the normal
    // bounds so un-maximizing later restores the real size.
    const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
    require('node:fs').mkdirSync(path.dirname(WINDOW_STATE_PATH), { recursive: true });
    require('node:fs').writeFileSync(WINDOW_STATE_PATH, JSON.stringify({ ...bounds, maximized: window.isMaximized() }));
  } catch { /* never let state saving break the app */ }
}

function clampToDisplay(saved) {
  try {
    const { screen } = require('electron');
    const display = screen.getDisplayMatching(saved);
    const area = display.workArea;
    const intersects = saved.x < area.x + area.width && saved.x + saved.width > area.x
      && saved.y < area.y + area.height && saved.y + saved.height > area.y;
    if (intersects) return saved;
  } catch { /* fall through to centered default */ }
  return { width: saved.width, height: saved.height };
}

async function captureScreenshot(window, filename) {
  const image = await window.webContents.capturePage();
  const verifySubdir = e2eMode ? 'e2e' : '';
  const verifyDirectory = path.join(__dirname, '../../verify', verifySubdir);
  await fs.mkdir(verifyDirectory, { recursive: true });
  const target = path.join(verifyDirectory, filename);
  await fs.writeFile(target, image.toPNG());
  return target;
}

function markColdStartInteractive() {
  if (!e2eMode || coldStartInteractiveMs != null) return;
  coldStartInteractiveMs = Date.now() - appStartMs;
}

async function runVerifySidebar(window) {
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const paths = [];
  paths.push(await captureScreenshot(window, 'sidebar-default.png'));
  await window.webContents.executeJavaScript(`
    document.querySelector('.sidebar-search-input')?.focus();
    const input = document.querySelector('.sidebar-search-input');
    if (input) {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(input, 'cdt');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  `);
  await new Promise((resolve) => setTimeout(resolve, 800));
  paths.push(await captureScreenshot(window, 'sidebar-search.png'));
  await window.webContents.executeJavaScript(`
    document.querySelector('[data-filter="7d"]')?.click();
  `);
  await new Promise((resolve) => setTimeout(resolve, 800));
  paths.push(await captureScreenshot(window, 'sidebar-filter-7d.png'));
  await window.webContents.executeJavaScript(`
    const older = document.querySelector('.sidebar-older-button');
    if (older) older.click();
  `);
  await new Promise((resolve) => setTimeout(resolve, 800));
  paths.push(await captureScreenshot(window, 'sidebar-older-expanded.png'));
  const stats = await window.webContents.executeJavaScript(`
    ({
      sessionRows: document.querySelectorAll('.sidebar-session-row').length,
      indexerCount: window.__harborSidebarStats?.indexerSessionCount ?? null,
    })
  `);
  console.log('VERIFY_SCREENSHOTS', JSON.stringify(paths));
  console.log('VERIFY_STATS', JSON.stringify(stats));
  app.exit(0);
}

async function runVerifyTerminal(window) {
  await new Promise((resolve) => setTimeout(resolve, stressMode ? 7000 : 5000));
  const domProbe = await window.webContents.executeJavaScript(`
    ({
      paneCount: document.querySelectorAll('.terminal-pane').length,
      empty: document.querySelector('.terminal-empty')?.textContent ?? null,
      wsTabs: document.querySelectorAll('.terminal-workspace-tab').length,
      tabTabs: document.querySelectorAll('.terminal-tab').length,
    })
  `);
  console.log('VERIFY_TERMINAL_DOM_PROBE', JSON.stringify(domProbe));
  if (!domProbe.paneCount) {
    throw new Error('no terminal pane found');
  }
  const paths = [];
  paths.push(await captureScreenshot(window, 'terminal-3panes.png'));

  await window.webContents.executeJavaScript(`
    (async () => {
      const pane = document.querySelector('.terminal-pane');
      if (!pane) throw new Error('no terminal pane found');
      pane.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
    })()
  `);

  let focusedPaneId = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    focusedPaneId = terminalBridge.getState().controlledPaneId;
    if (focusedPaneId) break;
  }
  if (!focusedPaneId) {
    const bridgeState = terminalBridge.getState();
    const layout = Object.values(bridgeState.layouts || {})[0];
    focusedPaneId = layout?.panes?.[0]?.pane_id || null;
    if (focusedPaneId) {
      await terminalBridge.focusPane({ paneId: focusedPaneId, cols: 80, rows: 24 });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  const roundtripMarker = `harbor_roundtrip_${Date.now()}`;
  console.log('VERIFY_TERMINAL_CONTROL', JSON.stringify({
    focusedPaneId,
    externalControl: terminalBridge.getState().externalControl,
  }));
  if (focusedPaneId) {
    const sendResult = terminalBridge.sendInput(focusedPaneId, `echo ${roundtripMarker}\r`);
    console.log('VERIFY_TERMINAL_SEND', JSON.stringify(sendResult));
    await new Promise((resolve) => setTimeout(resolve, stressMode ? 4000 : 1500));
    let echoed = false;
    const deadline = Date.now() + (stressMode ? 8000 : 2000);
    const verifyClient = createControlClient({ env: process.env, sessionStorePolicy });
    while (Date.now() < deadline) {
      echoed = await window.webContents.executeJavaScript(`
        (() => {
          const rows = Array.from(document.querySelectorAll('.terminal-pane .xterm-rows'));
          return rows.some((el) => (el.textContent || '').includes(${JSON.stringify(roundtripMarker)}));
        })()
      `);
      if (echoed) break;
      try {
        const readRes = await verifyClient.readPane(focusedPaneId, {
          source: 'recent',
          lines: 30,
          strip_ansi: true,
        });
        echoed = (readRes?.read?.text || '').includes(roundtripMarker);
      } catch {
        // keep polling
      }
      if (echoed) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    console.log('VERIFY_TERMINAL_ROUNDTRIP', JSON.stringify({ marker: roundtripMarker, echoed }));
    if (!echoed) {
      console.error('typed input roundtrip failed: marker not visible in focused pane');
      app.exit(1);
      return;
    }
  }

  await window.setContentSize(1400, 900);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  paths.push(await captureScreenshot(window, 'terminal-resized.png'));

  const paneCount = await window.webContents.executeJavaScript(`
    document.querySelectorAll('.terminal-pane').length
  `);

  const durationMs = stressMode ? 12000 : 6000;
  await new Promise((resolve) => setTimeout(resolve, durationMs));

  const rendererLag = await window.webContents.executeJavaScript(`
    window.__harborLagReport ? window.__harborLagReport() : null
  `);
  const mainLag = stopMainLagMonitor ? stopMainLagMonitor() : null;

  console.log('VERIFY_TERMINAL_SCREENSHOTS', JSON.stringify(paths));
  console.log('VERIFY_TERMINAL_PANES', paneCount);
  console.log('VERIFY_TERMINAL_LAG', JSON.stringify({ main: mainLag, renderer: rendererLag }));

  if (rendererLag && rendererLag.p95Ms >= 100) {
    console.error(`renderer p95 lag ${rendererLag.p95Ms}ms exceeds 100ms threshold`);
    app.exit(1);
    return;
  }
  if (mainLag && mainLag.p95Ms >= 100) {
    console.error(`main p95 lag ${mainLag.p95Ms}ms exceeds 100ms threshold`);
    app.exit(1);
    return;
  }

  app.exit(0);
}

async function runVerifyMeters(window) {
  await new Promise((resolve) => setTimeout(resolve, 4500));
  const meterData = await window.webContents.executeJavaScript(`
    (() => {
      const tiles = Array.from(document.querySelectorAll('.meter-tile'));
      return tiles.map((t) => ({
        account: t.dataset.account,
        email: t.querySelector('.meter-email')?.textContent ?? null,
        fiveHour: t.querySelector('[data-metric="5h"] .meter-value')?.textContent ?? null,
        weekly: t.querySelector('[data-metric="wk"] .meter-value')?.textContent ?? null,
        cost: t.querySelector('[data-metric="cost"] .meter-value')?.textContent ?? null,
        unavailable: t.querySelector('.meter-unavailable') !== null,
      }));
    })()
  `);
  console.log('VERIFY_METERS_DATA', JSON.stringify(meterData));
  const paths = [];
  paths.push(await captureScreenshot(window, 'header-meters.png'));
  await window.webContents.executeJavaScript(`
    document.querySelector('.sidebar-new-row')?.scrollIntoView();
  `);
  await new Promise((resolve) => setTimeout(resolve, 500));
  paths.push(await captureScreenshot(window, 'new-session-split.png'));
  console.log('VERIFY_METERS_SCREENSHOTS', JSON.stringify(paths));
  app.exit(0);
}

async function runVerifyOrch(window) {
  await new Promise((resolve) => setTimeout(resolve, 4500));
  // Open the orch panel for this project (harbor)
  await window.webContents.executeJavaScript(`
    (async () => {
      const model = await window.harbor.sidebar.getState();
      const proj = (model.model.projects || []).find(p => p.label === 'harbor');
      if (!proj) throw new Error('harbor project not found in sidebar');
      window.__orchTestProject = proj;
      if (typeof window.__openOrchForTest !== 'function') throw new Error('__openOrchForTest not mounted');
      window.__openOrchForTest(proj);
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const orchVisible = await window.webContents.executeJavaScript(`
    document.querySelector('.orch-panel') !== null
  `);
  if (!orchVisible) throw new Error('orch panel did not appear');
  const paths = [];
  paths.push(await captureScreenshot(window, 'orch-panel.png'));

  // Fill in goal textarea for kickoff screenshot
  await window.webContents.executeJavaScript(`
    const ta = document.querySelector('.orch-goal-textarea');
    if (ta) {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      nativeSetter.call(ta, 'Test goal for screenshot');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  `);
  await new Promise((resolve) => setTimeout(resolve, 400));
  paths.push(await captureScreenshot(window, 'orch-kickoff.png'));

  // Force mutex blocked state for the execute button
  await window.webContents.executeJavaScript(`
    window.__forceOrchMutex && window.__forceOrchMutex('An orchestrate-execution session is already open in this workspace.');
  `);
  await new Promise((resolve) => setTimeout(resolve, 400));
  paths.push(await captureScreenshot(window, 'orch-mutex-refusal.png'));

  console.log('VERIFY_ORCH_SCREENSHOTS', JSON.stringify(paths));
  app.exit(0);
}

async function captureSmoke(window) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await captureScreenshot(window, 'smoke.png');
  // app.exit orphans stream children; detach first so no observer outlives us.
  try { terminalBridge?.close?.(); sidebarBridge?.close?.(); } catch { /* exiting */ }
  app.exit(0);
}

function broadcastSidebarUpdate(payload) {
  if (!mainWindow) return;
  sendToRenderer('sidebar:update', payload);
}

function broadcastTerminalUpdate(payload) {
  if (!mainWindow) return;
  sendToRenderer('terminal:update', payload);
}

// One freeze log for every process (renderer stalls arrive over IPC; main
// stalls, GPU/child deaths and renderer-unresponsive events are recorded
// here), so a capture always says WHICH layer froze. Never any conversation
// text.
function appendPerfLine(payload) {
  // HARBOR_PERF_LOG_DIR relocates the log (and re-enables it under E2E), so a
  // harness can prove the capture pipeline end to end without ever writing
  // into the real freeze evidence.
  const dirOverride = process.env.HARBOR_PERF_LOG_DIR;
  if (process.env.HARBOR_NO_PERF_LOG === '1' || (e2eMode && !dirOverride)) return;
  try {
    const dir = dirOverride || path.join(os.homedir(), '.cache', 'harbor', 'perf');
    require('node:fs').mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'renderer-stalls.jsonl');
    try {
      if (require('node:fs').statSync(file).size > 2 * 1024 * 1024) {
        require('node:fs').renameSync(file, `${file}.1`);
      }
    } catch { /* no file yet */ }
    require('node:fs').appendFileSync(file, `${JSON.stringify(payload)}\n`);
    console.warn(`perf: ${payload?.kind} ${payload?.ms ?? ''}ms`, JSON.stringify(payload?.context || payload?.details || {}));
  } catch { /* logging must never break the app */ }
}

// The renderer watchdog cannot see a blocked MAIN process, and a blocked main
// process produces Pat's exact symptom: input dispatch to the renderer rides
// through this process, so a block here queues X11 auto-repeat keydowns while
// the renderer's own timers stay perfectly healthy. hrtime is monotonic and
// excludes suspend, so sleep/resume can never write a fake freeze.
function startMainStallWatch() {
  const { stallFromTick } = require('../renderer/perf-watch.cjs');
  let last = process.hrtime.bigint();
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const gapMs = Number((now - last) / 1000000n);
    last = now;
    const stall = stallFromTick({ now: gapMs, last: 0, tickMs: 250 });
    if (stall) appendPerfLine({ ...stall, kind: 'blocked-main-process' });
  }, 250);
  timer.unref?.();
  return () => clearInterval(timer);
}

// Rendering-mode telemetry. Reads through appendPerfLine so a GPU death and the
// stall it caused land in ONE log, already correlated by timestamp: that
// correlation is how the 2026-07-28 freeze was finally explained, and it should
// not have taken two days of forensics. Bound to the same HARBOR_NO_PERF_LOG /
// E2E gating as every other perf line, by virtue of sharing the writer.
const gpuTelemetry = createGpuTelemetry({
  getFeatureStatus: () => app.getGPUFeatureStatus(),
  getGpuInfo: (kind) => app.getGPUInfo(kind),
  // Chromium's own process table, so "is there a GPU process" stops being a
  // question answered by enumerating /proc. Measured under xvfb 2026-07-30:
  // 127us, against 3.9us for the feature status and 1.5ms for getGPUInfo.
  getAppMetrics: () => app.getAppMetrics(),
  log: appendPerfLine,
  // Test seams, same shape as every other HARBOR_* override: a drive cannot
  // wait half an hour to prove the watcher writes anything.
  pollMs: Number(process.env.HARBOR_GPU_POLL_MS) || undefined,
  heartbeatMs: Number(process.env.HARBOR_GPU_HEARTBEAT_MS) || undefined,
});

function registerIpc() {
  // The realistic Linux paste path is clipboard.readImage() (screenshot tools
  // populate the system clipboard, not the DOM paste event). In E2E, fake a
  // non-empty clipboard image so that path resolves to a fixed test path.
  const e2eClipboardPath = process.env.HARBOR_E2E_CLIPBOARD_PATH;
  const writeClipboardImage = e2eClipboardPath
    ? async () => e2eClipboardPath
    : createImageWriter();
  registerClipboardImageIpc(electronIpcMain, {
    router: rpcRouter,
    saveImage: writeClipboardImage,
    readImage: e2eClipboardPath
      ? () => ({ isEmpty: () => false, toPNG: () => Buffer.from([0]) })
      : () => clipboard.readImage(),
    // Lets the composer open a pending attachment and look at it. Bounded to
    // the paste cache the writer above owns; the E2E stand-in path lives
    // outside it, so it is named explicitly rather than widening the rule.
    readImageDataUri: createImageReader({
      allowPaths: e2eClipboardPath ? [e2eClipboardPath] : [],
    }),
  });
  ipcMain.handle('clipboard:write-formatted', (_event, payload = {}) => {
    const { html, text } = payload;
    const limit = 2 * 1024 * 1024;
    if (typeof html !== 'string' || typeof text !== 'string') {
      throw new TypeError('clipboard:write-formatted requires string html and text');
    }
    if (Buffer.byteLength(html, 'utf8') >= limit || Buffer.byteLength(text, 'utf8') >= limit) {
      throw new RangeError('clipboard:write-formatted payloads must each be under 2MB');
    }
    clipboard.write({ html, text });
    return { ok: true };
  });
  // The board's Copy as PNG / Copy as image (Miro findings 56, 63). The renderer
  // hands over a rendered `data:image/png;base64,...` URL and main is the only
  // side that may touch the OS clipboard. It answers `{ ok }` rather than
  // throwing so a failed copy surfaces as the board's own honest status pill,
  // and it refuses anything that is not a decodable image rather than silently
  // clearing whatever the user already had on the clipboard.
  ipcMain.handle('clipboard:write-image', (_event, payload = {}) => {
    const { dataURL } = payload;
    if (typeof dataURL !== 'string' || !dataURL.startsWith('data:image/')) {
      throw new TypeError('clipboard:write-image requires a data:image/... URL');
    }
    if (dataURL.length >= 64 * 1024 * 1024) throw new RangeError('clipboard:write-image payload must be under 64MB');
    try {
      const image = nativeImage.createFromDataURL(dataURL);
      if (!image || image.isEmpty()) return { ok: false };
      clipboard.writeImage(image);
      return { ok: true };
    } catch { return { ok: false }; }
  });
  // A harness never opens a real voice call: it costs money, needs the network
  // and would make the suite depend on a third party. Off by default under E2E,
  // the same posture as the usage fetch. BOTH voice features answer to this one
  // switch: dictation is a paid OpenAI call too, and it was reachable from a
  // harness with nothing able to turn it off until 2026-09-03.
  const voiceEnv = {
    ...process.env,
    HARBOR_NO_VOICE: process.env.HARBOR_NO_VOICE ?? (e2eMode ? '1' : '0'),
  };
  registerWhisperIpc(electronIpcMain, { router: rpcRouter, env: voiceEnv });
  // Live voice mode: main mints the short-lived realtime credential so the real
  // OpenAI key never reaches the renderer (see voice-realtime.js).
  registerVoiceIpc(electronIpcMain, { router: rpcRouter, env: voiceEnv });
  registerContextMenuIpc(electronIpcMain, {
    router: rpcRouter,
    getWebContents: () => mainWindow?.webContents || null,
    getSession: () => mainWindow?.webContents?.session || null,
    userDataPath: app.getPath('userData'),
  });

  ipcMain.handle('sidebar:get-state', () => sidebarBridge.getState());
  ipcMain.handle('daemon:get-banner', () => daemonBanner);
  ipcMain.handle('daemon:retry', async () => {
    const ok = await connectDaemon();
    if (ok) {
      // Bridges were built against a dead socket; a clean relaunch (912 ms cold
      // start) is the reliable way to rewire everything. Tear down streams
      // first so no observer children outlive this process.
      try { terminalBridge?.close?.(); sidebarBridge?.close?.(); } catch {}
      app.relaunch();
      app.exit(0);
    }
    return daemonBanner;
  });

  // Custom-titlebar window controls (frameless window owns its own chrome).
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('window:close', () => mainWindow?.close());

  // Windows exposes one taskbar overlay per window. Updating it must remain a
  // passive status operation: never focus, flash, show, or restack the window.
  ipcMain.on('taskbar-badge:set', (_event, payload = {}) => {
    if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) return;
    if (!payload.dataUrl) {
      mainWindow.setOverlayIcon(null, '');
      return;
    }
    try {
      const image = nativeImage.createFromDataURL(payload.dataUrl);
      if (!image.isEmpty()) mainWindow.setOverlayIcon(image, String(payload.description || ''));
    } catch { /* Ignore a malformed or stale renderer update. */ }
  });

  // Renderer stalls, appended for the next freeze report (see
  // renderer/perf-watch.js). One line per stall over the threshold, capped so a
  // pathological day cannot fill the disk, and never any conversation text.
  ipcMain.on('perf:stall', (_event, payload) => {
    appendPerfLine({
      ms: payload?.ms, at: payload?.at, kind: payload?.kind, context: payload?.context,
    });
  });
  ipcMain.handle('window:is-maximized', () => Boolean(mainWindow?.isMaximized()));
  // Custom edge/corner resize grips drive the frameless window directly, so
  // resizing never depends on the window manager honoring undecorated edges.
  ipcMain.handle('window:get-bounds', () => mainWindow?.getBounds() || null);
  ipcMain.on('window:set-bounds', (_event, bounds) => {
    // Ignore grip-resize while maximized so isMaximized() can't desync from an
    // arbitrarily-sized window (the restore glyph would otherwise lie).
    if (mainWindow && !mainWindow.isDestroyed() && bounds && !mainWindow.isMaximized()) {
      mainWindow.setBounds(bounds);
    }
  });

  // Titlebar app-menu actions (the clean replacement for the removed menu bar).
  ipcMain.on('window:menu-action', (_event, action) => {
    const wc = mainWindow?.webContents;
    if (!wc || mainWindow.isDestroyed()) return;
    switch (action) {
      case 'reload': {
        // A renderer reload never fires the blur/release path (live-caught
        // 2026-07-18 under CDP), so a controlled pane would stay leased by a
        // renderer that no longer exists. Release through the normal debounced
        // blur first; a post-reload re-select of the same pane re-acquires.
        const controlled = terminalBridge?.getState?.().controlledPaneId;
        if (controlled) terminalBridge.blurPane(controlled);
        wc.reload();
        break;
      }
      // Full relaunch: a renderer reload does NOT pick up main-process changes
      // (the reason a build-on-disk needs more than wc.reload). Pat clicks this
      // himself, so it never steals his screen the way an out-of-band restart
      // would.
      case 'restart': app.relaunch(); app.exit(0); break;
      case 'devtools': wc.toggleDevTools(); break;
      case 'zoom-in': wc.setZoomLevel(Math.min(3, wc.getZoomLevel() + 0.5)); break;
      case 'zoom-out': wc.setZoomLevel(Math.max(-3, wc.getZoomLevel() - 0.5)); break;
      case 'zoom-reset': wc.setZoomLevel(0); break;
      case 'fullscreen': mainWindow.setFullScreen(!mainWindow.isFullScreen()); break;
      case 'quit': app.quit(); break;
      case 'about': showAboutDialog(); break;
      default: break;
    }
  });

  if (e2eMode) {
    ipcMain.handle('e2e:get-launch-calls', () => e2eLaunchCalls);
    ipcMain.handle('e2e:get-metrics', () => ({
      coldStartInteractiveMs,
      rssMb: Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10,
    }));
    ipcMain.handle('e2e:mark-interactive', () => {
      markColdStartInteractive();
      return { coldStartInteractiveMs };
    });
    // Test seam: is any LIVE process holding this session id right now?
    //
    // The resume specs pick a real session out of the real corpus, which is the
    // point (they are proving behaviour against real transcripts), but it makes
    // the answer depend on what the developer happens to be running: a session
    // open in a terminal outside Harbor is not `isLive` to the rail, and yet the
    // owner scan finds its process and correctly refuses to call the owner gone.
    // The spec then fails for the most confusing possible reason, which is that
    // it was right. This repo already refuses to let a suite depend on what the
    // user did five minutes ago; the same rule applies to what they are doing
    // right now. It calls the PRODUCTION probe, so a spec that skips a candidate
    // skips it for exactly the reason the product would.
    // It asks the SCAN, not the full ownership ladder, because the full ladder
    // needs a statusline tee and answers "cannot tell" without one, which would
    // make a spec skip every candidate on a machine that has no tees. The scan
    // answers the only question a spec needs: is a live process holding this id.
    ipcMain.handle('e2e:session-owner-pid', async (_event, { sessionId } = {}) => {
      try { return { ok: true, pid: (await platform.findSessionOwner(sessionId)) || null }; }
      catch (error) { return { ok: false, pid: null, reason: error.message }; }
    });
    // Test seam: E2E runs fake launches, so nothing ever populates the link
    // registry; this lets a spec pair a REAL harness pane with a session and
    // exercise the live command-bar path end to end.
    ipcMain.handle('e2e:set-link', (_event, { sessionId, paneId, workspaceId }) => {
      paneLinks.set(sessionId, { paneId, workspaceId });
      return paneLinks.all();
    });
    // Stand in for the AskUserQuestion a session's transcript would carry, so
    // the in-window card's question/option merge can be driven against a REAL
    // pty dialog without writing into Pat's actual transcript store. Only the
    // transcript READ is substituted here; the parse, the merge, the card and
    // the answer all run for real.
    // Point a session's question lookup at a transcript the harness wrote.
    // Only WHICH FILE is substituted: the production reader still stats it,
    // reads its tail, decides which question is unanswered and merges it onto
    // the pane. That distinction is the lesson of 2026-07-27. The seam used to
    // hand over a ready-made question payload, so the read itself was never
    // gated, and the read is exactly what failed Pat in the field.
    ipcMain.handle('e2e:set-ask-transcript', (_event, { sessionId, transcriptPath }) => {
      if (!sessionId) return false;
      askTranscript.set(sessionId, transcriptPath);
      return true;
    });
    // Replay the second half of a new-session launch: the moment the transcript
    // materializes and the window's provisional pane:<id> becomes the real
    // session id. Driving the real event is the only way to prove a draft
    // survives that swap, and a draft dying there is what ate Pat's typing.
    ipcMain.handle('e2e:emit-launched', (_event, payload) => {
      sendToRenderer('session:launched', payload);
      return true;
    });
    ipcMain.handle('e2e:quit', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy();
      }
      mainWindow = null;
      shutdownApp();
      app.quit();
      return { ok: true };
    });
  }

  ipcMain.handle('pane:focus', async (_event, { paneId, workspaceId }) => {
    notifier?.acknowledgePane(paneId);
    return terminalBridge.requestFocusPane({ paneId, workspaceId });
  });

  ipcMain.handle('resume-session', async (_event, { id, detectedHome }) => sessionOperationGate.run(id, async () => {
    // Snapshot BEFORE the launch so the fresh pane is identifiable the moment
    // the daemon creates it (no waiting on slow agent detection).
    const [preIds, meta] = await Promise.all([
      sessionSend.paneIdSet(),
      sidebarBridge.getSessionMeta(id).catch(() => null),
    ]);
    // Codex/cursor resume rides bin/ai; claude rides bin/claude-sessions.
    if (meta?.provider && meta.provider !== 'claude') {
      const result = await launchActions.resumeProviderSession({
        provider: meta.provider, cwd: meta.cwd, id,
        ...(meta.profileId ? { profileId: meta.profileId } : {}),
        ...(meta.configHome ? { configHome: meta.configHome } : {}),
      });
      startResumeFollowup({
        sessionId: id,
        emitStatus: (payload) => sendToRenderer('send:status', payload),
        run: async () => {
        const fresh = await sessionSend.findFreshPane({ preIds, cwd: meta?.cwd || null });
        if (!fresh) return;
        paneLinks.set(id, fresh);
        terminalBridge.requestFocusPane({
          paneId: fresh.paneId,
          workspaceId: fresh.workspaceId,
        }).catch(() => {});
        const ready = await sessionSend.waitForProviderReady(fresh.paneId);
        if (!ready) {
          sendToRenderer('send:status', {
            sessionId: id,
            phase: 'error',
            detail: `Session resumed, but ${meta.provider} never became ready`,
          });
          return;
        }
        sendToRenderer('session:launched', {
          sessionId: id, paneId: fresh.paneId, cwd: meta?.cwd || null, resumed: true,
          provider: meta.provider,
        });
        },
      });
      return result;
    }
    const result = await launchActions.resumeSession({ id, detectedHome });
    // Link the fresh pane to the session the moment it exists so the command
    // bar can drive it without waiting on agent detection (60-150s lag).
    startResumeFollowup({
      sessionId: id,
      emitStatus: (payload) => sendToRenderer('send:status', payload),
      run: async () => {
      const fresh = await sessionSend.findFreshPane({ preIds, cwd: meta?.cwd || null });
      if (!fresh) return;
      paneLinks.set(id, fresh);
      terminalBridge.requestFocusPane({
        paneId: fresh.paneId,
        workspaceId: fresh.workspaceId,
      }).catch(() => {});
      const ready = await sessionSend.waitForResumedClaudeReady(fresh.paneId, fresh.workspaceId);
      if (!ready) {
        sendToRenderer('send:status', {
          sessionId: id,
          phase: 'error',
          detail: 'Session resumed, but Claude never became ready',
        });
        return;
      }
      sendToRenderer('session:launched', {
        sessionId: id, paneId: fresh.paneId, cwd: meta?.cwd || null, resumed: true,
      });
      },
    });
    return result;
  }));

  ipcMain.handle('session:takeover', async (_event, { sessionId }) => {
    return takeoverHandler({ sessionId });
  });

  ipcMain.handle('session:preview', async (_event, { sessionId }) => {
    const text = await sidebarBridge.getSessionPreview(sessionId).catch(() => null);
    return { text };
  });

  ipcMain.handle('new-session', async (_event, { account, folder, sessionId, provider, model, effort, prompt }) => {
    let cwd;
    if (folder) {
      cwd = folder;
    } else if (sessionId) {
      const meta = await sidebarBridge.getSessionMeta(sessionId).catch(() => null);
      cwd = meta?.cwd || os.homedir();
    } else {
      cwd = os.homedir();
    }
    // The launch floor for every entry point: a cwd that does not exist on THIS
    // machine (a migrated session's /home/you/... path is the live-caught case,
    // 2026-08-12) must refuse here with the path named, not crash a keeper five
    // seconds from now. The daemon carries the same check; this one is what the
    // popover can show.
    const stat = await fs.stat(cwd).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(`cannot start a session in ${cwd}: the folder does not exist on this machine — pick a folder`);
    }
    return launchNewSession({ account, cwd, provider, model, effort, prompt });
  });
  ipcMain.handle('workflow:run', async (_event, { id, current = {} }) => {
    const launch = resolveWorkflowLaunch(id, current, harborConfig);
    if (!launch.cwd) return { ok: false, reason: 'workflow requires a project folder' };
    try {
      const stat = await fs.stat(launch.cwd);
      if (!stat.isDirectory()) return { ok: false, reason: `workflow project is not a folder: ${launch.cwd}` };
    } catch {
      return { ok: false, reason: `workflow project folder does not exist: ${launch.cwd}` };
    }

    if (id === 'handoff') {
      const meta = await sidebarBridge.getSessionMeta(current.sessionId).catch(() => null);
      if (!meta?.path) return { ok: false, reason: 'selected session transcript path is unknown' };
      const before = await fs.stat(meta.path).then((stat) => stat.size).catch(() => 0);
      const sent = await sessionSend.send({
        sessionId: current.sessionId,
        text: '/handoff',
        pane: current.pane,
        detectedHome: current.account,
        provider: current.provider || 'claude',
      }).catch((error) => ({ ok: false, reason: error.message }));
      if (!sent?.ok) return sent;
      const handoffPath = await waitForHandoffPath(meta.path, before).catch((error) => null);
      if (!handoffPath) return { ok: false, reason: 'handoff completed without reporting a handoff file path' };
      launch.command = `/pickup ${handoffPath}`;
    }

    await launchNewSession(launch);
    return { ok: true, command: launch.command, cwd: launch.cwd };
  });
  ipcMain.handle('new-session:options', () => newSessionOptions(harborConfig));
  ipcMain.handle('new-session:folder', async (_event, { sessionId }) => {
    const meta = sessionId ? await sidebarBridge.getSessionMeta(sessionId).catch(() => null) : null;
    if (!meta?.cwd) return null;
    // A foreign-era or since-deleted cwd is not a candidate folder: answering
    // null sends the caller to the folder picker instead of into a refused
    // launch (the 2026-08-12 shape: a Linux-era session's cwd inherited by a
    // Windows new-session).
    const stat = await fs.stat(meta.cwd).catch(() => null);
    return stat?.isDirectory() ? meta.cwd : null;
  });

  // ---- Slate conversation surface ----
  ipcMain.handle('transcript:open', (_event, payload) => transcriptProvider.open(payload.sessionId, payload));
  ipcMain.handle('transcript:close', (_event, { sessionId }) => transcriptProvider.close(sessionId));

  ipcMain.handle('session:send', async (_event, payload) => {
    try {
      const result = await sessionSend.send(payload);
      // A codex/cursor session first exists on disk when its first prompt
      // lands, and the daemon has not named it: the send IS the moment to look. A
      // window that opened as a bare pane becomes its real session here,
      // without waiting for the 5s tick.
      if (result?.ok && String(payload?.sessionId || '').startsWith('pane:')) {
        setTimeout(() => sidebarBridge?.resolveProviderSessions?.(), 2500);
      }
      return result;
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  });
  // Interactive select menus: the command bar polls menu-state for the selected
  // pane and answers it in place, so a session parked on a menu is never a
  // dead-end that forces the raw terminal.
  ipcMain.handle('session:menu-state', async (_event, payload) => {
    try {
      // The question's own text and options come from the session's transcript,
      // where Claude recorded the AskUserQuestion in full. The pane can only
      // show what fits its viewport, and a clipped dialog left the card with no
      // question at all (Pat, 2026-07-27).
      //
      // Read from the FILE, not from the transcript provider's streamed
      // `pendingAsk`. That cache was the first shape of this fix and it failed
      // Pat the same day: it is only as current as the last tail read that
      // landed, and his window was thirteen minutes behind the question the
      // card was asking about. The file cannot lag, and a cache keyed on its
      // size+mtime keeps this poll at a stat. See providers/pending-ask.js.
      const ask = (await liveAskFor(payload?.sessionId))?.questions || null;
      return await sessionSend.getMenu({ ...payload, ask });
    } catch {
      return null;
    }
  });
  ipcMain.handle('session:menu-answer', async (_event, payload) => {
    try {
      // A sheet delivery navigates the batch by matching what the pane shows
      // against what the transcript says was asked, so the question set comes
      // from the same on-demand file read the card itself is built from. The
      // renderer never supplies question text; it only says which numbers.
      const ask = payload?.action?.type === 'sheet'
        ? (await liveAskFor(payload?.sessionId))?.questions || null
        : null;
      return await sessionSend.answerMenu({ ...payload, ask });
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  });
  ipcMain.handle('session:send-queue', (_event, { sessionId }) => (
    sessionSend.getQueueState(sessionId)
  ));
  ipcMain.handle('session:cancel-send', (_event, { sessionId, sendId }) => (
    sessionSend.cancelQueued(sessionId, sendId)
  ));
  ipcMain.handle('session:interrupt', (_event, { paneId }) => {
    if (!paneId) return { ok: false, reason: 'no live pane to interrupt' };
    return terminalBridge.sendInput(paneId, '\x1b');
  });

  // Delete a session for good: moves its transcript to a recoverable trash
  // folder (see session-delete.js). The rail's fs-watch drops the row once the
  // file is gone; the renderer also hides it optimistically.
  ipcMain.handle('session:delete', (_event, { sessionId, isLive } = {}) => (
    deleteSessionTranscript({ sessionId, isLive })
  ));

  // Capability menu: fs-only enumeration (renderer stays fs-free), plus the two
  // pty-touching permission-mode operations (scrape + shift+tab cycle).
  ipcMain.handle('capabilities:get', async (_event, { sessionId }) => {
    try {
      return { ok: true, capabilities: await capabilitiesProvider.get(sessionId) };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  });
  ipcMain.handle('capabilities:permission-mode', async (_event, { paneId }) => {
    if (!paneId) return { mode: null };
    try {
      return await sessionSend.readPermissionMode(paneId);
    } catch (error) {
      return { mode: null, reason: error.message };
    }
  });
  ipcMain.handle('capabilities:cycle-permission-mode', async (_event, { paneId, workspaceId }) => {
    if (!paneId) return { ok: false, reason: 'no pane to cycle' };
    try {
      const res = await sessionSend.cyclePermissionMode(paneId, workspaceId);
      return { ok: true, ...res };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  });

  ipcMain.handle('links:get', () => paneLinks.all());

  // Input flight recorder sink: bounded JSONL under ~/.cache/harbor.
  const diagPath = path.join(os.homedir(), '.cache', 'harbor', 'input-diag.jsonl');
  ipcMain.on('diag:input', (_event, events) => {
    try {
      if (!Array.isArray(events) || !events.length) return;
      const fsSync = require('node:fs');
      fsSync.mkdirSync(path.dirname(diagPath), { recursive: true });
      try {
        if (fsSync.statSync(diagPath).size > 2_000_000) {
          fsSync.renameSync(diagPath, `${diagPath}.1`);
        }
      } catch { /* fresh file */ }
      fsSync.appendFileSync(diagPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    } catch { /* diagnostics must never hurt the app */ }
  });

  ipcMain.handle('worker:close', async (_event, { paneId, force = false }) => {
    try {
      const result = await terminalBridge.closePaneTab(paneId, { force });
      if (result.ok && result.verified) {
        paneLinks.dropPane(paneId);
      }
      return result;
    } catch (error) {
      return {
        ok: false,
        method: force ? 'signal' : 'pane',
        verified: false,
        reason: error.message,
      };
    }
  });

  // A harness can supply the answer the OS dialog would have given. Checked
  // BEFORE the guard on purpose: with an answer in hand no portal call is made
  // at all, so there is nothing to refuse. It is also what lets the guard be
  // proven two-sided, by showing a drive really does reach the picker.
  const fakeDialogAnswer = () => (e2eMode && process.env.HARBOR_E2E_FAKE_DIALOG) || null;

  ipcMain.handle('pick-files', async () => {
    const faked = fakeDialogAnswer();
    if (faked) return [faked];
    // Throws loudly rather than routing to the desktop portal (see
    // main/isolation.js): under a harness the picker would open on the real
    // desktop and block this process awaiting an answer.
    assertDialogAllowed('pick-files');
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || !result.filePaths?.length) return null;
    return result.filePaths;
  });

  ipcMain.handle('usage:get-all', async () => {
    return Object.fromEntries(await Promise.all(harborConfig.profiles.map(async ({ id }) => (
      [id, await usageProvider.getUsage(id)]
    ))));
  });

  ipcMain.handle('accounts:read-emails', () => readAccountEmails({ profiles: harborConfig.profiles }));

  ipcMain.handle('pick-folder', async () => {
    const faked = fakeDialogAnswer();
    if (faked) return faked;
    assertDialogAllowed('pick-folder');
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths?.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('terminal:get-state', () => terminalBridge.getState());
  ipcMain.handle('terminal:set-visible-panes', (_event, panes) => terminalBridge.setVisiblePanes(panes));
  ipcMain.handle('terminal:focus-pane', (_event, payload) => terminalBridge.focusPane(payload));
  ipcMain.handle('terminal:blur-pane', (_event, payload) => terminalBridge.blurPane(payload.paneId));
  ipcMain.handle('terminal:send-input', (_event, payload) => terminalBridge.sendInput(payload.paneId, payload.text));
  ipcMain.handle('terminal:resize-pane', (_event, payload) => terminalBridge.resizePane(payload.paneId, payload));
  ipcMain.handle('terminal:focus-workspace', (_event, payload) => terminalBridge.focusWorkspace(payload.workspaceId));
  ipcMain.handle('terminal:create-workspace', (_event, payload) => terminalBridge.createWorkspace(payload));
  ipcMain.handle('terminal:close-workspace', (_event, payload) => terminalBridge.closeWorkspace(payload.workspaceId));
  ipcMain.handle('terminal:focus-tab', (_event, payload) => terminalBridge.focusTab(payload.tabId));
  ipcMain.handle('terminal:create-tab', (_event, payload) => terminalBridge.createTab(payload));
  ipcMain.handle('terminal:close-tab', (_event, payload) => terminalBridge.closeTab(payload.tabId));
  ipcMain.handle('terminal:rename-tab', (_event, payload) => terminalBridge.renameTab(payload.tabId, payload.label));

  // Orchestration IPC
  async function orchGetProjectRoot(sessionId) {
    const meta = await sidebarBridge.getSessionMeta(sessionId).catch(() => null);
    return meta?.cwd || null;
  }

  // Parsed-liveness cache keyed by transcript size+mtime. Safe because the run
  // derivation degrades any signal by its AGE (WORKING_FRESH_MS in delegate.js),
  // so a cached verdict for an unchanged file can never render fresher than its
  // own mtime allows.
  const orchLivenessCache = new Map();

  async function orchHistoryRows(queues = []) {
    // Only pending/active batches need worker liveness: done ones render from
    // queue facts, and blocked/failed/error ones have no live worker to find.
    // Counting failed as needing liveness reopened the full-corpus sweep for
    // as long as a failed batch sat in any queue (round-2 review catch).
    const needsLiveness = (value) => ['pending', 'active', ''].includes(String(value || '').toLowerCase());
    const exactIds = new Set(queues.flatMap((queue) => queue?.batches || []).map((batch) => batch.last_session_id).filter(Boolean));
    // Scope BEFORE reading anything: the title-join only matters for batches
    // still in flight, so sessions older than the oldest incomplete dispatch
    // (minus slack) are never read. Without this floor every historical orch
    // worker in the corpus was re-read and re-parsed on every poll, a tax that
    // grew with each run ever executed (caught in review, 2026-08-25).
    const DISPATCH_SLACK_MS = 15 * 60 * 1000;
    const incompleteBatches = queues.flatMap((queue) => (queue?.batches || [])
      .filter((batch) => needsLiveness(batch.status)));
    const dispatchStamps = incompleteBatches
      .map((batch) => Date.parse(batch.last_dispatched_at || batch.started_at || '') || 0)
      .filter(Boolean);
    // No incomplete batches: only identity joins matter. Incomplete batches
    // with no stamps at all: the join itself tolerates a missing stamp, so the
    // floor must not exclude everything the join would accept.
    const windowFloorMs = incompleteBatches.length === 0
      ? Infinity
      : (dispatchStamps.length ? Math.min(...dispatchStamps) - DISPATCH_SLACK_MS : 0);
    const projects = sidebarBridge.getState()?.model?.projects || [];
    const candidates = projects.flatMap((project) => project.sessions || []).filter((session) => (
      exactIds.has(session.id)
      || ((session.isChildTask || /^BATCH TITLE:/i.test(String(session.firstPrompt || session.title || '')))
        && (session.lastActiveMs || 0) >= windowFloorMs)
    ));
    return Promise.all(candidates.map(async (session) => {
      const meta = await sidebarBridge.getSessionMeta(session.id).catch(() => null);
      if (!meta?.path) return { ...session, id: session.id };
      const stat = await fs.stat(meta.path).catch(() => null);
      // Only content-derived facts are cached; anything computed against the
      // wall clock would come back stale from a cache hit. The join derives
      // freshness from signalAt at its own read of the clock.
      let finished = null;
      const cached = orchLivenessCache.get(meta.path);
      if (cached && stat && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        ({ finished } = cached);
      } else {
        try {
          const parser = new TranscriptParser(meta.provider || session.provider || 'claude');
          for (const line of (await fs.readFile(meta.path, 'utf8')).split(/\r?\n/)) {
            if (!line.trim()) continue;
            try { parser.applyLine(JSON.parse(line)); } catch { /* skip partial records */ }
          }
          finished = parser.header.lastSignal === 'idle';
          if (stat) orchLivenessCache.set(meta.path, { size: stat.size, mtimeMs: stat.mtimeMs, finished });
        } catch { /* The join still has identity and mtime if parsing fails. */ }
      }
      return {
        ...session,
        ...meta,
        id: session.id,
        firstPrompt: session.firstPrompt || session.title,
        start: meta.start || session.startedAt || null,
        signalAt: stat?.mtimeMs || meta.mt || null,
        finished,
      };
    }));
  }

  async function orchDeriveQueue(queue, now = Date.now(), suppliedRows = null) {
    const events = await delegateProvider.getEvents(queue?.queue_id);
    return deriveRun(queue, suppliedRows || await orchHistoryRows([queue]), events, now);
  }

  async function orchBuildPayload(projectLabel, projectRoot) {
    const queue = await delegateProvider.getQueue(projectRoot);
    const { summary, events, liveBatches } = await orchDeriveQueue(queue);
    const mutex = checkExecuteMutex({
      projectLabel,
      terminalState: terminalBridge.getState(),
      queue,
    });
    return { queue: { ...queue, batches: (queue.batches || []).map((batch) => ({
      ...batch,
      ...(liveBatches.find((row) => row.batchId === batch.id) || {}),
      last_session_id: batch.last_session_id || liveBatches.find((row) => row.batchId === batch.id)?.sessionId || null,
    })) }, mutex, projectRoot, summary, events, liveBatches };
  }

  const stopOrchSummaryWatchers = () => {
    for (const close of orchSummaryWatchers) close();
    orchSummaryWatchers = [];
    clearTimeout(orchSummaryExpiryTimer);
    orchSummaryExpiryTimer = null;
  };

  const buildOrchSummaries = async (workspaces) => {
    const queues = await delegateProvider.listQueues();
    const historyRows = await orchHistoryRows(queues);
    const resolved = new Map();
    const entries = await Promise.all(workspaces.map(async (workspace) => {
      const key = process.platform === 'win32' ? path.resolve(workspace).toLowerCase() : path.resolve(workspace);
      if (!resolved.has(key)) {
        resolved.set(key, (async () => {
          const queue = findQueueForWorkspace(queues, workspace) || await delegateProvider.getQueue(workspace);
          const events = await delegateProvider.getEvents(queue.queue_id);
          return deriveRun(queue, historyRows, events).summary;
        })());
      }
      return [workspace, await resolved.get(key)];
    }));
    return Object.fromEntries(entries.filter(([, summary]) => summary?.visible));
  };

  ipcMain.handle('orchestration:watch-summaries', async (_event, { workspaces = [] } = {}) => {
    stopOrchSummaryWatchers();
    const unique = [...new Set(workspaces.filter(Boolean))];
    const broadcast = () => buildOrchSummaries(unique).then((summaries) => {
      sendToRenderer('orchestration:summaries', summaries);
      clearTimeout(orchSummaryExpiryTimer);
      const expiry = Object.values(summaries)
        .filter((summary) => summary.remaining === 0 && summary.updatedAt)
        .reduce((nearest, summary) => Math.min(nearest, summary.updatedAt + 10 * 60 * 1000), Infinity);
      if (Number.isFinite(expiry)) {
        orchSummaryExpiryTimer = setTimeout(broadcast, Math.max(50, expiry - Date.now() + 50));
        orchSummaryExpiryTimer.unref?.();
      }
      return summaries;
    }).catch(() => ({}));
    orchSummaryWatchers = unique.map((workspace) => delegateProvider.watchQueue(workspace, broadcast));
    return broadcast();
  });

  ipcMain.handle('orchestration:unwatch-summaries', () => {
    stopOrchSummaryWatchers();
    return { ok: true };
  });

  ipcMain.handle('orchestration:list-runs', async () => {
    const queues = await delegateProvider.listQueues();
    const historyRows = await orchHistoryRows(queues);
    const rows = await Promise.all(queues.map((queue) => orchDeriveQueue(queue, Date.now(), historyRows)));
    return rows.filter((run) => run.summary?.visible)
      .sort((a, b) => (a.summary.state === 'live' ? -1 : 1) - (b.summary.state === 'live' ? -1 : 1)
        || b.summary.updatedAt - a.summary.updatedAt);
  });

  ipcMain.handle('orchestration:get-data', async (_event, { projectLabel, sessionId, projectRoot: suppliedRoot }) => {
    const projectRoot = suppliedRoot || await orchGetProjectRoot(sessionId);
    if (!projectRoot) return { error: 'Could not determine project root from session' };
    return orchBuildPayload(projectLabel, projectRoot);
  });

  ipcMain.handle('orchestration:watch', async (_event, { projectLabel, sessionId, projectRoot: suppliedRoot }) => {
    if (orchWatcher) { orchWatcher(); orchWatcher = null; }
    const projectRoot = suppliedRoot || await orchGetProjectRoot(sessionId);
    if (!projectRoot) return { ok: false, reason: 'Could not determine project root' };

    const broadcastUpdate = () => orchBuildPayload(projectLabel, projectRoot)
      .then((payload) => sendToRenderer('orchestration:update', payload))
      .catch(() => {});

    const initialPayload = await orchBuildPayload(projectLabel, projectRoot);
    orchWatcher = delegateProvider.watchQueue(projectRoot, broadcastUpdate, initialPayload.queue?.queue_id);
    return { ok: true, ...initialPayload };
  });

  ipcMain.handle('orchestration:unwatch', () => {
    if (orchWatcher) { orchWatcher(); orchWatcher = null; }
    return { ok: true };
  });

  // Orchestration is optional and may have failed to build (no launcher, no
  // profile with a config home). Refusing here by name beats a TypeError with
  // no explanation, and the Orch view surfaces `error` to the user.
  const ORCH_UNAVAILABLE = { error: 'Orchestration is not configured: Harbor could not build it from this config. Check orchestration.launcher and your default plan, or turn the Orch view off in the setup wizard.' };

  ipcMain.handle('orchestration:kickoff-research', async (_event, { projectLabel, sessionId, goal }) => {
    if (!orchActions) return ORCH_UNAVAILABLE;
    const projectRoot = await orchGetProjectRoot(sessionId);
    if (!projectRoot) return { error: 'Could not determine project root' };
    return orchActions.kickoffResearch({ projectRoot, projectLabel, goal });
  });

  let executeKickoffInFlight = false;
  ipcMain.handle('orchestration:kickoff-execute', async (_event, { projectLabel, sessionId }) => {
    if (!orchActions) return ORCH_UNAVAILABLE;
    if (executeKickoffInFlight) return { blocked: true, reason: 'An execute kickoff is already in progress.' };
    executeKickoffInFlight = true;
    try {
      const projectRoot = await orchGetProjectRoot(sessionId);
      if (!projectRoot) return { error: 'Could not determine project root' };
      const queue = await delegateProvider.getQueue(projectRoot);
      // Fresh state check with no await between it and the kickoff; the tab
      // created by kickoffExecute is the durable reservation.
      const mutex = checkExecuteMutex({
        projectLabel,
        terminalState: terminalBridge.getState(),
        queue,
      });
      if (mutex.blocked) return { blocked: true, reason: mutex.reason };
      return await orchActions.kickoffExecute({ projectRoot, projectLabel });
    } finally {
      executeKickoffInFlight = false;
    }
  });

  ipcMain.handle('orchestration:session-preview', async (_event, { sessionId }) => {
    const text = await sidebarBridge.getSessionPreview(sessionId).catch(() => null);
    return { text };
  });

  bindIpcMain(rpcRouter, electronIpcMain, getRendererWebContents);
}

// The frameless window renders no menu bar; this menu exists ONLY to preserve a
// few safe accelerators. Terminal-hostile default accelerators are DELIBERATELY
// not bound so those keystrokes reach xterm instead of the chrome: Ctrl+C/V
// (interrupt / paste; xterm owns these), Ctrl+A (start of line), Ctrl+R
// (reverse-search), Ctrl+W (delete word), Ctrl+Z (suspend), Ctrl+M (carriage
// return), Ctrl+Q (XON). Reload and Quit are moved to Shift variants.
function installAppMenu() {
  const template = [
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        {
          label: 'Force Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            // Same guard as the titlebar menu's reload: release the controlled
            // pane through the normal blur path first, or the reloaded
            // renderer leaves the old lease orphaned in the supervisor.
            const controlled = terminalBridge?.getState?.().controlledPaneId;
            if (controlled) terminalBridge.blurPane(controlled);
            mainWindow?.webContents.reloadIgnoringCache();
          },
        },
      ],
    },
    {
      label: 'App',
      submenu: [
        // The wizard is re-openable for the whole life of the install, not just
        // on first run: adding a plan or changing a launcher must never mean
        // hand-editing config.json.
        { label: 'Setup wizard…', click: () => sendToRenderer('setup:open') },
        { type: 'separator' },
        { role: 'quit', accelerator: 'CmdOrCtrl+Shift+Q' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Desktop-quality session names: the Node titler asks Haiku for a short title
// per session (cached on disk; the history index overlays them on every emit). Runs
// in the background after the sidebar updates, so new sessions get real names
// within a minute; without an API key it exits quietly and raw prompts remain.
// The build-time icon set, so the generator does not pay for an icon a fork
// already bundles. It ships EMPTY in this repo on purpose (an icon set is named
// for someone's real projects), so on a normal checkout this is [].
function bundledIconSlugs() {
  try {
    return require('node:fs').readdirSync(path.join(__dirname, '../../assets/project-icons'))
      .filter((name) => path.extname(name))
      .map((name) => name.slice(0, -path.extname(name).length).toLowerCase());
  } catch {
    return [];
  }
}

// At most one titling pass in flight. The titler now spawns a Claude Code CLI
// per title (to bill Pat's plan, not the API console), which is far heavier than
// the old HTTP call; without this guard the per-sidebar-update scheduling could
// stack many concurrent passes and spawn a storm of CLIs. A pass that fires while
// one is busy simply skips; the next free pass re-reads the index and catches up.
let titlerBusy = false;
function scheduleTitler() {
  const provider = createTitlesProvider();
  scheduleTitlesProvider({
    env: process.env,
    e2eMode,
    run: async () => {
      if (titlerBusy) return { skipped: 'busy' };
      titlerBusy = true;
      try {
        return await provider.run({ days: 30 });
      } finally {
        titlerBusy = false;
      }
    },
    onResult: (result) => {
      if (result.skipped) return;
      console.log(`harbor-titles: titled ${result.titled}, failed ${result.failed}, cached total ${result.cached}`);
      if (result.titled > 0) sidebarBridge?.refreshHistory?.().catch(() => {});
    },
  });
}

// A rebuild landing in dist/ while the app runs used to be invisible: the
// window kept serving the old bundle and fixes "never arrived". Watch dist/
// and tell the renderer so one click loads the new build. The watcher rides
// through a rebuild wiping dist/assets (see dist-watcher.js).
function watchDistForUpdates() {
  if (process.env.VITE_DEV_SERVER_URL || e2eMode) return;
  const { createDistWatcher } = require('./dist-watcher.js');
  createDistWatcher(path.join(__dirname, '../../dist'), () => {
    // A window that never came up is healed by the very build this announces;
    // a healthy window keeps the renderer-side ribbon (distChanged no-ops).
    bootRecovery?.distChanged();
    sendToRenderer('app:update-available');
  });
}

function showAboutDialog() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Same class as the pickers: a native modal awaiting a human. Warn and skip
  // rather than throw, because nothing is waiting on this one's result.
  try {
    assertDialogAllowed('about dialog');
  } catch (error) {
    console.warn('isolation:', error.message);
    return;
  }
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'About Harbor',
    message: 'Harbor',
    detail: 'A desktop head for agent sessions on Harbor sessiond.\n\n'
      + `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
    buttons: ['OK'],
    noLink: true,
  }).catch(() => {});
}

function createWindow() {
  const savedStateRaw = e2eMode ? null : readWindowState();
  const savedState = savedStateRaw ? { maximized: savedStateRaw.maximized, ...clampToDisplay(savedStateRaw) } : null;
  const window = new BrowserWindow({
    width: savedState?.width || 1600,
    height: savedState?.height || 1000,
    ...(savedState && Number.isFinite(savedState.x) ? { x: savedState.x, y: savedState.y } : {}),
    // A harness window (HARBOR_E2E) is BORN fully offscreen. Drives used to
    // reposition it with a post-boot SetWindowPos, which raced the first
    // paint: the app window flashed on the user's screen once per run, a hard
    // rule violation on this box (nothing may ever show, focus, or restack a
    // window over Pat's fullscreen game). CDP input dispatch and
    // Page.captureScreenshot both work at this position; the drives prove it
    // on every run.
    ...(e2eMode ? { x: -4200, y: 100 } : {}),
    backgroundColor: '#05080c',
    icon: path.join(__dirname, '../../assets/icon-512.png'),
    show: e2eMode,
    // Own the whole window: no OS titlebar, no 1995 grey chrome, no default
    // menu bar. A custom in-renderer titlebar provides brand + window controls;
    // edge-resize stays native (frameless Linux windows resize from the edges).
    frame: false,
    autoHideMenuBar: true,
    minWidth: 960,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Chromium's built-in PDF viewer (an internal extension) renders PDF
      // artifacts INSIDE the Artifacts view; without this flag a PDF frame
      // just downloads.
      plugins: true,
    },
  });

  mainWindow = window;

  // Spellcheck is Chromium's, drawn as its own red squiggle under the composer
  // text. The language is PINNED rather than left to the system locale so the
  // behaviour is the same on every machine and in every harness.
  //
  // On Linux the dictionary is a .bdic Chromium fetches once into
  // userData/Dictionaries, so first run needs network. A failed fetch means no
  // squiggles; `context-menu:spell-status` reports that state rather than
  // letting it pass for a working feature.
  //
  // E2E gets a THROWAWAY userData per launch, so leaving this on would mean a
  // fresh download on every one of the suite's ~34 app boots. Tests must not
  // depend on the network (the same reason the usage fetch is off here), so it
  // is opt-in per spec; an empty language list disables the checker outright.
  const spellcheckOn = !e2eMode || process.env.HARBOR_E2E_SPELLCHECK === '1';
  try {
    window.webContents.session.setSpellCheckerLanguages(spellcheckOn ? ['en-US'] : []);
  } catch (error) {
    console.warn('[harbor] spellchecker language could not be set:', error.message);
  }
  attachContextMenu(window.webContents, {
    send: (payload) => sendToRenderer('context-menu:show', payload),
  });

  // Live voice mode needs the microphone, and Electron denies media permission
  // by default. Grant ONLY the microphone, and only to Harbor's own loaded
  // document: everything else (camera, screen capture, geolocation, notifications
  // via the page, MIDI) stays denied, so a compromised artifact frame cannot ask
  // for something the app never uses. Nothing here is a portal call, so this
  // does not reopen the 2026-07-26 file-chooser hole.
  try {
    window.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const fromHarbor = webContents === window.webContents;
      const audioOnly = permission === 'media'
        && details?.mediaTypes?.includes('audio')
        && !details.mediaTypes.includes('video');
      callback(Boolean(fromHarbor && audioOnly));
    });
    window.webContents.session.setPermissionCheckHandler((webContents, permission, _origin, details) => (
      webContents === window.webContents
      && permission === 'media'
      && details?.mediaType !== 'video'
    ));
  } catch (error) {
    console.warn('[harbor] media permission handler could not be installed:', error.message);
  }

  // Keep the renderer's maximize/restore control glyph in sync with real state.
  const sendMaxState = () => {
    if (window.isDestroyed()) return;
    sendToRenderer('window:maximize-changed', window.isMaximized());
  };
  window.on('maximize', sendMaxState);
  window.on('unmaximize', sendMaxState);
  window.once('ready-to-show', () => {
    if (noFocusSteal) {
      // ORDER IS THE BUG THIS FIXES (2026-07-27, a restart landed on top of
      // a full-screen game and interrupted it): maximizing a window that is ALREADY
      // MAPPED asks mutter to activate it, so `showInactive()` followed by
      // `maximize()` handed over the screen the flag existed to protect.
      // Maximizing while still hidden shows it unfocused instead.
      const previousActive = platform.readActiveWindow();
      if (savedState?.maximized) window.maximize();
      else window.showInactive();
      // And the outcome is CHECKED rather than assumed: a flag driving a WM
      // hint is a proxy, and believing the proxy is what put the window on his
      // game. If X says we became the active window anyway, the screen goes
      // straight back to whoever had it, which restacks them above us too.
      platform.focusGuard(window, { previousActive });
    } else {
      window.show();
      if (savedState?.maximized) window.maximize();
    }
    markColdStartInteractive();
  });
  window.on('focus', () => {
    notifier?.acknowledgeAll();
    broadcastUsageUpdate();
  });
  if (!e2eMode) {
    let persistTimer = null;
    const schedulePersist = () => {
      clearTimeout(persistTimer);
      persistTimer = setTimeout(() => persistWindowState(window), 500);
    };
    window.on('resize', schedulePersist);
    window.on('move', schedulePersist);
    window.on('close', () => persistWindowState(window));
  }

  // The floor under drag-and-drop (Pat, 2026-07-25: "I somehow lost a window in
  // here and no clue which one it was"). Chromium's default for a file dropped
  // on a window is to NAVIGATE at it, which replaces the whole app with the
  // file and takes the rail, the stage and every open window with it. The
  // renderer preventDefaults every drop, but a single gap there used to cost a
  // window, so the main process refuses the navigation outright: this app never
  // navigates anywhere after its own load.
  window.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    const current = new URL(window.webContents.getURL() || 'about:blank');
    if (target.origin === current.origin && target.pathname === current.pathname) return;
    event.preventDefault();
    console.warn('blocked navigation away from the app shell:', url.slice(0, 200));
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    console.warn('blocked a new window request:', String(url).slice(0, 200));
    return { action: 'deny' };
  });

  // Chromium's own verdict that the renderer hung, from outside the renderer:
  // pairs with (or contradicts) the in-renderer watchdog in the freeze log.
  window.webContents.on('unresponsive', () => {
    appendPerfLine({ at: new Date().toISOString(), kind: 'renderer-unresponsive' });
  });

  // Rendering mode, recorded once the window has actually painted. Before the
  // first paint Chromium has not decided, so an earlier read reports nothing
  // useful. See gpu-telemetry.js for why this exists at all.
  window.webContents.once('did-finish-load', () => {
    gpuTelemetry?.readStatus('boot');
    // The boot read alone is blind to the leading hypothesis: a GPU process
    // torn down by a suspend emits no crash event, so nothing would ever log
    // it. The watcher writes only on change (plus a slow heartbeat), and
    // powerMonitor brackets the sleep with a reading on each side.
    gpuTelemetry?.start();
    try {
      powerMonitor.on('suspend', () => { gpuTelemetry?.handleSuspend(); });
      powerMonitor.on('resume', () => { gpuTelemetry?.handleResume(); });
    } catch { /* powerMonitor is unavailable on some headless stacks */ }
  });
  window.webContents.on('responsive', () => {
    appendPerfLine({ at: new Date().toISOString(), kind: 'renderer-responsive' });
  });

  // The renderer is this process's only transcript client, and it tracks what
  // it has open in RENDERER memory (openTranscriptsRef). A reload or a renderer
  // crash resets that ref to empty while main still holds every refcount from
  // the previous life; the restored stage then re-opens the same sessions and
  // the old refs are stranded, so each one keeps an fs watcher and a 5s poller
  // re-reading its transcript for as long as the app runs. That is the same
  // defect the mobile server had, arriving through a reload instead of a
  // dropped socket. Drop them BEFORE the new page runs: whatever it wants, it
  // asks for again.
  const dropStrandedTranscripts = (why) => {
    const open = transcriptProvider?.openCount?.() || 0;
    if (!open) return;
    console.warn(`harbor: releasing ${open} transcript(s) stranded by ${why}`);
    transcriptProvider?.closeAll();
  };
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) dropStrandedTranscripts('a renderer reload');
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    const reason = details?.reason || 'unknown';
    dropStrandedTranscripts(`the renderer going away (${reason})`);
    // A DEAD RENDERER MUST NOT LEAVE A WINDOWLESS PROCESS. Before this, the
    // main process simply carried on: no window, no recovery, and still
    // holding the single-instance lock, so clicking the launcher did nothing
    // and the only way back was finding the pid (Pat, 2026-08-10, "my harbor
    // app keeps closing unexpectedly"). Reload first, because that restores the
    // window without touching the daemon, the sessions or the drafts; give up
    // only on a genuine crash loop, and QUIT when giving up so the lock is
    // released and one click gets a working window.
    const now = Date.now();
    const plan = planRendererRecovery({
      reason,
      shuttingDown,
      attempts: rendererDeaths.count,
      sinceLastMs: rendererDeaths.at ? now - rendererDeaths.at : Number.POSITIVE_INFINITY,
    });
    rendererDeaths = { count: plan.attempts, at: now };
    console.warn(`harbor: ${plan.why}`);
    if (plan.action === 'ignore') return;
    // Say it out loud either way: a window that vanishes and silently comes
    // back is still an unexplained event to whoever was looking at it.
    platform.notify(
      plan.action === 'quit' ? 'Harbor stopped' : 'Harbor recovered',
      plan.action === 'quit'
        ? `Its window kept crashing (${reason}). Start Harbor again from the taskbar.`
        : `Its window crashed (${reason}) and was reloaded. Sessions were not affected.`,
    );
    if (plan.action === 'quit') { app.quit(); return; }
    // This reload can land on a mid-wipe dist like any load; hand the boot
    // watch back to bootRecovery so a black post-crash window still heals.
    bootRecovery?.rearm();
    if (!window.isDestroyed()) window.reload();
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    // A LAUNCH THAT RACES A REBUILD MUST HEAL ITSELF (2026-08-29, "cant even
    // open harbor, just a black screen"). Vite wipes and renames dist's hashed
    // assets, so a launch mid-build loads an index.html whose chunks are gone:
    // the page finishes loading, React never mounts, and the window shows the
    // body background forever, because the update ribbon needs a mounted
    // renderer and render-process-gone never fires for an empty page. The
    // recovery lives in boot-recovery.js: probe the mount after every load,
    // retry a load that failed or never mounted on a steady cadence, and
    // retry immediately when the dist watcher reports a settled new build.
    // Once mounted ONCE it disarms; a healthy window is never reloaded.
    const indexPath = path.join(__dirname, '../../dist/index.html');
    bootRecovery?.close();
    bootRecovery = createBootRecovery({
      attemptLoad: () => {
        if (!window.isDestroyed()) window.loadFile(indexPath).catch(() => { /* did-fail-load carries the verdict */ });
      },
      probeMount: async () => {
        if (window.isDestroyed() || !canReceivePush(window.webContents)) return false;
        const children = await window.webContents
          .executeJavaScript('(() => { const r = document.getElementById("root"); return r ? r.children.length : 0; })()')
          .catch(() => 0);
        return children > 0;
      },
    });
    window.webContents.on('did-finish-load', () => bootRecovery?.loadFinished());
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (isMainFrame) bootRecovery?.loadFailed({ errorCode, errorDescription });
    });
    window.on('closed', () => { bootRecovery?.close(); });
    window.loadFile(indexPath).catch(() => { /* did-fail-load carries the verdict */ });
  }

  window.webContents.once('did-finish-load', () => {
    if (smokeMode) {
      captureSmoke(window).catch((error) => {
        console.error(error);
        app.exit(1);
      });
      return;
    }
    if (verifyMode) {
      runVerifySidebar(window).catch((error) => {
        console.error(error);
        app.exit(1);
      });
      return;
    }
    if (verifyMetersMode) {
      runVerifyMeters(window).catch((error) => {
        console.error(error);
        app.exit(1);
      });
      return;
    }
    if (verifyTerminalMode) {
      runVerifyTerminal(window).catch((error) => {
        console.error(error);
        app.exit(1);
      });
    }
    if (verifyOrchMode) {
      runVerifyOrch(window).catch((error) => {
        console.error(error);
        app.exit(1);
      });
    }
  });
}

// Windows binds notifications and taskbar identity to an explicit
// AppUserModelID. Without one, Electron Notifications never display there, and
// a pinned shortcut never groups with the running window, because the process
// is electron.exe so the implicit exe-path identity is Electron's, not
// Harbor's. The value matches build.appId in package.json so the dev checkout
// and the packaged app present as the same application; any pinned shortcut
// must stamp the same id (System.AppUserModel.ID) for grouping to hold.
if (process.platform === 'win32') app.setAppUserModelId('com.harbor.desktop');

// Single-instance lock (R9/S8). Second invocation focuses the existing window
// or launches a new session, then exits. Skipped in E2E so Playwright can launch
// isolated instances without fighting an existing harbor process.
// The payload is parsed from OUR OWN process.argv (never Chromium-mangled) and
// delivered to the first instance via additionalData; the argv fallback in the
// handler only trusts equals-form flags (see parseSecondInstanceArgs).
const secondInstancePayload = buildSecondInstancePayload(process.argv);
const gotSingleInstanceLock = e2eMode ? true : app.requestSingleInstanceLock(secondInstancePayload);
if (!e2eMode && !gotSingleInstanceLock) {
  app.quit();
} else if (!e2eMode) {
  app.on('second-instance', (_event, argv, _wd, additionalData) => {
    const parsed = (additionalData && additionalData.action)
      ? additionalData
      : parseSecondInstanceArgs(argv);
    console.log('second-instance parsed:', JSON.stringify(parsed),
      additionalData?.action ? '(from additionalData)' : '(argv fallback)');
    // A relaunch that races a not-yet-dead instance lands HERE, and this used
    // to focus unconditionally: the ship-loop restart that took Pat's screen
    // off a full-screen game could do it through this path even with the flag set on
    // both processes. The incoming launch says what it wanted.
    if (mainWindow && !parsed.noFocusSteal) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    if (parsed.action === 'new-session') {
      const intent = { account: configuredProfileId(parsed.home), cwd: parsed.cwd };
      if (launchActions) runNewSessionIntent(intent);
      else pendingNewSessionIntent = intent; // chord landed during startup
    }
  });
}

// Last-resort safety net: Electron pops a modal "A JavaScript error occurred in
// the main process" dialog on any uncaught exception. During teardown and daemon
// hiccups a stray async throw (a pane-stream callback firing into a
// half-destroyed window) would surface that dialog over whatever Pat is doing.
// The real causes are guarded at their source (sendToRenderer, stream error
// handlers); this only keeps an unforeseen edge case from interrupting him. It
// LOGS everything so real bugs are still visible in the console/log.
process.on('uncaughtException', (error) => {
  console.error('uncaughtException (suppressed dialog):', error?.stack || error);
});

// A dying helper process (the GPU process above all: the freeze evidence
// includes GetVSyncParametersIfAvailable warnings) leaves a line in the freeze
// log, so a stall entry can be correlated with the layer that actually died.
app.on('child-process-gone', (_event, details) => {
  appendPerfLine({
    at: new Date().toISOString(),
    kind: 'child-process-gone',
    details: {
      type: details?.type,
      reason: details?.reason,
      exitCode: details?.exitCode,
      serviceName: details?.serviceName || undefined,
    },
  });
  // A GPU death additionally re-reads the rendering mode a beat later, because
  // the crash line alone never said whether Chromium respawned the process or
  // fell back to software for the rest of the session.
  gpuTelemetry?.handleChildProcessGone(details);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason?.stack || reason);
});

app.whenReady().then(async () => {
  configStore = createConfigStore({ app });
  harborConfig = await configStore.load();
  configureModelCatalog(harborConfig);
  stopMainLagMonitor = startLagMonitor('main');
  startMainStallWatch();
  installAppMenu();

  // Model catalog: learn the model list from the installed Claude CLI so a
  // model released today reaches the menus without a Harbor code change
  // (built 2026-07-24, the day Opus 5 shipped and the hand-pinned list missed
  // it). Failure is honest and non-fatal: the shipped seed list stands.
  if (!e2eMode && process.env.HARBOR_NO_MODEL_DISCOVERY !== '1') {
    const notifiedFile = path.join(os.homedir(), '.cache', 'harbor', 'claude-models-notified.json');
    // Toast only ids newer than the seed's family flagship: a first scan also
    // "adds" old ids the seed never listed (opus 4.0), and those are not news.
    const seedFlagship = new Map();
    for (const m of MODEL_VERSION_SEED) {
      if (!seedFlagship.has(m.family) || compareVersionsDesc(m.id, seedFlagship.get(m.family)) < 0) {
        seedFlagship.set(m.family, m.id);
      }
    }
    const refreshModels = async () => {
      try {
        const result = await modelCatalog.refresh();
        if (!result.ok) {
          console.warn(`model catalog: ${result.reason}; menus stay on the shipped list`);
          return;
        }
        if (!result.added.length) return;
        console.log(`model catalog: CLI knows models beyond the shipped list: ${result.added.join(', ')}`);
        let notified = [];
        try { notified = JSON.parse(await fs.readFile(notifiedFile, 'utf8')); } catch { /* first time */ }
        const news = result.added.filter((id) => {
          const flagship = seedFlagship.get(String(id).match(/^claude-([a-z]+)-/)?.[1]);
          return flagship && compareVersionsDesc(id, flagship) < 0 && !notified.includes(id);
        });
        if (!news.length) return;
        platform.notify('New Claude model available', `${news.join(', ')} is now in Harbor's model menus.`);
        await fs.mkdir(path.dirname(notifiedFile), { recursive: true }).catch(() => {});
        await fs.writeFile(notifiedFile, JSON.stringify([...notified, ...news])).catch(() => {});
      } catch (error) {
        console.warn('model catalog refresh failed:', error.message);
      }
    };
    refreshModels();
    const modelTimer = setInterval(refreshModels, 6 * 60 * 60 * 1000);
    modelTimer.unref?.();
  }

  const earlyProfile = {
    userDataPath: app.getPath('userData'),
    defaultUserDataPath: path.join(app.getPath('appData'), app.getName()),
  };
  sessionStorePolicy = resolveSessionStorePolicy({ ...earlyProfile, env: process.env });
  await connectDaemon();

  // The direct-endpoint fallback hits real accounts; harnesses must never do
  // that, so it is off under E2E and behind an env kill switch.
  usageProvider = createUsageProvider(
    (e2eMode || process.env.HARBOR_NO_USAGE_FETCH === '1')
      ? { fetchRemoteUsage: null, profiles: harborConfig.profiles, cacheDir: harborConfig.paths.cacheDir }
      : { profiles: harborConfig.profiles, cacheDir: harborConfig.paths.cacheDir },
  );
  // One decision, made once, for every path that can touch state belonging to
  // processes this app did not start (see main/isolation.js): where the
  // statusline context tees are read from, whether a pid learned there may be
  // signaled, and whether bin/ may be shelled out to for a real launch.
  const contextDir = resolveContextDir(process.env);
  const profile = {
    userDataPath: app.getPath('userData'),
    defaultUserDataPath: path.join(app.getPath('appData'), app.getName()),
  };
  const signalPolicy = resolveSignalPolicy({ ...profile, contextDir });
  const launchPolicy = resolveLaunchPolicy(profile);
  const dialogPolicy = resolveDialogPolicy(profile);
  if (!signalPolicy.allowed) console.warn('isolation:', signalPolicy.reason);
  if (!launchPolicy.allowed) console.warn('isolation:', launchPolicy.reason);
  if (!dialogPolicy.allowed) console.warn('isolation:', dialogPolicy.reason);
  if (!sessionStorePolicy.allowed) console.warn('isolation:', sessionStorePolicy.reason);
  if (signalPolicy.optIn || launchPolicy.optIn || dialogPolicy.optIn) console.warn('isolation: real-machine effects explicitly opted in');
  assertDialogAllowed = createDialogGuard({ policy: dialogPolicy });
  const guardedKill = createSignalGuard({ policy: signalPolicy, processKill: process.kill.bind(process) });

  // First-run setup. Registered here rather than earlier because it needs the
  // two policies above: its folder picker is a native dialog and its sign-in
  // buttons are real launches against real accounts, so both go through the
  // same guards the rest of the app uses instead of a second set of rules.
  registerSetupIpc({
    ipcMain: electronIpcMain,
    router: rpcRouter,
    dialog,
    app,
    getConfig: () => harborConfig,
    saveConfig: async (next) => {
      const saved = await configStore.save(next);
      harborConfig = saved;
      return saved;
    },
    // FINISHING THE WIZARD HAS TO CHANGE THE RUNNING APP, and until 2026-08-07
    // it changed only the file and one variable. `launchActions`, `orchActions`,
    // `historyProvider`, `usageProvider` and the capabilities provider are all
    // constructed ONCE, near the bottom of this file, from a snapshot of
    // `harborConfig` taken before the window exists. Nothing subscribed to
    // `configStore`'s own `change` event and this hook was accepted by
    // `registerSetupIpc` but never supplied, so the modules that launch a
    // session, kick off orchestration and read usage kept the pre-wizard
    // profile list until the user happened to quit and reopen. On a FIRST run
    // that is every one of them: the wizard is what created the profiles.
    // The renderer's own `window.location.reload()` cannot fix it, because the
    // stale state is in this process.
    //
    // Relaunching is the same answer `daemon:retry` and the menu's Restart
    // already give for "the bridges were built against the wrong thing", and it
    // is honest: the app comes back on exactly the config just written. The
    // no-focus-steal flag is carried through for the same reason the watchdog
    // carries it, so an out-of-band restart never takes the screen.
    //
    // A harness cannot survive its own subject exiting, so `HARBOR_E2E_RELAUNCH_LOG`
    // records the relaunch instead of performing it, for a future drive that
    // wants to prove the hook fired without dying.
    //
    // WHAT IS ACTUALLY PROVEN TODAY, stated plainly because the alternative is a
    // comment describing a test nobody wrote: `test/setup/ipc.test.js` proves
    // behaviourally that `setup:save` calls `onCompleted` with the saved config
    // and does NOT call it on a rejected save, and proves STRUCTURALLY that this
    // file passes the hook and that the hook relaunches and fails closed under
    // the harness. Nothing yet drives the wizard to Finish through a real
    // Electron boot and observes the relaunch, because that spec would have to
    // survive the process exiting; the log seam above is what it would use.
    // FAIL CLOSED UNDER THE HARNESS, like every sibling guard in this file. The
    // daemon watchdog's identical relaunch is gated on `!e2eMode`, and the
    // signal, launch and dialog policies all refuse the real effect on an
    // isolated profile and require an explicit opt-in. A single-purpose opt-OUT
    // would have meant the first spec that ever drives the wizard to Finish
    // exits the Electron process Playwright is attached to, mid-suite, with
    // nothing to catch it. The log path stays as the way a drive can prove the
    // hook fired.
    onCompleted: () => {
      const relaunchLog = process.env.HARBOR_E2E_RELAUNCH_LOG;
      if (relaunchLog) {
        try { require('node:fs').appendFileSync(relaunchLog, `setup-completed ${Date.now()}\n`); } catch { /* best effort */ }
        return;
      }
      if (e2eMode) return;
      app.relaunch({ args: [...new Set([...process.argv.slice(1), '--no-focus-steal'])] });
      app.exit(0);
    },
    assertDialogAllowed,
    launchPolicy,
  });

  const injectableExecFile = createInjectableExecFile(launchPolicy, {
    env: process.env,
    fakeLaunch: e2eFakeLaunch,
    onFakeLaunch: (record) => e2eLaunchCalls.push({ ...record, ts: Date.now() }),
  });
  // ONE ownership ladder, shared by the two things that need it: adopt-on-send
  // before it may signal, and resume before it may overrule bin/claude-sessions'
  // transcript-mtime live guard. Built here, ahead of both, so neither can grow
  // its own copy. It only ever READS (/proc plus signal 0, which every liveness
  // probe needs and the signal guard always permits); the kill stays behind
  // assertSignalsAllowed below, and an isolated profile still cannot launch.
  sessionOwnerProbe = createSessionOwnerProbe({
    contextDir,
    readFile: fs.readFile,
    statFile: (target) => fs.stat(target),
    // The wrapper stays read-only on purpose, but it must carry the
    // platform's own process-question deadline: win32's honest CIM cost is
    // seconds, and the probe's /proc-calibrated 3000ms default refused every
    // Windows probe (2026-08-21). Undefined on POSIX, where that default
    // stands.
    platform: {
      processInfo: (pid) => platform.processInfo(pid),
      processQuestionDeadlineMs: platform.processQuestionDeadlineMs,
    },
    // Best-effort double-writer guard for the owner-gone fall-through: any
    // live claude-ish process still carrying this session id (a concurrent
    // resume, an outside `claude --resume <id>`) blocks the fall-through with
    // an honest, retryable refusal. It is never used to pick a kill target.
    scanForSessionOwner: (sessionId) => platform.findSessionOwner(sessionId),
  });
  launchActions = createLaunchActions({
    execFile: injectableExecFile,
    profiles: harborConfig.profiles,
    // Anything short of proof leaves the guard standing; resumeSession treats
    // every throw as "not proven" rather than as a failed resume.
    isSessionUnowned: async (id) => (await sessionOwnerProbe(id)).ownerGone,
  });
  // THE ORCH VIEW IS OPTIONAL, SO IT MUST NOT BE ABLE TO STOP HARBOR STARTING.
  // `createOrchestrationActions` throws when it has no launcher or no profile
  // with a config home, and that throw used to propagate straight out of app
  // startup: a config that named a blank launcher (which a hand-edit produces,
  // and which the config documentation now invites) meant the window never
  // appeared at all, over a tab the user may have turned off. A failure here
  // leaves `orchActions` null, which the two kickoff handlers refuse by name
  // (`ORCH_UNAVAILABLE`, added with this), and says why in the log.
  try {
    orchActions = createOrchestrationActions({
      config: harborConfig,
      env: process.env,
      sessionStorePolicy,
    });
  } catch (error) {
    orchActions = null;
    console.error('orchestration is unavailable and the Orch view will refuse:', error.message);
  }
  const delegateStateDir = e2eMode ? process.env.HARBOR_DELEGATE_STATE_DIR : null;
  const resolvedDelegateStateDir = delegateStateDir || harborConfig.paths.delegateStateDir;
  delegateProvider = createDelegateProvider({
    stateDir: resolvedDelegateStateDir,
    queuePathFor: (workspace) => queuePath(workspace, resolvedDelegateStateDir),
  });
  const historyProvider = createHistoryProvider({
    projectsPath: harborConfig.paths.projectsDir,
    cacheDir: harborConfig.paths.cacheDir,
    profiles: harborConfig.profiles,
  });
  sidebarBridge = createSidebarBridge({
    daemonOptions: { env: process.env, sessionStorePolicy },
    projectLabelForCwd,
    history: historyProvider,
    profiles: harborConfig.profiles,
    providerMetadataFile: path.join(harborConfig.paths.cacheDir, 'provider-session-metadata.json'),
  });
  terminalBridge = createTerminalBridge({
    env: process.env,
    sessionStorePolicy,
    // Sibling of the takeover kill: closePaneTab escalates SIGTERM/SIGKILL onto
    // a pane's captured pid, which is a real process whenever the socket points
    // at the real daemon.
    processKill: guardedKill,
  });

  sidebarBridge.emitter.on('update', broadcastSidebarUpdate);
  sidebarBridge.emitter.on('update', scheduleTitler);
  sidebarBridge.emitter.on('error', (error) => console.error('sidebar error', error));

  // A codex/cursor pane just got its real session id. Two windows can be
  // showing that pane under a provisional key: the fresh-launch one
  // (pane:<id>) and one opened from the rail's anonymous live row
  // (live:<id>). Both upgrade in place, exactly like a claude session whose
  // transcript materialized, so the conversation renders where the terminal
  // fallback used to sit.
  sidebarBridge.emitter.on('provider-session-linked', ({ paneId, sessionId, provider, cwd, workspaceId }) => {
    paneLinks?.set(sessionId, { paneId, workspaceId });
    for (const replacesKey of [`pane:${paneId}`, `live:${paneId}`]) {
      sendToRenderer('session:launched', {
        sessionId, paneId, workspaceId, cwd, provider, replacesKey,
      });
    }
  });

  // Conversation-surface plumbing: transcript tailing, the command-bar send
  // engine, and the provisional session<->pane link registry.
  transcriptProvider = createTranscriptProvider({
    getSessionMeta: (id) => sidebarBridge.getSessionMeta(id),
    contextCacheDir: contextDir,
  });
  transcriptProvider.emitter.on('update', (payload) => {
    sendToRenderer('transcript:update', payload);
  });
  transcriptProvider.emitter.on('error', (error) => console.warn('transcript error:', error.message));
  paneLinks = createLinkRegistry();
  paneLinks.emitter.on('update', () => {
    sendToRenderer('links:update', paneLinks.all());
  });
  const sendClient = createControlClient({ env: process.env, sessionStorePolicy });
  sessionSend = createSessionSend({
    snapshot: async () => {
      const res = await sendClient.snapshot();
      return res?.snapshot || res || {};
    },
    readPane: async (paneId, lines = 16, source = 'recent') => {
      const res = await sendClient.readPane(paneId, { source, lines, strip_ansi: true });
      return res?.read?.text || '';
    },
    terminalBridge,
    launchActions: {
      ...launchActions,
      resumeSession: (args) => sessionOperationGate.run(
        args.id,
        () => launchActions.resumeSession(args),
      ),
      resumeProviderSession: (args) => sessionOperationGate.run(
        args.id,
        () => launchActions.resumeProviderSession(args),
      ),
    },
    getSessionMeta: (id) => sidebarBridge.getSessionMeta(id),
    resolveTranscriptPath: (id) => askTranscript.resolve(id),
    links: paneLinks,
    projectLabelForCwd,
    setXClipboardImage: (imagePath) => platform.clipboardImage(imagePath),
  });
  sessionSend.emitter.on('status', (payload) => {
    sendToRenderer('send:status', payload);
  });
  const takeoverOwner = createTakeoverOwner({
    ownerProbe: sessionOwnerProbe,
    platform: {
      killProcess: (pid, signal) => platform.killProcess(pid, signal),
    },
    processKill: guardedKill,
    assertSignalsAllowed: () => {
      if (!signalPolicy.allowed) throw new Error(signalPolicy.reason);
    },
    sleep: () => new Promise((resolve) => setTimeout(resolve, 150)),
  });
  takeoverHandler = createTakeoverHandler({
    operationGate: sessionOperationGate,
    takeoverOwner,
    paneIdSet: () => sessionSend.paneIdSet(),
    getSessionMeta: (id) => sidebarBridge.getSessionMeta(id),
    resumeSession: (args) => launchActions.resumeSession(args),
    findFreshPane: (args) => sessionSend.findFreshPane(args),
    setPaneLink: (id, pane) => paneLinks.set(id, pane),
    requestFocusPane: (pane) => terminalBridge.requestFocusPane(pane),
    waitForResumedClaudeReady: (paneId, workspaceId) => (
      sessionSend.waitForResumedClaudeReady(paneId, workspaceId)
    ),
    emitStatus: (payload) => {
      sessionSend?.logStatus?.(payload);
      sendToRenderer('send:status', payload);
    },
    emitLaunched: (payload) => sendToRenderer('session:launched', payload),
  });

  // Workflow-run visibility: the strip and inspector in each session window
  // read run state straight from the files next to the transcript.
  const workflowRuns = createWorkflowRuns({
    getSessionMeta: (id) => sidebarBridge.getSessionMeta(id),
    findTranscript: findProviderTranscript,
  });
  ipcMain.handle('session:workflow-runs', (_event, { sessionId } = {}) => (
    workflowRuns.runsForSession(sessionId)
  ));

  // Artifacts view plumbing: transcript-driven discovery of agent-produced
  // files, served to the renderer ONLY through the allowlisted scheme.
  const artifactsProvider = createArtifactsProvider({
    roots: [harborConfig.paths.projectsDir],
    cacheFile: path.join(harborConfig.paths.cacheDir, 'artifacts-index.json'),
  });
  // Grid previews: HTML artifacts render in a short-lived OFFSCREEN window
  // (loaded through the same allowlisted scheme as the viewer, with the same
  // no-navigation posture) and get captured; PDFs and videos convert via
  // poppler/ffmpeg inside the thumbs provider.
  const captureHtmlThumb = async (filePath) => {
    const sourceUrl = artifactUrl(filePath, ARTIFACT_SCHEME);
    const win = new BrowserWindow({
      show: false,
      width: 1024,
      height: 768,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (event) => event.preventDefault());
      await win.loadURL(sourceUrl);
      // Charts and fonts paint a beat after load; capture the settled page.
      await new Promise((resolve) => setTimeout(resolve, 900));
      const image = await win.webContents.capturePage();
      return image.resize({ width: 480 }).toPNG();
    } finally {
      win.destroy();
    }
  };
  const artifactThumbs = createArtifactThumbs({ captureHtml: captureHtmlThumb });
  ipcMain.handle('artifacts:thumb', async (_event, { path: target, mtimeMs, kind } = {}) => {
    // Generators only ever run on indexed artifacts, never an arbitrary path.
    if (!artifactsProvider.isServable(target)) return { ok: false, thumbPath: null };
    const thumbPath = await artifactThumbs.thumbFor({ path: target, mtimeMs, kind });
    return { ok: true, thumbPath };
  });
  const ARTIFACT_MIME = {
    html: 'text/html', htm: 'text/html', png: 'image/png', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', css: 'text/css',
    js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
    txt: 'text/plain', woff: 'font/woff', woff2: 'font/woff2',
  };
  protocol.handle(ARTIFACT_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      // One shared rule with the renderer that built this URL. Decoding it
      // here as decodeURIComponent(url.pathname) assumed a POSIX path: it
      // produced '.' for every Windows request, which the allowlist then
      // refused, so the whole Files view served nothing but 403s.
      const requested = filePathFromUrlPath(url.pathname);
      if (!requested) return new Response('not found', { status: 404 });
      const filePath = path.resolve(requested);
      // Indexed artifacts (and their sibling assets), plus the generated
      // thumbnail cache; everything else is refused.
      const isThumb = filePath.startsWith(`${artifactThumbs.cacheDir}${path.sep}`);
      if (!isThumb && !artifactsProvider.isServable(filePath)) return new Response('forbidden', { status: 403 });
      // `fs` in this file is node:fs/promises, so there is no `fs.promises`.
      // Written as fs.promises.realpath this threw a TypeError on EVERY request,
      // the catch below turned it into a 404, and the whole artifact scheme went
      // dark: images, HTML and PDFs all stopped rendering, thumbnails included.
      // The symlink check itself is correct and stays; only the call was wrong.
      let resolvedPath = filePath;
      try { resolvedPath = await fs.realpath(filePath); } catch { return new Response('not found', { status: 404 }); }
      if (!isThumb && resolvedPath !== path.resolve(filePath) && !artifactsProvider.isServable(resolvedPath)) {
        return new Response('forbidden', { status: 403 });
      }
      const stat = await fs.stat(resolvedPath);
      if (!stat.isFile()) return new Response('not a file', { status: 404 });
      const mime = ARTIFACT_MIME[path.extname(resolvedPath).slice(1).toLowerCase()] || 'application/octet-stream';
      // CORS open on purpose: only allowlisted files are ever served, and an
      // open header lets the app (and harness assertions) fetch them.
      const baseHeaders = {
        'content-type': mime,
        'accept-ranges': 'bytes',
        'access-control-allow-origin': '*',
      };
      // Range support: the PDF viewer and <video> both seek. Serve the exact
      // slice from disk instead of buffering the file per request.
      const rangeHeader = request.headers.get('range');
      const rangeMatch = rangeHeader ? rangeHeader.match(/^bytes=(\d*)-(\d*)$/) : null;
      if (rangeMatch && (rangeMatch[1] || rangeMatch[2])) {
        const start = rangeMatch[1] ? Number(rangeMatch[1]) : Math.max(0, stat.size - Number(rangeMatch[2]));
        const end = rangeMatch[1] && rangeMatch[2] ? Math.min(Number(rangeMatch[2]), stat.size - 1) : stat.size - 1;
        if (!Number.isFinite(start) || start > end || start >= stat.size) {
          return new Response('bad range', { status: 416, headers: { 'content-range': `bytes */${stat.size}` } });
        }
        const length = Math.min(end - start + 1, 32 * 1024 * 1024);
        const handle = await fs.open(resolvedPath, 'r');
        try {
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, start);
          return new Response(buffer, {
            status: 206,
            headers: {
              ...baseHeaders,
              'content-range': `bytes ${start}-${start + length - 1}/${stat.size}`,
              'content-length': String(length),
            },
          });
        } finally {
          await handle.close();
        }
      }
      if (stat.size > 128 * 1024 * 1024) return new Response('too large', { status: 413 });
      const data = await fs.readFile(resolvedPath);
      return new Response(data, { headers: baseHeaders });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
  // An artifact's HTML may pull CDN subresources (scripts, styles), which is
  // what opening it in a browser would do; but the artifact FRAME itself must
  // always stay a local artifact document. Blocking http(s) and file subframe
  // documents keeps a link inside an artifact from turning the viewer into a
  // browser or a local-file reader, alongside the standing guards
  // (will-navigate refusal, window-open denial, the HTML iframe sandbox, and
  // the scheme allowlist). The file:// block matters now that the PDF frame
  // is unsandboxed so the Chromium PDF viewer can run in it.
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'file:///*'] },
    (details, callback) => callback({ cancel: details.resourceType === 'subFrame' }),
  );
  // Per-project icons. The set lives in the user's data directory, so it is not
  // repo content and cannot be deleted by work on the repo, which is exactly how
  // it was lost on 2026-07-29: the share pass removed 53 icons named for real
  // projects and the build-time glob had nothing left to resolve.
  const projectIcons = createProjectIconProvider({
    configuredDir: harborConfig.paths.projectIconsDir,
    scheme: ICON_SCHEME,
  });
  protocol.handle(ICON_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const file = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      // Answers only for a filename the index found in the icons directory, so
      // no renderer string ever composes a served path.
      const filePath = await projectIcons.filePathFor(file);
      if (!filePath) return new Response('forbidden', { status: 403 });
      const data = await fs.readFile(filePath);
      return new Response(data, {
        headers: {
          'content-type': projectIcons.mimeFor(file) || 'application/octet-stream',
          // The URL carries the file's mtime, so a hit is only ever the same
          // bytes; a replaced icon arrives under a new URL.
          'cache-control': 'public, max-age=31536000, immutable',
        },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
  ipcMain.handle('project-icons:list', () => projectIcons.list());
  ipcMain.handle('project-icons:reveal', async () => {
    await projectIcons.list(); // creates the directory if it does not exist yet
    shell.openPath(projectIcons.dir);
    return { ok: true, dir: projectIcons.dir };
  });
  // Watch, so dropping a PNG in shows up without a restart.
  projectIcons.watch((payload) => sendToRenderer('project-icons:update', payload));
  // A project with no icon of its own gets one generated for it. It asks the
  // SAME provider what already exists, so the generator and the renderer can
  // never disagree about which projects still need one, and the resize is
  // Electron's own: the API answers 1024px and the set on disk is 96px.
  scheduleIconGen({
    env: process.env,
    e2eMode,
    run: () => createIconGenerator({
      iconsDir: projectIcons.dir,
      cacheDir: harborConfig.paths.cacheDir,
      listIcons: () => projectIcons.list(),
      bundledSlugs: bundledIconSlugs(),
      resizeToPng: (buffer, px) => nativeImage.createFromBuffer(buffer)
        .resize({ width: px, height: px, quality: 'best' })
        .toPNG(),
    }).run(),
    onResult: (result) => {
      if (result.skipped || !result.generated) return;
      console.log(`harbor icon-gen: generated ${result.generated} project icon(s)`);
      // The folder watcher normally carries this, but a watch is a best-effort
      // feature (it is allowed to fail to a no-op), and an icon generated for a
      // project sitting on screen is exactly when the repaint has to happen.
      projectIcons.invalidate();
      projectIcons.list().then((payload) => sendToRenderer('project-icons:update', payload)).catch(() => {});
    },
  });
  // Tasks. Plain JSON in the user's own config directory, same posture as the
  // project icons above: user data, not repo content, and readable without
  // Harbor running. The store owns atomicity and corrupt-file recovery; the
  // shared reducer owns what every operation MEANS, so main and the renderer
  // cannot disagree about it.
  taskStore = createTaskStore({ configuredFile: harborConfig.paths.tasksFile });
  ipcMain.handle('tasks:read', () => taskStore.read());
  ipcMain.handle('tasks:mutate', (_event, op) => taskStore.mutate(op));
  ipcMain.handle('tasks:reveal', async () => {
    // The file may not exist until the first task is added; showing the folder
    // is still the useful answer, and it is never a dead click.
    shell.showItemInFolder(taskStore.file);
    return { ok: true, file: taskStore.file };
  });
  // An edit made outside Harbor (a script, jq, another agent) repaints the view
  // rather than being silently overwritten by the next mutation.
  taskStore.subscribe((doc) => sendToRenderer('tasks:changed', { doc }));
  noteStore = createNoteStore({ configuredFile: harborConfig.paths.notesFile });
  ipcMain.handle('notes:read', () => noteStore.read());
  ipcMain.handle('notes:mutate', (_event, op) => noteStore.mutate(op));
  noteStore.subscribe((doc) => sendToRenderer('notes:changed', { doc }));
  whiteboardStore = createWhiteboardStore({ configuredDir: harborConfig.paths.boardsDir });
  ipcMain.handle('whiteboard:list', () => whiteboardStore.list());
  ipcMain.handle('whiteboard:read', (_event, payload) => whiteboardStore.read(payload));
  ipcMain.handle('whiteboard:write', (_event, payload) => whiteboardStore.write(payload));
  ipcMain.handle('whiteboard:create', (_event, payload) => whiteboardStore.create(payload));
  ipcMain.handle('whiteboard:rename', (_event, payload) => whiteboardStore.rename(payload));
  ipcMain.handle('whiteboard:delete', (_event, payload) => whiteboardStore.delete(payload));
  // A board written outside Harbor (bin/harbor-board) reaches the open canvas
  // instead of being silently overwritten by its next debounced save (b6 H1).
  whiteboardStore.subscribe((payload) => sendToRenderer('whiteboard:changed', payload));
  ipcMain.handle('artifacts:list', () => artifactsProvider.list());
  ipcMain.handle('artifacts:open-external', async (_event, { path: target } = {}) => {
    if (!artifactsProvider.isServable(target)) return { ok: false, reason: 'not an indexed artifact' };
    const error = await shell.openPath(target);
    return error ? { ok: false, reason: error } : { ok: true };
  });
  ipcMain.handle('artifacts:show-in-folder', (_event, { path: target } = {}) => {
    if (!artifactsProvider.isServable(target)) return { ok: false, reason: 'not an indexed artifact' };
    shell.showItemInFolder(target);
    return { ok: true };
  });
  // Warm the index in the background so the first view open lands on the disk
  // cache instead of a cold multi-second corpus scan. Harness runs only scan
  // when they brought their own fabricated roots.
  if (!e2eMode || process.env.HARBOR_ARTIFACTS_ROOTS) {
    const warmTimer = setTimeout(() => { artifactsProvider.list().catch(() => {}); }, 8000);
    warmTimer.unref?.();
  }

  // Capability enumeration for the command-bar menu: resolves each session's
  // profile config home and reads models/plugins/commands fresh.
  const accountsProvider = createAccountsProvider({
    history: { sessionMeta: (id) => sidebarBridge.getSessionMeta(id) },
    profiles: harborConfig.profiles,
  });
  capabilitiesProvider = createCapabilitiesProvider({ accounts: accountsProvider });

  // Notification driver (R8): Electron supplies the native implementation.
  notifier = createNotifier({
    getFocusedPaneId: () => terminalBridge?.getState().controlledPaneId ?? null,
    isWindowFocused: () => mainWindow?.isFocused() ?? false,
    getWorkspaceLabel: (workspaceId) => terminalBridge?.getState().workspaces
      ?.find((w) => w.workspace_id === workspaceId)?.label || '',
    setBadgeCount: setAppBadgeCount,
    notify: (title, body) => platform.notify(title, body),
  });
  sidebarBridge.emitter.on('pane-agent-status', (event) => {
    // agent_status 'unknown' means no foreground agent owns the pane: the CLI
    // exited or crashed back to the shell. A provisional session link kept
    // through that would route the next send into bash (live-caught
    // 2026-07-22), so the link dies with the agent.
    const data = event?.data || {};
    if (data.agent_status === 'unknown' && data.pane_id) paneLinks?.dropPane(data.pane_id);
    notifier.onAgentStatusChanged(event);
  });

  // Agent-status watcher: the daemon only delivers pane.agent_status_changed
  // with a per-pane subscription entry (verified live), so maintain one
  // subscription covering the current set of live agent panes and rebuild it
  // (debounced) whenever that set changes.
  const agentClient = createControlClient({ env: process.env, sessionStorePolicy });
  let agentSub = null;
  let agentSubKey = '';
  let agentSubTimer = null;
  const rebuildAgentWatcher = () => {
    clearTimeout(agentSubTimer);
    agentSubTimer = setTimeout(() => {
      try {
        const model = sidebarBridge?.getState()?.model;
        const paneIds = [...new Set((model?.projects || [])
          .flatMap((proj) => (proj.sessions || [])
            .filter((sess) => sess.isLive && sess.paneId)
            .map((sess) => sess.paneId)))].sort();
        const key = paneIds.join(',');
        if (key === agentSubKey) return;
        agentSubKey = key;
        agentSub?.close?.();
        agentSub = null;
        if (!paneIds.length) return;
        agentSub = agentClient.subscribeAgentStatus(paneIds);
        agentSub.ready().catch(() => {}); // daemon-down subscribe must not reject unhandled
        // This subscription is the authoritative status source for both the
        // window working state and notifications. The sidebar bridge updates
        // the owning session, then re-emits the unchanged event to notifier.
        agentSub.on('event', (event) => sidebarBridge?.onPaneAgentStatus(event));
        agentSub.on('error', () => {});
        agentSub.on('close', () => {
          agentSubKey = '';
          rebuildAgentWatcher(); // notifications must not stay dead until the next sidebar update
        });
      } catch (e) {
        console.error('agent watcher rebuild failed:', e.message);
      }
    }, 2000);
    agentSubTimer.unref?.();
  };
  sidebarBridge.emitter.on('update', rebuildAgentWatcher);

  terminalBridge.emitter.on('update', broadcastTerminalUpdate);
  terminalBridge.emitter.on('frame', (payload) => sendToRenderer('terminal:frame', payload));
  terminalBridge.emitter.on('backfill', (payload) => sendToRenderer('terminal:backfill', payload));
  terminalBridge.emitter.on('reset', (payload) => sendToRenderer('terminal:reset', payload));
  terminalBridge.emitter.on('control-state', (payload) => sendToRenderer('terminal:control-state', payload));
  terminalBridge.emitter.on('error', (error) => console.error('terminal error', error));
  terminalBridge.emitter.on('connection-lost', () => {
    daemonBanner = { error: 'connection_lost: the session daemon went away; reconnecting...' };
    broadcastDaemonBanner();
  });
  terminalBridge.emitter.on('connection-restored', () => {
    daemonBanner = 'ok';
    broadcastDaemonBanner();
  });

  usageTimer = setInterval(broadcastUsageUpdate, 60_000);

  // Mid-session wedge detection (live-caught 2026-07-21): a wedged daemon
  // keeps its established connections open, so connection-lost never fires
  // and the running app dies silently until the next user action times out.
  // Active probe instead: on two consecutive ping failures, recover the
  // daemon IN PLACE through `harbor-sessiond recover` (wedge-recovery.js owns
  // the policy). No app relaunch (2026-08-30): every recovery lane now ends
  // with the wedged process DEAD, so the bridges' close-triggered reconnect
  // fires and rebuilds observers; the old relaunch existed only because a
  // wedge's connections never closed. `daemon:retry` keeps its relaunch as
  // the manual last resort.
  // Disabled for harnesses: they own their daemon and their app lifetime.
  if (!e2eMode && process.env.HARBOR_NO_DAEMON_START !== '1') {
    daemonWatchdog = createDaemonWatchdog({
      ping: () => createControlClient({ env: process.env, sessionStorePolicy }).ping(),
      onWedge: createWedgeRecovery({
        connectDaemon,
        setBanner: (banner) => { daemonBanner = banner; broadcastDaemonBanner(); },
        reconnectNow: () => terminalBridge?.reconnectNow?.(),
        log: (msg) => console.warn(msg),
      }),
      log: (msg) => console.warn(msg),
    });
    daemonWatchdog.start();
  }

  registerIpc();
  await Promise.all([
    sidebarBridge.start(),
    terminalBridge.start(),
  ]);
  // Hold EVERY driven pane at a size Claude's dialogs fit in, not just the ones
  // a window happens to be open on. Live-caught 2026-07-28: sizing ran only
  // from the question card's poll, so two of Pat's twelve panes stayed at
  // 23x54 and the first dialog either of them drew would have clipped exactly
  // as before. Serialized and idempotent; a pane with the ">_" view open is
  // left at the size that xterm fitted.
  if (!e2eMode) terminalBridge.startPaneSizeSweep();
  // Seed notifier with current agent statuses so the first event is
  // interpreted correctly (a completion right after boot must still toast).
  try {
    const snap = await agentClient.snapshot();
    notifier?.seedFromSnapshot(snap.snapshot);
  } catch {
    // daemon may be unavailable; notifier starts cold
  }
  rebuildAgentWatcher();
  broadcastSidebarUpdate(sidebarBridge.getState());
  broadcastTerminalUpdate(terminalBridge.getState());
  createWindow();
  watchDistForUpdates();
  scheduleTitler();

  // Cold-start chord (R10): when Ctrl/Alt+Copilot LAUNCHES the app (no prior
  // instance to forward to), our own argv carries the intent; act on it now.
  if (!e2eMode && secondInstancePayload?.action === 'new-session') {
    runNewSessionIntent({
      account: configuredProfileId(secondInstancePayload.home),
      cwd: secondInstancePayload.cwd,
    });
  }
  if (pendingNewSessionIntent) {
    runNewSessionIntent(pendingNewSessionIntent);
    pendingNewSessionIntent = null;
  }
}).catch((error) => {
  console.error('app startup failed', error);
  app.exit(1);
});

function shutdownApp() {
  shuttingDown = true;
  clearInterval(usageTimer);
  daemonWatchdog?.stop();
  notifier?.destroy();
  transcriptProvider?.closeAll();
  if (orchWatcher) {
    orchWatcher();
    orchWatcher = null;
  }
  for (const close of orchSummaryWatchers) close();
  orchSummaryWatchers = [];
  clearTimeout(orchSummaryExpiryTimer);
  orchSummaryExpiryTimer = null;
  taskStore?.close();
  noteStore?.close();
  whiteboardStore?.close();
  sidebarBridge?.close();
  terminalBridge?.close();
}

app.on('before-quit', () => { shuttingDown = true; });

app.on('window-all-closed', () => {
  shutdownApp();
  if (platform.shouldQuitOnWindowAllClosed()) app.quit();
});
