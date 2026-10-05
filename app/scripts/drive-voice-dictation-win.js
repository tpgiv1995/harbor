'use strict';

// LIVE Windows prod-drive for voice DICTATION (the .compose-mic button), end to
// end in the real app: a real MediaRecorder capture, the real whisper:transcribe
// IPC, the real OpenAI Whisper call, and the real composer draft.
//
// Same posture as drive-composer-nested-win.js: an ISOLATED Harbor instance with
// tmp userData and state, the real transcript corpus read-only, no daemon start,
// and a window parked off the visible desktop WITHOUT activating it. Nothing
// here may show, focus or restack a window (Pat games fullscreen).
//
// NOT in any gate: it costs money (one short TTS clip plus one Whisper call) and
// needs the network, exactly like scripts/live-drive-voice.js.
//
// The microphone is Chromium's fake capture device fed from a REAL speech clip
// (--use-file-for-fake-audio-capture), so the transcript that comes back is a
// known sentence rather than a guess about a test tone. Only the microphone
// hardware is substituted; the recorder, the container, the IPC, the API call
// and the draft are all the real thing.
//
// It is also the two-sided proof for the stale-draft defect: text typed WHILE
// the recording is running must still be in the draft when the transcription
// lands. Before the fix the transcription was appended to the draft as it stood
// when recording STARTED, silently destroying anything typed since.
//
// Usage (from app/):  node scripts/drive-voice-dictation-win.js
// Writes screenshots and a verdict to %TEMP%\harbor-drive-voice\

const { spawn, execSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const { resolveOpenAiKey } = require('../src/main/whisper-transcription.js');

const execFileAsync = promisify(execFile);
const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9337;
const OUT = path.join(os.tmpdir(), 'harbor-drive-voice');
const KEY_PATHS = [path.join(os.homedir(), '.config', 'harbor', '.env')];
const PHRASE = 'Harbor voice check one two three';
const BEFORE = 'before ';
const DURING = 'during ';
// HARBOR_NO_VOICE=1 drives the REFUSAL side of the same click: both voice
// features answer to that switch, and a harness must be able to prove the mic
// says so out loud rather than quietly spending money.
const REFUSING = process.env.HARBOR_NO_VOICE === '1';

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
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    return file;
  }
}

async function waitFor(cdp, expression, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await cdp.eval(expression);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
  }
}

async function key(cdp, keyName, { text = '', modifiers = 0, code = '' } = {}) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: keyName, code, text, unmodifiedText: text, modifiers,
  });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, modifiers });
  await sleep(40);
}

// Click rail rows until one leaves the composer typeable, and return its id.
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

async function typeText(cdp, value) {
  await cdp.eval("(() => { const e = document.querySelector('.ubar-input[contenteditable=\"true\"]'); e.focus(); return document.activeElement === e; })()");
  for (const character of value) await key(cdp, character === ' ' ? ' ' : character, { text: character });
}

// Fixtures live OUTSIDE the screenshot dir (which is wiped each run) so they are
// built once and cached; a re-run costs nothing extra, and wiping them was what
// forced a paid TTS call on every run, including the no-spend refusal side.
const FIXTURE_DIR = path.join(os.tmpdir(), 'harbor-drive-voice-fixtures');

// The REFUSAL side (HARBOR_NO_VOICE=1) only needs the mic to be recording; the
// backend refuses before transcribing, so the audio content is irrelevant. Two
// seconds of local silence keeps that path free of any network spend.
async function silenceFixture() {
  const wav = path.join(FIXTURE_DIR, 'voice-check-silence.wav');
  if (fs.existsSync(wav)) return wav;
  await execFileAsync('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
    '-t', '2', '-c:a', 'pcm_s16le', wav,
  ]);
  return wav;
}

