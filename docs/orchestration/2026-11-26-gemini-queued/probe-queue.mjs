// Live proof for "Gemini sessions can't handle queued messages" (2026-11-26): the REAL agy 1.5.14 in a ConPTY
// (scratch profile, Hydrogen low, windowless node-pty, no daemon, no window) driven through Harbor's own
// createSessionSend. A turn of about 32 s; two messages sent into it; every status the engine reports is recorded.
// Run it once with the fixed module and once with the pre-fix one; only the fixed one may end with no error.
//   node probe-queue.mjs <session-send.js to load> <scratch home> <scratch folder> <label>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const APP = 'C:/dev/harbor/app';
const req = createRequire(`${APP}/src/daemon/package.json`);
const pty = req('node-pty');
const { Terminal } = req('@xterm/headless');
const { Unicode11Addon } = req('@xterm/addon-unicode11');
const [modulePath, home, ws, label] = process.argv.slice(2);
const ss = createRequire(`${APP}/package.json`)(modulePath);
const T0 = Date.now();
const log = (...a) => console.log(`[${label} ${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

// agy's consent screens are seeded in this SCRATCH profile only.
fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli', 'cache'), { recursive: true });
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'cache', 'onboarding.json'), JSON.stringify({ consumerOnboardingComplete: true, enterpriseOnboardingComplete: true, onboardingComplete: true }));
const settings = path.join(home, 'probe-settings.json');
fs.writeFileSync(settings, JSON.stringify({ trustedWorkspaces: [ws], showFeedbackSurvey: false }));
const env = { ...process.env, USERPROFILE: home, HOME: home, HOMEPATH: home.replace(/^[A-Za-z]:/, ''), AGY_CLI_DISABLE_AUTO_UPDATE: 'true', NO_OPEN_BROWSER: '1', TERM: 'xterm-256color' };
const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true, scrollback: 3000, windowsPty: { backend: 'conpty', buildNumber: 26200 } });
term.loadAddon(new Unicode11Addon());
term.unicode.activeVersion = '11';
const proc = pty.spawn('C:\\tools\\antigravity\\1.5.14\\agy.exe', ['--settings', settings, '--model', 'gemini-4-hydrogen', '--effort', 'low', '--dangerously-skip-permissions'], { name: 'xterm-256color', cols: 120, rows: 40, cwd: ws, env, useConpty: true });
proc.onData((d) => term.write(d));

const flush = () => new Promise((r) => term.write('', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const allLines = () => {
  const b = term.buffer.active;
  const out = [];
  for (let y = 0; y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) ?? '');
  while (out.length && !out.at(-1).trim()) out.pop();
  return out;
};
const readPane = async (_p, lines = 90) => { await flush(); return allLines().slice(-lines).join('\n'); };
const brain = path.join(home, '.gemini', 'antigravity-cli', 'brain');
let sessionPath = null;
const engine = ss.createSessionSend({
  snapshot: async () => ({ panes: [{ pane_id: 'p1', workspace_id: 'w1', created_at: new Date(T0).toISOString() }], workspaces: [{ workspace_id: 'w1', label: 'probe' }] }),
  readPane,
  terminalBridge: { getState: () => ({ controlledPaneId: 'p1' }), requestFocusPane: async () => ({ ok: true }), sendInput: (_p, t) => { proc.write(t); return { ok: true }; } },
  launchActions: {},
  getSessionMeta: async () => ({ cwd: ws, provider: 'gemini', ...(sessionPath ? { path: sessionPath } : {}) }),
  links: ss.createLinkRegistry(),
  projectLabelForCwd: () => 'probe',
  captureDir: path.join(home, 'harness', 'cap'),
  sendLogFile: path.join(home, 'harness', 'send-log.jsonl'),
  contextDir: path.join(home, 'harness', 'context'),
});
const statuses = [];
engine.emitter.on('status', (e) => {
  statuses.push({ t: ((Date.now() - T0) / 1000).toFixed(1), phase: e.phase, detail: e.detail || '' });
  log('status', e.phase, e.detail || '');
});
const idle = async (ms) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    await sleep(500);
    const b = ss.geminiPromptBox(await readPane('p1', 90));
    if (b && b.status === 'idle') return true;
  }
  return false;
};
const target = { paneId: 'p1', workspaceId: 'w1' };
const full = () => sessionPath.replace(/transcript\.jsonl$/, 'transcript_full.jsonl');

try {
  await idle(45000);
  const before = await engine.listTranscriptIds(ws, 'gemini', home);
  const sinceMs = Date.now();
  await engine.send({ sessionId: 'pane:p1', provider: 'gemini', text: 'Reply with exactly READY. Use no tools.', pane: target });
  const id = await engine.findFreshTranscript({ cwd: ws, provider: 'gemini', sinceMs, knownIds: before, timeoutMs: 20000, home });
  sessionPath = path.join(brain, id, '.system_generated', 'logs', 'transcript.jsonl');
  log('conversation', id);
  await idle(60000);
  statuses.length = 0;
  log('--- a turn of about 32 s');
  await engine.send({ sessionId: id, provider: 'gemini', text: 'Run the shell command Start-Sleep -Seconds 4 eight separate times, one call after another, waiting for each to finish (never in the background). Then reply with exactly DONE-WORK.', pane: target });
  await sleep(5000);
  const A = 'Reply with exactly QUEUED-A and nothing else. Use no tools.';
  const B = 'Reply with exactly QUEUED-B and nothing else. Use no tools.';
  log('--- message A while it works');
  log('result', JSON.stringify(await engine.send({ sessionId: id, provider: 'gemini', text: A, pane: target })));
  await sleep(2500);
  log('--- message B while it works');
  log('result', JSON.stringify(await engine.send({ sessionId: id, provider: 'gemini', text: B, pane: target })));
  const rows = (await readPane('p1', 12)).split('\n').filter((l) => /^\u25b8|Press up|Running/.test(l)).join(' | ');
  log('screen rows:', rows.slice(0, 300));
  await sleep(24000);
  log('24 s after B: transcript holds QUEUED-A yet?', fs.readFileSync(full(), 'utf8').includes('QUEUED-A'), '| still working?', ss.geminiPromptBox(await readPane('p1', 90))?.status !== 'idle');
  await idle(90000);
  await sleep(3000);
  await idle(60000);
  const last = fs.readFileSync(full(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.type === 'USER_INPUT').map((r) => ss.geminiUserRequest(r.content)).at(-1);
  log('last prompt in transcript:', JSON.stringify(last));
  log('ERRORS reported:', JSON.stringify(statuses.filter((s) => s.phase === 'error')));
  log('SENT notes:', JSON.stringify(statuses.filter((s) => s.phase === 'sent').map((s) => s.detail)));
} finally {
  try { proc.kill(); } catch { /* gone */ }
  await sleep(800);
  process.exit(0);
}
