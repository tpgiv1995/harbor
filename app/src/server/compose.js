'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createRouter } = require('../main/rpc/router.js');
const { METHOD_CHANNELS } = require('../main/rpc/channels.js');
const { createConfigStore } = require('../main/config/store.js');
const { createSidebarBridge } = require('../main/sidebar-bridge.js');
const { createTerminalBridge } = require('../main/terminal-bridge.js');
const { createControlClient, resolveSessionBackend } = require('../main/session-daemon/factory.js');
const { createLaunchActions } = require('../main/actions/launch.js');
const { createSessionOperationGate, createSessionOwnerProbe, createTakeoverOwner, createTakeoverHandler, startResumeFollowup } = require('../main/actions/takeover.js');
const { createPlatform } = require('../main/platform/index.js');
const { createVoiceRealtime } = require('../main/voice-realtime.js');
const { createWhisperTranscriber } = require('../main/whisper-transcription.js');
const { resolveContextDir, resolveSignalPolicy, resolveLaunchPolicy, resolveSessionStorePolicy, createSignalGuard, createInjectableExecFile } = require('../main/isolation.js');
const { defaultUserDataDir } = require('../shared/tasks-file.cjs');
const { projectLabelForCwd: sharedProjectLabelForCwd } = require('../shared/project-label.cjs');
const { createTranscriptProvider, findProviderTranscript } = require('../main/providers/transcript.js');
const { createAskTranscriptResolver } = require('../main/ask-transcript-path.js');
const { createPendingAskReader } = require('../main/providers/pending-ask.js');
const { createSessionSend, createLinkRegistry } = require('../main/session-send.js');
const { createHistoryProvider } = require('../main/providers/history.js');
const { createUsageProvider } = require('../main/providers/usage.js');
const { createAccountsProvider, readAccountEmails } = require('../main/providers/accounts.js');
const { createCapabilitiesProvider, newSessionOptions } = require('../main/providers/capabilities.js');
const { createWorkflowRuns } = require('../main/providers/workflow-runs.js');
const { createArtifactsProvider } = require('../main/providers/artifacts.js');
const { createArtifactThumbs } = require('../main/providers/artifact-thumbs.js');
const { createProjectIconProvider } = require('../main/providers/project-icons.js');
const { createTaskStore } = require('../main/providers/tasks.js');
const { createNoteStore } = require('../main/providers/notes.js');
const { createWhiteboardStore } = require('../main/providers/whiteboard.js');
const { startSessionDaemon } = require('../main/lifecycle.js');
const { createAppShim } = require('./app-shim.js');
const { createArtifactHandler } = require('./http/artifacts.js');
const { createIconHandler } = require('./http/icons.js');
const { createStaticHandler } = require('./http/static.js');
const { createWebSocketTransport } = require('./transport/ws.js');
const { createClientResources } = require('./client-resources.js');
const { ensureServerToken } = require('./transport/auth.js');
const { createTailnetAuthorizer, resolveAllowedLogins } = require('./transport/tailnet-identity.js');
const { createImageUploader } = require('./upload.js');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

// Tailscale hands every node an address in the CGNAT range 100.64.0.0/10, which
// is the range this server is allowed to bind because reaching it requires
// already being on the tailnet. It used to be a LITERAL '100.x.y.z' in the
// allow-set: the publish-time scrub rewrote a real address, and since the check
// is exact-membership the entry could then never match any address at all, so
// the documented direct-tailnet bind was refused for everyone (including the
// author) with a message naming an impossible string. A range test is both the
// correct check and immune to the scrub, because there is no address in it to
// anonymize.
function isTailscaleCgnat(host) {
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host));
  if (!octets) return false;
  const parts = octets.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return false;
  // 100.64.0.0/10 is 100.64.x.x through 100.127.x.x inclusive.
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function assertSafeBind(host) {
  if (!LOOPBACK_HOSTS.has(host) && !isTailscaleCgnat(host)) {
    throw new Error(`harbor-server: refusing unsafe bind address '${host}'; use localhost or a Tailscale address in 100.64.0.0/10`);
  }
  return host;
}

