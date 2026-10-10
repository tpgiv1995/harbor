'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  createSessionSend,
  createLinkRegistry,
  claudeProjectDir,
  providerTranscriptDirs,
  composerSendState,
  isFleetView,
} = require('../../src/main/session-send.js');

const resumeDialogFixture = (name) => fs.readFileSync(
  path.join(__dirname, '../fixtures/resume-summary-dialog', name),
  'utf8',
);

test('claudeProjectDir munges every non-alphanumeric to dash', () => {
  assert.equal(
    claudeProjectDir('/home/you/dev/harbor', '/home/you'),
    path.join('/home/you', '.claude', 'projects', '-home-you-dev-harbor'),
  );
  assert.equal(
    claudeProjectDir('/home/p/My Files.v2', '/home/p'),
    path.join('/home/p', '.claude', 'projects', '-home-p-My-Files-v2'),
  );
});

test('provider transcript discovery uses the real Codex and Cursor stores', () => {
  // Yesterday rides along: a session launched before midnight writes its
  // rollout into the next day's directory, so a today-only scan would read
  // every one of yesterday's rollouts as brand new.
  assert.deepEqual(providerTranscriptDirs('codex', '/work/x', '/home/test', new Date('2026-07-20T12:00:00Z')), [
    path.join('/home/test', '.codex', 'sessions', '2026', '07', '20'),
    path.join('/home/test', '.codex', 'sessions', '2026', '07', '19'),
  ]);
  assert.deepEqual(providerTranscriptDirs('cursor', '/work/x', '/home/test'), [
    path.join('/home/test', '.cursor', 'projects', 'work-x', 'agent-transcripts'),
  ]);
});

test('link registry sets, resolves, prunes by pane and ttl', () => {
  const links = createLinkRegistry({ ttlMs: 60_000 });
  links.set('sess-a', { paneId: 'pane-1', workspaceId: 'ws-1' });
  assert.equal(links.get('sess-a').paneId, 'pane-1');
  assert.deepEqual(links.all(), { 'sess-a': { paneId: 'pane-1', workspaceId: 'ws-1' } });
  links.dropPane('pane-1');
  assert.equal(links.get('sess-a'), null);
});

// THIS FILE WAS THE SINGLE BIGGEST SOURCE OF /tmp LITTER ON THIS MACHINE
// (2026-08-09). `makeHarness` has 95 call sites and several run it more than
// once, so ONE `npm test` left about 2,900 `harbor-session-send-test-*`
// directories behind, roughly two thirds of the 4,400 the whole suite creates.
// Pat's /tmp had reached 18,842 entries, and /tmp here is a TMPFS, so every one
// of those was RAM on a box whose actual problem is memory pressure.
// `scripts/sweep-test-tmp.js` is the net that catches whatever a killed run
// abandons; this is the source, and a suite should not need the net on a run
// that completes normally. Module-scope `after` covers every case in the file
// without touching 95 call sites or threading `t` through the helper.
const harnessTempDirs = [];
// The image-paste chord is per-OS (Alt+V on win32, Ctrl+V elsewhere) - see
// session-send.js. Tests assert the chord for the platform they run on.
const IMAGE_PASTE = process.platform === 'win32' ? '\x1bv' : '\x16';
test.after(() => {
  for (const dir of harnessTempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

// A real Claude draws what is typed into its prompt, and since 2026-10-09 a
// send presses Enter only once the prompt shows the text. So the stand-in pane
// draws it too: typed text (never a control key or escape sequence; bracketed
// paste markers stripped) appears in a prompt box under whatever frame the
// test staged, and Enter clears it. `promptEchoes: false` stands in for the
// 2026-10-09 failure, a prompt that takes none of the typing.
const PROMPT_RULE = '─'.repeat(60);
function makeHarness({ panes = [], readFrames = [], controlled = null, promptEchoes = true } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-session-send-test-'));
  harnessTempDirs.push(stateDir);
  const sent = [];
  const focused = [];
  const sequence = [];
  const state = { controlledPaneId: controlled, panes: [...panes] };
  const reads = [...readFrames];
  const prompt = { draft: '', echo: promptEchoes };
  const harness = {
    sent,
    focused,
    state,
    prompt,
    sized: [],
    resumeCalls: [],
    deps: {
      snapshot: async () => ({
        panes: state.panes.map((p) => (typeof p === 'string' ? { pane_id: p, workspace_id: 'ws-1' } : p)),
        workspaces: [{ workspace_id: 'ws-1', label: 'harbor' }],
      }),
      terminalBridge: {
        getState: () => ({ controlledPaneId: state.controlledPaneId }),
        requestFocusPane: async ({ paneId }) => {
          focused.push(paneId);
          state.controlledPaneId = paneId;
          return { ok: true };
        },
        sendInput: (paneId, text) => {
          sent.push({ paneId, text });
          sequence.push(['input', text]);
          if (text === '\r') prompt.draft = '';
          else if (!/^[\x00-\x1f\x7f]/.test(text) || text.startsWith('\x1b[200~')) {
            prompt.draft += text.replace(/\x1b\[20[01]~/g, '');
          }
          return { ok: true };
        },
        ensureDialogSize: async (paneId, opts = {}) => {
          harness.sized.push({ paneId, force: Boolean(opts.force) });
          return { ok: true };
        },
      },
      launchActions: {
        resumeSession: async (args) => {
          harness.resumeCalls.push(args);
          state.panes.push('pane-fresh');
        },
      },
      getSessionMeta: async () => ({ cwd: '/home/x/dev/harbor' }),
      links: createLinkRegistry(),
      projectLabelForCwd: () => 'harbor',
      sleep: async () => {},
      setXClipboardImage: async (imagePath) => sequence.push(['clipboard', imagePath]),
      captureDir: path.join(stateDir, 'unrecognized-dialogs'),
      sendLogFile: path.join(stateDir, 'send-log.jsonl'),
    },
    sequence,
  };
  // Whatever screen a test installs (most assign their own readPane), the
  // prompt it typed into is drawn under it. The getter binds the reader it
  // wraps, so a test that wraps the current readPane (closesOnEnter) does not
  // recurse, and a frame that already ends in the prompt is not drawn twice.
  let stagedRead = async () => (reads.length > 1 ? reads.shift() : reads[0] ?? '');
  Object.defineProperty(harness.deps, 'readPane', {
    enumerable: true,
    configurable: true,
    get: () => {
      const base = stagedRead;
      return async (...args) => {
        const frame = await base(...args);
        if (!prompt.echo || !prompt.draft) return frame;
        const box = `${PROMPT_RULE}\n❯ ${prompt.draft}\n${PROMPT_RULE}`;
        return String(frame).endsWith(box) ? frame : `${frame}\n${box}`;
      };
    },
    set: (fn) => { stagedRead = fn; },
  });
  return harness;
}


// A dialog CHANGES when Enter lands on it (it closes, or the batch advances),
// and since 2026-09-03 the driver verifies exactly that before reporting an
// answer delivered. A stand-in that keeps drawing the same dialog after Enter
// is therefore a stand-in for a dropped keystroke. This makes one close on
// Enter the way a real one does.
function closesOnEnter(h) {
  const read = h.deps.readPane;
  const send = h.deps.terminalBridge.sendInput;
  let closed = false;
  h.deps.readPane = async (...args) => (closed ? 'conversation\n──────\n❯\n──────' : read(...args));
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    const result = send(paneId, text);
    if (text === '\r') closed = true;
    return result;
  };
}

// Synthetic shapes modelled on resize-damaged captures, no captured prose.
const damagedDivider = '\u2500'.repeat(35) + '\ufffd' + '\u2500'.repeat(40);
const { fixture: modelSwitchFixture } = require('../support/model-switch-fixtures.js');
for (const kind of ['usage', 'paused']) {
  test(`model switch ${kind}: explicit click verifies pointer before Enter`, async () => {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    let selected = 1; let closed = false;
    h.deps.readPane = async () => closed ? '\u276f' : modelSwitchFixture(kind, 38, selected);
    h.deps.terminalBridge.sendInput = (_, text) => {
      h.sent.push(text);
      if (text === '\x1b[B') selected = 2;
      if (text === '\r') { assert.equal(selected, 2); closed = true; }
      return { ok: true };
    };
    const send = createSessionSend(h.deps);
    const pane = { paneId: 'pane-1' };
    const menu = await send.getMenu({ pane });
    assert.equal(menu.kind, 'model-switch');
    await assert.rejects(send.send({ sessionId: 'model-test', text: 'continue', pane }));
    for (const action of [{type:'select',index:2}, {type:'key',key:'enter'}, {type:'submit'}, {type:'raw',text:'\r'}]) {
      assert.equal((await send.answerMenu({pane,action})).ok, false);
      assert.equal(h.sent.length, 0);
    }
    const option = menu.options[1];
    assert.equal((await send.answerMenu({pane, action:{type:'model-switch', index:option.index, label:option.label, explicitClick:true}})).ok,true);
    assert.deepEqual(h.sent,['\x1b[B','\r']);
  });
}
test('model switch: dropped arrow and stale label never press Enter', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => modelSwitchFixture('usage');
  const send = createSessionSend(h.deps); const pane = {paneId:'pane-1'};
  assert.equal((await send.answerMenu({pane,action:{type:'model-switch',index:2,label:'Continue with Fable Test',explicitClick:true}})).ok,false);
  assert.equal(h.sent.some(s=>s.text==='\r'),false);
  h.sent.length=0;
  assert.equal((await send.answerMenu({pane,action:{type:'model-switch',index:2,label:'Old price choice',explicitClick:true}})).ok,false);
  assert.equal(h.sent.length,0);
});
test('model switch: checking blocks sends, footer controls cancellation, dropped Enter is refused', async () => {
  const h = makeHarness({panes:['pane-1'],controlled:'pane-1'});
  let kind='checking',closed=false;
  h.deps.readPane=async()=>closed?'\u276f':modelSwitchFixture(kind);
  const original=h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput=(id,text)=>{if(text==='\x1b')closed=true;return original(id,text);};
  const send=createSessionSend(h.deps),pane={paneId:'pane-1'};
  assert.equal((await send.getMenu({pane})).kind,'model-switch');
  await assert.rejects(send.send({sessionId:'waiting',text:'continue',pane}));
  assert.equal(h.sent.length,0);
  assert.equal((await send.answerMenu({pane,action:{type:'model-switch',index:1,label:'Switch',explicitClick:true}})).ok,false);
  assert.equal(h.sent.length,0);
  assert.equal((await send.answerMenu({pane,action:{type:'cancel'}})).ok,true);
  closed=false;kind='paused';h.sent.length=0;
  assert.equal((await send.answerMenu({pane,action:{type:'cancel'}})).ok,false);
  assert.equal(h.sent.length,0);
  const option=(await send.getMenu({pane})).options[0];
  assert.equal((await send.answerMenu({pane,action:{type:'model-switch',index:option.index,label:option.label,explicitClick:true}})).ok,false);
  assert.deepEqual(h.sent.map(row=>row.text),['\r']);
});
test('model switch arriving after a send stops the Enter retry watcher', async () => {
  for(const kind of ['usage','paused','checking']){
    const h=makeHarness({panes:['pane-1'],controlled:'pane-1'});
    let submitted=false;
    h.deps.readPane=async()=>submitted?modelSwitchFixture(kind):[damagedDivider,'\u276f',damagedDivider].join('\n');
    const original=h.deps.terminalBridge.sendInput;
    h.deps.terminalBridge.sendInput=(id,text)=>{if(text==='\r')submitted=true;return original(id,text);};
    await createSessionSend(h.deps).send({sessionId:'watch-'+kind,text:'blue',pane:{paneId:'pane-1'}});
    assert.equal(h.sent.filter(row=>row.text==='\r').length,1,kind+' did not receive a retry Enter');
  }
});
test('damaged divider: idle prose question stays sendable without an answer panel', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => ['- Do you want me to sort the toy blocks?', damagedDivider,
    '\u276f keep the blue blocks', damagedDivider, '  synthetic status'].join('\n');
  const send = createSessionSend(h.deps);
  assert.equal(await send.getMenu({ pane: { paneId: 'pane-1' }, blockedHint: true }), null);
  await send.send({ sessionId: 'synthetic-damaged', text: 'blue blocks', pane: { paneId: 'pane-1' } });
  assert.ok(h.sent.some(s => s.text.includes('blue blocks')));
});
test('damaged divider: real confirmation remains blocked and refuses a send', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => [damagedDivider, 'Do you want to proceed?', '\u276f 1. Yes',
    '  2. No', 'Esc to cancel'].join('\n');
  const send = createSessionSend(h.deps);
  assert.ok(await send.getMenu({ pane: { paneId: 'pane-1' } }));
  await assert.rejects(send.send({ sessionId: 'synthetic-confirm', text: 'blue blocks', pane: { paneId: 'pane-1' } }));
  assert.equal(h.sent.length, 0);
});
test('damaged divider: Enter watcher distinguishes stranded from submitted text', () => {
  assert.equal(composerSendState([damagedDivider, '\u276f blue blocks', damagedDivider].join('\n'), { text: 'blue blocks' }), 'holds');
  assert.equal(composerSendState(['\u276f blue blocks', damagedDivider, '\u276f', damagedDivider].join('\n'), { text: 'blue blocks' }), 'taken');
});

test('session-send test harness redirects every writable default away from the user cache', () => {
  const h = makeHarness();
  const realCache = path.join(os.homedir(), '.cache', 'harbor');
  assert.ok(path.isAbsolute(h.deps.captureDir));
  assert.ok(path.isAbsolute(h.deps.sendLogFile));
  assert.equal(h.deps.captureDir.startsWith(realCache + path.sep), false);
  assert.equal(h.deps.sendLogFile.startsWith(realCache + path.sep), false);
});

test('image attachments set and verify the clipboard, send Ctrl+V, confirm each marker, then send text', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const screens = [
    'conversation\n❯',
    'conversation\n❯',
    'draft [Image #1]\n❯',
    'draft [Image #1]\n❯',
    'draft [Image #1] [Image #2]\n❯',
  ];
  h.deps.readPane = async () => screens.shift() || screens.at(-1) || '';
  const send = createSessionSend(h.deps);

  await send.send({
    sessionId: 's-images',
    text: 'describe both',
    images: ['/cache/one.png', '/cache/two.png'],
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });

  assert.deepEqual(h.sequence, [
    ['clipboard', '/cache/one.png'],
    ['input', IMAGE_PASTE],
    ['clipboard', '/cache/two.png'],
    ['input', IMAGE_PASTE],
    ['input', 'describe both'],
    ['input', '\r'],
  ]);
});

test('image attach is confirmed even when a prior turn\'s markers scroll off (max #N, not count)', async () => {
  // Regression: a SENT image turn leaves two [Image #N] markers in the recent
  // viewport (prompt echo + "⎿ [Image #N]"). Pasting the next image grows the
  // composer and scrolls those off the top, so a COUNT delta DROPS (2 -> 1) and
  // falsely reports "never confirmed", even though the image attached. The
  // fresh paste is always the highest #N, so max-of-#N must still confirm it.
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  // Idle pane whose last turn was an image send: two lingering #2 markers
  // (prompt echo + attachment line). Repeated to cover the composer-safe check
  // and the beforeMax read before the after-paste frame arrives.
  const idle = '❯ [Image #2] describe this\n  ⎿  [Image #2]\n● sure\n────\n❯\n────';
  // After Ctrl+V: old #2 markers scrolled off the top; only the new #3 remains.
  // Old count-logic saw 2 -> 1 and failed; max-#N sees 2 -> 3 and confirms.
  const afterPaste = '● sure\n────\n❯ [Image #3]\n────\n status';
  const screens = [idle, idle, idle, afterPaste];
  h.deps.readPane = async () => screens.shift() || screens.at(-1) || '';
  const send = createSessionSend(h.deps);

  const res = await send.send({
    sessionId: 's-scrolloff',
    text: 'and this one',
    images: ['/cache/three.png'],
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });

  assert.equal(res.ok, true);
  assert.deepEqual(h.sequence, [
    ['clipboard', '/cache/three.png'],
    ['input', IMAGE_PASTE],
    ['input', 'and this one'],
    ['input', '\r'],
  ]);
});

test('image marker timeout is an honest send error and text is never typed', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => 'conversation\n❯';
  const realNow = Date.now;
  let now = realNow();
  h.deps.sleep = async () => { now += 500; };
  Date.now = () => now;
  try {
    const send = createSessionSend(h.deps);
    const statuses = [];
    send.emitter.on('status', (value) => statuses.push(value));
    await assert.rejects(
      () => send.send({
        sessionId: 's-image-fail',
        text: 'do not type me',
        images: ['/cache/one.png'],
        pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
      }),
      /never confirmed the image attachment/,
    );
    assert.deepEqual(h.sent.map(({ text }) => text), [IMAGE_PASTE]);
    assert.equal(statuses.at(-1).phase, 'error');
  } finally {
    Date.now = realNow;
  }
});

// Live-caught 2026-09-23 (send log 03:05:52 and 03:08:23): two image sends into
// a 48MB-transcript session typed their text and image into Claude's composer,
// and neither Enter submitted. Both messages sat in the composer until a third
// send's Enter carried all of it, "/compact" glued onto the end, while Harbor
// reported "could not confirm the message reached the session" twice. Measured
// against the real CLI 2.1.280 in an isolated pty: when the text and the Enter
// reach it in ONE read (a busy CLI does not read its input for 160ms), the
// Enter is taken as text and nothing submits; whether the bytes coalesce is up
// to the console, so the same write submitted in two panes and not in a third.
// Spare Enters are harmless (three in a row sent one message; one on an idle
// empty composer, or with a message queued, sent nothing), so a swallowed Enter
// is pressed again, but only while the composer visibly still holds the text.
const enterFixture = (name) => fs.readFileSync(
  path.join(__dirname, '../fixtures/composer-enter', name),
  'utf8',
);

