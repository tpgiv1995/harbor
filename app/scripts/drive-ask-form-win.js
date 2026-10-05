#!/usr/bin/env node
'use strict';

// Drive the question FORM end to end in the real app (2026-09-05).
//
// Isolated userData + offscreen (HARBOR_E2E), no daemon, an isolated ask dir
// with HARBOR_E2E_ASK_OWN_ALL=1 so the inbox claims the seeded request without
// a live pane. The stage is seeded with a real session id from the corpus so a
// window exists for the form to mount in; a request file shaped exactly like
// the hook's is dropped in; the drive then behaves like Pat on 2026-09-04:
// picks an option, adds a note, ticks a multi-select, tries Submit with one
// question unanswered (must NOT be dead: it goes to the missing question),
// answers it, submits, and reads the answer file the hook would have consumed.
// Port 9343.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const proto = require('../src/shared/ask-protocol.cjs');

const APP_DIR = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9343;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function connect(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const target = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools:'));
      if (target) return target;
    } catch { /* not up yet */ }
    await sleep(400);
  }
  throw new Error('no CDP page target');
}

class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result); }
      if (msg.method === 'Runtime.exceptionThrown') this.errors.push(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text);
    });
  }
  send(method, params = {}) { const id = ++this.seq; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed'); return r?.result?.value; }
}

// A session with a transcript on this machine, so the stage has a window.
function pickSessionId() {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  const dirs = fs.readdirSync(projects).map((d) => path.join(projects, d)).filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const dir of dirs.slice(0, 20)) {
    const file = fs.readdirSync(dir).find((n) => /^[0-9a-f-]{36}\.jsonl$/.test(n) && fs.statSync(path.join(dir, n)).size > 2000);
    if (file) return file.slice(0, 36);
  }
  throw new Error('no transcript to seed the stage with');
}

const QUESTIONS = [
  { question: 'Which visual direction should the overhaul commit to?', header: 'Look & feel', multiSelect: false, options: [
    { label: 'Refined analytics SaaS', description: 'Soft shadows, 10px radius, navy and coral.', preview: '┌ DASHBOARD ─────┐\n│ 6,891   1,555  │\n│ ▁▂▃▅▇ ↑        │\n└────────────────┘' },
    { label: 'Bold command center', description: 'Dense, dark, dashboards first.' },
    { label: 'Dark analytics cockpit', description: 'Deep navy, high contrast.', preview: '┌ COCKPIT ┐\n│  ◕  ◑   │\n└─────────┘' },
  ] },
  { question: 'Which charts should ship first? (pick any)', header: 'Analytics', multiSelect: true, options: [
    { label: 'Review burndown', description: 'Open reviews over time.' },
    { label: 'Access coverage', description: 'Grants versus employees.' },
    { label: 'Top carriers', description: 'By login volume.' },
  ] },
  { question: 'Which quality-of-life feature first?', header: 'QOL', multiSelect: false, options: [
    { label: 'Ctrl-K palette', description: 'Jump anywhere.' },
    { label: 'Saved views', description: 'Per-user filters.' },
  ] },
];

