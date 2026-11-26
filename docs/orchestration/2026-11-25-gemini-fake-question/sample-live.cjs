// Usage: node sample-live.cjs <pane id> <out dir> [minutes]   (read-only; the 2026-11-25 background-agent card was caught with it)
// Read-only sampler: runs Harbor's own question reader (getMenu, observe mode, keys recorded not sent) on a live pane
// every 700 ms, the same cadence as a window's poll, and saves both screens whenever it returns anything.
const fs = require('fs');
const path = require('path');
const { SessionDaemonClient } = require('C:/dev/harbor/app/src/main/session-daemon/client.js');
const { daemonSendReads } = require('C:/dev/harbor/app/src/main/session-daemon/send-reads.js');
const ss = require('C:/dev/harbor/app/src/main/session-send.js');
const [paneId, outDir, minutes = '30'] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const client = new SessionDaemonClient();
const reads = daemonSendReads(client);
const keys = [];
const engine = ss.createSessionSend({
  ...reads,
  terminalBridge: { getState: () => ({}), requestFocusPane: async () => ({ ok: true }), sendInput: (_p, t) => { keys.push(t); return { ok: true }; }, ensureDialogSize: async () => ({ ok: true }) },
  launchActions: {},
  getSessionMeta: async () => ({ provider: 'gemini' }),
  projectLabelForCwd: () => 'x',
  links: ss.createLinkRegistry(),
  captureDir: path.join(outDir, 'cap'),
  sendLogFile: path.join(outDir, 'send-log.jsonl'),
  contextDir: path.join(outDir, 'ctx'),
});
const log = (s) => fs.appendFileSync(path.join(outDir, 'sample.log'), `${new Date().toISOString()} ${s}\n`);
const pane = { paneId, workspaceId: null };
const end = Date.now() + Number(minutes) * 60000;
let n = 0; let hits = 0; let last = '';
(async () => {
  log(`start pane ${paneId}`);
  while (Date.now() < end) {
    n += 1;
    try {
      const [recent, visible] = await Promise.all([reads.readPane(paneId, 90, 'recent'), reads.readPane(paneId, 90, 'visible')]);
      const box = ss.geminiPromptBox(recent);
      const boxV = ss.geminiPromptBox(visible);
      const state = `box(recent)=${box ? box.status : 'none'} box(visible)=${boxV ? boxV.status : 'none'}`;
      for (const hint of [false, true]) {
        const menu = await engine.getMenu({ pane, blockedHint: hint, observe: true });
        if (!menu) continue;
        hits += 1;
        const kind = menu.fallback ? (menu.list ? 'fallback-list' : 'fallback-panel') : (menu.kind || 'card');
        const what = `${kind} q=${JSON.stringify(String(menu.question || menu.title || '').slice(0, 80))} opts=${JSON.stringify((menu.options || menu.list?.rows || []).map((o) => String(o.label || o.text || o).slice(0, 40)).slice(0, 5))}`;
        const stamp = `${String(n).padStart(5, '0')}-hint${hint ? 1 : 0}`;
        fs.writeFileSync(path.join(outDir, `${stamp}-recent.txt`), recent);
        fs.writeFileSync(path.join(outDir, `${stamp}-visible.txt`), visible);
        fs.writeFileSync(path.join(outDir, `${stamp}-menu.json`), JSON.stringify(menu, null, 1));
        log(`HIT #${n} hint=${hint} ${state} -> ${what}`);
      }
      if (state !== last) { log(`state #${n} ${state}`); last = state; }
    } catch (e) { log(`err #${n} ${e.message}`); }
    await new Promise((r) => setTimeout(r, 700));
  }
  log(`end samples=${n} hits=${hits} keys=${keys.length}`);
  client.close();
  process.exit(0);
})();