// Claude's composer as 2.1.280 draws it (the fixtures above): the draft sits in
// a box between two dividers, the prompt glyph followed by a no-break space. An
// Enter either submits the draft (the box empties) or is swallowed.
function composerPane(h, { swallowEnters = 0, renderDelayReads = 0 } = {}) {
  let draft = '';
  let swallowed = 0;
  let images = 0;
  let hideReads = 0;
  const echoed = [];
  const divider = '─'.repeat(60);
  h.prompt.echo = false; // this stand-in draws its own prompt
  // A submitted prompt is echoed above the box, as Claude draws it; a busy CLI
  // shows nothing new for `renderDelayReads` reads after each keystroke.
  h.deps.readPane = async () => {
    const shown = hideReads > 0 ? '' : draft;
    if (hideReads > 0) hideReads -= 1;
    const above = echoed.map((line) => `❯ ${line}`).join('\n');
    return `conversation\n${above}\n${divider}\n❯ ${shown}\n${divider}\n  personal  ·  Opus 5.5\n  ⏵⏵ auto mode on`;
  };
  const sendInput = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    const result = sendInput(paneId, text);
    if (text === '\r') {
      if (swallowed < swallowEnters) swallowed += 1;
      else if (draft) { echoed.push(draft); draft = ''; }
    } else if (text === IMAGE_PASTE) {
      images += 1;
      draft += `[Image #${images}] `;
    } else {
      draft += text.replace(/\x1b\[20[01]~/g, '');
      hideReads = renderDelayReads;
    }
    return result;
  };
  return { get draft() { return draft; } };
}

const typed = (h) => h.sent.map(({ text }) => text);

test('an Enter Claude swallowed is pressed again while the message still sits in its composer', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = composerPane(h, { swallowEnters: 1 });
  const send = createSessionSend(h.deps);

  await send.send({ sessionId: 's-swallowed', text: 'group the outlined squares together', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });

  assert.deepEqual(typed(h), ['group the outlined squares together', '\r', '\r']);
  assert.equal(pane.draft, '');
});

test('an Enter Claude took is never pressed twice', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  composerPane(h);
  const send = createSessionSend(h.deps);

  await send.send({ sessionId: 's-taken', text: 'one message', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });

  assert.deepEqual(typed(h), ['one message', '\r']);
});

test('the image send that failed live: a swallowed Enter after an image and a pasted body is retried', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = composerPane(h, { swallowEnters: 1 });
  const send = createSessionSend(h.deps);
  const body = 'love this visual but can you check on the outlined ones?\n\nadditionally group them by sub-group';

  await send.send({ sessionId: 's-image-swallowed', text: body, images: ['/cache/shot.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });

  assert.deepEqual(typed(h), [IMAGE_PASTE, `\x1b[200~${body}\x1b[201~`, '\r', '\r']);
  assert.equal(pane.draft, '');
});

test('an image-only send whose Enter was swallowed is retried on its own marker', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = composerPane(h, { swallowEnters: 1 });
  const send = createSessionSend(h.deps);

  await send.send({ sessionId: 's-image-only', text: '', images: ['/cache/shot.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });

  assert.deepEqual(typed(h), [IMAGE_PASTE, '\r', '\r']);
  assert.equal(pane.draft, '');
});

test('spare Enters stop after two: a composer that never takes one is left to the delivery confirm', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  composerPane(h, { swallowEnters: 99 });
  const send = createSessionSend(h.deps);

  await send.send({ sessionId: 's-stuck', text: 'never taken', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });

  assert.deepEqual(typed(h), ['never taken', '\r', '\r', '\r']);
});

test('a slash command never gets a spare Enter: its picker or dialog would take it as an answer', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  composerPane(h, { swallowEnters: 99 });
  const send = createSessionSend(h.deps);

  await send.send({ sessionId: 's-slash', text: '/model opus', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });

  assert.equal(typed(h).filter((text) => text === '\r').length, 1);
});

test('a message queued behind a running turn is drawn above the box and is not a swallowed Enter', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => enterFixture('queued-above-box-2.1.280.txt');
  const send = createSessionSend(h.deps);

  await send.send({ sessionId: 's-queued', text: 'queued follow-up 38113', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });

  assert.deepEqual(typed(h), ['queued follow-up 38113', '\r']);
});

test('a CLI that has not drawn the text yet is watched until the message shows up stuck', async () => {
  // Measured live: a second after the Enter, a busy CLI's composer did not show
  // the text at all, and it arrived later with the Enter absorbed into it.
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = composerPane(h, { swallowEnters: 1, renderDelayReads: 4 });
  const send = createSessionSend(h.deps);

  await send.send({ sessionId: 's-slow', text: 'drawn late, Enter absorbed', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });

  assert.deepEqual(typed(h), ['drawn late, Enter absorbed', '\r', '\r']);
  assert.equal(pane.draft, '');
});

test('composerSendState reads the real 2.1.280 composer shapes', () => {
  const longText = `Reply with just OK. probe-H-2588 ${'lorem ipsum dolor sit amet '.repeat(25)}END1`;
  // A long draft wrapped across the box, trailing padding and all.
  assert.equal(composerSendState(enterFixture('stranded-long-text-2.1.280.txt'), { text: longText }), 'holds');
  assert.equal(composerSendState(enterFixture('stranded-long-text-2.1.280.txt'), { text: 'some other message entirely' }), 'pending');
  // A big paste collapses to Claude's placeholder, which only counts for a pasted send.
  const placeholder = enterFixture('stranded-paste-placeholder-2.1.280.txt');
  assert.equal(composerSendState(placeholder, { text: 'pasted line 29', pasted: true }), 'holds');
  assert.equal(composerSendState(placeholder, { text: 'pasted line 29', pasted: false }), 'pending');
  // The queued copy is echoed above the box, which holds only the hint.
  assert.equal(composerSendState(enterFixture('queued-above-box-2.1.280.txt'), { text: 'queued follow-up 38113' }), 'taken');
  // No box at all is no evidence.
  assert.equal(composerSendState('conversation\n❯ queued follow-up 38113', { text: 'queued follow-up 38113' }), 'nobox');
  assert.equal(composerSendState('', { text: 'x' }), 'nobox');
  // Image markers, for a send with no text.
  const divider = '─'.repeat(40);
  assert.equal(composerSendState(`${divider}\n❯ [Image #7] \n${divider}\n  status`, { imageMarker: '[Image #7]' }), 'holds');
  assert.equal(composerSendState(`${divider}\n❯ \n${divider}\n  status`, { imageMarker: '[Image #7]' }), 'pending');
  assert.equal(composerSendState(`❯ [Image #7]\n${divider}\n❯\n${divider}\n  status`, { imageMarker: '[Image #7]' }), 'taken');
});

// 2026-10-09: session aac2564b's prompt took none of Harbor's keystrokes for 45
// minutes while Claude was alive and idle (two image pastes drew no marker; two
// messages and a "continue" never appeared; Claude's own prompt history never
// recorded them), and Harbor pressed Enter blind and reported "sent". The
// fixtures below are real CLI 2.1.295 screens from the probes run that day,
// with session names and paths replaced.
const PROMPT_EMPTY = `${PROMPT_RULE}\n❯ \n${PROMPT_RULE}\n  personal  ·  Opus 5.5\n  ⏵⏵ bypass permissions on`;
const harborCaptures = (h) => {
  const dir = path.join(path.dirname(h.deps.sendLogFile), 'send-captures');
  try { return fs.readdirSync(dir); } catch { return []; }
};

test('composerSendState reads the 2.1.295 prompt shapes it used to miss', () => {
  // A single line past ~800 characters collapses to a placeholder WITHOUT a
  // line count (measured: 799 drew literally, 1,599 collapsed).
  const longLine = 'the quick brown fox jumps over the lazy dog '.repeat(36).trim();
  assert.equal(composerSendState(enterFixture('long-single-line-placeholder-2.1.295.txt'), { text: longLine, pasted: true }), 'holds');
  // A message starting with "!" puts the prompt in shell mode, drawn with "!".
  assert.equal(composerSendState(enterFixture('shell-mode-prompt-2.1.295.txt'), { text: '!echo hello there' }), 'holds');
  assert.equal(composerSendState(enterFixture('shell-mode-prompt-2.1.295.txt'), { text: '!echo something else' }), 'pending');
});

test('the sessions view is recognized by its own box and key hints, never by prose that quotes it', () => {
  assert.equal(isFleetView(enterFixture('sessions-view-2.1.295.txt')), true);
  assert.equal(isFleetView(enterFixture('sessions-view-typed-2.1.295.txt')), true);
  const prose = [
    '● The input reads "describe a task for a new session" and the hints say',
    '  enter to return · space to reply · ctrl+x to delete.',
    PROMPT_EMPTY,
  ].join('\n');
  assert.equal(isFleetView(prose), false);
  assert.equal(isFleetView(PROMPT_EMPTY), false);
});

test('a prompt that never shows the typed text gets no Enter, an honest error, and a saved screen', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1', promptEchoes: false, readFrames: [PROMPT_EMPTY] });
  const send = createSessionSend(h.deps);
  const errors = [];
  send.emitter.on('status', (s) => { if (s.phase === 'error') errors.push(s.detail); });

  await assert.rejects(
    send.send({ sessionId: 's-deaf', text: 'i like the calm stone a lot more', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'PROMPT_NEVER_HELD' && /did not press Enter and nothing was sent/.test(error.message),
  );
  assert.deepEqual(typed(h), ['i like the calm stone a lot more'], 'Enter is never pressed blind');
  assert.match(errors[0] || '', /prompt never showed your text/);
  const log = await readSendLog(h.deps.sendLogFile, (rows) => rows.some((r) => r.phase === 'prompt-never-held'));
  assert.ok(log.some((r) => r.phase === 'prompt-never-held' && r.state === 'pending'));
  assert.equal(harborCaptures(h).length, 1, 'the screen the send saw is kept for diagnosis');
});

test('a send into the sessions view is refused before a single key is typed', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1', readFrames: [enterFixture('sessions-view-2.1.295.txt')] });
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.send({ sessionId: 's-fleet', text: 'continue', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'FLEET_VIEW' && /sessions list/.test(error.message),
  );
  assert.deepEqual(typed(h), [], 'Enter there would create a new background session from the text');
});

test('a dim suggested prompt that reads like the message is not the message', async () => {
  // Claude fills an EMPTY box with a dim suggestion; the keeper reports it as
  // `suggestion`. Here the typing is lost and the suggestion says "continue",
  // so the box reads exactly like the message without holding it.
  const h = makeHarness({
    panes: ['pane-1'],
    controlled: 'pane-1',
    promptEchoes: false,
    readFrames: [`${PROMPT_RULE}\n❯ continue\n${PROMPT_RULE}\n  personal  ·  Opus 5.5`],
  });
  h.deps.readSuggestion = async () => 'continue';
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.send({ sessionId: 's-suggested', text: 'continue', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'PROMPT_NEVER_HELD',
  );
  assert.deepEqual(typed(h), ['continue'], 'typed once, and no Enter into a box that only shows a suggestion');
});

// 2026-10-10: a brand-new cdt-app session drew its empty prompt, then kept
// Harbor's typing in its startup buffer for over half a minute on a machine at
// 100% CPU. Harbor gave up after 7.5 s and said "nothing was sent", Pat sent
// again, Harbor typed the message a second time, and both copies landed in the
// prompt later. composerPane's renderDelayReads stands in for that buffer: the
// typing shows only after that many reads.
const NEW_SESSION_MESSAGE = 'pick up three pieces of cdt-app work; read the findings first';

test('a starting Claude that shows the typing late still gets it once, with one Enter, and says why it waits', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = composerPane(h, { renderDelayReads: 240 });
  const send = createSessionSend(h.deps);
  const details = [];
  send.emitter.on('status', (s) => { if (s.phase === 'sending' && s.detail) details.push(s.detail); });

  await send.send({ sessionId: 's-starting', text: NEW_SESSION_MESSAGE, pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });

  assert.deepEqual(typed(h), [NEW_SESSION_MESSAGE, '\r']);
  assert.equal(pane.draft, '', 'the message was submitted');
  assert.match(details[0] || '', /still starting up/);
});

test('a pane that has taken a message keeps the short wait', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = composerPane(h);
  const composed = h.deps.readPane;
  let reads = 0;
  let deaf = false;
  h.deps.readPane = async (...args) => {
    if (!deaf) return composed(...args);
    reads += 1;
    return `conversation\n${PROMPT_EMPTY}`;
  };
  const send = createSessionSend(h.deps);
  await send.send({ sessionId: 's-short', text: 'first one lands', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.equal(pane.draft, '');
  deaf = true;
  await assert.rejects(
    send.send({ sessionId: 's-short', text: 'second one is never shown', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'PROMPT_NEVER_HELD',
  );
  assert.ok(reads < 120, `an established pane gives up in seconds, not minutes (${reads} reads)`);
});

test('a second send after a refusal waits for the first typing instead of typing the message again', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  // Longer than the whole first wait, so the first send is refused and the
  // buffer lets go during the second.
  const pane = composerPane(h, { renderDelayReads: 1300 });
  const send = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };

  await assert.rejects(
    send.send({ sessionId: 's-retry', text: NEW_SESSION_MESSAGE, pane: target }),
    (error) => error.code === 'PROMPT_NEVER_HELD' && /sending again waits for it instead of typing it twice/.test(error.message),
  );
  await send.send({ sessionId: 's-retry', text: NEW_SESSION_MESSAGE, pane: target });

  assert.deepEqual(typed(h), [NEW_SESSION_MESSAGE, '\r'], 'typed once, submitted once');
  assert.equal(pane.draft, '');
  const log = await readSendLog(h.deps.sendLogFile, (rows) => rows.some((r) => r.phase === 'awaiting-earlier-typing'));
  assert.ok(log.some((r) => r.phase === 'awaiting-earlier-typing'));
});

test('a long message that showed up after the refusal is submitted by the resend, even though the prompt shows only its end', async () => {
  // Claude draws only the last ~25 lines of a long prompt, so it can never
  // match the whole message; the earlier attempt's record is what proves it.
  const message = Array.from({ length: 60 }, (_, i) => `line ${i + 1} of the cdt-app handoff`).join('\n');
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1', promptEchoes: false });
  let released = false;
  let submitted = false;
  h.deps.readPane = async () => {
    if (submitted) return `❯ ${message.split('\n').slice(-3).join(' ')}\n${PROMPT_EMPTY}`;
    const shown = released ? message.split('\n').slice(-25).join('\n  ') : '';
    return `${PROMPT_RULE}\n❯ ${shown}\n${PROMPT_RULE}\n  personal  ·  Opus 5.5`;
  };
  const sendInput = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    if (text === '\r' && released) submitted = true;
    return sendInput(paneId, text);
  };
  const send = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };

  await assert.rejects(send.send({ sessionId: 's-late', text: message, pane: target }), (e) => e.code === 'PROMPT_NEVER_HELD');
  released = true;
  await send.send({ sessionId: 's-late', text: message, pane: target });

  assert.deepEqual(typed(h), [`\x1b[200~${message}\x1b[201~`, '\r']);
});

test('typing that never shows even after the second wait is typed fresh by the send after that', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1', promptEchoes: false, readFrames: [PROMPT_EMPTY] });
  const send = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  const lost = 'these keys are truly lost';

  await assert.rejects(send.send({ sessionId: 's-lost', text: lost, pane: target }), (e) => e.code === 'PROMPT_NEVER_HELD');
  await assert.rejects(
    send.send({ sessionId: 's-lost', text: lost, pane: target }),
    (e) => e.code === 'PROMPT_NEVER_HELD' && /sending again types it fresh/.test(e.message),
  );
  assert.deepEqual(typed(h), [lost], 'the second send typed nothing');
  await assert.rejects(send.send({ sessionId: 's-lost', text: lost, pane: target }), (e) => e.code === 'PROMPT_NEVER_HELD');
  assert.deepEqual(typed(h), [lost, lost], 'no dead end: the third send types again');
});

test('a different message after a refusal is not typed on top of the earlier one when that one shows up', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = composerPane(h, { renderDelayReads: 1300 });
  const send = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };

  await assert.rejects(send.send({ sessionId: 's-edit', text: NEW_SESSION_MESSAGE, pane: target }), (e) => e.code === 'PROMPT_NEVER_HELD');
  await assert.rejects(
    send.send({ sessionId: 's-edit', text: 'a shorter rewrite of it', pane: target }),
    (e) => e.code === 'PROMPT_HOLDS_EARLIER',
  );
  assert.deepEqual(typed(h), [NEW_SESSION_MESSAGE], 'neither the rewrite nor an Enter went in');
  assert.equal(pane.draft, NEW_SESSION_MESSAGE, 'the earlier message is left in the prompt for Pat');
});

