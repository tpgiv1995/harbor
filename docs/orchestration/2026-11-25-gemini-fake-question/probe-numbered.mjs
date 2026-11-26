// Live proof for "wtf? fix your shit for gemini" (2026-11-25): a Gemini window showed a "Claude is asking" card built
// from a numbered list in Gemini's reply, with "needs your answer", while Gemini was still working. The REAL agy 1.5.14
// in a ConPTY (scratch profile, Hydrogen low, windowless node-pty, no daemon, no window). Turn 1 replies with a
// numbered list; turn 2 keeps agy working; during turn 2 the window's card poll (getMenu) runs with the pre-fix module
// and the fixed one over the same screen. Their key writes go to a recorder, never to agy.
//   node probe-numbered.mjs <fixed session-send.js> <pre-fix session-send.js> <scratch home> <scratch folder> <out dir>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const APP = 'C:/dev/harbor/app';
const req = createRequire(`${APP}/src/daemon/package.json`);
const pty = req('node-pty');
const { Terminal } = req('@xterm/headless');
const { Unicode11Addon } = req('@xterm/addon-unicode11');
const [fixedPath, oldPath, home, ws, outDir] = process.argv.slice(2);
const load = createRequire(`${APP}/package.json`);
const NEW = load(fixedPath);
const OLD = load(oldPath);
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
fs.mkdirSync(outDir, { recursive: true });

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
const proc = pty.spawn('C:\\tools\\antigravity\\1.5.14\\agy.exe', ['--settings', settings, '--model', 'gemini-4-hydrogen', '--effort', 'low', '--dangerously-skip-permissions'], { name: 'xterm-256color', cols: 120, rows: 40, cwd: ws, env, useConpty: true, windowsHide: true });
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
const deps = (sendInput) => ({
  snapshot: async () => ({ panes: [{ pane_id: 'p1', workspace_id: 'w1', created_at: new Date(T0).toISOString() }], workspaces: [{ workspace_id: 'w1', label: 'probe' }] }),
  readPane,
  terminalBridge: { getState: () => ({ controlledPaneId: 'p1' }), requestFocusPane: async () => ({ ok: true }), sendInput, ensureDialogSize: async () => ({ ok: true }) },
  launchActions: {},
  getSessionMeta: async () => ({ cwd: ws, provider: 'gemini' }),
  projectLabelForCwd: () => 'probe',
  captureDir: path.join(home, 'harness', 'cap'),
  sendLogFile: path.join(home, 'harness', 'send-log.jsonl'),
  contextDir: path.join(home, 'harness', 'context'),
});
// The driver types into agy; the two pollers only read (any key they try is recorded, not sent).
const driver = NEW.createSessionSend({ ...deps((_p, t) => { proc.write(t); return { ok: true }; }), links: NEW.createLinkRegistry() });
const pollKeys = { OLD: [], NEW: [] };
const pollers = {
  OLD: OLD.createSessionSend({ ...deps((_p, t) => { pollKeys.OLD.push(t); return { ok: true }; }), links: OLD.createLinkRegistry() }),
  NEW: NEW.createSessionSend({ ...deps((_p, t) => { pollKeys.NEW.push(t); return { ok: true }; }), links: NEW.createLinkRegistry() }),
};
const idle = async (ms) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    await sleep(500);
    const b = NEW.geminiPromptBox(await readPane('p1', 90));
    if (b && b.status === 'idle') return true;
  }
  return false;
};
const target = { paneId: 'p1', workspaceId: 'w1' };
const shown = (menu) => (!menu ? 'none' : menu.fallback ? 'panel' : menu.kind === 'gemini-setup' ? 'setup' : 'card');

try {
  await idle(45000);
  log('--- turn 1: a reply with a numbered list');
  await driver.send({ sessionId: 'pane:p1', provider: 'gemini', pane: target,
    text: 'Use no tools. Reply with a numbered list of three made-up page layout names. Write each item as "1. Name - one short sentence" with one indented bullet line under it, then one closing sentence.' });
  await idle(90000);
  const list = (await readPane('p1', 60)).split('\n').filter((row) => /^\s*\d\.\s/.test(row));
  log('numbered rows on screen:', JSON.stringify(list));
  log('--- turn 2: keep agy working');
  await driver.send({ sessionId: 'pane:p1', provider: 'gemini', pane: target,
    text: 'Run the shell command Start-Sleep -Seconds 4 five separate times, one call after another, waiting for each to finish (never in the background). Then reply with exactly DONE-WORK.' });
  const tally = { OLD: {}, NEW: {} };
  let saved = false;
  for (let i = 0; i < 20; i += 1) {
    await sleep(1000);
    const screen = await readPane('p1', 90);
    const box = NEW.geminiPromptBox(screen);
    if (box?.status !== 'working') continue;
    for (const label of ['OLD', 'NEW']) {
      const menu = await pollers[label].getMenu({ pane: target });
      const s = shown(menu);
      tally[label][s] = (tally[label][s] || 0) + 1;
      if (s === 'card' && !saved) {
        saved = true;
        fs.writeFileSync(path.join(outDir, 'old-card-screen.txt'), screen);
        log(`${label} card: question ${JSON.stringify(String(menu.question || '').slice(0, 120))} options ${JSON.stringify((menu.options || []).map((o) => o.label))}`);
      }
    }
  }
  log('polls while agy worked, OLD:', JSON.stringify(tally.OLD), '| NEW:', JSON.stringify(tally.NEW));
  log('keys the pollers tried to send, OLD:', pollKeys.OLD.length, '| NEW:', pollKeys.NEW.length);
  await idle(90000);
} finally {
  try { proc.kill(); } catch { /* gone */ }
  await sleep(800);
  process.exit(0);
}