// The Origin allowlist in transport/ws.js is built mostly from the live bound
// socket, but that alone misses `setup/mobile.md`'s recommended phone setup:
// keep the loopback bind and put `tailscale serve --https=443` in front of
// it, which terminates HTTPS at the tailnet's MagicDNS name and proxies to
// loopback. A phone reaching the PWA that way opens its WebSocket from
// its MagicDNS name on port 443 (`https://your-machine.your-tailnet.ts.net`,
// say), neither of which is what
// this process itself is bound to, so the bind-derived check alone would
// refuse that exact documented flow and break the phone.
//
// Discovered the same way `resolveAllowedLogins` (transport/tailnet-identity.js)
// discovers the node's own login: `tailscale status --json` is the one place
// this codebase already trusts the CLI's self-report, so this reuses that
// shape rather than inventing a second way to ask. A missing `tailscale`
// binary, a `tailscale down` node, or a malformed reply all degrade to null
// rather than throwing; that only means the Serve/MagicDNS origin is not
// allowed, while loopback and a direct tailnet-IP bind keep working exactly
// as before, because they never depended on this.
async function resolveSelfMagicDnsName({ env = process.env, execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    execFileImpl('tailscale', ['status', '--json'], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      try {
        const parsed = JSON.parse(String(stdout));
        const name = parsed?.Self?.DNSName;
        // Tailscale reports the MagicDNS name fully-qualified, with a
        // trailing dot; a browser's Origin header never carries one, so
        // comparing against the raw value would refuse every real request.
        resolve(typeof name === 'string' && name.trim() ? name.trim().replace(/\.+$/, '').toLowerCase() : null);
      } catch { resolve(null); }
    });
  });
}

async function waitForDaemon({ env, sessionStorePolicy }) {
  const client = createControlClient({ env, sessionStorePolicy });
  try {
    try { await client.ping(); return; } catch { /* start below */ }
    startSessionDaemon();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try { await client.ping(); return; } catch { /* keep polling */ }
    }
    throw new Error('harbor-server: session daemon did not become available');
  } finally {
    client.close?.();
  }
}

// THE canonical rule, from shared/project-label.cjs, not a copy of it. This file
// carried its own hand-copied version, which is precisely the shape the
// 2026-08-05 incident in that module's header is about: two labellers for one
// directory split it into two rail groups. A local copy that merely happens to
// agree today is the same defect waiting.
function projectLabelForCwd(cwd) {
  return sharedProjectLabelForCwd(cwd, os.homedir());
}

async function candidateProjectFolders(sidebar, { sessionId } = {}) {
  const candidates = [];
  if (sessionId) {
    const meta = await sidebar.getSessionMeta(sessionId).catch(() => null);
    if (path.isAbsolute(meta?.cwd || '')) candidates.push(path.normalize(meta.cwd));
  }
  const projects = sidebar.getState()?.model?.projects || [];
  const sessions = projects.flatMap((project) => project.sessions || [])
    .filter((session) => path.isAbsolute(session?.cwd || ''))
    .sort((left, right) => (right.lastActiveMs || 0) - (left.lastActiveMs || 0));
  for (const session of sessions) candidates.push(path.normalize(session.cwd));
  return [...new Set(candidates)];
}