test('a prompt already holding the message twice gets nothing typed and no Enter', async () => {
  const h = makeHarness({
    panes: ['pane-1'],
    controlled: 'pane-1',
    promptEchoes: false,
    readFrames: [`${PROMPT_RULE}\n❯ ${NEW_SESSION_MESSAGE}${NEW_SESSION_MESSAGE}\n${PROMPT_RULE}\n  personal  ·  Opus 5.5`],
  });
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.send({ sessionId: 's-doubled', text: NEW_SESSION_MESSAGE, pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'PROMPT_HOLDS_MORE' && /typed and sent nothing/.test(error.message),
  );
  assert.deepEqual(typed(h), []);
});

test('a plan move never types /exit into the sessions view, and says why', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1', readFrames: [enterFixture('sessions-view-2.1.295.txt')] });
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.moveIdleSession({ sessionId: 's-plan', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }, (exit) => exit()),
    (error) => error.code === 'FLEET_VIEW',
  );
  assert.deepEqual(typed(h), []);
});

test('the sessions view appearing mid-send gets no Enter', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1', promptEchoes: false });
  let typedText = false;
  h.deps.readPane = async () => (typedText ? enterFixture('sessions-view-typed-2.1.295.txt') : PROMPT_EMPTY);
  const sendInput = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => { typedText = true; return sendInput(paneId, text); };
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.send({ sessionId: 's-fleet-mid', text: 'hello typed in the sessions view', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'FLEET_VIEW',
  );
  assert.equal(typed(h).includes('\r'), false);
});

test('a frame with no prompt box right after Enter is read again, not taken as delivered', async () => {
  // The Enter watcher used to end on the first boxless frame and call the
  // message gone; that is how two of the 2026-10-09 sends read "sent" in half
  // a second. Here the Enter is swallowed and the box only comes back three
  // reads later, still holding the message, so a spare Enter is owed.
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = composerPane(h, { swallowEnters: 1 });
  const composed = h.deps.readPane;
  let blank = 0;
  h.deps.readPane = async (...args) => {
    if (blank > 0) { blank -= 1; return 'redrawing'; }
    return composed(...args);
  };
  const sendInput = h.deps.terminalBridge.sendInput;
  let enters = 0;
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    if (text === '\r' && (enters += 1) === 1) blank = 3;
    return sendInput(paneId, text);
  };
  const send = createSessionSend(h.deps);

  await send.send({ sessionId: 's-blank', text: 'group them by sub-group', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });

  assert.deepEqual(typed(h), ['group them by sub-group', '\r', '\r']);
  assert.equal(pane.draft, '');
});

test('a message already sitting in the prompt from an earlier attempt is submitted, not typed twice', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let submitted = false;
  h.deps.readPane = async () => (submitted
    ? `❯ continue\n${PROMPT_EMPTY}`
    : `${PROMPT_RULE}\n❯ continue\n${PROMPT_RULE}\n  personal  ·  Opus 5.5`);
  const sendInput = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    if (text === '\r') submitted = true;
    return sendInput(paneId, text);
  };
  const send = createSessionSend(h.deps);
  await send.send({ sessionId: 's-stranded', text: 'continue', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.deepEqual(typed(h), ['\r']);
});

// Live-caught 2026-08-08. A brand-new codex session took a message and the
// rollout recorded it with the LEADING characters missing, because Harbor typed
// into the pane while codex was still starting its TUI. waitForProviderReady
// existed but was wired only to the resume path, so resuming was safe and
// starting was not. The gate is first-delivery-only and non-fatal: a pane
// mid-turn never produces two identical reads, so a hard gate would refuse
// sends into a busy codex.
test('a FRESH codex pane is allowed to settle before anything is typed into it', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const order = [];
  let reads = 0;
  // A stable, non-shell screen: two identical reads is what "settled" means.
  h.deps.readPane = async () => { reads += 1; order.push('read'); return 'codex\n> '; };
  const send = createSessionSend(h.deps);
  await send.send({
    sessionId: 'pane:fresh-codex',
    text: 'the whole message must survive',
    provider: 'codex',
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });
  const typedAt = h.sent.length ? order.indexOf('type') : -1;
  assert.ok(reads >= 2, `a fresh pane must be READ until it settles before typing, saw ${reads} reads`);
  assert.match(h.sent.map(({ text }) => text).join(''), /the whole message must survive/);
  void typedAt;
});

test('a FRESH cursor pane settles too: the gate is not codex-only', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let reads = 0;
  h.deps.readPane = async () => { reads += 1; return 'cursor\n> '; };
  const send = createSessionSend(h.deps);
  await send.send({
    sessionId: 'pane:fresh-cursor',
    text: 'cursor must not lose the front of this either',
    provider: 'cursor',
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });
  assert.ok(reads >= 2, `a fresh cursor pane must settle before typing, saw ${reads} reads`);
  assert.match(h.sent.map(({ text }) => text).join(''), /cursor must not lose the front of this either/);
});

// Measured 2026-09-26: a fresh cursor pane stays BLANK for 25-32 s while cursor
// starts its MCP servers, then draws its composer. The first-send budget was
// 15 s, so the message went in while the pane was still blank. A blank pane is
// booting, not busy: it gets the longer budget, and typing waits for the draw.
test('a fresh pane that has drawn nothing yet gets the boot budget, not the busy one', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let t = 0;
  h.deps.clock = () => t;
  h.deps.sleep = async (ms) => { t += ms; };
  const order = [];
  h.deps.readPane = async () => {
    const text = t < 30_000 ? '' : 'Cursor Agent v2026.09.26\n → Plan, search, build anything';
    order.push(text ? 'drawn' : 'blank');
    return text;
  };
  const input = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => { order.push('type'); return input(paneId, text); };
  const send = createSessionSend(h.deps);
  await send.send({
    sessionId: 'pane:fresh-cursor-slow',
    text: 'typed only once cursor is listening',
    provider: 'cursor',
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });
  const firstType = order.indexOf('type');
  assert.ok(firstType > 0, 'the message was typed');
  assert.ok(order.slice(0, firstType).filter((step) => step === 'drawn').length >= 2,
    `typing must wait for the drawn screen to settle, saw ${order.slice(0, firstType).join(',')}`);
  assert.match(h.sent.map(({ text }) => text).join(''), /typed only once cursor is listening/);
});

test('a fresh pane that is drawing but never settles still gives up on the old 15 s budget', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let t = 0;
  h.deps.clock = () => t;
  h.deps.sleep = async (ms) => { t += ms; };
  let frame = 0;
  let typedAt = null;
  // Mid-turn output: never two identical reads.
  h.deps.readPane = async () => `codex\nworking ${frame += 1}`;
  const input = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => { if (typedAt === null) typedAt = t; return input(paneId, text); };
  const send = createSessionSend(h.deps);
  await send.send({
    sessionId: 'pane:fresh-busy', text: 'x', provider: 'codex',
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });
  assert.ok(typedAt !== null && typedAt <= 17_000, `a busy drawn pane waits ~15 s as before, typed at ${typedAt} ms`);
});

// Only a read that comes back BLANK is evidence of a booting pane. A read that
// throws says nothing, so it must not buy the 45 s boot budget.
test('a fresh pane whose reads fail keeps the old 15 s budget', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let t = 0;
  h.deps.clock = () => t;
  h.deps.sleep = async (ms) => { t += ms; };
  let gateReads = 0;
  // Throw through the settle gate, then answer normally so delivery can finish.
  h.deps.readPane = async () => {
    if (t < 16_000) { gateReads += 1; throw new Error('pane unreadable'); }
    return 'codex\n> ';
  };
  let typedAt = null;
  const input = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => { if (typedAt === null) typedAt = t; return input(paneId, text); };
  const send = createSessionSend(h.deps);
  await send.send({
    sessionId: 'pane:fresh-unreadable', text: 'x', provider: 'codex',
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });
  assert.ok(gateReads > 0, 'the gate did read (and fail)');
  assert.ok(typedAt !== null && typedAt <= 17_000, `an unreadable pane waits ~15 s as before, typed at ${typedAt} ms`);
});

// The gate keyed on `provider !== 'claude'` while `provider` itself arrived with
// a silent default of 'claude', so an unresolved codex pane skipped the wait AND
// took the claude composer guard. resolveProvider asks the session's own
// metadata before believing the default.
test('an unresolved provider is taken from the session, not defaulted to claude', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.getSessionMeta = async () => ({ provider: 'codex', cwd: '/tmp/x' });
  let reads = 0;
  h.deps.readPane = async () => { reads += 1; return 'codex\n> '; };
  const send = createSessionSend(h.deps);
  await send.send({
    sessionId: 'pane:unresolved',
    text: 'this is a codex session even though nobody said so',
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });
  assert.ok(reads >= 2, `an unresolved provider must still settle, saw ${reads} reads`);
});

// Codex 0.159.3 can draw an account-security banner over an EMPTY composer that
// takes a bare `1` keypress as "Set up security" (actionable_banner.rs
// handle_inline_banner_key: empty composer, no paste burst, digit 1..N). A
// single-line message typed raw that starts with "1" lost its first character
// to the banner. A bracketed paste is a Paste event, never a key, so a codex
// message always goes in as one; claude keeps its measured raw single line.
test('a single-line codex message is pasted, so a banner over the empty composer cannot take its first key', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => 'codex\n> ';
  const send = createSessionSend(h.deps);
  await send.send({
    sessionId: 'pane:codex-banner', text: '1. fix the header', provider: 'codex',
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });
  const typed = h.sent.map(({ text }) => text);
  assert.ok(typed.includes('\x1b[200~1. fix the header\x1b[201~'), `codex text must be a bracketed paste: ${JSON.stringify(typed)}`);
  assert.ok(!typed.includes('1. fix the header'), 'never typed raw');
});

test('an established codex pane is NOT re-settled on every send', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let reads = 0;
  h.deps.readPane = async () => { reads += 1; return 'codex\n> '; };
  const send = createSessionSend(h.deps);
  const payload = (text) => ({
    sessionId: 'pane:fresh-codex', text, provider: 'codex',
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });
  await send.send(payload('first'));
  const afterFirst = reads;
  await send.send(payload('second'));
  assert.ok(
    reads - afterFirst < afterFirst,
    `the second send must not repeat the settle: ${afterFirst} reads then ${reads - afterFirst}`,
  );
});

// harbor-server is headless, so it never passes setXClipboardImage and there is
// no X selection for it to own. Before 2026-08-08 the delivery loop called it
// unconditionally, so every image sent from the PHONE died on
// "setXClipboardImage is not a function": the upload succeeded, the file landed
// on disk, and the send threw. The mobile gate never caught it because that gate
// stubs the pty boundary and so never reaches the delivery loop.
test('with no clipboard, an image is delivered as a path instead of a paste', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  delete h.deps.setXClipboardImage;
  const send = createSessionSend(h.deps);
  await send.send({
    sessionId: 's-headless-image',
    text: 'what is wrong with this screen?',
    images: ['/srv/upload/shot.png'],
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });
  const typed = h.sent.map(({ text }) => text);
  // No Ctrl+V, because there was nothing to paste.
  assert.equal(typed.includes(IMAGE_PASTE), false, 'must not press the paste chord without a clipboard');
  const body = typed.join('');
  assert.match(body, /\/srv\/upload\/shot\.png/, 'the image path has to reach the composer');
  assert.match(body, /what is wrong with this screen\?/, 'the typed text must survive alongside it');
});

test('two headless images are both delivered, on one line, ahead of the text', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  delete h.deps.setXClipboardImage;
  const send = createSessionSend(h.deps);
  await send.send({
    sessionId: 's-headless-two',
    text: 'compare these',
    images: ['/srv/upload/a.png', '/srv/upload/b.png'],
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });
  const body = h.sent.map(({ text }) => text).join('');
  assert.match(body, /Images: \/srv\/upload\/a\.png \/srv\/upload\/b\.png/);
  assert.ok(body.indexOf('/srv/upload/a.png') < body.indexOf('compare these'), 'images lead the prompt');
});

test('clipboard failure is an honest send error before Ctrl+V or text', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.setXClipboardImage = async () => { throw new Error('clipboard failed'); };
  const send = createSessionSend(h.deps);
  await assert.rejects(
    () => send.send({
      sessionId: 's-clipboard-fail',
      text: 'do not type me',
      images: ['/cache/one.png'],
      pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
    }),
    /clipboard failed/,
  );
  assert.deepEqual(h.sent, []);
});

for (const { name, text, expected } of [
  {
    name: 'bare slash command types its token and closing space raw',
    text: '/handoff',
    expected: ['/handoff ', '\r'],
  },
  {
    name: 'slash command with single-line args types token and remainder separately',
    text: '/acclimate with single-line args',
    expected: ['/acclimate ', 'with single-line args', '\r'],
  },
  {
    name: 'slash command with multi-line args types token raw and bracket-pastes remainder',
    text: '/acclimate with\nmulti-line args',
    expected: ['/acclimate ', '\x1b[200~with\nmulti-line args\x1b[201~', '\r'],
  },
  {
    name: 'plain multi-line prose remains one bracketed paste',
    text: 'plain\nmulti-line prose',
    expected: ['\x1b[200~plain\nmulti-line prose\x1b[201~', '\r'],
  },
  {
    name: 'plain single-line prose remains raw',
    text: 'plain single-line prose',
    expected: ['plain single-line prose', '\r'],
  },
]) {
  test(name, async () => {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    const send = createSessionSend(h.deps);
    await send.send({ sessionId: 's1', text, pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
    assert.deepEqual(h.sent.map((s) => s.text), expected);
    assert.deepEqual(h.focused, []);
  });
}

test('dead session: resume, discover fresh pane, wait ready, deliver', async () => {
  const composer = '──────────────\n❯\n──────────────\n  haiku 4.5 xhigh │ you';
  const h = makeHarness({ panes: ['pane-old'], readFrames: [composer] });
  const send = createSessionSend(h.deps);
  const statuses = [];
  send.emitter.on('status', (s) => statuses.push(s.phase));
  const res = await send.send({ sessionId: 's2', text: 'continue where we left off', detectedHome: 'team' });
  assert.equal(res.ok, true);
  assert.equal(res.resumed, true);
  assert.equal(h.resumeCalls[0].id, 's2');
  assert.equal(res.paneId, 'pane-fresh');
  assert.deepEqual(h.sent.map((s) => s.text), ['continue where we left off', '\r']);
  assert.deepEqual(statuses, ['resuming', 'waiting', 'sending', 'sent']);
});

for (const fixtureName of ['handoff-target-w1T-p0.txt', 'dev-image-w1V-p1.txt']) {
  test(`resume summary dialog is blocked and unsafe from ${fixtureName}`, async () => {
    const dialog = resumeDialogFixture(fixtureName);
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    h.deps.readPane = async () => dialog;
    const realNow = Date.now;
    let now = realNow();
    h.deps.sleep = async () => { now += 1000; };
    Date.now = () => now;
    try {
      const send = createSessionSend(h.deps);
      assert.equal(await send.waitForClaudeReady('pane-1', { timeoutMs: 2500 }), false);
      await assert.rejects(
        () => send.send({ sessionId: 'resume-dialog', text: 'keep this', pane: { paneId: 'pane-1' } }),
        /asking a question in its window/,
      );
      assert.deepEqual(h.sent, []);
    } finally {
      Date.now = realNow;
    }
  });
}

test('resume then send selects full session only after verifying option 2 and waits for composer', async () => {
  const h = makeHarness({ panes: [] });
  let phase = 'dialog-1';
  const render = () => {
    if (phase === 'composer') return 'conversation\n──────\n❯\n──────';
    const selected = phase === 'dialog-2' ? 2 : 1;
    return [
      'This session is 10h 57m old and 559.1k tokens.',
      'Resuming the full session will consume a substantial portion of your usage limits.',
      'We recommend resuming from a summary.',
      `${selected === 1 ? '❯' : ' '} 1. Resume from summary (recommended)`,
      `${selected === 2 ? '❯' : ' '} 2. Resume full session as-is`,
      '  3. Don\'t ask me again',
    ].join('\n');
  };
  h.deps.readPane = async () => render();
  const realSendInput = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    const result = realSendInput(paneId, text);
    if (text === '\x1b[B') phase = 'dialog-2';
    if (text === '\r' && phase === 'dialog-2') phase = 'composer';
    return result;
  };
  const send = createSessionSend(h.deps);

  const result = await send.send({ sessionId: 'resume-full', text: 'deliver after resume' });

  assert.equal(result.ok, true);
  assert.deepEqual(h.sent.map(({ text }) => text), [
    '\x1b[B',
    '\r',
    'deliver after resume',
    '\r',
  ]);
});

// A resume can come up STRAIGHT into a live turn or a compaction that outlasts
// the 30s settle window (live-caught 2026-09-02: an Opus xhigh cdt-app session
// whose redelivered /compact ran ~95s). The old readiness check read both as an
// unsettled/blocked screen for the whole window and returned false, so the send
// threw "session resumed, but Claude never came up; message NOT sent" while the
// resume had in fact succeeded. A session that is demonstrably alive and
// working has come up.
test('waitForResumedClaudeReady: a resumed working turn is ready (message will queue)', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let tick = 0;
  // A live turn STREAMING output above the composer: the body changes every
  // read, so settleKey (which only drops the last two footer lines) can never
  // settle it. The composer box is drawn with an "esc to interrupt" footer,
  // which is Claude in-session and ready to QUEUE the message.
  h.deps.readPane = async () => [
    `streaming assistant output, line ${tick++}`,
    'still generating a long answer',
    '╭──────────────╮',
    '│ ❯            │',
    '╰──────────────╯',
    '✻ Working… (esc to interrupt)',
  ].join('\n');
  const realNow = Date.now;
  let now = realNow();
  h.deps.sleep = async () => { now += 1000; };
  Date.now = () => now;
  try {
    const send = createSessionSend(h.deps);
    assert.equal(await send.waitForResumedClaudeReady('pane-1', 'ws-1', { timeoutMs: 30_000 }), true);
  } finally {
    Date.now = realNow;
  }
});

