// Usage: node replay.cjs <sample-live out dir>   (every saved screen through the current reader; 1,007 screens, 0 cards after the fix)
// Replays every screen pair the live sampler saved (each one a poll where the OLD reader returned a card or panel)
// through the FIXED reader, with the window's real read order (recent, then visible), both blockedHint values.
const fs = require('fs');
const path = require('path');
const ss = require('C:/dev/harbor/app/src/main/session-send.js');
const dir = process.argv[2];
const stamps = [...new Set(fs.readdirSync(dir).filter((f) => f.endsWith('-recent.txt')).map((f) => f.replace(/-recent\.txt$/, '')))];
(async () => {
  const tally = {};
  for (const stamp of stamps) {
    const recent = fs.readFileSync(path.join(dir, `${stamp}-recent.txt`), 'utf8');
    const visible = fs.readFileSync(path.join(dir, `${stamp}-visible.txt`), 'utf8');
    const engine = ss.createSessionSend({
      snapshot: async () => ({ panes: [], workspaces: [] }),
      readPane: async (_p, _l, source) => (source === 'visible' ? visible : recent),
      terminalBridge: { getState: () => ({}), sendInput: () => { throw new Error('no keys'); }, ensureDialogSize: async () => ({ ok: true }) },
      launchActions: {}, getSessionMeta: async () => ({ provider: 'gemini' }), projectLabelForCwd: () => 'x', links: ss.createLinkRegistry(),
      captureDir: path.join(dir, '..', 'replay-cap'), sendLogFile: path.join(dir, '..', 'replay-send.jsonl'),
    });
    for (const blockedHint of [false, true]) {
      const menu = await engine.getMenu({ pane: { paneId: 'p', workspaceId: 'w' }, blockedHint, observe: true });
      const shown = !menu ? 'none' : menu.fallback ? 'panel' : 'card';
      tally[shown] = (tally[shown] || 0) + 1;
      if (menu) console.log('STILL', stamp, blockedHint, shown);
    }
  }
  console.log('screens', stamps.length, 'polls', JSON.stringify(tally));
})();
