'use strict';

// End-to-end herdr bridge tests against an ISOLATED named session (S4/S5, A5).
// One named server is started for the whole file; every subtest runs in order,
// sharing the client, two stream supervisors, and one bash pane. The last
// subtest tears everything down and asserts the herdr process table returned to
// its pre-test baseline. The user's live daemon is never touched.

const { describe, before, after, test } = require('node:test');
const assert = require('node:assert');

const { HerdrClient } = require('../../src/main/herdr/client.js');
const { PaneStreamSupervisor } = require('../../src/main/herdr/streams.js');
const H = require('./harness.js');

let markerCounter = 0;
const marker = (prefix) => `${prefix}_${process.pid}_${++markerCounter}`;

describe('herdr bridge (isolated named session)', { timeout: 60000 }, () => {
  let client;
  let supA; // primary: observer + controller
  let supB; // secondary: second observer + contending controller
  let pane;
  let baseline; // pgrep -a herdr before we start our server
  const acc = Object.create(null); // `${sup}:${source}` -> accumulated frame text

  const text = (key) => acc[key] || '';
  const stripped = (key) => H.stripAnsi(text(key));

  before(async () => {
    // Clean any stale named server, then snapshot the legitimately pre-existing
    // herdr processes (Pat's daemon + TUI) BEFORE starting ours.
    H.stopNamedServer();
    H.deleteNamedSession();
    await H.sleep(400);
    baseline = H.herdrProcs();
    console.log('[baseline] pre-test herdr procs:', [...baseline.keys()].join(', ') || '(none)');

    await H.startNamedServer();
    console.log('[setup] isolated session socket:', H.SOCKET_PATH);

    client = new HerdrClient({ socketPath: H.SOCKET_PATH });
    supA = new PaneStreamSupervisor({ socketPath: H.SOCKET_PATH });
    supB = new PaneStreamSupervisor({ socketPath: H.SOCKET_PATH });
    for (const [name, sup] of [['A', supA], ['B', supB]]) {
      sup.on('error', (e) => console.log(`[sup${name} error]`, e.message));
      sup.on('frame', (e) => { const k = `${name}:${e.source}`; acc[k] = (acc[k] || '') + e.text; });
    }
  });

  after(async () => {
    // Safety net only (assertions live in the final subtest).
    try { if (supA) supA.detach(); } catch {}
    try { if (supB) supB.detach(); } catch {}
    await H.sleep(200);
    H.stopNamedServer();
    H.deleteNamedSession();
  });

  test('ping and a supported protocol', async () => {
    const pong = await client.ping();
    assert.equal(pong.type, 'pong');
    const snap = await client.assertProtocol();
    assert.equal(snap.snapshot.protocol, 16);
    console.log('[protocol] pong + snapshot protocol =', snap.snapshot.protocol, 'version', snap.snapshot.version);
  });

  test('create workspace, tab, and a bash pane', async () => {
    const ws = await client.createWorkspace({ cwd: H.HOME, label: 'bridge-ws', focus: true });
    assert.ok(ws.workspace.workspace_id, 'workspace created');
    const tab = await client.createTab({ workspace_id: ws.workspace.workspace_id, cwd: H.HOME, label: 'bridge-tab', focus: true });
    pane = tab.root_pane.pane_id;
    assert.ok(pane, 'root pane id present');
    const got = await client.getPane(pane);
    assert.equal(got.pane.pane_id, pane);
    const list = await client.listPanes(ws.workspace.workspace_id);
    assert.ok(list.panes.some((p) => p.pane_id === pane), 'pane appears in pane.list');
    console.log('[create] workspace', ws.workspace.workspace_id, 'tab', tab.tab.tab_id, 'pane', pane);
  });

  test('observer stream receives frames', async () => {
    supA.attachObserver(pane, { cols: 80, rows: 24 });
    await H.waitUntil(() => text('A:observe').length > 0, { timeout: 8000, message: 'no observer frames' });
    console.log('[frame streaming] observer A received', text('A:observe').length, 'bytes of frames');
    assert.ok(text('A:observe').length > 0);
  });

  test('pane.send_text echo roundtrip visible in frames', async () => {
    const M = marker('SENDTEXT');
    await client.sendText(pane, `echo ${M}`);
    await client.sendKeys(pane, ['enter']);
    await H.waitUntil(() => stripped('A:observe').includes(M), { timeout: 8000, message: 'echo marker never rendered' });
    console.log('[input echo] send_text marker', M, 'visible in observer frames');
    assert.ok(stripped('A:observe').includes(M));
  });

  // Acquire and wait for PROVEN ownership: a control child that has streamed
  // at least one frame and not been denied. A refusal can land hundreds of ms
  // after spawn (the server may still be detaching our own just-released
  // child), so absence-of-denial right after spawn proves nothing — that gap
  // was this suite's long-standing 1-in-3 flake.
  async function acquireUntilOwned(sup, paneId, size) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!sup.controller || sup.controller.paneId !== paneId) {
        sup.acquireControl(paneId, size);
      }
      const entry = sup.controller;
      try {
        await H.waitUntil(
          () => sup.controller === entry && !entry.denied && entry.frames > 0,
          { timeout: 2500, message: 'ownership not proven' },
        );
        return;
      } catch {
        await H.sleep(400); // denied or stale; let the server settle, retry
      }
    }
    throw new Error(`control of ${paneId} never truly acquired`);
  }

  test('control session input roundtrip', async () => {
    supA.acquireControl(pane, { cols: 80, rows: 24 });
    // discipline guard: cannot control a second pane without releasing first
    {
      // Graceful swap semantics: acquiring a different pane releases the
      // current controller (with a warning) instead of throwing.
      let warned = null;
      supA.once('warning', (w) => { warned = w; });
      supA.acquireControl('w9:p9');
      assert.equal(warned?.type, 'control-swap');
      supA.releaseControl('w9:p9');
      await acquireUntilOwned(supA, pane, { cols: 80, rows: 24 });
    }
    const M = marker('CTLINPUT');
    supA.sendInput(pane, `echo ${M}\r`);
    await H.waitUntil(() => stripped('A:observe').includes(M), { timeout: 8000, message: 'control input never rendered' });
    console.log('[control input] marker', M, 'submitted via terminal.input, visible in frames');
    assert.ok(stripped('A:observe').includes(M));
  });

  test('resize via control reflected in stty size', async () => {
    // Herdr renders inter-token spaces as cursor moves, which ANSI-stripping
    // drops, so we collapse the "rows cols" pair into a contiguous sentinel in
    // the shell (RSZ<rows><cols>END) and match that.
    const before = stripped('A:observe').length;
    supA.resize(pane, { cols: 100, rows: 40 });
    await H.sleep(300);
    supA.sendInput(pane, "echo RSZ$(stty size | tr -d ' ')END\r");
    await H.waitUntil(() => /RSZ40100END/.test(stripped('A:observe').slice(before)), { timeout: 8000, message: 'resized stty size never seen' });
    console.log('[resize] terminal.resize to 100x40 confirmed by stty size => rows 40, cols 100');
    assert.match(stripped('A:observe').slice(before), /RSZ40100END/);
  });

  test('multi-observer: two observers both receive frames', async () => {
    supB.attachObserver(pane, { cols: 80, rows: 24 });
    await H.waitUntil(() => text('B:observe').length > 0, { timeout: 8000, message: 'observer B got no frames' });
    const M = marker('MULTIOBS');
    await client.sendText(pane, `echo ${M}`);
    await client.sendKeys(pane, ['enter']);
    await H.waitUntil(
      () => stripped('A:observe').includes(M) && stripped('B:observe').includes(M),
      { timeout: 8000, message: 'both observers did not see the marker' },
    );
    console.log('[multi-observer] observers A and B both rendered marker', M);
    assert.ok(stripped('A:observe').includes(M) && stripped('B:observe').includes(M));
  });

  test('contention: observer keeps receiving alongside an active controller', async () => {
    assert.ok(supA.controller && supA.controller.paneId === pane, 'supA still controls the pane');
    const beforeB = text('B:observe').length;
    const M = marker('COEXIST');
    supA.sendInput(pane, `echo ${M}\r`);
    await H.waitUntil(() => stripped('B:observe').includes(M), { timeout: 8000, message: 'observer B stopped receiving under a controller' });
    console.log('[contention observer+controller] observer B kept receiving while A controls (grew', text('B:observe').length - beforeB, 'bytes)');
    assert.ok(text('B:observe').length > beforeB);
  });

  test('contention: second controller WITHOUT takeover is refused, incumbent retained', async () => {
    const incumbentChild = supA.controller.child;
    let deniedReason = null;
    supB.once('denied', (e) => { deniedReason = e.reason; });
    supB.acquireControl(pane, { cols: 80, rows: 24 }); // no takeover
    await H.waitUntil(() => deniedReason !== null || supB.controller === null, { timeout: 8000, message: 'no-takeover controller neither denied nor exited' });
    console.log('[contention no-takeover] refused reason:', JSON.stringify(String(deniedReason).slice(0, 90)));
    assert.ok(deniedReason && /takeover|attached client/i.test(deniedReason), 'refusal names the takeover requirement');
    assert.equal(incumbentChild.exitCode, null, 'incumbent controller still alive');
    assert.ok(supA.controller && supA.controller.paneId === pane, 'supA retained control');
    await H.waitUntil(() => supB.controller === null, { timeout: 4000, message: 'failed controller not cleared' });
  });

  test('contention: second controller WITH takeover displaces the incumbent', async () => {
    const incumbent = supA.controller;
    assert.ok(incumbent, 'supA has a controller to displace');
    supB.acquireControl(pane, { cols: 80, rows: 40 }, { takeover: true });
    await H.waitUntil(() => incumbent.child.exitCode !== null, { timeout: 8000, message: 'incumbent controller was not displaced' });
    await H.waitUntil(() => supA.controller === null, { timeout: 4000, message: 'supA did not observe its displacement' });
    console.log('[contention takeover] incumbent controller displaced (exit code', incumbent.child.exitCode, ')');
    // The new owner can drive input.
    const M = marker('TAKEOVER');
    await H.sleep(300);
    supB.sendInput(pane, `echo ${M}\r`);
    await H.waitUntil(() => stripped('B:observe').includes(M), { timeout: 8000, message: 'new controller could not drive input' });
    console.log('[contention takeover] new controller drove input, marker', M, 'visible');
    assert.ok(stripped('B:observe').includes(M));
    // exercise releaseControl explicitly
    supB.releaseControl(pane);
    assert.equal(supB.controller, null, 'releaseControl cleared the controller');
  });

  test('teardown leaves no leaked herdr processes and removes the socket', async () => {
    const childPids = [...supA.childPids(), ...supB.childPids()];
    supA.detach();
    supB.detach();
    await H.sleep(500);
    for (const pid of childPids) {
      assert.ok(!aliveHerdrPid(pid), `supervisor child pid ${pid} still alive`);
    }
    await H.stopAndWait();
    await H.sleep(600);

    const post = H.herdrProcs();
    const leaked = [...post.keys()].filter((pid) => !baseline.has(pid));
    console.log('[pgrep parity] baseline:', [...baseline.keys()].join(', ') || '(none)');
    console.log('[pgrep parity] post    :', [...post.keys()].join(', ') || '(none)');
    console.log('[pgrep parity] leaked  :', leaked.join(', ') || '(none)');
    assert.deepEqual(leaked, [], 'no herdr processes may remain that were not in the baseline');
    assert.equal(H.socketExists(), false, 'named session socket removed');
  });
});

// A pid is a live herdr process if it currently appears in pgrep -a herdr.
function aliveHerdrPid(pid) {
  return H.herdrProcs().has(pid);
}