test('waitForResumedClaudeReady: a resume that comes up compacting waits it out, not "never came up"', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let tick = 0;
  const compacting = ['earlier conversation', '✻ Compacting conversation history…'].join('\n');
  const composer = 'conversation\n──────\n❯\n──────';
  // Compaction runs past the 30s window (50 "seconds"), then settles.
  h.deps.readPane = async () => (tick++ < 50 ? compacting : composer);
  const realNow = Date.now;
  let now = realNow();
  h.deps.sleep = async () => { now += 1000; };
  Date.now = () => now;
  try {
    const send = createSessionSend(h.deps);
    assert.equal(await send.waitForResumedClaudeReady('pane-1', 'ws-1', { timeoutMs: 30_000 }), true);
  } finally {
    Date.now = realNow;
  }
});

test('resume into a working turn delivers (queues) the message instead of reporting it unsent', async () => {
  const h = makeHarness({ panes: [] });
  let tick = 0;
  // Streaming body (never settles) with an "esc to interrupt" footer: the old
  // path timed out and threw "message NOT sent"; the fix reads it as came-up and
  // delivers, which the CLI queues.
  h.deps.readPane = async () => [
    `assistant streaming, line ${tick++}`,
    '╭────╮', '│ ❯  │', '╰────╯',
    '✻ Working… (esc to interrupt)',
  ].join('\n');
  const realNow = Date.now;
  let now = realNow();
  h.deps.sleep = async () => { now += 1000; };
  Date.now = () => now;
  try {
    const send = createSessionSend(h.deps);
    const res = await send.send({ sessionId: 'busy-resume', text: 'closer but still not quite right' });
    assert.equal(res.ok, true);
    assert.deepEqual(h.sent.map((s) => s.text), ['closer but still not quite right', '\r']);
  } finally {
    Date.now = realNow;
  }
});

test('resumeOnly answers the resume dialog with option 2 and sends no message', async () => {
  const h = makeHarness({ panes: [] });
  let selected = 1;
  let answered = false;
  h.deps.readPane = async () => answered ? 'conversation\n──────\n❯\n──────' : [
    'Resuming the full session will consume a substantial portion of your usage limits.',
    `${selected === 1 ? '❯' : ' '} 1. Resume from summary (recommended)`,
    `${selected === 2 ? '❯' : ' '} 2. Resume full session as-is`,
    '  3. Don\'t ask me again',
  ].join('\n');
  const realSendInput = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    const result = realSendInput(paneId, text);
    if (text === '\x1b[B') selected = 2;
    if (text === '\r' && selected === 2) answered = true;
    return result;
  };
  const send = createSessionSend(h.deps);
  const res = await send.send({ sessionId: 's3', text: '', resumeOnly: true });
  assert.equal(res.ok, true);
  assert.deepEqual(h.sent.map(({ text }) => text), ['\x1b[B', '\r']);
});

test('resumeOnly re-delivers an unanswered typed tail as the resume prompt', async () => {
  const h = makeHarness({ panes: [], readFrames: ['conversation\n>'] });
  const transcriptPath = path.join(path.dirname(h.deps.sendLogFile), 'mid-turn.jsonl');
  const original = `Do not lose this question.\n${'full detail '.repeat(4000)}`;
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: 'Earlier answer' } }),
    JSON.stringify({
      type: 'user',
      origin: { kind: 'human' },
      promptSource: 'typed',
      message: { role: 'user', content: original },
    }),
  ].join('\n'));
  h.deps.resolveTranscriptPath = async () => transcriptPath;
  const send = createSessionSend(h.deps);

  const result = await send.send({ sessionId: 'mid-turn', text: '', resumeOnly: true });

  assert.equal(result.redelivered, true);
  assert.equal(h.resumeCalls[0].resumePrompt, original);
  assert.deepEqual(h.sent, [], 'redelivery is part of resume, never a second terminal send');
});

test('resumeOnly after a clean assistant turn keeps the bare resume', async () => {
  const h = makeHarness({ panes: [], readFrames: ['conversation\n>'] });
  const transcriptPath = path.join(path.dirname(h.deps.sendLogFile), 'between-turns.jsonl');
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ type: 'user', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: 'Question' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: 'Answered' } }),
  ].join('\n'));
  h.deps.resolveTranscriptPath = async () => transcriptPath;
  const send = createSessionSend(h.deps);

  const result = await send.send({ sessionId: 'between-turns', text: '', resumeOnly: true });

  assert.equal(result.redelivered, false);
  assert.equal(h.resumeCalls[0].resumePrompt, null);
  assert.deepEqual(h.sent, []);
});

test('resumeOnly surfaces an image-tail refusal through send status', async () => {
  const h = makeHarness({ panes: [] });
  const transcriptPath = path.join(path.dirname(h.deps.sendLogFile), 'image-tail.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify({
    type: 'user',
    origin: { kind: 'human' },
    promptSource: 'typed',
    message: { role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
      { type: 'text', text: 'Describe it' },
    ] },
  }));
  h.deps.resolveTranscriptPath = async () => transcriptPath;
  const send = createSessionSend(h.deps);
  const statuses = [];
  send.emitter.on('status', (entry) => statuses.push(entry));

  await assert.rejects(
    () => send.send({ sessionId: 'image-tail', text: '', resumeOnly: true }),
    /included an attachment Harbor cannot safely re-send/,
  );
  assert.equal(statuses.at(-1).phase, 'error');
  assert.match(statuses.at(-1).detail, /Reattach it and send the message again/);
  assert.deepEqual(h.resumeCalls, []);
});

test('claude never coming up is an HONEST failure, not a silent drop', async () => {
  const h = makeHarness({ panes: [], readFrames: ['starting…', 'still starting…', 'nope'] });
  // Make readiness reads always differ so settle never happens.
  let i = 0;
  h.deps.readPane = async () => `frame ${i++}`;
  const realNow = Date.now;
  let t = realNow();
  h.deps.sleep = async () => { t += 5000; };
  Date.now = () => t;
  try {
    const send = createSessionSend(h.deps);
    const statuses = [];
    send.emitter.on('status', (s) => statuses.push(s));
    await assert.rejects(
      () => send.send({ sessionId: 's4', text: 'hello' }),
      /message NOT sent/,
    );
    assert.equal(statuses.at(-1).phase, 'error');
  } finally {
    Date.now = realNow;
  }
});

// The 2026-07-22 live incident: the Claude CLI (Bun) segfaulted mid-session,
// leaving its pane at a bash prompt, and Harbor typed the next send into that
// SHELL, which executed it. A pane that still exists but no longer hosts the
// session must fall through to the resume path; no byte may reach the shell.
const CRASHED_SHELL_SCREEN = [
  'panic(main thread): Segmentation fault at address 0x64',
  'oh no: Bun has crashed. This indicates a bug in Bun, not your code.',
  'Segmentation fault         (core dumped) claude --dangerously-skip-permissions --model fable',
  'you@your-machine:~/dev/harbor$',
].join('\n');

test('a crashed CLI\'s leftover shell pane is never typed into: the send resumes instead', async () => {
  const composer = '──────\n❯\n──────';
  const h = makeHarness({ panes: ['pane-crashed'] });
  h.deps.readPane = async (paneId) => (paneId === 'pane-crashed' ? CRASHED_SHELL_SCREEN : composer);
  const send = createSessionSend(h.deps);
  const res = await send.send({
    sessionId: 'ebe07764-crashed',
    text: 'status?',
    pane: { paneId: 'pane-crashed', workspaceId: 'ws-1' },
  });
  assert.equal(res.resumed, true);
  assert.equal(res.paneId, 'pane-fresh');
  assert.ok(h.sent.every((s) => s.paneId !== 'pane-crashed'), 'no byte may reach the dead shell');
  assert.deepEqual(h.sent.map((s) => s.text), ['status?', '\r']);
});

test('a pane now owned by a DIFFERENT session falls through to resume', async () => {
  const h = makeHarness({
    panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', agent_session: { kind: 'id', value: 'other-session' } }],
  });
  h.deps.readPane = async () => '──────\n❯\n──────';
  const send = createSessionSend(h.deps);
  const res = await send.send({ sessionId: 's-moved', text: 'hello', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.equal(res.resumed, true);
  assert.ok(h.sent.every((s) => s.paneId !== 'pane-1'), 'the reused pane belongs to another session');
});

test('a pane whose agent_session matches the session delivers straight in', async () => {
  const h = makeHarness({
    panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', agent_session: { kind: 'id', value: 's-owned' } }],
    controlled: 'pane-1',
    readFrames: ['──────\n❯\n──────'],
  });
  const send = createSessionSend(h.deps);
  const res = await send.send({ sessionId: 's-owned', text: 'hi', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.equal(res.ok, true);
  assert.equal(res.paneId, 'pane-1');
  assert.deepEqual(h.sent.map((s) => s.text), ['hi', '\r']);
});

test('a dead shell behind a stale-but-owned pane falls through to resume: text never runs in bash', async () => {
  const h = makeHarness({
    panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', agent_session: { kind: 'id', value: 's-race' } }],
    controlled: 'pane-1',
  });
  // resolvePane accepts (the snapshot's ownership is stale-at-crash); the
  // composer guard must refuse the shell and runSend must resume instead.
  h.deps.readPane = async (paneId) => (paneId === 'pane-1' ? CRASHED_SHELL_SCREEN : '──────\n❯\n──────');
  const send = createSessionSend(h.deps);
  const res = await send.send({ sessionId: 's-race', text: 'anything here would execute', pane: { paneId: 'pane-1' } });
  assert.equal(res.resumed, true);
  assert.ok(h.sent.every((s) => s.paneId !== 'pane-1'), 'no byte may reach the dead shell');
  assert.deepEqual(h.sent.map((s) => s.text), ['anything here would execute', '\r']);
});

test('a non-Claude provider send refuses the dead shell and resumes through bin/ai, never claude-sessions', async () => {
  const h = makeHarness({
    panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1' }],
    controlled: 'pane-1',
  });
  h.deps.readPane = async (paneId) => (paneId === 'pane-1' ? CRASHED_SHELL_SCREEN : '──────\n❯\n──────');
  const providerResumes = [];
  h.deps.launchActions.resumeProviderSession = async (args) => {
    providerResumes.push(args);
    h.state.panes.push('pane-fresh');
  };
  h.deps.getSessionMeta = async () => ({ cwd: '/home/x/dev/harbor', provider: 'codex' });
  const send = createSessionSend(h.deps);
  const res = await send.send({
    sessionId: 's-codex', text: 'hello', provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });
  assert.equal(res.resumed, true);
  assert.ok(h.sent.every((s) => s.paneId !== 'pane-1'), 'no byte may reach the dead shell');
  assert.equal(h.resumeCalls.length, 0, 'no claude resume fired at a codex id');
  assert.deepEqual(providerResumes, [{ provider: 'codex', cwd: '/home/x/dev/harbor', id: 's-codex' }]);
  // Codex text is always a bracketed paste (the 0.159.3 security-banner rule).
  assert.deepEqual(h.sent.filter((s) => s.paneId === 'pane-fresh').map((s) => s.text), ['\x1b[200~hello\x1b[201~', '\r']);
});

test('a codex session with no recoverable cwd refuses honestly instead of resuming blind', async () => {
  const h = makeHarness({ panes: [], controlled: null });
  const providerResumes = [];
  h.deps.launchActions.resumeProviderSession = async (args) => { providerResumes.push(args); };
  h.deps.getSessionMeta = async () => ({ provider: 'cursor', cwd: null });
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.send({ sessionId: 's-cursor-nocwd', text: 'hello', provider: 'cursor' }),
    /working folder is unknown/,
  );
  assert.equal(providerResumes.length, 0);
  assert.equal(h.resumeCalls.length, 0);
});

test('a working turn footer (esc to interrupt) is never mistaken for a dead shell', async () => {
  // Tool output can legitimately end a line with $; the working footer wins.
  const working = 'running tests...\ncosts 5$\n✳ Cerebrating... (esc to interrupt)';
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => working;
  const send = createSessionSend(h.deps);
  const res = await send.send({ sessionId: 's-working', text: 'queue this', pane: { paneId: 'pane-1' } });
  assert.equal(res.ok, true);
  assert.deepEqual(h.sent.map((s) => s.text), ['queue this', '\r']);
});

test('a pane-keyed send at a dead shell refuses honestly (no resumable identity)', async () => {
  const h = makeHarness({
    panes: [{ pane_id: 'pane-9', workspace_id: 'ws-1' }],
    controlled: 'pane-9',
  });
  h.deps.readPane = async () => CRASHED_SHELL_SCREEN;
  const send = createSessionSend(h.deps);
  await assert.rejects(
    () => send.send({ sessionId: 'pane:pane-9', text: 'hello', pane: { paneId: 'pane-9', workspaceId: 'ws-1' } }),
    /shell/i,
  );
  assert.deepEqual(h.sent, []);
});

test('a provisional pane-keyed send keeps its pane even after agent detection names the real id', async () => {
  const h = makeHarness({
    panes: [{ pane_id: 'pane-9', workspace_id: 'ws-1', agent_session: { kind: 'id', value: 'real-uuid' } }],
    controlled: 'pane-9',
    readFrames: ['──────\n❯\n──────'],
  });
  const send = createSessionSend(h.deps);
  const res = await send.send({ sessionId: 'pane:pane-9', text: '/effort xhigh', pane: { paneId: 'pane-9', workspaceId: 'ws-1' } });
  assert.equal(res.ok, true);
  assert.equal(res.paneId, 'pane-9');
});

test('stale provisional link falls through to resume', async () => {
  const h = makeHarness({ panes: ['pane-other'] });
  h.deps.links.set('s5', { paneId: 'pane-dead', workspaceId: 'ws-1' });
  h.deps.readPane = async () => '──────\n❯\n──────';
  const send = createSessionSend(h.deps);
  const res = await send.send({ sessionId: 's5', text: 'hi' });
  assert.equal(res.resumed, true);
  assert.equal(h.deps.links.get('s5').paneId, 'pane-fresh');
});

test('two rapid sends to one session both deliver in FIFO order', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const send = createSessionSend(h.deps);
  const [a, b] = await Promise.all([
    send.send({ sessionId: 's6', text: 'one', pane: { paneId: 'pane-1' } }),
    send.send({ sessionId: 's6', text: 'two', pane: { paneId: 'pane-1' } }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(h.sent.map((s) => s.text), ['one', '\r', 'two', '\r']);
});

test('a message queued behind an in-flight send is exposed and survives until delivery', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let releaseFirstRead;
  const firstRead = new Promise((resolve) => { releaseFirstRead = resolve; });
  let reads = 0;
  h.deps.readPane = async () => {
    reads += 1;
    if (reads === 1) await firstRead;
    return 'conversation\n❯';
  };
  const send = createSessionSend(h.deps);
  const statuses = [];
  send.emitter.on('status', (value) => statuses.push(value));

  const first = send.send({ sessionId: 's-queued', text: 'first', pane: { paneId: 'pane-1' } });
  await new Promise((resolve) => setImmediate(resolve));
  const second = send.send({ sessionId: 's-queued', text: 'second message', pane: { paneId: 'pane-1' } });
  await new Promise((resolve) => setImmediate(resolve));

  const queued = statuses.find((value) => value.phase === 'queued');
  assert.deepEqual(queued.queue, {
    count: 2,
    items: [
      { id: queued.queue.items[0].id, status: 'sending', textPreview: 'first' },
      { id: queued.queue.items[1].id, status: 'queued', textPreview: 'second message' },
    ],
  });
  assert.deepEqual(send.getQueueState('s-queued'), queued.queue);
  releaseFirstRead();
  await Promise.all([first, second]);
  assert.deepEqual(h.sent.map((entry) => entry.text), ['first', '\r', 'second message', '\r']);
  assert.deepEqual(send.getQueueState('s-queued'), { count: 0, items: [] });
});

test('a queued message can be explicitly cancelled before FIFO drain sends it', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let releaseFirstRead;
  const firstRead = new Promise((resolve) => { releaseFirstRead = resolve; });
  let reads = 0;
  h.deps.readPane = async () => {
    reads += 1;
    if (reads === 1) await firstRead;
    return 'conversation\n❯';
  };
  const send = createSessionSend(h.deps);
  const statuses = [];
  send.emitter.on('status', (value) => statuses.push(value));

  const first = send.send({ sessionId: 's-cancel', text: 'first', pane: { paneId: 'pane-1' } });
  await new Promise((resolve) => setImmediate(resolve));
  const second = send.send({ sessionId: 's-cancel', text: 'never send me', pane: { paneId: 'pane-1' } });
  await new Promise((resolve) => setImmediate(resolve));
  const queuedId = send.getQueueState('s-cancel').items.find((item) => item.status === 'queued').id;

  assert.deepEqual(send.cancelQueued('s-cancel', queuedId), { ok: true, cancelledId: queuedId });
  assert.deepEqual(await second, { ok: true, cancelled: true, sendId: queuedId });
  assert.equal(statuses.at(-1).phase, 'cancelled');
  assert.equal(statuses.at(-1).detail, 'Queued message cancelled');
  assert.equal(statuses.at(-1).queue.items.some((item) => item.id === queuedId), false);

  releaseFirstRead();
  await first;
  assert.deepEqual(h.sent.map((entry) => entry.text), ['first', '\r']);
});

test('the sending queue item cannot be cancelled', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let releaseRead;
  const blockedRead = new Promise((resolve) => { releaseRead = resolve; });
  h.deps.readPane = async () => {
    await blockedRead;
    return 'conversation\n❯';
  };
  const send = createSessionSend(h.deps);
  const active = send.send({ sessionId: 's-active', text: 'in flight', pane: { paneId: 'pane-1' } });
  await new Promise((resolve) => setImmediate(resolve));
  const sendingItem = send.getQueueState('s-active').items.find((item) => item.status === 'sending');

  assert.ok(sendingItem);
  assert.deepEqual(send.cancelQueued('s-active', sendingItem.id), {
    ok: false,
    reason: 'message is already sending',
  });

  releaseRead();
  await active;
});

test('a genuine delivery failure surfaces honestly and does not lose the queued item', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let releaseFirstRead;
  const firstRead = new Promise((resolve) => { releaseFirstRead = resolve; });
  let reads = 0;
  h.deps.readPane = async () => {
    reads += 1;
    if (reads === 1) await firstRead;
    return 'conversation\n❯';
  };
  const realSendInput = h.deps.terminalBridge.sendInput;
  let failFirst = true;
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    if (text === 'first fails' && failFirst) {
      failFirst = false;
      throw new Error('terminal write failed');
    }
    return realSendInput(paneId, text);
  };
  const send = createSessionSend(h.deps);
  const statuses = [];
  send.emitter.on('status', (value) => statuses.push(value));

  const first = send.send({ sessionId: 's-failure-queue', text: 'first fails', pane: { paneId: 'pane-1' } });
  await new Promise((resolve) => setImmediate(resolve));
  const second = send.send({ sessionId: 's-failure-queue', text: 'second survives', pane: { paneId: 'pane-1' } });
  releaseFirstRead();

  await assert.rejects(first, /terminal write failed/);
  assert.equal((await second).ok, true);
  assert.ok(statuses.some((value) => value.phase === 'error' && value.detail === 'terminal write failed'));
  assert.deepEqual(h.sent.map((entry) => entry.text), ['second survives', '\r']);
});

