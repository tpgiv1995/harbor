'use strict';

// LIVE Windows prod-drive for LIVE VOICE MODE: a real ephemeral credential, a
// real WebRTC handshake against the real OpenAI realtime model, a real data
// channel, and a real tool call back into Harbor.
//
// Why this exists next to scripts/live-drive-voice.js: that one is the Linux
// original and CANNOT be run on this machine. It launches through Playwright's
// electron helper and then calls setBounds({ x: 0, y: 0, width: 2560, height:
// 1600 }), which shows and restacks a full-screen window over whatever is on
// the desktop. Windows has no focus guard, and Pat games fullscreen, so that is
// exactly the thing no automation here may do. This is the same drive in the
// drive-*-win.js posture: spawned directly with --no-focus-steal and parked off
// the visible desktop with SWP_NOACTIVATE before anything else happens.
//
// NOT in any gate: it opens a real voice session and costs real money (cents).
//
// The microphone is Chromium's fake device fed SILENCE, deliberately: the
// default fake device emits a periodic beep, and server-side turn detection
// would answer it over and over. What the user "says" is injected as text
// through the same data channel (window.__harborVoice.sayAsUser), which is the
// e2e seam the hook already exposes. Everything else is real.
//
// The proof that the TOOL LOOP ran is that the spoken answer names a session
// only harbor_list_sessions could have told it about. Only read-only tools are
// exercised: nothing here may type into one of Pat's sessions.
//
// Usage (from app/):  node scripts/drive-live-voice-win.js
// Writes screenshots and a verdict to %TEMP%\harbor-drive-live-voice\

const { spawn, execSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9338;
const OUT = path.join(os.tmpdir(), 'harbor-drive-live-voice');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url) {
  const res = await fetch(url);
  return res.json();
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`page threw: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''}`);
    }
    return result.result.value;
  }

  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(result.data, 'base64'));
  }
}

async function waitFor(cdp, expression, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await cdp.eval(expression);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(400);
  }
}

async function pickTypeableSession(cdp) {
  const groups = await cdp.eval("document.querySelectorAll('.pg').length");
  for (let group = 0; group < Math.min(groups, 6); group += 1) {
    await cdp.eval(`document.querySelectorAll('.pg')[${group}]?.click(); true`);
    await sleep(500);
    const rows = await cdp.eval("document.querySelectorAll('.sr:not(:disabled)').length");
    for (let row = 0; row < Math.min(rows, 8); row += 1) {
      const id = await cdp.eval(`(() => {
        const target = document.querySelectorAll('.sr:not(:disabled)')[${row}];
        if (!target) return '';
        target.click();
        return target.getAttribute('data-session-id') || 'unknown';
      })()`);
      if (!id) continue;
      for (let wait = 0; wait < 12; wait += 1) {
        await sleep(250);
        if (await cdp.eval("document.querySelector('.ubar-input[contenteditable=\"true\"]') ? true : false")) return id;
      }
    }
  }
  return '';
}