// The LIVE side needs a real spoken sentence for Whisper to return. This is the
// only paid call, and it only runs when voice is actually being exercised.
async function speechFixture() {
  const wav = path.join(FIXTURE_DIR, 'voice-check-speech.wav');
  if (fs.existsSync(wav)) return wav;
  const key = await resolveOpenAiKey({ readFile: fsp.readFile, keyPaths: KEY_PATHS, env: process.env });
  if (!key) throw new Error('no OPENAI_API_KEY in ~/.config/harbor/.env, so neither the fixture nor Whisper can run');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: PHRASE, response_format: 'opus' }),
  });
  if (!res.ok) throw new Error(`TTS fixture failed: HTTP ${res.status}`);
  const ogg = path.join(FIXTURE_DIR, 'voice-check.ogg');
  fs.writeFileSync(ogg, Buffer.from(await res.arrayBuffer()));
  // Chromium's fake capture device reads 16-bit PCM wav and loops it.
  await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-i', ogg, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', wav]);
  return wav;
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  // No-spend refusal path uses local silence; only the live path pays for TTS.
  const wav = REFUSING ? await silenceFixture() : await speechFixture();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-voice-drive-'));
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
    HARBOR_SESSIOND_JOB_NAMESPACE: `harbor-voice-drive-${process.pid}`,
    HARBOR_CONTEXT_DIR: path.join(tmp, 'context'),
    HARBOR_NO_ICON_GEN: '1',
    HARBOR_NO_USAGE_FETCH: '1',
    HARBOR_NO_TITLER: '1',
    // The one thing this drive deliberately turns back on. Both voice features
    // answer to this switch, and dictation is the one under test here; the live
    // voice button is never clicked, so nothing is minted.
    // Overridable so the refusal side can be driven too: HARBOR_NO_VOICE=1 must
    // make the mic say so in the UI instead of quietly spending money.
    HARBOR_NO_VOICE: process.env.HARBOR_NO_VOICE ?? '0',
  };
  const child = spawn(ELECTRON, [
    APP_DIR,
    `--remote-debugging-port=${PORT}`,
    '--no-focus-steal',
    // Real speech into the fake device, so the transcript is checkable.
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

    // SWP_NOACTIVATE | SWP_NOZORDER keeps the proof away from the desktop.
    execSync(`powershell -NoProfile -Command "Add-Type -Name W -Namespace P -MemberDefinition '[DllImport(\\"user32.dll\\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int cy, uint f);'; $p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [P.W]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, -4200, 100, 1600, 1000, 0x0014) }"`, { stdio: 'ignore' });

    await waitFor(cdp, "document.querySelector('.sidebar-filter-chip') ? true : false", 'the session filter');
    await cdp.eval(`(() => {
      const all = [...document.querySelectorAll('.sidebar-filter-chip')].find((i) => i.textContent.trim() === 'All');
      if (all) all.click();
      return Boolean(all);
    })()`);
    await waitFor(cdp, "document.querySelector('.pg') ? true : false", 'a project row');
    // Not every session gives a TYPEABLE composer: a cursor or codex row whose
    // working folder could not be resolved is honestly read-only, and which row
    // sorts first changes with recency. So walk the rail until one arms the
    // composer instead of assuming the first one does.
    facts.session = await pickTypeableSession(cdp);
    if (!facts.session) throw new Error('no session in the rail armed the composer');

    // A draft that already has words in it, so an append is distinguishable
    // from a replace.
    await typeText(cdp, BEFORE);
    await sleep(300);
    facts.draftBefore = await cdp.eval("document.querySelector('.ubar-input').innerText.trim()");

    facts.micPresent = await cdp.eval("document.querySelectorAll('.compose-mic').length");
    await cdp.eval("document.querySelector('.compose-mic').click(); true");
    // A real getUserMedia grant plus a real MediaRecorder start.
    await waitFor(cdp, "document.querySelector('.compose-mic.recording') ? true : false", 'the mic to start recording', 20_000);
    facts.recordingStarted = true;
    await cdp.shot('01-recording');

    // Let the fake device play the sentence through.
    await sleep(3800);

    // THE DEFECT: type while the recording is running. This text must survive.
    await typeText(cdp, DURING);
    facts.draftDuringRecording = await cdp.eval("document.querySelector('.ubar-input').innerText.trim()");
    await sleep(400);

    await cdp.eval("document.querySelector('.compose-mic').click(); true");
    // Observing 'transcribing' is a RACE when the call is refused locally: the
    // gate answers in microseconds and the class is gone before a poll can see
    // it. A real Whisper round trip takes seconds, so it is required there and
    // only recorded here.
    facts.transcribingShown = await waitFor(cdp, `(() => {
      const mic = document.querySelector('.compose-mic');
      if (mic.classList.contains('transcribing')) return 'transcribing';
      return mic.classList.contains('idle') || mic.classList.contains('error') ? 'settled' : false;
    })()`, 'the mic to leave the recording state', 20_000) === 'transcribing';
    await cdp.shot('02-transcribing');

    // Back to idle (success) or error (an honest failure that must be visible).
    await waitFor(cdp, `(() => {
      const mic = document.querySelector('.compose-mic');
      return mic.classList.contains('idle') || mic.classList.contains('error');
    })()`, 'the transcription to settle', 60_000);
    facts.micClassAfter = await cdp.eval("document.querySelector('.compose-mic').className");
    facts.statusAfter = await cdp.eval("(document.querySelector('.voice-status')?.textContent || '').trim()");
    facts.draftAfter = await cdp.eval("document.querySelector('.ubar-input').innerText.trim()");
    facts.storedDraft = await cdp.eval(`(() => {
      const drafts = JSON.parse(localStorage.getItem('harbor-drafts') || '{}');
      const hit = Object.entries(drafts).find(([, v]) => v && v.text);
      return hit ? hit[1].text : '';
    })()`);
    await cdp.shot('03-settled');

    const draft = facts.draftAfter || '';
    const checks = {
      micButtonExists: facts.micPresent === 1,
      recordingStarted: facts.recordingStarted === true,
      textBeforeRecordingSurvived: draft.includes(BEFORE.trim()),
      // The two-sided bit. Fails at pre-fix HEAD.
      textTypedDuringRecordingSurvived: draft.includes(DURING.trim()),
      noSilentFailure: facts.micClassAfter.includes('error')
        ? Boolean(facts.statusAfter)
        : true,
    };
    if (REFUSING) {
      // The other side of the switch: nothing is spent, the draft is untouched,
      // and the reason is on screen rather than swallowed.
      checks.refusalWasSpoken = /voice is disabled/i.test(facts.statusAfter || '');
      checks.draftUntouchedByARefusal = !/harbor voice check/i.test(draft);
    } else {
      checks.transcriptionLanded = /harbor/i.test(draft) || /one[, ]*two[, ]*three/i.test(draft);
      checks.transcribingStateShown = facts.transcribingShown === true;
    }
    facts.checks = checks;
    const bad = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
    if (bad.length) failure = `failed checks: ${bad.join(', ')}`;
  } catch (error) {
    failure = error.message;
    // A failure with no picture of the app is a failure nobody can diagnose.
    if (live) {
      try { await live.shot('99-failure'); } catch { /* the page may be gone */ }
      try {
        facts.diagnostics = await live.eval(`(() => ({
          composer: document.querySelector('.ubar-input')?.outerHTML.slice(0, 300) || '(no .ubar-input)',
          placeholder: document.querySelector('.ubar-input')?.getAttribute('data-placeholder') || '',
          status: (document.querySelector('.ubar-status')?.textContent || '').trim().slice(0, 200),
          windows: document.querySelectorAll('.win2').length,
          rows: document.querySelectorAll('.sr').length,
        }))()`);
      } catch { /* the page may be gone */ }
    }
  } finally {
    await sleep(300);
    try { child.kill(); } catch { /* already gone */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* it is a tmpdir */ }
  }

  const verdict = failure ? 'FAIL' : 'PASS';
  const report = [
    verdict,
    '',
    `phrase spoken by the fake mic: ${JSON.stringify(PHRASE)}`,
    `draft before recording:        ${JSON.stringify(facts.draftBefore || '')}`,
    `draft during recording:        ${JSON.stringify(facts.draftDuringRecording || '')}`,
    `draft after transcription:     ${JSON.stringify(facts.draftAfter || '')}`,
    `persisted draft:               ${JSON.stringify(facts.storedDraft || '')}`,
    `mic class after:               ${JSON.stringify(facts.micClassAfter || '')}`,
    `voice status line:             ${JSON.stringify(facts.statusAfter || '')}`,
    `checks: ${JSON.stringify(facts.checks || {}, null, 1)}`,
    `diagnostics: ${JSON.stringify(facts.diagnostics || {}, null, 1)}`,
    `failure: ${failure || '(none)'}`,
    `screenshots: ${OUT}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'verdict.txt'), report);
  console.log(report);
  process.exit(failure ? 1 : 0);
}

main().catch((error) => { console.error('DRIVE FAILED:', error.message); process.exit(2); });