test('a dead renderer-passed pane falls through to the resume path', async () => {
  // Renderer claims pane-dead exists; the snapshot says otherwise.
  const h = makeHarness({ panes: ['pane-other'] });
  h.deps.readPane = async () => '──────\n❯\n──────';
  const send = createSessionSend(h.deps);
  const res = await send.send({
    sessionId: 's7',
    text: 'do not eat this message',
    pane: { paneId: 'pane-dead', workspaceId: 'ws-1' },
  });
  assert.equal(res.resumed, true, 'resumed instead of writing to a ghost pane');
  assert.deepEqual(h.sent.map((s) => s.text), ['do not eat this message', '\r']);
});

test('queued sends prefer the fresh session link over their stale offered dead pane', async () => {
  const h = makeHarness({
    panes: [{ pane_id: 'pane-dead', workspace_id: 'ws-1', agent_session: { kind: 'id', value: 's-queued-dead' } }],
  });
  h.deps.readPane = async (paneId) => (
    paneId === 'pane-dead' ? CRASHED_SHELL_SCREEN : '──────\n❯\n──────'
  );
  const send = createSessionSend(h.deps);

  const stalePane = { paneId: 'pane-dead', workspaceId: 'ws-1' };
  const [first, second] = await Promise.all([
    send.send({ sessionId: 's-queued-dead', text: 'first', pane: stalePane }),
    send.send({ sessionId: 's-queued-dead', text: 'second', pane: stalePane }),
  ]);

  assert.equal(first.resumed, true);
  assert.equal(second.paneId, 'pane-fresh');
  assert.equal(h.resumeCalls.length, 1, 'the stale queued payload cannot launch a second writer');
  assert.deepEqual(h.sent.map(({ paneId, text }) => [paneId, text]), [
    ['pane-fresh', 'first'],
    ['pane-fresh', '\r'],
    ['pane-fresh', 'second'],
    ['pane-fresh', '\r'],
  ]);
});

test('a blocking dialog on screen refuses the send and keeps the text', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => 'some conversation\n\nDo you want to make this edit?\n  1. Yes\n  2. No';
  const send = createSessionSend(h.deps);
  await assert.rejects(
    () => send.send({ sessionId: 's8', text: 'my precious message', pane: { paneId: 'pane-1' } }),
    /showing a prompt/,
  );
  assert.deepEqual(h.sent, [], 'no bytes were fired into the dialog');
});

test('an interactive select menu refuses the send and points at the in-window question card', async () => {
  // Regression: a session parked on a numbered choice menu drew "❯ 1. …" on the
  // highlighted row, so the composer-glyph check passed it as safe and Harbor
  // typed the message + Enter INTO the menu, and the text vanished and the send
  // reported the confusing "could not confirm the message reached the session".
  // The "Enter to select … to navigate" footer must be caught first; and since
  // the menu is answerable in the window's question card, the refusal points
  // there, not at the raw terminal.
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => [
    'How should sibling folders be iconed?',
    '❯ 1. Shared icon family',
    '  2. Distinct logo for each',
    '  3. Type something.',
    '──────────────────────────────',
    '  4. Chat about this',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ].join('\n');
  const send = createSessionSend(h.deps);
  await assert.rejects(
    () => send.send({ sessionId: 's-menu', text: 'answer me instead', pane: { paneId: 'pane-1' } }),
    /asking a question in its window/,
  );
  assert.deepEqual(h.sent, [], 'no bytes were fired into the menu');
});

test('a hook permission dialog refuses the send and points at the in-window question card', async () => {
  // Real shape live-caught 2026-07-20: a PreToolUse hook confirmation with the
  // "Esc to cancel · Tab to amend · ctrl+e to explain" footer. The first Q/A
  // build only knew the "Enter to select" footer, so this screen refused the
  // send AND rendered no card: a dead end from the GUI.
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => [
    ' Hook PreToolUse:Bash requires confirmation for',
    ' this command:',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel · Tab to amend · ctrl+e to explain',
  ].join('\n');
  const send = createSessionSend(h.deps);
  await assert.rejects(
    () => send.send({ sessionId: 's-hook', text: 'my kept message', pane: { paneId: 'pane-1' } }),
    /asking a question in its window/,
  );
  assert.deepEqual(h.sent, [], 'no bytes were fired into the dialog');
});

test('getMenu parses a live menu; answerMenu drives the highlight and selects', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let highlight = 1;
  const render = () => [
    'Pick an option',
    `${highlight === 1 ? '❯' : ' '} 1. First`,
    `${highlight === 2 ? '❯' : ' '} 2. Second`,
    `${highlight === 3 ? '❯' : ' '} 3. Third`,
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
  h.deps.readPane = async () => render();
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    h.sent.push({ paneId, text });
    if (text === '\x1b[B') highlight = Math.min(3, highlight + 1);
    if (text === '\x1b[A') highlight = Math.max(1, highlight - 1);
    return { ok: true };
  };
  closesOnEnter(h);
  const send = createSessionSend(h.deps);

  const menu = await send.getMenu({ pane: { paneId: 'pane-1' } });
  assert.equal(menu.options.length, 3);
  assert.equal(menu.selectedIndex, 0);

  const res = await send.answerMenu({
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
    action: { type: 'select', index: 3 },
  });
  assert.equal(res.ok, true);
  const keys = h.sent.map((s) => s.text);
  assert.equal(keys.filter((k) => k === '\x1b[B').length, 2, 'two downs to move 1 -> 3');
  assert.equal(keys.at(-1), '\r', 'Enter selects the landed option');
});

test('answerMenu cancel sends Esc and never a stray Enter', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => 'Pick\n❯ 1. A\n  2. B\nEnter to select · ↑/↓ to navigate · Esc to cancel';
  const send = createSessionSend(h.deps);
  const res = await send.answerMenu({ pane: { paneId: 'pane-1' }, action: { type: 'cancel' } });
  assert.equal(res.ok, true);
  assert.deepEqual(h.sent.map((s) => s.text), ['\x1b']);
});

test('auto-mode outside read can select allow once without changing the answer number', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const labels = [
    'Yes, and keep allowing any reads outside the working directories',
    'No, and block reads outside the working directories from now on',
    'No, and ask again next time',
    'Yes, but ask again next time',
  ];
  let highlight = 1;
  let answered = null;
  h.deps.readPane = async () => answered === null ? [
    'Read outside the working directories',
    'Allow this read outside the working directories?',
    ...labels.map((label, i) => `${highlight === i + 1 ? '❯' : ' '} ${i + 1}. ${label}`),
    'Enter to select · Esc to cancel',
  ].join('\n') : 'conversation\n──────────\n❯\n──────────';
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    h.sent.push({ paneId, text });
    if (text === '\x1b[B') highlight = Math.min(4, highlight + 1);
    if (text === '\x1b[A') highlight = Math.max(1, highlight - 1);
    if (text === '\r') answered = highlight;
    return { ok: true };
  };
  const send = createSessionSend(h.deps);
  const menu = await send.getMenu({ pane: { paneId: 'pane-1' } });
  assert.deepEqual(menu.options.map(({ index, label }) => ({ index, label })),
    labels.map((label, i) => ({ index: i + 1, label })));
  const result = await send.answerMenu({
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' }, action: { type: 'select', index: 4 },
  });
  assert.equal(result.ok, true);
  assert.equal(answered, 4, 'the new allow-once answer is selected, never the persistent allow');
  assert.equal(h.sent.filter(({ text }) => text === '\r').length, 1);
});

test('getMenu returns null when the pane is a normal composer', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => 'conversation\n──────\n❯\n──────';
  const send = createSessionSend(h.deps);
  assert.equal(await send.getMenu({ pane: { paneId: 'pane-1' } }), null);
});

const MODEL_SWITCH_DIALOG = [
  'Switching to Haiku 4.5 means the full history gets re-read on your next message.',
  '1. Yes',
  '2. No',
].join('\n');

test('Claude /model answers a post-send full-history confirmation with 1 then Enter', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const panes = [
    'conversation\n❯',
    MODEL_SWITCH_DIALOG,
    'conversation\n❯',
  ];
  h.deps.readPane = async () => panes.shift() ?? 'conversation\n❯';
  const send = createSessionSend(h.deps);

  await send.send({
    sessionId: 's-model-dialog',
    text: '/model haiku',
    provider: 'claude',
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });

  assert.deepEqual(h.sent.map(({ text }) => text), ['/model ', 'haiku', '\r', '1', '\r']);
});

test('Claude /effort handles the same post-send full-history confirmation', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const panes = ['conversation\n❯', MODEL_SWITCH_DIALOG, 'conversation\n❯'];
  h.deps.readPane = async () => panes.shift() ?? 'conversation\n❯';
  const send = createSessionSend(h.deps);

  await send.send({
    sessionId: 's-effort-dialog',
    text: '/effort low',
    provider: 'claude',
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });

  assert.deepEqual(h.sent.map(({ text }) => text), ['/effort ', 'low', '\r', '1', '\r']);
});

test('Claude /model leaves input untouched when no post-send confirmation appears', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => 'conversation\n❯';
  const send = createSessionSend(h.deps);

  await send.send({
    sessionId: 's-model-no-dialog',
    text: '/model haiku',
    provider: 'claude',
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });

  assert.deepEqual(h.sent.map(({ text }) => text), ['/model ', 'haiku', '\r']);
});

test('Claude /model refuses honestly when its post-send confirmation does not clear', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let reads = 0;
  h.deps.readPane = async () => (++reads === 1 ? 'conversation\n❯' : MODEL_SWITCH_DIALOG);
  const send = createSessionSend(h.deps);

  await assert.rejects(
    () => send.send({
      sessionId: 's-model-stuck-dialog',
      text: '/model haiku',
      provider: 'claude',
      pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
    }),
    /could not confirm the Claude model\/effort switch/,
  );
  assert.deepEqual(h.sent.map(({ text }) => text), ['/model ', 'haiku', '\r', '1', '\r']);
});

test('non-Claude /model never auto-answers a matching pane dialog', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const panes = ['conversation\n❯', MODEL_SWITCH_DIALOG];
  h.deps.readPane = async () => panes.shift() ?? MODEL_SWITCH_DIALOG;
  const send = createSessionSend(h.deps);

  await send.send({
    sessionId: 's-codex-model-dialog',
    text: '/model haiku',
    provider: 'codex',
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });

  assert.deepEqual(h.sent.map(({ text }) => text), ['/model ', 'haiku', '\r']);
});