async function silenceFixture() {
  const wav = path.join(OUT, 'silence.wav');
  if (!fs.existsSync(wav)) {
    await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'anullsrc=r=48000:cl=mono', '-t', '10', '-c:a', 'pcm_s16le', wav]);
  }
  return wav;
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const wav = await silenceFixture();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-live-voice-drive-'));
  const userData = path.join(tmp, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const realConfig = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  realConfig.paths = {
    ...realConfig.paths,
    cacheDir: path.join(tmp, 'cache'),
    tasksFile: path.join(tmp, 'tasks.json'),
    projectIconsDir: path.join(tmp, 'project-icons'),
  };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(realConfig, null, 2));

  const env = {
    ...process.env,
    HARBOR_E2E: '1',
    HARBOR_E2E_USER_DATA: userData,
    HARBOR_NO_DAEMON_START: '1',
    HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'),
    HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-live-voice-drive-${process.pid}`,
    HARBOR_CONTEXT_DIR: path.join(tmp, 'context'),
    HARBOR_NO_ICON_GEN: '1',
    HARBOR_NO_USAGE_FETCH: '1',
    HARBOR_NO_TITLER: '1',
    // The one thing this drive deliberately turns back on.
    HARBOR_NO_VOICE: '0',
  };
  const child = spawn(ELECTRON, [
    APP_DIR,
    `--remote-debugging-port=${PORT}`,
    '--no-focus-steal',
    `--use-file-for-fake-audio-capture=${wav}`,
  ], { env, stdio: 'ignore', detached: false });

  const facts = {};
  let failure = '';
  let live = null;
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i += 1) {
      await sleep(500);
      try {
        const list = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
        target = list.find((item) => item.type === 'page' && !/devtools/.test(item.url));
      } catch { /* not listening yet */ }
    }
    if (!target) throw new Error('CDP target never appeared');
    const connect = (url) => new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', () => reject(new Error('ws failed')));
    });
    const cdp = new Cdp(await connect(target.webSocketDebuggerUrl));
    live = cdp;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // Off the visible desktop, never activated, before anything else.
    execSync(`powershell -NoProfile -Command "Add-Type -Name W -Namespace P -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);'; $p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [P.W]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, -4200, 100, 1600, 1000, 0x0014) }"`, { stdio: 'ignore' });

    await waitFor(cdp, "document.querySelector('.sidebar-filter-chip') ? true : false", 'the session filter');
    await cdp.eval(`(() => {
      const all = [...document.querySelectorAll('.sidebar-filter-chip')].find((i) => i.textContent.trim() === 'All');
      if (all) all.click();
      return Boolean(all);
    })()`);
    await waitFor(cdp, "document.querySelector('.pg') ? true : false", 'a project row');
    facts.session = await pickTypeableSession(cdp);
    if (!facts.session) throw new Error('no session in the rail armed the composer');
    facts.openWindow = await cdp.eval(`(() => {
      const title = document.querySelector('.win2 .wh .ti');
      return title ? title.textContent.trim() : '';
    })()`);
    // The PROJECT is the checkable fact: the agent can only know it by calling
    // harbor_list_sessions, and it is the field the tool actually returns.
    facts.openProject = await cdp.eval("(document.querySelector('.ustat-pj-name')?.textContent || '').trim()");

    // The tool surface the model is handed must be the audited one.
    facts.toolNames = await cdp.eval('window.__harborVoiceTools || null');

    // Refuse to go further if a send could reach a real session. Read-only
    // tools are all this drive exercises, but the guard is cheap and the
    // consequence of being wrong is typing into Pat's work.
    facts.sendGuard = await cdp.eval(`(() => {
      window.__voiceSends = [];
      try {
        const real = window.harbor.session.send;
        window.harbor.session.send = async (payload) => {
          window.__voiceSends.push({ sessionId: payload.sessionId, text: payload.text });
          return { ok: false, reason: 'this drive does not send' };
        };
        return window.harbor.session.send !== real ? 'stubbed' : 'FROZEN: contextBridge refused the stub';
      } catch (error) { return 'FROZEN: ' + error.message; }
    })()`);

    // FAIL CLOSED. contextBridge freezes window.harbor, so the renderer-side
    // send stub above can be REFUSED, and if it was, window.__voiceSends stays
    // empty and the later "nothing was sent" check passes for the wrong reason
    // while a real tool call could still reach a session. So unless the stub is
    // proven installed, this drive never opens the paid voice agent (2026-09-03).
    if (facts.sendGuard !== 'stubbed') {
      throw new Error(`isolation not proven (${facts.sendGuard}); refusing to open the live voice agent`);
    }
    await cdp.eval("document.querySelector('.compose-live-voice').click(); true");
    // A real mint, a real SDP exchange and a real data channel open.
    await waitFor(cdp, "window.__harborVoice?.phase === 'live' ? true : (window.__harborVoice?.phase === 'error' ? 'error' : false)", 'the voice session to come up', 60_000);
    facts.phase = await cdp.eval('window.__harborVoice?.phase');
    facts.message = await cdp.eval('window.__harborVoice?.message || ""');
    if (facts.phase !== 'live') throw new Error(`voice never went live: ${facts.message}`);
    facts.voice = await cdp.eval('window.__harborVoice?.voice');
    await cdp.shot('01-live');

    // What Pat would have said. Answering it REQUIRES harbor_list_sessions.
    await cdp.eval(`window.__harborVoice.sayAsUser('what sessions are open right now? name the project.'); true`);
    await waitFor(cdp, "window.__harborVoice?.activity?.some((a) => a.kind === 'voice') ? true : false",
      'the agent to answer', 60_000);
    await sleep(2500);
    facts.activity = await cdp.eval("window.__harborVoice.activity.map((a) => ({ kind: a.kind, text: a.text.slice(0, 200) }))");
    await cdp.shot('02-answered');

    await cdp.eval('window.__harborVoice.stop(); true');
    await sleep(800);
    facts.phaseAfterStop = await cdp.eval('window.__harborVoice?.phase');
    facts.sendsAttempted = await cdp.eval('window.__voiceSends || []');

    const spoken = (facts.activity || []).filter((a) => a.kind === 'voice').map((a) => a.text).join(' ').toLowerCase();
    // The agent paraphrases a path out loud ("harbor slash orch-research"), so
    // the check is on distinctive WORDS from the project, not the exact string.
    // "harbor" is excluded because the agent says it naturally: it is Harbor's
    // own voice, and matching on it would prove nothing.
    facts.projectTokens = [...new Set((facts.openProject || '').toLowerCase().split(/[^a-z0-9]+/))]
      .filter((word) => word.length >= 4 && word !== 'harbor' && !/^\d+$/.test(word));
    const checks = {
      toolSurfaceIsTheAuditedFive: Array.isArray(facts.toolNames) && facts.toolNames.length === 5
        && facts.toolNames.includes('harbor_list_sessions')
        && !facts.toolNames.some((n) => /close|kill|launch|permission/.test(n)),
      wentLive: facts.phase === 'live',
      agentSpoke: spoken.length > 0,
      // Only a tool call could have told it this.
      toolLoopRan: facts.projectTokens.length > 0
        && facts.projectTokens.some((word) => spoken.includes(word)),
      stoppedCleanly: facts.phaseAfterStop === 'idle',
      nothingWasSent: (facts.sendsAttempted || []).length === 0,
    };
    facts.checks = checks;
    const bad = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
    if (bad.length) failure = `failed checks: ${bad.join(', ')}`;
  } catch (error) {
    failure = error.message;
    if (live) {
      try { await live.shot('99-failure'); } catch { /* the page may be gone */ }
      try { facts.phaseAtFailure = await live.eval('window.__harborVoice?.phase || "(no hook)"'); } catch { /* gone */ }
      try { facts.messageAtFailure = await live.eval('window.__harborVoice?.message || ""'); } catch { /* gone */ }
    }
  } finally {
    // Never leave a paid voice session running.
    try { if (live) await live.eval('window.__harborVoice?.stop?.(); true'); } catch { /* gone */ }
    await sleep(300);
    try { child.kill(); } catch { /* already gone */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* it is a tmpdir */ }
  }

  const verdict = failure ? 'FAIL' : 'PASS';
  const report = [
    verdict,
    '',
    `open window title:   ${JSON.stringify(facts.openWindow || '')}`,
    `open window project: ${JSON.stringify(facts.openProject || '')}`,
    `project tokens:      ${JSON.stringify(facts.projectTokens || [])}`,
    `tool names:          ${JSON.stringify(facts.toolNames || null)}`,
    `send stub:           ${facts.sendGuard || '(not reached)'}`,
    `phase:               ${facts.phase || facts.phaseAtFailure || '(not reached)'}`,
    `voice:               ${facts.voice || '(not reached)'}`,
    `hook message:        ${JSON.stringify(facts.message || facts.messageAtFailure || '')}`,
    `activity:            ${JSON.stringify(facts.activity || [], null, 1)}`,
    `phase after stop:    ${facts.phaseAfterStop || '(not reached)'}`,
    `sends attempted:     ${JSON.stringify(facts.sendsAttempted || [])}`,
    `checks: ${JSON.stringify(facts.checks || {}, null, 1)}`,
    `failure: ${failure || '(none)'}`,
    `screenshots: ${OUT}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'verdict.txt'), report);
  console.log(report);
  process.exit(failure ? 1 : 0);
}

main().catch((error) => { console.error('DRIVE FAILED:', error.message); process.exit(2); });
