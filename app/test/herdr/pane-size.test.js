'use strict';

// The pane a dialog is drawn into, measured against a REAL pty in an isolated
// named session. Never the user's daemon.
//
// This is the root-cause half of the 2026-07-27 question-card fix. Four
// separate "the question scrolled out of the terminal view" reports
// (2026-07-21 through 2026-07-27) were all one thing: herdr hands out
// 23-row x 54-column panes, Claude Code's AskUserQuestion dialog needs about
// 35 rows at that width, and the pane keeps no scrollback, so the question,
// the tab strip and option 1 are simply gone. Captured live at both sizes:
// at 23x54 the pane read is byte-identical to Pat's screenshot; at 120x60 the
// same dialog redraws whole, "❯" on option 1 included.
//
// The assertions below are on the PTY the child process actually sees (stty),
// not on anything Harbor reports about itself.

const { describe, before, after, test } = require('node:test');
const assert = require('node:assert');

const { HerdrClient } = require('../../src/main/herdr/client.js');
const { PaneStreamSupervisor } = require('../../src/main/herdr/streams.js');
const H = require('./harness.js');

describe('driven panes are sized for dialogs (isolated named session)', { timeout: 90000 }, () => {
  let client;
  let sup;
  let paneId;

  const ptySize = async () => {
    await client.sendText(paneId, 'stty size\n');
    await H.sleep(700);
    const res = await client.readPane(paneId, { lines: 14, source: 'visible', strip_ansi: true });
    const rows = [...H.stripAnsi(res?.read?.text || '').matchAll(/^\s*(\d+)\s+(\d+)\s*$/gm)].pop();
    assert.ok(rows, 'stty size printed a geometry');
    return { rows: Number(rows[1]), cols: Number(rows[2]) };
  };

  before(async () => {
    H.stopNamedServer();
    H.deleteNamedSession();
    await H.sleep(400);
    await H.startNamedServer();
    client = new HerdrClient({ socketPath: H.SOCKET_PATH });
    sup = new PaneStreamSupervisor({ socketPath: H.SOCKET_PATH });
    sup.on('error', (e) => console.log('[sup error]', e.message));
    const ws = await client.createWorkspace({ cwd: H.HOME, label: 'size-ws', focus: true });
    await client.createTab({ workspace_id: ws.workspace.workspace_id, cwd: H.HOME, label: 'size-tab', focus: true });
    await H.sleep(600);
    const snap = await client.snapshot();
    paneId = (snap.snapshot || snap).panes.at(-1).pane_id;
  });

  after(async () => {
    try { sup?.closeAll?.(); } catch { /* already gone */ }
    await H.sleep(200);
    H.stopNamedServer();
    H.deleteNamedSession();
  });

  test('a fresh herdr pane is too small to hold a dialog', async () => {
    const before = await ptySize();
    console.log('[size] fresh pane:', before);
    assert.ok(before.rows < 40, `a fresh pane is ${before.rows} rows, which is why dialogs clipped`);
  });

  test('ensureDialogSize grows the real pty, and the size outlives the attach', async () => {
    const res = await sup.ensureDialogSize(paneId, { cols: 120, rows: 60 });
    assert.equal(res.ok, true, res.reason || 'sized');
    const grown = await ptySize();
    console.log('[size] after ensureDialogSize:', grown);
    assert.equal(grown.rows, 60);
    assert.equal(grown.cols, 120);

    // The transient control child is released at the end of the sizing, and
    // nothing of ours is left holding the pane. The size has to survive that,
    // or every dialog would clip again the moment we let go.
    assert.equal(sup.controller, null, 'sizing never takes the controller slot');
    await H.sleep(800);
    const later = await ptySize();
    assert.equal(later.rows, 60, 'the pty stays grown after the sizer releases');

    // And Harbor can still take normal control of the pane afterwards: a sizer
    // that leaked its attach would deny every later send.
    sup.acquireControl(paneId, { cols: 120, rows: 60 });
    await H.waitUntil(() => sup.controllerReady(paneId), { timeout: 8000, message: 'control never granted after sizing' });
    sup.releaseControl(paneId);
  });

  test('sizing a pane we already control resizes in place', async () => {
    sup.acquireControl(paneId, { cols: 100, rows: 30 });
    await H.waitUntil(() => sup.controllerReady(paneId), { timeout: 8000, message: 'control never granted' });
    const res = await sup.ensureDialogSize(paneId, { cols: 118, rows: 55 });
    assert.equal(res.via, 'controller');
    await H.sleep(500);
    const grown = await ptySize();
    assert.equal(grown.rows, 55);
    assert.equal(grown.cols, 118);
    sup.releaseControl(paneId);
    await H.sleep(300);
  });

  test('a pane that does not exist fails honestly instead of hanging', async () => {
    const res = await sup.ensureDialogSize('w9:p9', { cols: 120, rows: 60 });
    assert.equal(res.ok, false);
    assert.ok(res.reason, 'says why');
  });
});