test('delivery reports sent immediately while transcript confirmation reconciles in background', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 't.jsonl');
  await fsp.writeFile(file, '');
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => '──────\n❯\n──────';
  h.deps.getSessionMeta = async () => ({ cwd: '/x', path: file });
  const send = createSessionSend(h.deps);
  setTimeout(() => {
    fsp.appendFile(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'confirm me please' } }) + '\n');
  }, 500);
  const started = Date.now();
  const res = await send.send({ sessionId: 's9', text: 'confirm me please', pane: { paneId: 'pane-1' } });
  assert.equal(res.delivery, 'confirming');
  assert.ok(Date.now() - started < 400, 'send completion did not wait for transcript confirmation');
  await new Promise((resolve) => setTimeout(resolve, 550));
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a busy-session queue-operation enqueue confirms delivery without a false error', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 't.jsonl');
  await fsp.writeFile(file, '');
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => '──────\n❯\n──────';
  h.deps.getSessionMeta = async () => ({ cwd: '/x', path: file });
  process.env.HARBOR_CONFIRM_TIMEOUT_MS = '400';
  try {
    const send = createSessionSend(h.deps);
    const statuses = [];
    send.emitter.on('status', (value) => statuses.push(value));
    const res = await send.send({
      sessionId: 's-busy',
      text: 'please   queue\nthis',
      pane: { paneId: 'pane-1' },
    });
    assert.equal(res.delivery, 'confirming');
    await fsp.appendFile(file, `${JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content: 'please queue this',
    })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(statuses.at(-1).phase, 'sent');
  } finally {
    delete process.env.HARBOR_CONFIRM_TIMEOUT_MS;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('confirmNeedle: slash commands confirm against the command-name XML form, not the literal', () => {
  const h = makeHarness({ panes: ['pane-1'] });
  const send = createSessionSend(h.deps);
  assert.equal(send.confirmNeedle('/model haiku'), '<command-name>/model</command-name>');
  assert.equal(send.confirmNeedle('/effort xhigh'), '<command-name>/effort</command-name>');
  assert.equal(send.confirmNeedle('  /clear'), '<command-name>/clear</command-name>');
  // Plain text still confirms against its own literal.
  assert.equal(send.confirmNeedle('run the tests'), 'run the tests');
});

test('a /model send confirms against the transcript command-name form (the silent-switch fix)', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 't.jsonl');
  await fsp.writeFile(file, '');
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => '──────\n❯\n──────';
  h.deps.getSessionMeta = async () => ({ cwd: '/x', path: file });
  const send = createSessionSend(h.deps);
  // The CLI logs a /model command as its XML form, NOT the literal "/model haiku".
  setTimeout(() => {
    fsp.appendFile(file, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '<command-name>/model</command-name>\n<command-args>haiku</command-args>' },
    }) + '\n');
  }, 400);
  const res = await send.send({ sessionId: 's-model', text: '/model haiku', pane: { paneId: 'pane-1' } });
  assert.equal(res.delivery, 'confirming');
  await new Promise((resolve) => setTimeout(resolve, 550));
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a /model that writes NO confirmable transcript event resolves as requested, never a false failure', async () => {
  // The current CLI writes nothing confirmable for a bare /model; the send must
  // still succeed ("requested") instead of surfacing a spurious send failure.
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 't.jsonl');
  await fsp.writeFile(file, '');
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => '──────\n❯\n──────';
  h.deps.getSessionMeta = async () => ({ cwd: '/x', path: file });
  process.env.HARBOR_CONFIRM_TIMEOUT_MS = '400';
  try {
    const send = createSessionSend(h.deps);
    const statuses = [];
    send.emitter.on('status', (s) => statuses.push(s.phase));
    const res = await send.send({ sessionId: 's-req', text: '/model haiku', pane: { paneId: 'pane-1' } });
    assert.equal(res.ok, true);
    assert.equal(res.delivery, 'confirming');
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(statuses.at(-1), 'sent', 'ends on sent, never error');
    assert.deepEqual(h.sent.map((s) => s.text), ['/model ', 'haiku', '\r'], 'command token and args are delivered separately');
  } finally {
    delete process.env.HARBOR_CONFIRM_TIMEOUT_MS;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a real message that never lands becomes a background error (slash leniency does not weaken messages)', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 't.jsonl');
  await fsp.writeFile(file, '');
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => '──────\n❯\n──────';
  h.deps.getSessionMeta = async () => ({ cwd: '/x', path: file });
  process.env.HARBOR_CONFIRM_TIMEOUT_MS = '400';
  try {
    const send = createSessionSend(h.deps);
    const errors = [];
    send.emitter.on('status', (value) => {
      if (value.phase === 'error') errors.push(value);
    });
    const result = await send.send({ sessionId: 's-msg', text: 'a normal message', pane: { paneId: 'pane-1' } });
    assert.equal(result.delivery, 'confirming');
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.match(errors.at(-1).detail, /could not confirm/);
  } finally {
    delete process.env.HARBOR_CONFIRM_TIMEOUT_MS;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// Live-caught 2026-10-09 (send log 19:18:08Z): "continue" reached a busy 28MB
// session two minutes after the confirm window closed, and the "could not
// confirm" error stayed in the status bar for an hour. A late landing must
// replace the error.
test('a message that lands after the confirm window clears the error', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 't.jsonl');
  await fsp.writeFile(file, '');
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => '──────\n❯\n──────';
  h.deps.getSessionMeta = async () => ({ cwd: '/x', path: file });
  process.env.HARBOR_CONFIRM_TIMEOUT_MS = '300';
  process.env.HARBOR_LATE_CONFIRM_MS = '8000';
  try {
    const send = createSessionSend(h.deps);
    const statuses = [];
    send.emitter.on('status', (value) => statuses.push(value));
    await send.send({ sessionId: 's-late', text: 'continue', pane: { paneId: 'pane-1' } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(statuses.at(-1).phase, 'error');
    await fsp.appendFile(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'continue' } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    assert.equal(statuses.at(-1).phase, 'sent');
    assert.match(statuses.at(-1).detail, /reached the session after all/);
  } finally {
    delete process.env.HARBOR_CONFIRM_TIMEOUT_MS;
    delete process.env.HARBOR_LATE_CONFIRM_MS;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a late landing never overwrites a newer status for the same session', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 't.jsonl');
  await fsp.writeFile(file, '');
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => '──────\n❯\n──────';
  h.deps.getSessionMeta = async () => ({ cwd: '/x', path: file });
  process.env.HARBOR_CONFIRM_TIMEOUT_MS = '300';
  process.env.HARBOR_LATE_CONFIRM_MS = '8000';
  try {
    const send = createSessionSend(h.deps);
    const statuses = [];
    send.emitter.on('status', (value) => statuses.push(value));
    await send.send({ sessionId: 's-late2', text: 'first message', pane: { paneId: 'pane-1' } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(statuses.at(-1).phase, 'error');
    // A newer send for the same session says something new before the first lands.
    await send.send({ sessionId: 's-late2', text: 'second message', pane: { paneId: 'pane-1' } });
    await fsp.appendFile(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'first message' } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    assert.ok(
      !statuses.some((s) => /reached the session after all/.test(s.detail || '')),
      'the superseded watcher stayed quiet',
    );
  } finally {
    delete process.env.HARBOR_CONFIRM_TIMEOUT_MS;
    delete process.env.HARBOR_LATE_CONFIRM_MS;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('confirmation finds a queued message written after more than 1MB of other output', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 't.jsonl');
  await fsp.writeFile(file, '');
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => '──────\n❯\n──────';
  h.deps.getSessionMeta = async () => ({ cwd: '/x', path: file });
  process.env.HARBOR_CONFIRM_TIMEOUT_MS = '600';
  try {
    const send = createSessionSend(h.deps);
    const statuses = [];
    send.emitter.on('status', (value) => statuses.push(value));
    await send.send({ sessionId: 's-big', text: 'café latté please', pane: { paneId: 'pane-1' } });
    // A screenshot-sized tool result lands first, then the queued message.
    const screenshot = JSON.stringify({ type: 'user', message: { content: [{ type: 'image', data: 'A'.repeat(1_500_000) }] } });
    await fsp.appendFile(file, `${screenshot}\n${JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content: 'café latté please',
    })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(statuses.at(-1).phase, 'sent');
  } finally {
    delete process.env.HARBOR_CONFIRM_TIMEOUT_MS;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('readPermissionMode scrapes the composer footer honestly', async () => {
  const h = makeHarness({ panes: ['pane-1'] });
  const frames = { pane: '' };
  h.deps.readPane = async () => frames.pane;
  const send = createSessionSend(h.deps);

  frames.pane = 'conversation\n\n❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
  assert.deepEqual(await send.readPermissionMode('pane-1'), { mode: 'bypass' });
  frames.pane = 'conversation\n\n❯ \n  plan mode on (shift+tab to cycle)';
  assert.deepEqual(await send.readPermissionMode('pane-1'), { mode: 'plan' });
  frames.pane = 'conversation\n\n❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)';
  assert.deepEqual(await send.readPermissionMode('pane-1'), { mode: 'accept-edits' });
  frames.pane = 'conversation\n\n❯ \n  ⏵⏵ auto mode on (shift+tab to cycle)';
  assert.deepEqual(await send.readPermissionMode('pane-1'), { mode: 'auto' });
  frames.pane = 'conversation\n\n❯ ';
  assert.deepEqual(await send.readPermissionMode('pane-1'), { mode: 'default' });
  frames.pane = '';
  assert.deepEqual(await send.readPermissionMode('pane-1'), { mode: null });
});

test('cyclePermissionMode sends shift+tab then re-scrapes the landed mode', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let scrapeAfter = false;
  h.deps.readPane = async () => (scrapeAfter ? 'x\n  plan mode on (shift+tab to cycle)' : 'x\n  ❯ ');
  const send = createSessionSend(h.deps);
  // The send of ESC[Z flips the footer; model the flip on the input event.
  const realSend = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => { if (text === '\x1b[Z') scrapeAfter = true; return realSend(paneId, text); };
  const res = await send.cyclePermissionMode('pane-1', 'ws-1');
  assert.deepEqual(res, { mode: 'plan' });
  assert.ok(h.sent.some((s) => s.text === '\x1b[Z'), 'shift+tab (ESC [ Z) was sent');
});

test('unconfirmed optimistic delivery emits an honest error, never a silent failure', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 't.jsonl');
  await fsp.writeFile(file, '');
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => '──────\n❯\n──────';
  h.deps.getSessionMeta = async () => ({ cwd: '/x', path: file });
  process.env.HARBOR_CONFIRM_TIMEOUT_MS = '400';
  try {
    const send = createSessionSend(h.deps);
    const statuses = [];
    send.emitter.on('status', (value) => statuses.push(value));
    const result = await send.send({ sessionId: 's10', text: 'this never lands', pane: { paneId: 'pane-1' } });
    assert.equal(result.delivery, 'confirming');
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(statuses.at(-1).phase, 'error');
    assert.match(statuses.at(-1).detail, /could not confirm/);
  } finally {
    delete process.env.HARBOR_CONFIRM_TIMEOUT_MS;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('answerMenu drives a clipped menu: pointer off-screen, walk lands by option number', async () => {
  // Live-caught 2026-07-21 (pane wC:pC): the question, option 1, and the "❯"
  // pointer sit above the pty viewport. The first ↓ brings the pointer into
  // the visible run; the walk must land on the requested option NUMBER.
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let highlight = 1; // option 1 lives above the viewport with the question
  const render = () => [
    "     tail of option 1's clipped description",
    `${highlight === 2 ? '❯' : ' '} 2. Hand-build it now`,
    `${highlight === 3 ? '❯' : ' '} 3. Re-run it in the tool`,
    `${highlight === 4 ? '❯' : ' '} 4. Type something.`,
    '──────────────────────────────────────────────────',
    `${highlight === 5 ? '❯' : ' '} 5. Chat about this`,
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
  h.deps.readPane = async () => render();
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    h.sent.push({ paneId, text });
    if (text === '\x1b[B') highlight = Math.min(5, highlight + 1);
    if (text === '\x1b[A') highlight = Math.max(1, highlight - 1);
    return { ok: true };
  };
  closesOnEnter(h);
  const send = createSessionSend(h.deps);
  const res = await send.answerMenu({
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
    action: { type: 'select', index: 3 },
  });
  assert.equal(res.ok, true);
  const keys = h.sent.map((s) => s.text);
  assert.equal(keys.filter((k) => k === '\x1b[B').length, 2, 'reveal at 2, then step to 3');
  assert.equal(keys.at(-1), '\r', 'Enter fires only after ❯ verified on option 3');
  assert.equal(highlight, 3, 'the pty highlight is on option 3 when Enter lands');
});

// The root cause of every "the question scrolled out of the terminal view"
// report, measured 2026-07-27: herdr hands out 23-row x 54-column panes and
// Claude's AskUserQuestion dialog needs about 35 rows at that width, so the
// question and option 1 scroll off a screen that keeps no scrollback. The card
// therefore grows the pane the first time it polls one, which is within a
// second of the window opening and long before Claude asks anything.
test('opening a window sizes its pane so a dialog can fit in it', async () => {
  const h = makeHarness({ panes: ['pane-1'] });
  h.deps.readPane = async () => '';
  const send = createSessionSend(h.deps);
  await send.getMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.deepEqual(h.sized, [{ paneId: 'pane-1', force: false }]);
});

test('a dialog that still comes back clipped makes Harbor size the pane again', async () => {
  // Ink redraws on SIGWINCH, proven on a real dialog: growing the pty while the
  // dialog is already up makes Claude repaint the whole thing, question and
  // option 1 included. So a clipped read is not a thing to describe to Pat, it
  // is a thing to fix, and this is the retry that fixes it in place.
  const h = makeHarness({ panes: ['pane-1'] });
  h.deps.readPane = async () => [
    "     tail of option 1's clipped description",
    '  2. Local RUNBOOK step only',
    '  3. Both: CI, plus a one-command local script',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
  const send = createSessionSend(h.deps);
  const menu = await send.getMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.equal(menu.clipped, true, 'the read really was clipped');
  assert.deepEqual(h.sized, [
    { paneId: 'pane-1', force: false },
    { paneId: 'pane-1', force: true },
  ]);
});

// An option the pane has scrolled above its own viewport is REACHED, not
// refused (2026-07-27). It used to be refused on the grounds that the "❯"
// cannot be verified on a row the pane does not draw. That reasoning is still
// exactly right, and it is why the walk keys on the option NUMBER and re-reads
// after every keystroke: it steps the highlight up until the row scrolls into
// view and only then presses Enter. Refusing outright just meant Pat did the
// arrowing himself on a card that was already showing him the option.
test('answerMenu walks up to an option the viewport had scrolled off the top', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  // A 3-row window over a 5-row menu, starting scrolled past option 1. Moving
  // the highlight scrolls the window, exactly as the CLI does.
  let highlight = 2;
  let top = 2;
  const render = () => {
    const rows = [];
    for (let i = top; i < top + 2; i += 1) rows.push(`${highlight === i ? '❯' : ' '} ${i}. Option ${i}`);
    return [
      "     tail of option 1's clipped description",
      ...rows,
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
  };
  h.deps.readPane = async () => render();
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    h.sent.push({ paneId, text });
    if (text === '\x1b[A') highlight = Math.max(1, highlight - 1);
    if (text === '\x1b[B') highlight = Math.min(3, highlight + 1);
    top = Math.min(Math.max(1, highlight), 2); // the window follows the highlight
    return { ok: true };
  };
  closesOnEnter(h);
  const send = createSessionSend(h.deps);
  const res = await send.answerMenu({
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
    action: { type: 'select', index: 1 },
  });
  assert.equal(res.ok, true, 'the clipped option is reachable');
  assert.equal(h.sent.at(-1).text, '\r', 'Enter lands last');
  assert.equal(highlight, 1, 'and it lands on the option that was asked for');
});

test('answerMenu never presses Enter on an option it cannot get the highlight onto', async () => {
  // Same clipped shape, but a pane that will NOT scroll: the highlight can
  // never be seen on option 1, so the answer fails out loud rather than firing
  // a blind Enter on whatever row the terminal happens to be sitting on.
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => [
    "     tail of option 1's clipped description",
    '❯ 2. Hand-build it now',
    '  3. Re-run it in the tool',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
  const send = createSessionSend(h.deps);
  const res = await send.answerMenu({
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
    action: { type: 'select', index: 1 },
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /could not move the menu highlight/);
  assert.ok(!h.sent.some((s) => s.text === '\r'), 'no Enter is ever fired blind');
});

test('answerMenu still refuses an option number the menu does not have at all', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => [
    'Pick one',
    '❯ 1. First',
    '  2. Second',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
  const send = createSessionSend(h.deps);
  const res = await send.answerMenu({
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
    action: { type: 'select', index: 7 },
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /not on the menu/);
  assert.ok(!h.sent.some((s) => s.text === '\r'), 'no Enter is ever fired blind');
});

test('answerMenu keeps its bearings when the list scrolls under the walk', async () => {
  // If the CLI scrolls the option list to keep the highlight visible, an
  // option's POSITION in the visible run shifts between reads. A walk that
  // compares positions computed from the first read presses Enter on the
  // wrong option; the walk must verify the option NUMBER under the "❯".
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let highlight = 1;
  const render = () => {
    const lo = Math.max(1, Math.min(highlight, 3)); // 3-row window follows the highlight
    const rows = [];
    for (let i = lo; i < lo + 3; i += 1) rows.push(`${highlight === i ? '❯' : ' '} ${i}. Option ${i}`);
    return ['Pick one', ...rows, 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
  };
  h.deps.readPane = async () => render();
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    h.sent.push({ paneId, text });
    if (text === '\x1b[B') highlight = Math.min(5, highlight + 1);
    if (text === '\x1b[A') highlight = Math.max(1, highlight - 1);
    return { ok: true };
  };
  closesOnEnter(h);
  const send = createSessionSend(h.deps);
  const res = await send.answerMenu({
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
    action: { type: 'select', index: 3 },
  });
  assert.equal(res.ok, true);
  assert.equal(highlight, 3, 'Enter landed on option 3, not a shifted position');
  assert.equal(h.sent.map((s) => s.text).at(-1), '\r');
});

// ---- structural guard (Pat mandate 2026-07-21): a blocked pane must NEVER
// be a dead end. Six dialog shapes were each fixed only after Pat hit them
// live; the guard inverts the design so an UNRECOGNIZED blocker still yields
// an answerable in-window panel (raw screen tail + direct keys) instead of
// nothing, and self-captures the screen as a fixture for the next parser fix.

test('getMenu falls back to the raw screen for a blocked shape the parser does not know', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => ' Compacting conversation history…\n (this may take a moment)';
  const send = createSessionSend(h.deps);
  const menu = await send.getMenu({ pane: { paneId: 'pane-1' } });
  assert.equal(menu.fallback, true);
  assert.ok(menu.screen.some((line) => line.includes('Compacting')), 'the raw tail is shown');
  assert.ok(!menu.options, 'a fallback is not a parsed menu');
});

test('getMenu falls back on a never-seen dialog shape when herdr says blocked', async () => {
  // Matches neither FOOTER_RE nor BLOCKED_RE: the shape Claude Code has not
  // invented yet. The engine-level blocked signal is shape-independent.
  const novel = [
    ' Continue the migration ritual?',
    ' (a) Absolutely   (b) Never mind',
    ' Choose a letter · ctrl+q aborts',
  ].join('\n');
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => novel;
  const send = createSessionSend(h.deps);
  assert.equal(await send.getMenu({ pane: { paneId: 'pane-1' } }), null, 'no signal, no card');
  const menu = await send.getMenu({ pane: { paneId: 'pane-1' }, blockedHint: true });
  assert.equal(menu.fallback, true, 'blocked + unrecognized = answerable fallback');
  assert.ok(menu.screen.some((line) => line.includes('migration ritual')));
});

test('getMenu never ghosts a fallback card over a healthy composer or working screen', async () => {
  // agent_status lags 60-150s, so a stale blockedHint over a recovered
  // session must not render dangerous keys over a normal composer.
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const send = createSessionSend(h.deps);
  for (const screen of [
    'prose\n──────\n❯\n──────\n  opus 4.8 xhigh',
    'prose\n✶ Baking… (esc to interrupt)',
  ]) {
    h.deps.readPane = async () => screen;
    assert.equal(await send.getMenu({ pane: { paneId: 'pane-1' }, blockedHint: true }), null);
  }
});

test('getMenu captures an unrecognized blocked screen once for the fixture pipeline', async () => {
  const os = require('node:os');
  const fsSync = require('node:fs');
  const captureDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'harbor-unrec-'));
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.captureDir = captureDir;
  h.deps.readPane = async () => ' Compacting conversation history…';
  const send = createSessionSend(h.deps);
  await send.getMenu({ pane: { paneId: 'pane-1' } });
  await send.getMenu({ pane: { paneId: 'pane-1' } });
  const files = fsSync.readdirSync(captureDir);
  assert.equal(files.length, 1, 'same screen captures once, not per poll');
  assert.match(fsSync.readFileSync(path.join(captureDir, files[0]), 'utf8'), /Compacting/);
});

test('answerMenu key actions drive an unparseable dialog directly, no implied Enter', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => ' Compacting conversation history…';
  const send = createSessionSend(h.deps);
  for (const [key, bytes] of [['down', '\x1b[B'], ['up', '\x1b[A'], ['space', ' '], ['esc', '\x1b']]) {
    const res = await send.answerMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' }, action: { type: 'key', key } });
    assert.equal(res.ok, true, `key ${key} lands without a parsed menu`);
    assert.equal(h.sent.at(-1).text, bytes);
  }
  assert.ok(!h.sent.some((s) => s.text === '\r'), 'no Enter unless explicitly pressed');
  const enter = await send.answerMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' }, action: { type: 'key', key: 'enter' } });
  assert.equal(enter.ok, true);
  assert.equal(h.sent.at(-1).text, '\r');
});

test('answerMenu raw text types the bytes verbatim with no implied Enter', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => ' Continue? (y/n)';
  const send = createSessionSend(h.deps);
  const res = await send.answerMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' }, action: { type: 'raw', text: 'y' } });
  assert.equal(res.ok, true);
  assert.deepEqual(h.sent.map((s) => s.text), ['y']);
});