async function composeServer(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const userDataDir = path.resolve(options.userDataDir || env.HARBOR_USER_DATA_DIR || defaultUserDataDir({ env }));
  const defaultUserDataPath = defaultUserDataDir({ env });
  const profile = { userDataPath: userDataDir, defaultUserDataPath };
  const contextDir = resolveContextDir(env);
  const signalPolicy = resolveSignalPolicy({ ...profile, contextDir });
  const launchPolicy = resolveLaunchPolicy(profile);
  const sessionStorePolicy = resolveSessionStorePolicy({ ...profile, env });
  const signalCalls = [];
  const guardedKill = createSignalGuard({
    policy: signalPolicy,
    processKill: (pid, signal) => {
      signalCalls.push([pid, signal]);
      try { return process.kill(pid, signal); }
      catch (error) {
        if (error?.code === 'ESRCH' && signal === 0) return;
        throw error;
      }
    },
  });
  const injectableExecFile = createInjectableExecFile(launchPolicy, {
    env,
    fakeLaunch: env.HARBOR_E2E_FAKE_LAUNCH === '1',
    onFakeLaunch: options.onFakeLaunch,
  });
  const app = createAppShim({ userDataDir });
  const configStore = createConfigStore({ app, env, file: options.configFile });
  const config = await configStore.load();
  resolveSessionBackend(env);
  if (!options.skipDaemonStart && env.HARBOR_NO_DAEMON_START !== '1') {
    await waitForDaemon({ env, sessionStorePolicy });
  }

  const router = createRouter();
  const sidebar = options.sidebar || createSidebarBridge({
    daemonOptions: { env, sessionStorePolicy },
    // The SAME labeller index.js passes. Without it the bridge's provider
    // history fell back to naming a cwd by its last segment alone, so a codex
    // or cursor session in the same folder as a claude one landed under `site`
    // while the claude rows sat under `demo/site`: one project, two rail
    // groups, on the phone only.
    projectLabelForCwd,
    history: options.history || createHistoryProvider({
      projectsPath: config.paths.projectsDir,
      cacheDir: config.paths.cacheDir,
      profiles: config.profiles,
    }),
  });
  const artifacts = options.artifacts || createArtifactsProvider({
    roots: env.HARBOR_ARTIFACTS_ROOTS
      ? env.HARBOR_ARTIFACTS_ROOTS.split(path.delimiter).filter(Boolean)
      : [config.paths.projectsDir],
    cacheFile: env.HARBOR_ARTIFACTS_CACHE || path.join(config.paths.cacheDir, 'artifacts-index.json'),
  });
  const icons = options.icons || createProjectIconProvider({ app, configuredDir: config.paths.projectIconsDir, scheme: 'harbor-icon' });
  const tasks = options.tasks || createTaskStore({ app, env, configuredFile: config.paths.tasksFile });
  const notes = options.notes || createNoteStore({ app, env, configuredFile: config.paths.notesFile });
  const whiteboard = options.whiteboard || createWhiteboardStore({ app, env, configuredDir: config.paths.boardsDir });
  const terminalBridge = options.terminalBridge || createTerminalBridge({ env, sessionStorePolicy, processKill: guardedKill });
  const transcript = options.transcript || createTranscriptProvider({
    getSessionMeta: (id) => sidebar.getSessionMeta(id),
    contextCacheDir: contextDir,
  });
  // What each connected client has acquired, so it can be given back when that
  // client goes away. Register a releaser here for any method added later that
  // opens, attaches, or subscribes to something on a client's behalf.
  const clientResources = createClientResources({
    releasers: { transcript: (sessionId) => transcript.close(sessionId) },
    logger,
  });
  const links = options.links || createLinkRegistry();
  const sendClient = options.sendClient || createControlClient({ env, sessionStorePolicy });
  const platform = options.platform || createPlatform(process.platform, { env, processKill: guardedKill });
  // ONE ownership ladder for the two consumers that need it (see index.js and
  // actions/launch.js): adopt-on-send before it may signal, and resume before
  // it may overrule bin/claude-sessions' transcript-mtime live guard.
  const sessionOwnerProbe = options.sessionOwnerProbe || createSessionOwnerProbe({
    contextDir,
    readFile: fs.readFile,
    statFile: (target) => fs.stat(target),
    platform: { processInfo: (pid) => platform.processInfo(pid) },
    scanForSessionOwner: (sessionId) => platform.findSessionOwner(sessionId),
  });
  const launchActions = options.launchActions || createLaunchActions({
    execFile: injectableExecFile,
    profiles: config.profiles,
    isSessionUnowned: async (id) => (await sessionOwnerProbe(id)).ownerGone,
  });
  const pendingAsk = createPendingAskReader();
  const askTranscript = createAskTranscriptResolver({
    getSessionMeta: (id) => sidebar.getSessionMeta(id),
    findTranscript: findProviderTranscript,
  });
  const sessionSend = options.sessionSend || createSessionSend({
    snapshot: async () => {
      const result = await sendClient.snapshot();
      return result?.snapshot || result || {};
    },
    readPane: async (paneId, lines = 16, source = 'recent') => {
      const result = await sendClient.readPane(paneId, { source, lines, strip_ansi: true });
      return result?.read?.text || '';
    },
    terminalBridge,
    launchActions,
    getSessionMeta: (id) => sidebar.getSessionMeta(id),
    resolveTranscriptPath: (id) => askTranscript.resolve(id),
    links,
    projectLabelForCwd,
  });
  const liveAskFor = async (sessionId) => {
    const transcriptPath = await askTranscript.resolve(sessionId);
    return transcriptPath ? pendingAsk.read(transcriptPath) : null;
  };
  const usage = options.usage || createUsageProvider({
    profiles: config.profiles,
    cacheDir: config.paths.cacheDir,
    fetchRemoteUsage: env.HARBOR_NO_USAGE_FETCH === '1' ? null : undefined,
  });
  const accountsProvider = options.accountsProvider || createAccountsProvider({
    history: { sessionMeta: (id) => sidebar.getSessionMeta(id) },
    profiles: config.profiles,
  });
  const capabilities = options.capabilities || createCapabilitiesProvider({ accounts: accountsProvider });
  const workflowRuns = options.workflowRuns || createWorkflowRuns({
    getSessionMeta: (id) => sidebar.getSessionMeta(id),
    findTranscript: findProviderTranscript,
  });
  const artifactThumbs = options.artifactThumbs || createArtifactThumbs({
    cacheDir: path.join(config.paths.cacheDir, 'artifact-thumbs'),
  });
  const operationGate = createSessionOperationGate();
  const takeoverOwner = options.takeoverOwner || createTakeoverOwner({
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
  const takeoverHandler = options.takeoverHandler || createTakeoverHandler({
    operationGate,
    takeoverOwner,
    paneIdSet: () => sessionSend.paneIdSet(),
    getSessionMeta: (id) => sidebar.getSessionMeta(id),
    resumeSession: (args) => launchActions.resumeSession(args),
    findFreshPane: (args) => sessionSend.findFreshPane(args),
    setPaneLink: (id, pane) => links.set(id, pane),
    requestFocusPane: (pane) => terminalBridge.requestFocusPane(pane),
    waitForResumedClaudeReady: (paneId, workspaceId) => sessionSend.waitForResumedClaudeReady(paneId, workspaceId),
    emitStatus: (payload) => { sessionSend.logStatus?.(payload); router.emit('send:status', payload); },
    emitLaunched: (payload) => router.emit('session:launched', payload),
  });
  const voice = options.voice || createVoiceRealtime({ env });
  const whisperTranscriber = options.whisperTranscriber || createWhisperTranscriber({ env });
  const uploadImage = options.uploadImage || createImageUploader({ userDataDir });
  const handlers = {
    'sidebar:get-state': () => sidebar.getState(),
    'new-session:options': () => newSessionOptions(config),
    'new-session:folder': (payload = {}) => candidateProjectFolders(sidebar, payload),
    'new-session': async (payload = {}) => {
      const folder = path.normalize(String(payload.folder || ''));
      const candidates = await candidateProjectFolders(sidebar, payload);
      if (!path.isAbsolute(folder) || !candidates.includes(folder)) {
        throw new Error(`new-session folder is not a candidate project folder: ${payload.folder || '(missing)'}`);
      }
      return launchActions.newSession({
        account: payload.account,
        cwd: folder,
        provider: payload.provider,
        model: payload.model,
        effort: payload.effort,
      });
    },
    'pane:focus': (payload) => sidebar.focusLivePane(payload || {}),
    'session:preview': ({ sessionId } = {}) => sidebar.getSessionPreview(sessionId),
    'artifacts:list': () => artifacts.list(),
    'project-icons:list': async () => {
      const listed = await icons.list(); const mapped = {};
      for (const [slug, source] of Object.entries(listed.icons)) {
        const file = decodeURIComponent(new URL(source).pathname.replace(/^\/+/, ''));
        mapped[slug] = `/icons/${encodeURIComponent(file)}`;
      }
      return { ...listed, icons: mapped };
    },
    'tasks:read': () => tasks.read(),
    'tasks:mutate': (op) => tasks.mutate(op),
    'notes:read': () => notes.read(),
    'notes:mutate': (op) => notes.mutate(op),
    'whiteboard:list': () => whiteboard.list(),
    'whiteboard:read': (payload) => whiteboard.read(payload),
    // Opens are OWNED by the caller (see server/client-resources.js). Without
    // that, a client that vanishes pins the entry forever: its fs watcher and
    // its 5s poller keep re-reading the transcript for the life of the process,
    // and the refcount can never reach zero again, so even an honest close from
    // another client cannot free it.
    'transcript:open': async (payload = {}, ctx = {}) => {
      const result = await transcript.open(payload.sessionId, payload);
      if (result?.ok !== false) clientResources.acquire(ctx.clientId, 'transcript', payload.sessionId);
      return result;
    },
    'transcript:close': ({ sessionId } = {}, ctx = {}) => {
      // A caller with an identity may only close what it actually holds, so one
      // client can no longer decrement another's refcount and strand the entry.
      // A caller with NO identity (the local/desktop path) keeps the old
      // behaviour exactly.
      if (ctx.clientId && !clientResources.release(ctx.clientId, 'transcript', sessionId)) {
        return { ok: true, ignored: 'not held by this client' };
      }
      return transcript.close(sessionId);
    },
    'session:menu-state': async (payload = {}) => {
      try {
        const ask = (await liveAskFor(payload.sessionId))?.questions || null;
        return await sessionSend.getMenu({ ...payload, ask });
      } catch { return null; }
    },
    'session:menu-answer': async (payload) => {
      try { return await sessionSend.answerMenu(payload); }
      catch (error) { return { ok: false, reason: error.message }; }
    },
    'session:send': async (payload) => {
      try { return await sessionSend.send(payload); }
      catch (error) { return { ok: false, reason: error.message }; }
    },
    'session:send-queue': ({ sessionId } = {}) => sessionSend.getQueueState(sessionId),
    'session:cancel-send': ({ sessionId, sendId } = {}) => sessionSend.cancelQueued(sessionId, sendId),
    'session:interrupt': ({ paneId } = {}) => paneId
      ? terminalBridge.sendInput(paneId, '\x1b')
      : { ok: false, reason: 'no live pane to interrupt' },
    'usage:get-all': async () => Object.fromEntries(await Promise.all(config.profiles.map(async ({ id }) => (
      [id, await usage.getUsage(id)]
    )))),
    'capabilities:get': async ({ sessionId } = {}) => {
      try { return { ok: true, capabilities: await capabilities.get(sessionId) }; }
      catch (error) { return { ok: false, reason: error.message }; }
    },
    'capabilities:permission-mode': async ({ paneId } = {}) => {
      if (!paneId) return { mode: null };
      try { return await sessionSend.readPermissionMode(paneId); }
      catch (error) { return { mode: null, reason: error.message }; }
    },
    'capabilities:cycle-permission-mode': async ({ paneId, workspaceId } = {}) => {
      if (!paneId) return { ok: false, reason: 'no pane to cycle' };
      try { return { ok: true, ...await sessionSend.cyclePermissionMode(paneId, workspaceId) }; }
      catch (error) { return { ok: false, reason: error.message }; }
    },
    'resume-session': async ({ id, detectedHome } = {}) => operationGate.run(id, async () => {
      const meta = await sidebar.getSessionMeta(id).catch(() => null);
      const preIds = typeof sessionSend.paneIdSet === 'function' ? await sessionSend.paneIdSet() : null;
      const result = meta?.provider && meta.provider !== 'claude'
        ? await launchActions.resumeProviderSession({ provider: meta.provider, cwd: meta.cwd, id })
        : await launchActions.resumeSession({ id, detectedHome });
      if (preIds && typeof sessionSend.findFreshPane === 'function') {
        startResumeFollowup({
          sessionId: id,
          emitStatus: (payload) => router.emit('send:status', payload),
          run: async () => {
            const fresh = await sessionSend.findFreshPane({ preIds, cwd: meta?.cwd || null });
            if (!fresh) return;
            links.set(id, fresh);
            await terminalBridge.requestFocusPane?.(fresh).catch(() => {});
            const ready = meta?.provider && meta.provider !== 'claude'
              ? await sessionSend.waitForProviderReady(fresh.paneId)
              : await sessionSend.waitForResumedClaudeReady(fresh.paneId, fresh.workspaceId);
            if (!ready) throw new Error(`Session resumed, but ${meta?.provider || 'Claude'} never became ready`);
            router.emit('session:launched', { sessionId: id, ...fresh, cwd: meta?.cwd || null, resumed: true, ...(meta?.provider ? { provider: meta.provider } : {}) });
          },
        });
      }
      return result;
    }),
    'session:takeover': (payload = {}) => takeoverHandler(payload),
    'voice:voices': () => voice.voices(),
    'voice:token': async (payload = {}) => {
      try { return await voice.mintToken(payload); }
      catch (error) { return { ok: false, reason: error?.message || 'could not start a voice session' }; }
    },
    'whisper:transcribe': async (payload = {}) => {
      try { return await whisperTranscriber(payload); }
      catch (error) { return { ok: false, reason: error?.message || 'Whisper transcription failed.' }; }
    },
    'upload:image': (payload = {}) => uploadImage(payload),
    'session:workflow-runs': ({ sessionId } = {}) => workflowRuns.runsForSession(sessionId),
    'links:get': () => links.all(),
    'accounts:read-emails': () => options.accounts?.readEmails
      ? options.accounts.readEmails()
      : readAccountEmails({ profiles: config.profiles }),
    'artifacts:thumb': async ({ path: target, mtimeMs, kind } = {}) => {
      if (!artifacts.isServable(target)) return { ok: false, thumbPath: null };
      return { ok: true, thumbPath: await artifactThumbs.thumbFor({ path: target, mtimeMs, kind }) };
    },
  };
  for (const { method } of METHOD_CHANNELS) {
    router.register(method, handlers[method] || (() => { throw new Error(`RPC method '${method}' is not available in the headless composition`); }));
  }
  // An EventEmitter that emits 'error' with NO registered listener THROWS, and
  // in this process that kills harbor-server outright. The desktop root has
  // always registered one (main/index.js: `sidebarBridge.emitter.on('error',
  // ...)`); this root never did, so the SAME recoverable condition was a logged
  // warning on the desktop and a fatal crash on the phone.
  //
  // Live-caught 2026-08-03 15:23:32: one python3 child failed inside
  // history.sessionHomes(), refreshHistory's .catch re-emitted it as 'error',
  // nothing was listening, and the server exited 1 while Pat's phone was on it.
  // The journal shows the signature plainly: "Emitted 'error' event at:".
  //
  // The python runner (d4849e1) bounds the SPAWNS; it does not make a spawn
  // FAILURE non-fatal. That is this listener's job. Degrade and log: the rail
  // keeps serving its last good state and the next refresh retries.
  //
  // This is the fifth time a new composition root has missed something the
  // desktop root has (cf. resolveSignalPolicy, "the 4th time this repo lost
  // isolation"). Anything wired below that can emit 'error' needs a listener
  // here, not just its happy-path channel.
  const onSubsystemError = (source) => (error) => {
    console.error(`harbor-server: ${source} error (continuing):`, error?.message || error);
  };
  sidebar.emitter?.on('error', onSubsystemError('sidebar'));
  transcript.emitter?.on('error', onSubsystemError('transcript'));
  terminalBridge.emitter?.on('error', onSubsystemError('terminal-bridge'));

  // Trailing-edge throttle, not just the client-side coalesce fixed earlier
  // (2026-08-07): the sidebar model recomputes on every session/pane change
  // with no rate limit, and on a night this busy (77 projects, 891 sessions,
  // this very conversation forking a new one on every reply) that model
  // fires far faster than a real phone connection over Tailscale can drain
  // it. The client-side fix stopped the DOUBLE send (push + refetch); this
  // stops the push itself from outrunning a slow link. Always the LATEST
  // payload, never a stale one, and the trailing update always lands even
  // if changes stop mid-window.
  let sidebarThrottleTimer = null;
  let sidebarThrottlePayload = null;
  const SIDEBAR_THROTTLE_MS = 2000;
  sidebar.emitter?.on('update', (payload) => {
    sidebarThrottlePayload = payload;
    if (sidebarThrottleTimer) return;
    sidebarThrottleTimer = setTimeout(() => {
      sidebarThrottleTimer = null;
      router.emit('sidebar:update', sidebarThrottlePayload);
    }, SIDEBAR_THROTTLE_MS);
  });
  transcript.emitter?.on('update', (payload) => router.emit('transcript:update', payload));
  sessionSend.emitter?.on('status', (payload) => router.emit('send:status', payload));
  links.emitter?.on('update', () => router.emit('links:update', links.all()));
  icons.watch?.((payload) => router.emit('project-icons:update', payload));
  tasks.subscribe?.((doc) => router.emit('tasks:changed', { doc }));
  notes.subscribe?.((doc) => router.emit('notes:changed', { doc }));
  await sidebar.start?.();
  await terminalBridge.start?.();
  await artifacts.list();

  const artifactHandler = createArtifactHandler({ provider: artifacts });
  const iconHandler = createIconHandler({ provider: icons });
  // dist-web, NOT dist/web: the desktop renderer builds into dist/ and vite
  // empties that directory, so the mobile client was deleted by every
  // `npm run build`, and therefore by every E2E gate run. The server then
  // answered a bare "not found" on every path and the installed phone app
  // looked dead, which is exactly what Pat saw on 2026-08-02.
  const webDist = options.webDist
    || env.HARBOR_WEB_DIST
    || path.join(__dirname, '../../dist-web');
  // A missing client is a BUILD problem. Say so at startup rather than 404ing
  // every request and leaving whoever opens the app to guess.
  if (!require('node:fs').existsSync(path.join(webDist, 'index.html'))) {
    logger.warn(`harbor-server: no built client at ${webDist}; run \`npm run build:web\`. Serving 404 until then.`);
  }
  const staticHandler = createStaticHandler({ root: webDist, logger });
  // Tailscale already authenticated the DEVICE before its packets could route
  // here, so a caller it identifies as this node's owner does not also have to
  // carry a bearer token. Discovered, never hardcoded: see
  // transport/tailnet-identity.js.
  const allowedLogins = options.allowedTailnetLogins || await resolveAllowedLogins({ env, logger });
  // trustedPeerUids is the uid tailscaled runs as. A harness stands in for
  // tailscaled by declaring its own uid, which is why it is injectable.
  const tailnetAuth = createTailnetAuthorizer({ allowedLogins, trustedPeerUids: options.trustedPeerUids || null });
  if (allowedLogins.length) logger.info?.(`harbor-server: tailnet authentication enabled for ${allowedLogins.join(', ')}`);
  const server = http.createServer(async (req, res) => {
    if (await artifactHandler(req, res)) return;
    if (await iconHandler(req, res)) return;
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
    // The client asks this BEFORE it decides to show a token prompt, so it must
    // never be cached: a stale 'not authenticated' would resurrect the very
    // prompt this exists to remove, which is the same class of bug as the
    // frozen service worker.
    if (req.url === '/whoami') {
      const verdict = tailnetAuth(req);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        authenticated: verdict.ok,
        method: verdict.ok ? 'tailnet' : null,
        login: verdict.login,
        name: verdict.name,
        tokenRequired: !verdict.ok,
      }));
      return;
    }
    if (await staticHandler(req, res)) return;
    res.writeHead(404); res.end('not found');
  });
  const token = await ensureServerToken(userDataDir);
  // See resolveSelfMagicDnsName above: this is the third name (alongside
  // loopback and whatever this process is bound to) the Origin check in
  // transport/ws.js will accept a WebSocket handshake from. `options.selfOriginHosts`
  // lets a test or harness supply one directly rather than shelling out to a
  // real `tailscale` binary that likely is not installed there, the same
  // escape `options.allowedTailnetLogins` gives `resolveAllowedLogins` above.
  //
  // Discovery is NOT a one-shot at compose time. A server that starts before
  // the Tailscale service is up would otherwise refuse every phone browser
  // upgrade (Origin = MagicDNS name via `tailscale serve`) until restarted.
  // The transport re-asks through this getter on each upgrade (TTL-cached
  // inside ws.js). A pinned `options.selfOriginHosts` stays pinned.
  const resolveMagicDns = options.resolveSelfMagicDnsName || resolveSelfMagicDnsName;
  const resolveSelfOriginHosts = options.selfOriginHosts
    ? async () => options.selfOriginHosts
    : async () => {
      const name = await resolveMagicDns({ env });
      return name ? [name] : [];
    };
  // Seed once so the first handshake after a healthy start does not wait on
  // a cold `tailscale status` when discovery already succeeded here.
  const selfOriginHosts = await resolveSelfOriginHosts();
  const ws = createWebSocketTransport({
    server, router, token, tailnetAuth, selfOriginHosts,
    resolveSelfOriginHosts,
    selfOriginHostsTtlMs: options.selfOriginHostsTtlMs,
    selfOriginHostsEmptyTtlMs: options.selfOriginHostsEmptyTtlMs,
    queueLimit: options.queueLimit,
    // Default (8MB) sized for a normal client; a phone over Tailscale during
    // an exceptionally busy night (2026-08-07: 77 projects, 891 sessions) can
    // legitimately need more headroom to drain a burst before it's declared
    // "too slow" and dropped. Raised, not removed: an actually-wedged client
    // still gets closed, just at a threshold sized for real bursts instead
    // of a guess.
    queueMaxBytes: options.queueMaxBytes || 32 * 1024 * 1024,
    heartbeatMs: options.heartbeatMs,
    onClientGone: (clientId) => clientResources.releaseAll(clientId),
    logger,
  });
  return {
    app, config, router, server, token, userDataDir, transcript, clientResources,
    isolation: { signalPolicy, launchPolicy, guardedKill, signalCalls, injectableExecFile, launchActions },
    async listen({ host = env.HARBOR_SERVER_HOST || '127.0.0.1', port = Number(env.HARBOR_SERVER_PORT || 8787) } = {}) {
      assertSafeBind(host);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      return server.address();
    },
    async close() {
      transcript.closeAll?.(); terminalBridge.close?.(); sidebar.close?.(); tasks.close?.(); notes.close?.();
      await ws.close(); await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { LOOPBACK_HOSTS, isTailscaleCgnat, assertSafeBind, composeServer, resolveSelfMagicDnsName };