async function main() {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'harbor-ask-form-'));
  const userData = path.join(tmp, 'userData');
  const askDir = path.join(tmp, 'asks');
  fs.mkdirSync(userData, { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.harbor', 'config.json'), 'utf8'));
  config.setup = { completed: true, completedAt: new Date().toISOString(), appVersion: '0.1.0' };
  config.paths = { ...config.paths, cacheDir: path.join(tmp, 'cache'), tasksFile: path.join(tmp, 'tasks.json'), notesFile: path.join(tmp, 'notes.json'), projectIconsDir: path.join(tmp, 'project-icons'), boardsDir: path.join(tmp, 'boards') };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify(config, null, 2));
  const sessionId = pickSessionId();

  const failures = [];
  const check = (condition, message) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`); if (!condition) failures.push(message); };

  let child = null;
  try {
    child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-focus-steal'], {
      env: { ...process.env, HARBOR_E2E: '1', HARBOR_E2E_USER_DATA: userData, HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_DIR: path.join(tmp, 'sessiond'), HARBOR_CONTEXT_DIR: path.join(tmp, 'context'), HARBOR_PERF_LOG_DIR: path.join(tmp, 'perf'), HARBOR_ASK_DIR: askDir, HARBOR_E2E_ASK_OWN_ALL: '1', HARBOR_NO_ICON_GEN: '1', HARBOR_NO_USAGE_FETCH: '1', HARBOR_NO_TITLER: '1', HARBOR_NO_VOICE: '1' },
      stdio: 'ignore',
    });
    const target = await connect(PORT);
    const ws = new globalThis.WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    const probe = () => cdp.evaluate('(() => ({ mounted: Boolean(document.getElementById("root")?.children.length), form: Boolean(document.querySelector("[data-ask-form]")), tiles: document.querySelectorAll(".win2").length, submit: document.querySelector(".askf-primary")?.textContent || null, focusedQ: document.querySelector(".askf-q.focused")?.dataset.askfQ ?? null, missing: [...document.querySelectorAll(".askf-q.missing")].map((e) => e.dataset.askfQ) }))()');
    for (let i = 0; i < 40 && !(await probe()).mounted; i += 1) await sleep(500);

    // A window for the session, then a question for it, as the hook would write it.
    await cdp.evaluate(`(() => { localStorage.setItem('harbor-slate-stage', ${JSON.stringify(JSON.stringify({ tiles: [{ sessionId, slot: 0 }], selectedId: sessionId, focusedId: null }))}); localStorage.setItem('harbor-view', 'agents'); return true; })()`);
    await cdp.send('Page.reload');
    await sleep(1500);
    await cdp.send('Runtime.enable');
    for (let i = 0; i < 40 && (await probe()).tiles === 0; i += 1) await sleep(500);
    check((await probe()).tiles === 1, 'a window is open for the seeded session');

    fs.mkdirSync(askDir, { recursive: true });
    const id = 'toolu_drive_01';
    proto.writeJsonAtomic(proto.filesFor(askDir, id).request, { v: 1, id, at: Date.now(), hookPid: process.pid, sessionId, transcriptPath: null, cwd: 'C:\\dev\\carrier-login-manager', toolUseId: id, toolInput: { questions: QUESTIONS } });
    for (let i = 0; i < 30 && !(await probe()).form; i += 1) await sleep(500);
    let p = await probe();
    check(p.form, 'the form appears in the window once the inbox claims the request');
    check(fs.existsSync(proto.filesFor(askDir, id).claim), 'the inbox wrote the claim the hook waits for');
    check(/Answer 3 more/.test(p.submit || ''), `Submit names the unanswered count (${p.submit})`);

    const click = (selector) => cdp.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
    const type = (selector, text) => cdp.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const setter = Object.getOwnPropertyDescriptor(el.__proto__, 'value').set; setter.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

    // Question 1: pick option 2, and hover option 3 shows its preview.
    check(await click('[data-askf-row="0:1"]'), 'picked option 2 of question 1');
    // React delivers onMouseEnter from bubbling mouseover/mouseout at the root,
    // so a synthetic mouseenter never reaches it; mouseover is what a real
    // pointer produces on the way in.
    await cdp.evaluate('(() => { const el = document.querySelector(\'[data-askf-row="0:2"]\'); el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); return true; })()');
    await sleep(150);
    const previewText = await cdp.evaluate('document.querySelector(".askf-q[data-askf-q=\\"0\\"] .askf-preview pre")?.textContent || ""');
    check(/COCKPIT/.test(previewText), 'hovering option 3 shows ITS preview');
    // A note on question 1, the thing that failed on 2026-09-04.
    check(await click('.askf-q[data-askf-q="0"] .askf-quiet'), 'opened the note field');
    await sleep(100);
    check(await type('.askf-q[data-askf-q="0"] .askf-note', 'light mode, fancy buttons, do not follow the style guide blindly'), 'typed a note');
    // Question 2: tick two.
    check(await click('[data-askf-row="1:0"]') && await click('[data-askf-row="1:2"]'), 'ticked two options of the multi-select');
    p = await probe();
    check(/Answer 1 more/.test(p.submit || ''), `Submit now says one is left (${p.submit})`);
    // Submit with question 3 unanswered: never dead, goes to the missing one.
    await click('.askf-primary');
    await sleep(300);
    p = await probe();
    check(p.focusedQ === '2', `an incomplete submit focused the missing question (focused ${p.focusedQ})`);
    check(!fs.existsSync(proto.filesFor(askDir, id).answer), 'and wrote no answer yet');
    // Answer it and submit for real.
    check(await click('[data-askf-row="2:0"]'), 'picked option 1 of question 3');
    p = await probe();
    check(/Submit 3 answers/.test(p.submit || ''), `Submit is ready (${p.submit})`);
    await click('.askf-primary');
    let answer = null;
    for (let i = 0; i < 20 && !answer; i += 1) { await sleep(250); answer = proto.readJson(proto.filesFor(askDir, id).answer); }
    check(Boolean(answer), 'the answer file the hook consumes was written');
    if (answer) {
      check(answer.answers[QUESTIONS[0].question] === 'Bold command center', `q1 answer (${answer.answers[QUESTIONS[0].question]})`);
      check(answer.answers[QUESTIONS[1].question] === 'Review burndown, Top carriers', `q2 answer (${answer.answers[QUESTIONS[1].question]})`);
      check(answer.answers[QUESTIONS[2].question] === 'Ctrl-K palette', `q3 answer (${answer.answers[QUESTIONS[2].question]})`);
      check(answer.annotations?.[QUESTIONS[0].question]?.notes === 'light mode, fancy buttons, do not follow the style guide blindly', 'the note rode along as the annotation');
    }
    // The hook consumes the files; the form must leave the window.
    for (const file of Object.values(proto.filesFor(askDir, id))) { try { fs.unlinkSync(file); } catch { /* absent */ } }
    for (let i = 0; i < 20 && (await probe()).form; i += 1) await sleep(300);
    check(!(await probe()).form, 'the form leaves once the hook has taken the answer');
    check(cdp.errors.length === 0, `no renderer exceptions (${cdp.errors.slice(0, 2).join(' | ')})`);
  } finally {
    if (child) { try { child.kill(); } catch { /* gone */ } }
    await sleep(500);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (failures.length) { console.log(`\n${failures.length} FAILED`); process.exit(1); }
  console.log('\nALL PASS');
}

main().catch((error) => { console.error(error); process.exit(1); });