test('getMenu fallback clears when the dialog resolved and its ghost sits in the scrollback tail', async () => {
  // Gate-caught 2026-07-21: after the dialog resolves, its "Do you want"
  // text lingers above the fresh shell prompt in a recent read and kept the
  // fallback panel alive. Live vs dead is decided by the TAIL: a resolution
  // tail (shell prompt, composer, working turn) means no panel, whatever
  // blocker text sits above it.
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => ' Do you want to continue?\n (a) yes (b) no\nPICKED:b\nuser@host:~/dev$';
  const send = createSessionSend(h.deps);
  assert.equal(await send.getMenu({ pane: { paneId: 'pane-1' } }), null);
  assert.equal(await send.getMenu({ pane: { paneId: 'pane-1' }, blockedHint: true }), null,
    'a lingering blocked status must not panel a shell prompt');
});

test('getMenu fallback survives a viewport resize that scrolls the dialog top off the visible grid', async () => {
  // Gate-caught 2026-07-21: linking a pane resizes it, and a one-shot dialog
  // does not redraw, so its opening lines live only in scrollback while the
  // dialog is STILL live (its footer is the tail). The classifier must read
  // the recent scrape, not the visible grid.
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => [
    ' Continue the migration ritual?',
    ' Do you want to continue?',
    ' (a) Absolutely   (b) Never mind',
    ' cursor:1',
    ' Choose a letter · ctrl+q aborts',
  ].join('\n');
  const send = createSessionSend(h.deps);
  const menu = await send.getMenu({ pane: { paneId: 'pane-1' } });
  assert.equal(menu?.fallback, true, 'a live dialog whose top scrolled off must still panel');
});

test('getMenu fallback ignores the blank rows a visible-screen read pads below a short dialog', async () => {
  // The visible source returns the full pane grid; a 5-line dialog sits above
  // ~19 empty rows, and a bottom-window scan of blanks sees nothing. Trim
  // trailing blank rows before classifying (isolate-caught 2026-07-21).
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => `${[
    ' Continue the migration ritual?',
    ' Do you want to continue?',
    ' (a) Absolutely   (b) Never mind',
    ' cursor:1',
    ' Choose a letter · ctrl+q aborts',
  ].join('\n')}${'\n'.repeat(19)}`;
  const send = createSessionSend(h.deps);
  const menu = await send.getMenu({ pane: { paneId: 'pane-1' } });
  assert.equal(menu?.fallback, true, 'blank grid rows must not hide the dialog from the classifier');
});

// Pat, 2026-07-25: "the resume functionality doesn't even work". A pane whose
// claude exited survives at a shell prompt with no agent_session, and
// resolvePane accepts an unnamed pane on purpose (agent detection lags
// 60-150s). resumeOnly then returned ok having done NOTHING: the button was
// genuinely dead, and silently so.
test('Resume on a pane whose CLI exited actually resumes instead of reporting a silent success', async () => {
  const h = makeHarness({
    panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', agent_session: { kind: 'id', value: 's-dead' } }],
    controlled: 'pane-1',
  });
  h.deps.readPane = async (paneId) => (paneId === 'pane-1' ? CRASHED_SHELL_SCREEN : '──────\n❯\n──────');
  const send = createSessionSend(h.deps);
  const res = await send.send({ sessionId: 's-dead', text: '', resumeOnly: true, pane: { paneId: 'pane-1' } });
  assert.equal(res.ok, true);
  assert.equal(res.resumed, true, 'a real resume ran');
  assert.notEqual(res.paneId, 'pane-1', 'the session moved off the dead pane');
  assert.equal(res.alreadyLive, undefined);
});

test('Resume on a genuinely live pane says so, instead of clearing to nothing', async () => {
  const h = makeHarness({
    panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', agent_session: { kind: 'id', value: 's-live' } }],
    controlled: 'pane-1',
  });
  h.deps.readPane = async () => '──────\n❯\n──────';
  const statuses = [];
  const send = createSessionSend(h.deps);
  send.emitter.on('status', (s) => statuses.push(s));
  const res = await send.send({ sessionId: 's-live', text: '', resumeOnly: true, pane: { paneId: 'pane-1' } });
  assert.equal(res.ok, true);
  assert.equal(res.alreadyLive, true);
  const terminal = statuses.filter((s) => s.phase === 'sent').pop();
  assert.ok(terminal?.detail, 'the terminal status carries a message the UI can show');
  assert.match(terminal.detail, /already live/);
});

// Measured against a real pane on 2026-07-27, right after Harbor grew it: a pty
// resize empties herdr's `recent` buffer, and a full-screen redraw writes over
// the screen without pushing one line into scrollback, so a dialog plainly on
// the screen can have zero recent bytes. Reading only `recent` would make the
// card vanish at exactly the moment the pane was fixed.
test('a menu is still read when the resize left the recent buffer empty', async () => {
  const h = makeHarness({ panes: ['pane-1'] });
  const asked = [];
  h.deps.readPane = async (paneId, lines, source = 'recent') => {
    asked.push(source);
    if (source === 'recent') return '';
    return [
      'Where should the per-office PDFs get generated each quarter?',
      '❯ 1. In the publish workflow',
      '  2. Local RUNBOOK step only',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
  };
  const send = createSessionSend(h.deps);
  const menu = await send.getMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.ok(menu, 'the visible grid still has the dialog');
  assert.equal(menu.question, 'Where should the per-office PDFs get generated each quarter?');
  assert.deepEqual(asked, ['recent', 'visible'], 'recent first, visible only as the fallback');
});

test('the recent scrape still wins when it has the dialog', async () => {
  const h = makeHarness({ panes: ['pane-1'] });
  const asked = [];
  h.deps.readPane = async (paneId, lines, source = 'recent') => {
    asked.push(source);
    return [
      'Pick one',
      '❯ 1. From the recent scrape',
      '  2. Second',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
  };
  const send = createSessionSend(h.deps);
  const menu = await send.getMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.equal(menu.options[0].label, 'From the recent scrape');
  assert.deepEqual(asked, ['recent'], 'no second read when the first one parses');
});

// Live-caught 2026-07-28, and the panel is worse than the dead end it replaced:
// Pat's window put "NEEDS YOUR ANSWER" over a session that was simply idle with
// a draft typed into it, hiding the composer behind a panel answering nothing.
// Two things had to be wrong at once, and both are pinned here.
const composerFixture = (name) => fs.readFileSync(
  path.join(__dirname, '../fixtures/composer-vs-dialog', name), 'utf8',
);

test('an idle session with a draft typed into it is not a question', async () => {
  const h = makeHarness({ panes: ['pane-1'] });
  h.deps.readPane = async () => composerFixture('idle-composer-with-draft.txt');
  const send = createSessionSend(h.deps);
  // Even with the engine-level blocked hint set, which is the stronger trigger.
  const menu = await send.getMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' }, blockedHint: true });
  assert.equal(menu, null, 'a composer with a draft in it is still a composer');
});

test("Claude's own prose asking \"do you want me to\" does not summon a panel", async () => {
  const h = makeHarness({ panes: ['pane-1'] });
  h.deps.readPane = async () => [
    '  Ready to dig in, or do you want me to dive deeper on',
    '  anything?',
    '',
    '  ✳ Worked for 3m 16s',
  ].join('\n');
  const send = createSessionSend(h.deps);
  assert.equal(await send.getMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }), null);
});

// The other direction, from a REAL capture of the same pane an hour later: the
// /rewind dialog's selected row is "❯ (current)", with no number and no chrome
// Harbor knows. Widening the composer test to "any ❯ line" would have made this
// unanswerable, which is the dead end the panel exists to prevent.
test('a dialog whose selected row starts with the pointer still gets a panel', async () => {
  const h = makeHarness({ panes: ['pane-1'] });
  h.deps.readPane = async () => composerFixture('rewind-dialog-pointer-row.txt');
  const send = createSessionSend(h.deps);
  const menu = await send.getMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' }, blockedHint: true });
  assert.ok(menu?.fallback, 'the rewind dialog is answerable in its window');
  assert.ok(menu.screen.join('\n').includes('Rewind'));
});

test('a real dialog question on its own line still counts as blocked', async () => {
  const h = makeHarness({ panes: ['pane-1'] });
  h.deps.readPane = async () => [
    ' Continue the migration ritual?',
    ' Do you want to continue?',
    ' (a) Absolutely   (b) Never mind',
    ' cursor:a',
    ' Choose a letter · ctrl+q aborts',
  ].join('\n');
  const send = createSessionSend(h.deps);
  const menu = await send.getMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.ok(menu?.fallback, 'an unrecognized dialog is never a dead end');
});

// ---- the dead end from the OTHER side (live-caught 2026-08-02) -------------
// Pat's send refused with "the session is showing a prompt Harbor cannot fully
// read; use the answer panel in its window" while the window showed an ordinary
// idle session, "ready", and no panel to answer. Two causes, both pinned here.
//
// The trigger was Claude's own "※ recap" line saying the next step is
// "compacting": BLOCKED_CHROME_RE matched that word MID-SENTENCE, exactly the
// way "Do you want" used to match Claude's prose before it was anchored on
// 2026-07-28. A session near its context limit talks about compacting
// constantly, which is precisely when it happens. Real bytes from the pane he
// was locked out of (`herdr pane.read`, 16 lines, recent, strip_ansi).
test('Claude\'s recap saying the next step is "compacting" is prose, not a blocker', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => composerFixture('idle-composer-recap-mentions-compacting.txt');
  const send = createSessionSend(h.deps);
  const res = await send.send({ sessionId: 's-recap', text: 'push it', pane: { paneId: 'pane-1' } });
  assert.equal(res.ok, true, 'an idle composer accepts the send');
  assert.deepEqual(h.sent.map((s) => s.text), ['push it', '\r']);
});

// A compaction that is actually RUNNING still blocks, so anchoring the chrome
// cannot be "solved" by deleting it. Two-sided on purpose.
test('a compaction actually running still refuses the send', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => ' Compacting conversation history…\n (this may take a moment)';
  const send = createSessionSend(h.deps);
  await assert.rejects(
    () => send.send({ sessionId: 's-compacting', text: 'kept', pane: { paneId: 'pane-1' } }),
    /showing a prompt/,
  );
  assert.deepEqual(h.sent, [], 'no bytes were fired into the compaction');
});

// The structural half, and the one that makes the next unanchored word or new
// dialog shape a false positive instead of a lockout: the send refusal and the
// in-window card are now ONE decision, so a refusal always leaves something to
// answer and a screen with nothing to answer always accepts the send. The two
// used to be separate code reading different windows of different reads, which
// is how a refusal with no panel was even expressible.
for (const status of [
  'Continuing automatically at 3:00 PM · esc to cancel',
  'Usage limit reached · continuing automatically at 3:00 PM · esc to cancel',
  'Usage limit reached again · continuing automatically at 3:00 PM · esc to cancel',
  'Continuing shortly · esc to cancel',
  'opening… · esc to cancel',
  'Waiting for the next response. Press esc to cancel the wait.',
]) {
  test(`lowercase cancel status accepts sends without a composer in the tail: ${status}`, async () => {
    const screen = ['Earlier response', '❯', ...Array(9).fill('Status detail'), status].join('\n');
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    h.deps.readPane = async () => screen;
    const send = createSessionSend(h.deps);
    const card = await send.getMenu({ pane: { paneId: 'pane-1' } });
    const result = await send.send({ sessionId: 'status-example', text: 'continue with this', pane: { paneId: 'pane-1' } })
      .catch(error => ({ ok: false, error: error.message }));
    assert.equal(result.ok, true, result.error);
    assert.equal(card, null, 'a status line must not create a fallback card without a daemon hint');
    assert.deepEqual(h.sent.map(s => s.text), ['continue with this', '\r']);
  });
}

test('MCP URL and form prompts refuse sends and remain answerable without a daemon hint', async () => {
  const screens = [
    'MCP server "example" wants to open a URL\n\nhttps://example.invalid/confirm\n\n  ❯ Open in browser   I\'m done, continue   Decline\n\nEsc to cancel · ←/→ to switch',
    'MCP server "example" waiting for completion\n\nhttps://example.invalid/confirm\nWaiting for the server to confirm completion\n  ❯ Reopen URL   Continue without waiting\n\nEsc to cancel · ←/→ to switch',
    'MCP server "example" requests your input\nName: sample\n  ❯ Accept   Decline\n\nEsc to cancel · ↑/↓ to navigate',
  ];
  for (const screen of screens) {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    let current = screen;
    h.deps.readPane = async () => current;
    const send = createSessionSend(h.deps);
    assert.equal((await send.getMenu({ pane: { paneId: 'pane-1' } }))?.fallback, true);
    await assert.rejects(() => send.send({ sessionId: 'mcp-example', text: 'keep this', pane: { paneId: 'pane-1' } }), /showing a prompt/);
    assert.deepEqual(h.sent, []);
    for (const key of ['right', 'left', 'enter', 'esc']) {
      assert.equal((await send.answerMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' }, action: { type: 'key', key } })).ok, true);
    }
    assert.deepEqual(h.sent.map(s => s.text), ['\x1b[C', '\x1b[D', '\r', '\x1b']);
    current = `${screen}\n\n${'─'.repeat(80)}\n❯\n${'─'.repeat(80)}`;
    assert.equal(await send.getMenu({ pane: { paneId: 'pane-1' }, blockedHint: true }), null, 'resolved dialog never ghosts the composer');
  }
});

test('a send is refused if and only if the window has something to answer', async () => {
  const cases = [
    ['idle composer whose prose mentions compacting',
      () => composerFixture('idle-composer-recap-mentions-compacting.txt')],
    ['idle composer with a draft typed into it',
      () => composerFixture('idle-composer-with-draft.txt')],
    ['Claude prose asking "do you want me to"',
      () => '  Ready to dig in, or do you want me to dive deeper on\n  anything?\n\n  ✳ Worked for 3m 16s'],
    ['a resolved dialog ghost above a fresh shell prompt',
      () => ' Do you want to continue?\n (a) yes (b) no\nPICKED:b\nuser@host:~/dev$'],
    ['the /rewind dialog', () => composerFixture('rewind-dialog-pointer-row.txt')],
    ['the resume-from-summary dialog', () => resumeDialogFixture('handoff-target-w1T-p0.txt')],
    ['a hook permission confirmation',
      () => ' Hook PreToolUse:Bash requires confirmation\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend · ctrl+e to explain'],
    ['a compaction in progress', () => ' Compacting conversation history…\n (this may take a moment)'],
    ['an unrecognized dialog whose top scrolled off',
      () => ' Continue the migration ritual?\n Do you want to continue?\n (a) Absolutely   (b) Never mind\n cursor:a\n Choose a letter · ctrl+q aborts'],
  ];
  for (const [name, screen] of cases) {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    h.deps.readPane = async () => screen();
    const send = createSessionSend(h.deps);
    const card = await send.getMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
    let refused = false;
    try {
      await send.send({ sessionId: `s-inv-${name}`, text: 'x', pane: { paneId: 'pane-1' } });
    } catch (e) {
      refused = /showing a prompt|asking a question in its window/.test(e.message);
      // The ONE other honest outcome: a resolved ghost above a bare shell
      // prompt is not a blocker, it is a crashed CLI, so the send falls through
      // to resume-then-send (which this harness has no session to resume).
      // Anything else is a real failure and must not be swallowed.
      if (!refused && !/never came up/.test(e.message)) throw e;
    }
    assert.equal(refused, Boolean(card), `${name}: refusal (${refused}) must match the card (${Boolean(card)})`);
  }
});

// The send log is written fire-and-forget (a logging failure must never break a
// send), so a fixed sleep before reading it measures the machine, not the send:
// the 60ms the two specs below used to wait was enough on the gate machine and
// not on a 2-core hosted runner, where the file was still empty and
// JSON.parse('') failed the public CI run of 2026-09-06. Wait for the evidence
// itself, bounded. A line caught mid-append fails to parse and is read again.
async function readSendLog(logFile, done, deadlineMs = 5000) {
  const end = Date.now() + deadlineMs;
  for (;;) {
    let lines = [];
    try {
      lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { /* not written yet, or a line mid-append */ }
    if (done(lines) || Date.now() > end) return lines;
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Live-caught 2026-07-28: Pat sent the same message to a session twice and it
// landed nowhere. Not in that session's transcript, not in another's, not even
// as text in the pane's composer, and afterwards there was no way to tell WHICH
// decision dropped it. A send that leaves no evidence can only be guessed at.
test('every send leaves a text-free trace of which pane it resolved to', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-sendlog-'));
  const logFile = path.join(dir, 'send-log.jsonl');
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.sendLogFile = logFile;
  h.deps.readPane = async () => 'ready\n❯\n';
  const send = createSessionSend(h.deps);
  await send.send({
    sessionId: 'sess-1',
    text: 'a secret the log must not keep',
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });
  const lines = await readSendLog(logFile, (ls) => ls.some((l) => l.phase === 'resolve') && ls.some((l) => l.phase === 'sent'));
  const resolve = lines.find((l) => l.phase === 'resolve');
  assert.ok(resolve, 'the resolve decision is recorded');
  assert.equal(resolve.paneId, 'pane-1');
  assert.equal(resolve.offered, 'pane-1');
  assert.equal(resolve.chars, 'a secret the log must not keep'.length, 'length, not content');
  assert.ok(lines.some((l) => l.phase === 'sent'), 'and so is the outcome');
  assert.ok(!fs.readFileSync(logFile, 'utf8').includes('a secret'), 'never the message itself');
});

test('a send that resolves NO pane says so in the log', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-sendlog-'));
  const logFile = path.join(dir, 'send-log.jsonl');
  const h = makeHarness({ panes: [] });
  h.deps.sendLogFile = logFile;
  h.deps.readPane = async () => '';
  h.deps.launchActions = { resumeSession: async () => { throw new Error('refused: session is live'); } };
  const send = createSessionSend(h.deps);
  await send.send({ sessionId: 'sess-2', text: 'hello' }).catch(() => {});
  const lines = await readSendLog(logFile, (ls) => ls.some((l) => l.phase === 'resolve') && ls.some((l) => l.phase === 'error'));
  const resolve = lines.find((l) => l.phase === 'resolve');
  assert.ok(resolve, 'the resolve decision is recorded');
  assert.equal(resolve.paneId, null, 'the drop is visible: no pane was resolved');
  assert.ok(lines.some((l) => l.phase === 'error'), 'and the failure is recorded with its reason');
});

// Live-caught 2026-07-28: an adopt failed with "session adopted, but Claude
// never became ready", which is the most expensive way for a message not to
// land, because adoption KILLS and resumes the session before it delivers. The
// readiness wait demanded two BYTE-identical reads 800ms apart, and Claude's
// footer carries live numbers while a pane resize changes the wrap width, so
// settling was a matter of luck and a resize mid-wait made it impossible.
test('a resumed session settles even though its status line keeps ticking', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const frame = (cost) => [
    '  Resumed session.',
    '────────────────────────────────',
    '❯',
    '────────────────────────────────',
    `  opus 5 xhigh │ harbor │ $${cost} │ ctx 12%`,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n');
  let n = 0;
  h.deps.readPane = async () => frame((1.80 + (n += 0.01)).toFixed(2));
  const send = createSessionSend(h.deps);
  const res = await send.send({
    sessionId: 'sess-1',
    text: 'delivered after the adopt',
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
    resumeOnly: false,
  });
  assert.equal(res.ok, true);
});

test('the pane is sized BEFORE the settle, never during it', async () => {
  // A resize empties herdr's recent buffer and changes the wrap width, so one
  // landing mid-wait makes every read differ from the last.
  const h = makeHarness({ panes: [] });
  const order = [];
  h.deps.readPane = async () => {
    order.push('read');
    return '  ready\n──────────────\n❯\n──────────────\n  opus 5 xhigh\n  hint';
  };
  h.deps.terminalBridge.ensureDialogSize = async (paneId) => { order.push('size'); return { ok: true }; };
  h.deps.launchActions = {
    resumeSession: async () => { h.state.panes.push('pane-fresh'); },
  };
  const send = createSessionSend(h.deps);
  await send.send({ sessionId: 'sess-2', text: 'hello', resumeOnly: true }).catch(() => {});
  const firstRead = order.indexOf('read');
  const firstSize = order.indexOf('size');
  assert.ok(firstSize >= 0, 'the pane was sized');
  assert.ok(firstSize < firstRead || firstRead === -1, 'and sized before the first settle read');
});

// THE FREE-TEXT ROW IS A FIELD, NOT A BUTTON (2026-08-09, driven against a real
// Claude Code AskUserQuestion in an isolated pty; captures in
// test/fixtures/askuserquestion/real-text-row-typed-120x60.txt).
//
// What the CLI actually does:
//   land on "Type something." and TYPE  -> the row becomes "❯ 3. my typed answer"
//   then Enter                          -> "User answered Claude's questions: → my typed answer"
//   but Enter FIRST, before any text    -> "User declined to answer questions"
//                                          and the pane drops to the ordinary composer.
//
// Harbor pressed Enter first. So every typed answer declined the whole question
// set (all of it, not just the one question), then typed the words into the
// main composer and sent them as an ordinary chat message. Pat, exactly:
// "when i hit 'type something' it doesnt give me a way to type anything" and
// "i FUCKING HATE that it currently does submits everything when i hit enter".
const TEXT_MENU = [
  'Which solo option?',
  '  1. Solo one',
  '  2. Solo two',
  '  3. Type something.',
  '  4. Chat about this',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
];

test('a typed answer is TYPED first and confirmed second, never Enter first', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let highlight = 1;
  // The row's own label IS the field's contents, which is what the real CLI
  // does and what makes the typing verifiable rather than assumed.
  let field = null;
  h.deps.readPane = async () => TEXT_MENU
    .map((line, i) => {
      if (i < 1 || i > 4) return line;
      const body = i === 3 && field != null ? `  3. ${field}` : line;
      return `${highlight === i ? '❯' : ' '}${body.slice(1)}`;
    })
    .join('\n');
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    h.sent.push({ paneId, text });
    if (text === '\x1b[B') highlight = Math.min(4, highlight + 1);
    else if (text === '\x1b[A') highlight = Math.max(1, highlight - 1);
    else if (text !== '\r' && text !== '\x1b' && highlight === 3) field = `${field || ''}${text}`;
    return { ok: true };
  };
  closesOnEnter(h);
  const send = createSessionSend(h.deps);

  const res = await send.answerMenu({
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
    action: { type: 'text', index: 3, text: 'hand-build it from her files' },
  });
  assert.equal(res.ok, true);

  const keys = h.sent.map((s) => s.text);
  const firstEnter = keys.indexOf('\r');
  const textAt = keys.indexOf('hand-build it from her files');
  assert.ok(textAt >= 0, 'the answer was typed into the row');
  assert.ok(firstEnter > textAt, 'the ONLY Enter comes after the text, never before it');
  assert.equal(keys.filter((k) => k === '\r').length, 1, 'exactly one Enter: the confirm');
  // The walk still has to land on the row first, or the text goes somewhere else.
  assert.equal(keys.filter((k) => k === '\x1b[B').length, 2, 'two downs to reach option 3');
  assert.equal(keys.at(-1), '\r');
});

test('a plain option is still chosen with Enter and types nothing', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let highlight = 1;
  h.deps.readPane = async () => TEXT_MENU
    .map((line, i) => (i >= 1 && i <= 4 ? `${highlight === i ? '❯' : ' '}${line.slice(1)}` : line))
    .join('\n');
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    h.sent.push({ paneId, text });
    if (text === '\x1b[B') highlight = Math.min(4, highlight + 1);
    return { ok: true };
  };
  closesOnEnter(h);
  const send = createSessionSend(h.deps);
  const res = await send.answerMenu({
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
    action: { type: 'select', index: 2 },
  });
  assert.equal(res.ok, true);
  const keys = h.sent.map((s) => s.text);
  assert.deepEqual(keys, ['\x1b[B', '\r'], 'one step down, then Enter, and nothing else');
});

test('a text field that never took the answer is refused, and no Enter is risked', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let highlight = 1;
  // A pane that swallows the typing: the row never changes. Pressing Enter here
  // is the decline-everything case, so the only safe move is to refuse.
  h.deps.readPane = async () => TEXT_MENU
    .map((line, i) => (i >= 1 && i <= 4 ? `${highlight === i ? '❯' : ' '}${line.slice(1)}` : line))
    .join('\n');
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    h.sent.push({ paneId, text });
    if (text === '\x1b[B') highlight = Math.min(4, highlight + 1);
    return { ok: true };
  };
  const send = createSessionSend(h.deps);
  const res = await send.answerMenu({
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
    action: { type: 'text', index: 3, text: 'never lands' },
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /never reached the text field/);
  assert.equal(h.sent.filter((s) => s.text === '\r').length, 0, 'not one Enter was risked');
});

test('question navigation sends the arrow bytes the real dialog takes', async () => {
  // ← / → move between questions in a batch and Shift+Tab / Tab do the same;
  // ↑ / ↓ stay on the options. Measured against a live AskUserQuestion,
  // 2026-08-09, and the card sends the arrows because its own strip draws them.
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const send = createSessionSend(h.deps);
  const bytes = {};
  for (const key of ['left', 'right', 'tab', 'shifttab', 'up', 'down', 'enter', 'esc']) {
    h.sent.length = 0;
    const res = await send.answerMenu({ pane: { paneId: 'pane-1' }, action: { type: 'key', key } });
    assert.equal(res.ok, true, `${key} is a known key`);
    bytes[key] = h.sent.map((s) => s.text).join('');
  }
  assert.equal(bytes.right, '\x1b[C');
  assert.equal(bytes.left, '\x1b[D');
  assert.equal(bytes.tab, '\t');
  assert.equal(bytes.shifttab, '\x1b[Z');
  assert.equal(bytes.up, '\x1b[A');
  assert.equal(bytes.down, '\x1b[B');
  assert.equal(bytes.enter, '\r');
  assert.equal(bytes.esc, '\x1b');
  // A key nobody defined is refused rather than typed as literal text.
  const bad = await send.answerMenu({ pane: { paneId: 'pane-1' }, action: { type: 'key', key: 'pgup' } });
  assert.equal(bad.ok, false);
});

// A multi-select question's confirm is its own unnumbered row under the last
// option ("Submit", or "Next" when more questions follow). Measured against the
// real dialog 2026-08-09: a bare Enter on an option row TOGGLES that option, so
// the card's Submit button used to tick a box instead of submitting anything.
const MULTI_SCREEN = (checked, pointer) => {
  const rows = ['Fast boot', 'Telemetry', 'Auto update'].map((label, i) => {
    const n = i + 1;
    return `${pointer === n ? '❯' : ' '} ${n}. [${checked.has(n) ? '✔' : ' '}] ${label}`;
  });
  return [
    'Which features do you want?',
    ...rows,
    `${pointer === 4 ? '❯' : ' '}    Submit`,
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
};

test('submitting a multi-select walks to its unnumbered Submit row and confirms there', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const checked = new Set([1, 3]);
  let pointer = 1;
  h.deps.readPane = async () => MULTI_SCREEN(checked, pointer);
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    h.sent.push({ paneId, text });
    if (text === '\x1b[B') pointer = Math.min(4, pointer + 1);
    if (text === '\x1b[A') pointer = Math.max(1, pointer - 1);
    return { ok: true };
  };
  const send = createSessionSend(h.deps);
  const menu = await send.getMenu({ pane: { paneId: 'pane-1' } });
  assert.equal(menu.multiSelect, true, 'checkboxes alone make this multi-select');

  const res = await send.answerMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' }, action: { type: 'submit' } });
  assert.equal(res.ok, true);
  const keys = h.sent.map((s) => s.text);
  assert.equal(keys.filter((k) => k === '\x1b[B').length, 3, 'three steps down from option 1 to the Submit row');
  assert.equal(keys.at(-1), '\r', 'the Enter lands on Submit, never on an option');
  // The old behaviour, which this replaces: a lone Enter and nothing else.
  assert.notDeepEqual(keys, ['\r']);
});

test('a multi-select submit that cannot reach the Submit row refuses instead of guessing', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  // A pane where the highlight never moves: stepping down never clears it, so
  // there is no evidence the pointer ever left the options.
  h.deps.readPane = async () => MULTI_SCREEN(new Set([1]), 1);
  const send = createSessionSend(h.deps);
  const res = await send.answerMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' }, action: { type: 'submit' } });
  assert.equal(res.ok, false);
  assert.match(res.reason, /Submit row/);
  assert.equal(h.sent.filter((s) => s.text === '\r').length, 0, 'no Enter was risked on an option row');
});

// A free-text row on a MULTI-SELECT question. Measured against the real dialog
// 2026-08-09: typing into it TICKS the row ("[ ] Type something" becomes
// "[✔] my answer"), and an Enter there UNTICKS it again, discarding the answer
// and leaving the question open. So the typed row is confirmed on the
// question's own unnumbered Submit row, like every other multi-select answer.
const MULTI_TEXT_SCREEN = (state) => {
  const rows = [
    `${state.pointer === 1 ? '❯' : ' '} 1. [${state.checked.has(1) ? '✔' : ' '}] Fast boot`,
    `${state.pointer === 2 ? '❯' : ' '} 2. [${state.checked.has(2) ? '✔' : ' '}] Telemetry`,
    `${state.pointer === 3 ? '❯' : ' '} 3. [${state.field ? '✔' : ' '}] ${state.field || 'Type something'}`,
  ];
  return [
    'Which features do you want?',
    ...rows,
    `${state.pointer === 4 ? '❯' : ' '}    Submit`,
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
};

test('a typed answer on a multi-select confirms on Submit, never with a row Enter', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const state = { checked: new Set([1]), pointer: 1, field: null };
  h.deps.readPane = async () => MULTI_TEXT_SCREEN(state);
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    h.sent.push({ paneId, text });
    if (text === '\x1b[B') state.pointer = Math.min(4, state.pointer + 1);
    else if (text === '\x1b[A') state.pointer = Math.max(1, state.pointer - 1);
    else if (text !== '\r' && text !== '\x1b' && state.pointer === 3) state.field = `${state.field || ''}${text}`;
    return { ok: true };
  };
  const send = createSessionSend(h.deps);
  const res = await send.answerMenu({
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
    action: { type: 'text', index: 3, text: 'a fourth thing' },
  });
  assert.equal(res.ok, true);
  const keys = h.sent.map((s) => s.text);
  const textAt = keys.indexOf('a fourth thing');
  assert.ok(textAt >= 0, 'the answer was typed');
  assert.equal(keys.filter((k) => k === '\r').length, 1, 'exactly one Enter');
  // The single Enter is the LAST key, and it comes after a further step down
  // onto the Submit row rather than landing on the text row itself.
  assert.equal(keys.at(-1), '\r');
  assert.ok(keys.slice(textAt).includes('\x1b[B'), 'it stepped onto the Submit row before confirming');
  assert.equal(state.pointer, 4, 'the highlight ended on Submit, not on the typed option');
  assert.equal(state.field, 'a fourth thing', 'the typed answer survived');
  assert.equal(h.deps.readPane && [...state.checked].includes(1), true, 'the other tick was preserved');
});

test('a typed answer inside a BATCH answers its own question and never submits the set', async () => {
  // The riskiest combination, and the one the old Enter-first code destroyed:
  // a free-text answer on a question that is not the last in the batch. The
  // batch's tab strip and its "Tab/Arrow keys to navigate" footer are what make
  // this a batch rather than a lone question.
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let pointer = 1;
  let field = null;
  h.deps.readPane = async () => [
    '←  ☐ Alpha  ☐ Beta  ☐ Gamma  ✔ Submit  →',
    '',
    'Which beta option?',
    '',
    `${pointer === 1 ? '❯' : ' '} 1. Beta one`,
    `${pointer === 2 ? '❯' : ' '} 2. Beta two`,
    `${pointer === 3 ? '❯' : ' '} 3. ${field || 'Type something.'}`,
    `${pointer === 4 ? '❯' : ' '} 4. Chat about this`,
    '',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ].join('\n');
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    h.sent.push({ paneId, text });
    if (text === '\x1b[B') pointer = Math.min(4, pointer + 1);
    else if (text === '\x1b[A') pointer = Math.max(1, pointer - 1);
    else if (text !== '\r' && text !== '\x1b' && pointer === 3) field = `${field || ''}${text}`;
    return { ok: true };
  };
  closesOnEnter(h);
  const send = createSessionSend(h.deps);
  const menu = await send.getMenu({ pane: { paneId: 'pane-1' } });
  assert.equal(menu.keys.switchQuestions, true, 'this is a batch');
  assert.equal(menu.multiSelect, false, 'and a single-select one');
  // getMenu on a batch now DISCOVERS the other questions by walking the strip
  // (2026-09-03); this stand-in never changes screen on ←/→, so that walk gives
  // up honestly. The invariant under test is the ANSWER's keystrokes, so the
  // walk's are dropped before the answer is sent.
  h.sent.length = 0;

  const res = await send.answerMenu({
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
    action: { type: 'text', index: 3, text: 'neither, do it by hand' },
  });
  assert.equal(res.ok, true);
  const keys = h.sent.map((s) => s.text);
  const textAt = keys.indexOf('neither, do it by hand');
  assert.ok(textAt >= 0);
  assert.ok(keys.indexOf('\r') > textAt, 'typed first, confirmed second');
  assert.equal(keys.filter((k) => k === '\r').length, 1, 'ONE Enter: this question only');
  // Nothing that could move to another question or submit the batch was sent.
  for (const stray of ['\x1b[C', '\x1b[D', '\t', '\x1b[Z', '\x1b']) {
    assert.equal(keys.includes(stray), false, `no ${JSON.stringify(stray)} was sent`);
  }
});

test('a row with no checkbox refuses to be ticked instead of reporting success', async () => {
  // A multi-select question carries plain rows too ("Chat about this"). The
  // change check skipped itself when the row had no checkbox to read, so a
  // Space that did nothing came back ok:true (caught in review 2026-08-09).
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let pointer = 1;
  h.deps.readPane = async () => [
    'Which features do you want?',
    `${pointer === 1 ? '❯' : ' '} 1. [✔] Fast boot`,
    `${pointer === 2 ? '❯' : ' '} 2. [ ] Telemetry`,
    '─────────────────────────',
    `${pointer === 3 ? '❯' : ' '} 3. Chat about this`,
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    h.sent.push({ paneId, text });
    if (text === '\x1b[B') pointer = Math.min(3, pointer + 1);
    if (text === '\x1b[A') pointer = Math.max(1, pointer - 1);
    return { ok: true };
  };
  const send = createSessionSend(h.deps);
  const menu = await send.getMenu({ pane: { paneId: 'pane-1' } });
  assert.equal(menu.multiSelect, true);
  assert.equal(menu.options[2].checked, undefined, 'the bypass row draws no box');

  const res = await send.answerMenu({
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
    action: { type: 'toggle', index: 3 },
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /not a checkbox/);
  assert.equal(h.sent.filter((s) => s.text === ' ').length, 0, 'no Space was sent at it');
});
