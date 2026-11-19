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
  composerBox,
  codexBoxState,
  codexBoxMatch,
  codexBoxDraft,
  codexStartupEcho,
  codexSafeText,
  codexChangeNote,
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
          // As the daemon does: a resumed pane carries its session id from spawn.
          state.panes.push({ pane_id: 'pane-fresh', workspace_id: 'ws-1', agent_session: { kind: 'id', value: args.id } });
        },
      },
      getSessionMeta: async () => ({ cwd: '/home/x/dev/harbor' }),
      links: createLinkRegistry(),
      projectLabelForCwd: () => 'harbor',
      sleep: async () => {},
      setXClipboardImage: async (imagePath) => sequence.push(['clipboard', imagePath]),
      // The clipboard route is opt-in (2026-11-19); these specs keep proving it.
      pasteClaudeImagesFromClipboard: true,
      // Fixture paths name no real file; a spec about missing pictures overrides this.
      imageFileReady: async () => true,
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
  // The prompt draws what was typed into it (round fourteen: a draft already
  // there that merely ENDS like the message is someone else's, PROMPT_BUSY).
  h.prompt.echo = false;
  h.deps.readPane = async () => ['- Do you want me to sort the toy blocks?', damagedDivider,
    `\u276f ${h.prompt.draft}`, damagedDivider, '  synthetic status'].join('\n');
  const send = createSessionSend(h.deps);
  assert.equal(await send.getMenu({ pane: { paneId: 'pane-1' }, blockedHint: true }), null);
  await send.send({ sessionId: 'synthetic-damaged', text: 'keep the blue blocks', pane: { paneId: 'pane-1' } });
  assert.ok(h.sent.some(s => s.text.includes('keep the blue blocks')));
  assert.equal(h.sent.filter(s => s.text === '\r').length, 1);
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
// Claude Code's cold-resume warning (2.1.304 turned it on for Pro and Max; the
// server switch `tengu_amber_tally` was already live on four of Pat's homes on
// 2026-10-24). It asks before a send into an inactive conversation whose resume
// would cost 5% or more of the 5-hour limit, keeps the typed message in the
// box, and when another server switch is on puts the default focus on "Start a
// new conversation", so a blind Enter would leave the conversation. Harbor must
// refuse the send and type nothing. Synthetic screens built from the dialog's
// strings in the 2.1.310 binary: the resume trigger numbers its rows, the idle
// trigger hides the numbers.
test('the cold-resume usage warning blocks a send: no key reaches it', async () => {
  const body = 'This conversation has been inactive for 3h 12m and is 812.4k tokens long. Resuming it will use about 9% of your 5-hour usage limit.';
  const screens = [
    ['Resume this conversation?', body, '❯ 1. Resume', '  2. Start a new conversation',
      '     Claude can look this one up if you refer to it later', 'Enter to confirm · Esc to resume'],
    ['Resume this conversation?', body, 'Your unsent message will still be there after you answer.',
      '  Resume', '❯ Start a new conversation', '↑/↓ to pick a row first · Enter to confirm · Esc to dismiss'],
  ];
  for (const lines of screens) {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    h.deps.readPane = async () => lines.join('\n');
    const send = createSessionSend(h.deps);
    await assert.rejects(send.send({ sessionId: 'synthetic-cold-resume', text: 'carry on', pane: { paneId: 'pane-1' } }));
    assert.equal(h.sent.length, 0, lines[3]);
  }
});
// The idle trigger draws the same warning AFTER the Enter that would have
// submitted (the composer's text moves into the dialog's hidden draft), so the
// post-Enter watcher meets it instead of the conversation. Exactly one Enter may
// reach the pane: a spare one would confirm the focused row.
test('a cold-resume warning that appears after the Enter gets no spare key', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const divider = '─'.repeat(60);
  let draft = '';
  let warned = false;
  h.prompt.echo = false;
  h.deps.readPane = async () => (warned
    ? ['Resume this conversation?', 'This conversation has been inactive for 3h 12m and is 812.4k tokens long. Resuming it will use about 9% of your 5-hour usage limit.',
      'Your unsent message will still be there after you answer.', '  Resume', '❯ Start a new conversation',
      '↑/↓ to pick a row first · Enter to confirm · Esc to dismiss'].join('\n')
    : `conversation\n${divider}\n❯ ${draft}\n${divider}\n  personal  ·  Opus 5.5\n  ⏵⏵ auto mode on`);
  const sendInput = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    const result = sendInput(paneId, text);
    if (text === '\r') warned = true;
    else draft += text.replace(/\x1b\[20[01]~/g, '');
    return result;
  };
  const send = createSessionSend(h.deps);
  await send.send({ sessionId: 'synthetic-cold-resume-idle', text: 'carry on', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }).catch(() => {});
  assert.equal(typed(h).filter((text) => text === '\r').length, 1);
  assert.equal(typed(h).at(-1), '\r');
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
  // As Claude draws it: each paste puts its chip IN THE PROMPT (round seven:
  // only a chip in the composer confirms a paste).
  h.deps.readPane = async () => `conversation\n${PROMPT_RULE}\n❯ \n${PROMPT_RULE}`;
  let chips = 0;
  const base = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    const result = base(paneId, text);
    if (text === IMAGE_PASTE) { chips += 1; h.prompt.draft += `[Image #${chips}] `; }
    return result;
  };
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
  const idle = '❯ [Image #2] describe this\n  ⎿  [Image #2]\n● sure';
  // After Ctrl+V: old #2 markers scrolled off the top; only the new #3 remains,
  // drawn in the prompt (the harness draws the prompt under each frame).
  // Old count-logic saw 2 -> 1 and failed; max-#N sees 2 -> 3 and confirms.
  let pasted = false;
  h.deps.readPane = async () => `${pasted ? '● sure' : idle}\n${PROMPT_RULE}\n❯ \n${PROMPT_RULE}`;
  const base = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    const result = base(paneId, text);
    if (text === IMAGE_PASTE) { pasted = true; h.prompt.draft += '[Image #3] '; }
    return result;
  };
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

// One typist per pane across processes (withPaneLock): the desktop app and the
// phone server both type into the same panes. The lock is OS-owned
// (shared/os-lock.cjs): a second process holds it for real here.
const OS_LOCK = path.resolve(__dirname, '../../src/shared/os-lock.cjs');
function holdLockInAnotherProcess(name) {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', `
    const { withLock } = require(${JSON.stringify(OS_LOCK)});
    withLock(${JSON.stringify(name)}, () => new Promise((resolve) => {
      process.stdout.write('held\\n');
      process.stdin.on('end', resolve);
      process.stdin.resume();
    })).then(() => process.exit(0));
  `], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const ready = new Promise((resolve) => child.stdout.on('data', (d) => { if (String(d).includes('held')) resolve(); }));
  return { child, ready };
}
const paneLockName = (h, paneId) => `harbor-pane:${path.join(path.dirname(h.deps.sendLogFile), 'pane-locks')}:${paneId}`;

test('a pane locked by another live Harbor process makes the send wait, then it goes in once released', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = composerPane(h);
  const other = holdLockInAnotherProcess(paneLockName(h, 'pane-1'));
  try {
    await other.ready;
    const send = createSessionSend(h.deps);
    const details = [];
    send.emitter.on('status', (st) => { if (st.detail) details.push(st.detail); });
    const pending = send.send({ sessionId: 's-lock', text: 'hello there', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
    await new Promise((r) => setTimeout(r, 2200));
    assert.deepEqual(typed(h), [], 'nothing typed while the other process holds the pane');
    assert.ok(details.some((d) => /another Harbor window is typing/.test(d)), 'the bar says why');
    other.child.stdin.end();
    const result = await pending;
    assert.equal(result.ok, true);
    assert.deepEqual(typed(h), ['hello there', '\r']);
    assert.equal(pane.draft, '');
  } finally {
    other.child.kill();
  }
});

test('a pane lock whose holder process dies is free at once, with no staleness rule', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  composerPane(h);
  const other = holdLockInAnotherProcess(paneLockName(h, 'pane-1'));
  await other.ready;
  other.child.kill('SIGKILL');
  await new Promise((r) => other.child.once('exit', r));
  const send = createSessionSend(h.deps);
  const started = Date.now();
  const result = await send.send({ sessionId: 's-lock-dead', text: 'hello there', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.equal(result.ok, true);
  assert.ok(Date.now() - started < 1500, 'no wait behind a dead holder');
  assert.deepEqual(typed(h), ['hello there', '\r']);
});

// A send that waited for another process re-checks, inside the lock, that the
// pane still serves its session (Sol's review, round two).
test('a send that waited out another typist re-checks the pane, and types nothing if it changed conversation', async () => {
  const pane1 = { pane_id: 'pane-1', workspace_id: 'ws-1', agent_session: { kind: 'id', value: 's-mine' } };
  const h = makeHarness({ panes: [pane1], controlled: 'pane-1' });
  composerPane(h);
  const other = holdLockInAnotherProcess(paneLockName(h, 'pane-1'));
  try {
    await other.ready;
    const send = createSessionSend(h.deps);
    const pending = send.send({ sessionId: 's-mine', text: 'hello there', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
    await new Promise((r) => setTimeout(r, 600));
    pane1.agent_session = { kind: 'id', value: 's-someone-else' }; // the holder started another conversation there
    other.child.stdin.end();
    await assert.rejects(pending, (error) => error.code === 'TARGET_CHANGED');
    assert.deepEqual(typed(h), [], 'nothing typed into the other conversation');
  } finally {
    other.child.kill();
  }
});

// The record of typing a pane has not shown yet is shared by every Harbor
// process on the store (Sol's review): kept per process, the phone server could
// not see the desktop's paste still waiting in a stalled Claude, and typed a
// second message behind it.
test('typing one Harbor process left unshown is waited on by another, never typed again', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = composerPane(h, { renderDelayReads: 1300, alive: true });
  const desktop = createSessionSend(h.deps);
  const phone = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  await assert.rejects(
    desktop.send({ sessionId: 's-two-procs', text: NEW_SESSION_MESSAGE, pane: target }),
    (error) => error.code === 'PROMPT_NEVER_HELD',
  );
  assert.ok(fs.existsSync(path.join(path.dirname(h.deps.sendLogFile), 'pane-locks', 'pane-1.pending.json')), 'the record is on disk for every process');
  await phone.send({ sessionId: 's-two-procs', text: NEW_SESSION_MESSAGE, pane: target });
  assert.deepEqual(typed(h), [NEW_SESSION_MESSAGE, '\r'], 'typed once, submitted once, across both processes');
  assert.equal(pane.draft, '');
  assert.equal(fs.existsSync(path.join(path.dirname(h.deps.sendLogFile), 'pane-locks', 'pane-1.pending.json')), false, 'cleared once shown');
});

test('a picture whose chip wraps behind a long message is still seen as attached (2026-11-18, Vox)', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = composerPane(h, { imagesBefore: 429, wrapImageChips: true });
  const send = createSessionSend(h.deps);
  const result = await send.send({ sessionId: 's-wrap', text: 'look at this', images: ['/cache/one.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.equal(result.ok, true);
  assert.equal(typed(h)[0], IMAGE_PASTE);
  assert.equal(pane.draft, '');
});

test('a Claude that draws nothing after the image chord is waited on, not refused at 12 s', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = composerPane(h, { renderDelayReads: 400 });
  const send = createSessionSend(h.deps);
  const result = await send.send({ sessionId: 's-img-stall', text: 'look at this', images: ['/cache/one.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.equal(result.ok, true);
  assert.equal(pane.draft, '');
});

// Typed keys are answered by the keeper (terminal-bridge sendInputAcked): keys
// the session did not take fail the send at once, never a wait of minutes.
test('keys the session refuses fail the send at once, without waiting for the prompt', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  composerPane(h);
  h.deps.terminalBridge.sendInputAcked = async () => ({ ok: false, reason: 'the session did not take the keys: session pane-1 has exited' });
  const send = createSessionSend(h.deps);
  let reads = 0;
  const readPane = h.deps.readPane;
  h.deps.readPane = async (...args) => { reads += 1; return readPane(...args); };
  await assert.rejects(
    send.send({ sessionId: 's-refused-keys', text: 'hello there', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    /did not take the keys/,
  );
  assert.ok(reads < 60, `refused at once, not after a wait (${reads} reads)`);
});

// One clipboard, many panes (Sol's review, rounds one and two): Claude reads
// the clipboard when it reaches the chord, so a pane that never read its chord
// could attach the NEXT image put there. While that pane is still frozen on the
// same screen, other images go by path and the clipboard is left alone (never
// cleared: that wiped Pat's own copy and could not stop the late read anyway).
test('while a frozen pane still owes its clipboard read, the next image goes by path and the clipboard is untouched', async () => {
  const h = makeHarness({ panes: ['pane-1', 'pane-2'], controlled: 'pane-2' });
  const FROZEN = `✻ Working… (frozen)\nconversation\n${PROMPT_RULE}\n❯ \n${PROMPT_RULE}`;
  let pane2Screen = FROZEN;
  // The send captures its screen reader when it is made, so this one routes
  // pane-2 to pane2Screen and pane-1 to whatever draws it at the time (the
  // composer, installed below).
  let drawPane1 = h.deps.readPane;
  h.deps.readPane = async (paneId, ...rest) => (paneId === 'pane-2' ? pane2Screen : drawPane1(paneId, ...rest));
  const reader = h.deps.readPane;
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.send({ sessionId: 's-frozen', text: 'x', images: ['/cache/one.png'], pane: { paneId: 'pane-2', workspaceId: 'ws-1' } }),
    /drew nothing/,
  );
  const pane = composerPane(h, { pathChips: 'whole-line' });
  drawPane1 = h.deps.readPane;
  h.deps.readPane = reader;
  const before = h.sequence.length;
  const second = await send.send({ sessionId: 's-other', text: 'look at this', images: ['/cache/two.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.equal(second.ok, true);
  const during = h.sequence.slice(before);
  assert.equal(during.some(([kind]) => kind === 'clipboard'), false, 'the clipboard still holds the frozen pane\'s own image');
  assert.ok(during.some(([kind, text]) => kind === 'input' && String(text).includes('"/cache/two.png"')), 'the image went by path');
  assert.equal(pane.draft, '');
  // A redraw alone proves nothing: still by path.
  pane2Screen = `✻ Working… (later)\nconversation\n${PROMPT_RULE}\n❯ \n${PROMPT_RULE}`;
  const redrawn = h.sequence.length;
  const stillPath = await send.send({ sessionId: 's-other', text: 'one more', images: ['/cache/two-b.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.equal(stillPath.ok, true);
  assert.equal(h.sequence.slice(redrawn).some(([kind]) => kind === 'clipboard'), false, 'a redraw is not evidence the chord was read');
  // The frozen pane draws ITS image chip (it read the clipboard): the clipboard route is back.
  pane2Screen = `conversation\n${PROMPT_RULE}\n❯ [Image #1] x\n${PROMPT_RULE}`;
  const mark = h.sequence.length;
  const third = await send.send({ sessionId: 's-other', text: 'and this', images: ['/cache/three.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.equal(third.ok, true);
  assert.ok(h.sequence.slice(mark).some(([kind, file]) => kind === 'clipboard' && file === '/cache/three.png'));
});

// Round three: the debt is checked INSIDE the clipboard lock, so a send that
// was already waiting for the lock while the frozen pane's paste failed sees
// the debt and goes by path (checked before the lock, it wrote the clipboard).
test('an image send waiting on the clipboard lock sees the debt the holder recorded, and goes by path', async () => {
  const h = makeHarness({ panes: ['pane-1', 'pane-2'], controlled: 'pane-2' });
  const FROZEN = `✻ Working… (frozen)\nconversation\n${PROMPT_RULE}\n❯ \n${PROMPT_RULE}`;
  let drawPane1 = h.deps.readPane;
  // pane-2 is frozen and slow to read, so its failed paste holds the lock a while.
  h.deps.readPane = async (paneId, ...rest) => {
    if (paneId === 'pane-2') { await new Promise((r) => setTimeout(r, 5)); return FROZEN; }
    return drawPane1(paneId, ...rest);
  };
  const reader = h.deps.readPane;
  const baseInput = h.deps.terminalBridge.sendInput;
  composerPane(h, { pathChips: 'whole-line' });
  drawPane1 = h.deps.readPane;
  h.deps.readPane = reader;
  const composerInput = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => (paneId === 'pane-2' ? baseInput(paneId, text) : composerInput(paneId, text));
  const send = createSessionSend(h.deps);
  const first = send.send({ sessionId: 's-frozen', text: 'x', images: ['/cache/one.png'], pane: { paneId: 'pane-2', workspaceId: 'ws-1' } });
  first.catch(() => {});
  while (!h.sequence.some(([kind]) => kind === 'clipboard')) await new Promise((r) => setTimeout(r, 1));
  const second = send.send({ sessionId: 's-other', text: 'look at this', images: ['/cache/two.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  await assert.rejects(first);
  const result = await second;
  assert.equal(result.ok, true);
  assert.deepEqual(h.sequence.filter(([kind]) => kind === 'clipboard').map(([, file]) => file), ['/cache/one.png'], 'the clipboard still holds the frozen pane\'s image');
});

// Round three: every send re-checks the pane inside the lock, waited or not.
test('a pane that started another conversation between lookup and typing gets nothing, even with no wait', async () => {
  const pane1 = { pane_id: 'pane-1', workspace_id: 'ws-1', agent_session: { kind: 'id', value: 's-mine' } };
  const h = makeHarness({ panes: [pane1], controlled: 'pane-1' });
  composerPane(h);
  let lookups = 0;
  h.deps.getSessionMeta = async () => {
    lookups += 1;
    // The second lookup runs after the pane was resolved and before the lock.
    if (lookups === 2) pane1.agent_session = { kind: 'id', value: 's-someone-else' };
    return null;
  };
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.send({ sessionId: 's-mine', text: 'hello there', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'TARGET_CHANGED',
  );
  assert.equal(lookups >= 2, true);
  assert.deepEqual(typed(h), [], 'nothing typed into the other conversation');
});

// Round three: the record stands until the Enter is acknowledged.
test('an Enter whose answer never came keeps the record, and the same send again presses Enter only', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = composerPane(h);
  let lose = true;
  h.deps.terminalBridge.sendInputAcked = async (paneId, text) => {
    if (text === '\r' && lose) { lose = false; return { ok: false, ambiguous: true, reason: 'no answer from the session daemon: input request timed out after 10000ms' }; }
    return h.deps.terminalBridge.sendInput(paneId, text);
  };
  const file = path.join(path.dirname(h.deps.sendLogFile), 'pane-locks', 'pane-1.pending.json');
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.send({ sessionId: 's-enter-lost', text: 'hello there', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'INPUT_UNCONFIRMED',
  );
  assert.ok(fs.existsSync(file), 'the record stands');
  const again = await send.send({ sessionId: 's-enter-lost', text: 'hello there', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.equal(again.ok, true);
  assert.deepEqual(typed(h), ['hello there', '\r'], 'typed once, Enter pressed for it');
  assert.equal(pane.draft, '');
  assert.equal(fs.existsSync(file), false);
});

// Round three: a resize reflowing a frozen frame is not the CLI drawing.
test('a frozen frame reflowed by a resize still counts as frozen, so the next send types nothing', async () => {
  const longAgo = new Date(Date.now() - 12 * 60 * 60_000).toISOString();
  const h = makeHarness({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', created_at: longAgo }], controlled: 'pane-1' });
  h.prompt.echo = false;
  const frame = (width) => `✻ Working… (4m 11s · esc to interrupt)\n\n${'─'.repeat(width)}\n❯ \n${'─'.repeat(width)}\n  ⏵⏵ bypass permissions on`;
  let width = 60;
  h.deps.readPane = async () => frame(width);
  const send = createSessionSend(h.deps);
  await assert.rejects(send.send({ sessionId: 's-frozen', text: 'first message', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }));
  width = 44; // the window was resized; the CLI drew nothing
  await assert.rejects(send.send({ sessionId: 's-frozen', text: 'second message', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }));
  assert.deepEqual(typed(h), ['first message'], 'nothing typed behind the queued first message');
});

// Round three: a Codex paste into a frozen Codex is queued too.
function frozenCodex(h) {
  const state = { frozen: true, draft: '', echoed: [] };
  h.prompt.echo = false;
  const frame = () => `  >_ OpenAI Codex (v0.165.0)\n\n${state.echoed.map((m) => `› ${m}\n\n• OK\n`).join('\n')}\n› ${state.draft || 'Ask Codex to do anything'}\n\n  GPT-6.1-Sol low · ~\\dev\\proof · proof`;
  const still = frame();
  h.deps.readPane = async () => (state.frozen ? still : frame());
  const base = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    const result = base(paneId, text);
    if (state.frozen) return result;
    if (text === '\r') { if (state.draft.trim()) { state.echoed.push(state.draft.trim()); state.draft = ''; } } else state.draft += text.replace(/\x1b\[20[01]~/g, '');
    return result;
  };
  return state;
}

test('a second send into a frozen Codex waits for its queued paste instead of pasting behind it', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const codex = frozenCodex(h);
  const send = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  await assert.rejects(send.send({ sessionId: 'pane:pane-1', provider: 'codex', text: 'first message', pane: target }));
  await assert.rejects(
    send.send({ sessionId: 'pane:pane-1', provider: 'codex', text: 'second message', pane: target }),
    (error) => error.code === 'EARLIER_TYPING_STALLED',
  );
  assert.equal(typed(h).filter((t) => t.includes('message')).length, 1, 'pasted once');
  // Codex wakes: the queued paste shows in its box, and the same send presses Enter only.
  codex.frozen = false;
  codex.draft = 'first message';
  const result = await send.send({ sessionId: 'pane:pane-1', provider: 'codex', text: 'first message', pane: target });
  assert.equal(result.ok, true);
  assert.equal(typed(h).filter((t) => t.includes('message')).length, 1, 'still pasted once');
  assert.deepEqual(codex.echoed, ['first message']);
});

test('a Codex that drew since with an empty box ends the record, and the next send pastes', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const codex = frozenCodex(h);
  const send = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  await assert.rejects(send.send({ sessionId: 'pane:pane-1', provider: 'codex', text: 'first message', pane: target }));
  codex.frozen = false;
  codex.echoed.push('something it did meanwhile'); // it drew; the paste is gone
  const result = await send.send({ sessionId: 'pane:pane-1', provider: 'codex', text: 'second message', pane: target });
  assert.equal(result.ok, true);
  assert.equal(codex.echoed.at(-1), 'second message');
});

// Round four: a resume delivers only into a pane that is its own.
test('a resume takes only the new pane naming its own session, never one naming another or nobody', async () => {
  const h = makeHarness({ panes: [] });
  h.deps.readPane = async () => '  ready\n──────────────\n❯\n──────────────\n  opus 5 xhigh\n  hint';
  h.deps.launchActions = {
    resumeSession: async () => {
      // Another resume in the same project opened its pane first.
      h.state.panes.push({ pane_id: 'pane-other', workspace_id: 'ws-1', agent_session: { kind: 'id', value: 'sess-other' } });
      h.state.panes.push({ pane_id: 'pane-unnamed', workspace_id: 'ws-1' }); // a New Session opened meanwhile
      h.state.panes.push({ pane_id: 'pane-mine', workspace_id: 'ws-1', agent_session: { kind: 'id', value: 'sess-mine' } });
    },
  };
  const send = createSessionSend(h.deps);
  const result = await send.send({ sessionId: 'sess-mine', text: 'hello', resumeOnly: true });
  assert.equal(result.paneId, 'pane-mine');
});

// Round four: any refusal after an Enter was pressed is "submission unknown".
test('a Codex send refused after its Enter reports submission unknown', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  codexPane(h, { swallowEnters: 2 });
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.send({ sessionId: 'pane:pane-1', provider: 'codex', text: `Please look again. ${'proof words '.repeat(120)}marker`, pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'CODEX_NOT_SUBMITTED' && error.submission === 'unknown',
  );
});

// Round four: image chords and slash commands wait behind unshown typing too.
function frozenClaude(h) {
  const longAgo = new Date(Date.now() - 12 * 60 * 60_000).toISOString();
  h.state.panes.splice(0, h.state.panes.length, { pane_id: 'pane-1', workspace_id: 'ws-1', created_at: longAgo });
  h.prompt.echo = false;
  const state = { screen: `✻ Working… (4m 11s · esc to interrupt)\n\n${'─'.repeat(60)}\n❯ \n${'─'.repeat(60)}\n  ⏵⏵ bypass permissions on` };
  h.deps.readPane = async () => state.screen;
  return state;
}

test('an image paste into a Claude still holding unshown typing writes nothing to the clipboard', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  frozenClaude(h);
  const send = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  await assert.rejects(send.send({ sessionId: 's-frozen', text: 'first message', pane: target }));
  await assert.rejects(
    send.send({ sessionId: 's-frozen', text: 'see this', images: ['/cache/shot.png'], pane: target }),
    (error) => error.code === 'EARLIER_TYPING_STALLED',
  );
  assert.equal(h.sequence.some(([kind]) => kind === 'clipboard'), false);
  assert.deepEqual(typed(h), ['first message']);
});

test('a slash command into a frozen Codex with a queued paste types nothing', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  frozenCodex(h);
  const send = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  await assert.rejects(send.send({ sessionId: 'pane:pane-1', provider: 'codex', text: 'first message', pane: target }));
  await assert.rejects(
    send.send({ sessionId: 'pane:pane-1', provider: 'codex', text: '/status', pane: target }),
    (error) => error.code === 'EARLIER_TYPING_STALLED',
  );
  assert.equal(typed(h).filter((x) => x.includes('/status')).length, 0);
});

// Round four: a second look before ending a record on one changed frame.
test('a frame drawn just before the queued keys arrive does not end the record', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const claude = frozenClaude(h);
  let armed = false;
  h.deps.sleep = async (ms) => {
    // The second look: by now the CLI has read the queued keys and drawn them.
    if (armed && ms === 1000) claude.screen = `✻ Working… (4m 13s · esc to interrupt)\n\n${'─'.repeat(60)}\n❯ first message\n${'─'.repeat(60)}\n  ⏵⏵ bypass permissions on`;
  };
  const send = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  await assert.rejects(send.send({ sessionId: 's-frozen', text: 'first message', pane: target }));
  claude.screen = claude.screen.replace('4m 11s', '4m 12s'); // one spinner frame, prompt still empty
  armed = true;
  await assert.rejects(send.send({ sessionId: 's-frozen', text: 'a different message', pane: target }));
  assert.deepEqual(typed(h), ['first message'], 'nothing typed behind it');
});

// Round four: the clipboard debt survives a restart of the desktop process.
test('a clipboard debt recorded by one Harbor process is honoured by the next', async () => {
  const h = makeHarness({ panes: ['pane-1', 'pane-2'], controlled: 'pane-2' });
  const FROZEN = `✻ Working… (frozen)\nconversation\n${PROMPT_RULE}\n❯ \n${PROMPT_RULE}`;
  let drawPane1 = h.deps.readPane;
  h.deps.readPane = async (paneId, ...rest) => (paneId === 'pane-2' ? FROZEN : drawPane1(paneId, ...rest));
  const reader = h.deps.readPane;
  const before = createSessionSend(h.deps);
  await assert.rejects(before.send({ sessionId: 's-frozen', text: 'x', images: ['/cache/one.png'], pane: { paneId: 'pane-2', workspaceId: 'ws-1' } }));
  composerPane(h, { pathChips: 'whole-line' });
  drawPane1 = h.deps.readPane;
  h.deps.readPane = reader;
  const after = createSessionSend(h.deps); // the desktop restarted
  const mark = h.sequence.length;
  const result = await after.send({ sessionId: 's-other', text: 'look', images: ['/cache/two.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.equal(result.ok, true);
  assert.equal(h.sequence.slice(mark).some(([kind]) => kind === 'clipboard'), false, 'the restarted process still knows the debt');
});

// Round five: a bare Codex slash command can open a picker on its first
// Enter, so it never gets a spare.
test('a bare Codex slash command gets no spare Enter', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  codexPane(h, { swallowEnters: 1 });
  const send = createSessionSend(h.deps);
  await send.send({ sessionId: 'pane:pane-1', provider: 'codex', text: '/model', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }).catch(() => {});
  assert.equal(typed(h).filter((x) => x === '\r').length, 1, 'one Enter, no spare');
});

// Round five: one redraw and then the clock is not "alive".
test('a CLI that drew one frame and then froze keeps the record, so the next send types nothing', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const claude = frozenClaude(h);
  const base = h.deps.terminalBridge.sendInput;
  let typedOnce = false;
  let readsAfter = 0;
  h.deps.terminalBridge.sendInput = (paneId, text) => { if (text === 'first message') typedOnce = true; return base(paneId, text); };
  const frozenRead = h.deps.readPane;
  h.deps.readPane = async (...args) => {
    if (typedOnce && (readsAfter += 1) === 3) claude.screen = claude.screen.replace('4m 11s', '4m 12s'); // one frame, then frozen again
    return frozenRead(...args);
  };
  const send = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  await assert.rejects(send.send({ sessionId: 's-frozen', text: 'first message', pane: target }));
  await assert.rejects(send.send({ sessionId: 's-frozen', text: 'a different message', pane: target }));
  assert.deepEqual(typed(h), ['first message'], 'nothing typed behind it');
});

// Round five: an unreadable second look keeps the record.
test('a second look that cannot read the screen keeps the record', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const claude = frozenClaude(h);
  let blind = false;
  const frozenRead = h.deps.readPane;
  h.deps.readPane = async (...args) => { if (blind) throw new Error('pane unreadable'); return frozenRead(...args); };
  h.deps.sleep = async (ms) => { if (ms === 1000 && claude.screen.includes('4m 12s')) blind = true; };
  const send = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  await assert.rejects(send.send({ sessionId: 's-frozen', text: 'first message', pane: target }));
  claude.screen = claude.screen.replace('4m 11s', '4m 12s'); // drew, prompt empty
  await assert.rejects(send.send({ sessionId: 's-frozen', text: 'a different message', pane: target }));
  assert.deepEqual(typed(h), ['first message']);
});

// Round five: an unreadable clipboard-debt record counts as a debt.
test('an unreadable clipboard debt keeps images off the clipboard', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  composerPane(h, { pathChips: 'whole-line' });
  const debts = path.join(path.dirname(h.deps.sendLogFile), 'pane-locks', 'clipboard-debts');
  fs.mkdirSync(debts, { recursive: true });
  fs.writeFileSync(path.join(debts, 'pane-9.json'), '{ half-written');
  const send = createSessionSend(h.deps);
  const result = await send.send({ sessionId: 's-img', text: 'look', images: ['/cache/shot.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.equal(result.ok, true);
  assert.equal(h.sequence.some(([kind]) => kind === 'clipboard'), false);
});

// Round six: a Codex second look that cannot read the box keeps the record.
test('a Codex second look that cannot read the box refuses and keeps the record', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const codex = frozenCodex(h);
  let blind = false;
  let armed = false;
  const draw = h.deps.readPane;
  h.deps.readPane = async (...args) => { if (blind) throw new Error('pane unreadable'); return draw(...args); };
  // The send keeps the sleep it was made with, so the hook goes in first.
  h.deps.sleep = async (ms) => { if (armed && ms === 1000) blind = true; };
  const send = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  await assert.rejects(send.send({ sessionId: 'pane:pane-1', provider: 'codex', text: 'first message', pane: target }));
  codex.frozen = false;
  codex.echoed.push('it drew something'); // the box is empty, and the frame changed
  armed = true;
  await assert.rejects(
    send.send({ sessionId: 'pane:pane-1', provider: 'codex', text: 'second message', pane: target }),
    (error) => error.code === 'EARLIER_TYPING_UNRESOLVED' || /pane unreadable|no readable box/.test(error.message),
  );
  assert.equal(typed(h).filter((x) => x.includes('second message')).length, 0, 'nothing typed');
});

// Round six: an agent's (strict) send never crosses a Claude /clear.
test('a strict send to a session the inbox registry marks cleared types nothing; a plain send still types', async () => {
  const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-strict-inbox-'));
  const saved = process.env.HARBOR_INBOX_DIR;
  process.env.HARBOR_INBOX_DIR = inboxDir;
  try {
    const peer = require('../../src/shared/peer-inbox.cjs');
    const OLD = '0a1b2c3d-1111-2222-3333-444455556666';
    const NEW = '0a1b2c3d-9999-2222-3333-444455556666';
    const pipe = '\\\\.\\pipe\\LOCAL\\cc-msg-00000000000000000000000000000000';
    const token = 'ab'.repeat(16);
    assert.equal((await peer.writeRecord({ sessionId: OLD, socket: pipe, token })).written, true);
    await peer.writeRecord({ sessionId: NEW, socket: pipe, token }); // the pane ran /clear
    assert.equal(peer.lookup(OLD)?.clearedInto, NEW);
    const h = makeHarness({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', agent_session: { kind: 'id', value: OLD } }], controlled: 'pane-1' });
    composerPane(h);
    const send = createSessionSend(h.deps);
    const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
    await assert.rejects(
      send.send({ sessionId: OLD, text: 'for the old conversation', pane: target, strictTarget: true }),
      (error) => error.code === 'SESSION_CLEARED' && error.clearedInto === NEW,
    );
    assert.deepEqual(typed(h), []);
    const plain = await send.send({ sessionId: OLD, text: 'Pat typing into the window he sees', pane: target });
    assert.equal(plain.ok, true);
  } finally {
    if (saved === undefined) delete process.env.HARBOR_INBOX_DIR; else process.env.HARBOR_INBOX_DIR = saved;
  }
});

// Round six: the chip count to beat must be readable, or the image goes by path.
// Round twenty-nine: the old fallback (the path prepended to the text) let a
// path Claude left as text through; an unreadable prompt now refuses.
test('an image whose prompt cannot be read is refused before anything is written, by clipboard or by path', async () => {
  for (const clipboard of [true, false]) {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    if (!clipboard) delete h.deps.pasteClaudeImagesFromClipboard;
    composerPane(h, { pathChips: 'whole-line' });
    const draw = h.deps.readPane;
    // The image reads are the ones without a source (readPane(paneId, lines));
    // screen reads for the prompt name one ('recent' or 'visible').
    h.deps.readPane = async (paneId, lines, source) => { if (source === undefined) throw new Error('unreadable'); return draw(paneId, lines, source); };
    const send = createSessionSend(h.deps);
    await assert.rejects(
      send.send({ sessionId: 's-img', text: 'look', images: ['/cache/shot.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
      (error) => error.code === 'IMAGE_PROMPT_UNREADABLE',
    );
    assert.equal(h.sequence.some(([kind]) => kind === 'clipboard'), false, 'the clipboard untouched');
    assert.deepEqual(typed(h), [], `${clipboard ? 'clipboard' : 'path'} route: nothing written`);
  }
});

// Round seven: a strict send checks for /clear before anything, resume included.
test('a strict send to a cleared session with no pane resumes nothing', async () => {
  const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-strict-inbox-'));
  const saved = process.env.HARBOR_INBOX_DIR;
  process.env.HARBOR_INBOX_DIR = inboxDir;
  try {
    const peer = require('../../src/shared/peer-inbox.cjs');
    const OLD = '0a1b2c3d-1111-2222-3333-444455556666';
    const NEW = '0a1b2c3d-9999-2222-3333-444455556666';
    const pipe = '\\\\.\\pipe\\LOCAL\\cc-msg-11111111111111111111111111111111';
    const token = 'ab'.repeat(16);
    await peer.writeRecord({ sessionId: OLD, socket: pipe, token });
    await peer.writeRecord({ sessionId: NEW, socket: pipe, token });
    const h = makeHarness({ panes: [] });
    const send = createSessionSend(h.deps);
    await assert.rejects(
      send.send({ sessionId: OLD, text: 'for the old conversation', strictTarget: true }),
      (error) => error.code === 'SESSION_CLEARED' && error.clearedInto === NEW,
    );
    assert.deepEqual(h.resumeCalls, [], 'no resume was launched');
  } finally {
    if (saved === undefined) delete process.env.HARBOR_INBOX_DIR; else process.env.HARBOR_INBOX_DIR = saved;
  }
});

// Round seven: only a chip in the COMPOSER confirms a paste or ends a debt.
test('an image chip in the conversation output neither confirms the paste nor ends its debt', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let pasted = false;
  // After the paste the model's output above the prompt shows "[Image #5]",
  // while the prompt itself (drawn by the harness) never gets a chip.
  h.deps.readPane = async () => `${pasted ? '● Here is [Image #5] again' : 'conversation'}\n${PROMPT_RULE}\n❯ \n${PROMPT_RULE}`;
  const base = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => { const result = base(paneId, text); if (text === IMAGE_PASTE) pasted = true; return result; };
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.send({ sessionId: 's-img', text: 'see', images: ['/cache/one.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    /never confirmed the image|drew nothing/,
  );
  const debts = path.join(path.dirname(h.deps.sendLogFile), 'pane-locks', 'clipboard-debts');
  assert.equal(fs.readdirSync(debts).filter((name) => name.endsWith('.json')).length, 1, 'the debt stands');
});

// Rounds eight to ten: a /clear landing while a strict send works toward a
// resume can never reopen the session, because a strict send never resumes.
test('a strict send whose session is cleared while it works toward a resume launches nothing', async () => {
  const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-strict-inbox-'));
  const saved = process.env.HARBOR_INBOX_DIR;
  process.env.HARBOR_INBOX_DIR = inboxDir;
  try {
    const peer = require('../../src/shared/peer-inbox.cjs');
    const OLD = '0a1b2c3d-1111-2222-3333-444455556666';
    const NEW = '0a1b2c3d-9999-2222-3333-444455556666';
    const pipe = '\\\\.\\pipe\\LOCAL\\cc-msg-22222222222222222222222222222222';
    const token = 'ab'.repeat(16);
    await peer.writeRecord({ sessionId: OLD, socket: pipe, token });
    const h = makeHarness({ panes: [] });
    const meta = h.deps.getSessionMeta;
    let cleared = false;
    h.deps.getSessionMeta = async (...args) => {
      // The /clear lands after the send's first check, while it works toward the resume.
      if (!cleared) { cleared = true; await peer.writeRecord({ sessionId: NEW, socket: pipe, token }); }
      return meta(...args);
    };
    const send = createSessionSend(h.deps);
    await assert.rejects(
      send.send({ sessionId: OLD, text: 'for the old conversation', strictTarget: true }),
      (error) => error.code === 'SESSION_CLEARED' || error.code === 'NO_LIVE_PANE',
    );
    assert.deepEqual(h.resumeCalls, [], 'no resume was launched');
  } finally {
    if (saved === undefined) delete process.env.HARBOR_INBOX_DIR; else process.env.HARBOR_INBOX_DIR = saved;
  }
});

// Round eight: baseline and confirmation read the same scope (the composer).
test('a chip number quoted in the conversation does not make a real attachment look old', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.readPane = async () => `● The earlier screenshot was [Image #50]\n${PROMPT_RULE}\n❯ \n${PROMPT_RULE}`;
  const base = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => { const result = base(paneId, text); if (text === IMAGE_PASTE) h.prompt.draft += '[Image #3] '; return result; };
  const send = createSessionSend(h.deps);
  const result = await send.send({ sessionId: 's-img', text: 'here it is', images: ['/cache/shot.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.equal(result.ok, true);
  assert.ok(h.sequence.some(([kind]) => kind === 'clipboard'), 'it went through the clipboard, not by path');
  const debts = path.join(path.dirname(h.deps.sendLogFile), 'pane-locks', 'clipboard-debts');
  assert.equal(fs.existsSync(debts) ? fs.readdirSync(debts).filter((n) => n.endsWith('.json')).length : 0, 0, 'no debt left behind');
});

// Round nine: the /clear check runs after the last pane lookup before a launch.
test('a strict send whose session is cleared during the final pane lookup launches nothing', async () => {
  const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-strict-inbox-'));
  const saved = process.env.HARBOR_INBOX_DIR;
  process.env.HARBOR_INBOX_DIR = inboxDir;
  try {
    const peer = require('../../src/shared/peer-inbox.cjs');
    const OLD = '0a1b2c3d-1111-2222-3333-444455556666';
    const NEW = '0a1b2c3d-9999-2222-3333-444455556666';
    const pipe = '\\\\.\\pipe\\LOCAL\\cc-msg-33333333333333333333333333333333';
    const token = 'ab'.repeat(16);
    await peer.writeRecord({ sessionId: OLD, socket: pipe, token });
    const h = makeHarness({ panes: [] });
    const meta = h.deps.getSessionMeta;
    let metaCalls = 0;
    let armed = false;
    h.deps.getSessionMeta = async (...args) => { metaCalls += 1; if (metaCalls === 2) armed = true; return meta(...args); };
    const snapshot = h.deps.snapshot;
    h.deps.snapshot = async (...args) => {
      // The resume branch's own lookup: the /clear lands while it runs.
      if (armed) { armed = false; await peer.writeRecord({ sessionId: NEW, socket: pipe, token }); }
      return snapshot(...args);
    };
    const send = createSessionSend(h.deps);
    await assert.rejects(
      send.send({ sessionId: OLD, text: 'for the old conversation', strictTarget: true }),
      (error) => error.code === 'SESSION_CLEARED' || error.code === 'NO_LIVE_PANE',
    );
    assert.deepEqual(h.resumeCalls, [], 'no resume was launched');
  } finally {
    if (saved === undefined) delete process.env.HARBOR_INBOX_DIR; else process.env.HARBOR_INBOX_DIR = saved;
  }
});

// Round ten: an agent's message never reopens a session; Pat's still does.
test('a strict send with no live pane is refused and launches nothing; a plain send resumes', async () => {
  const h = makeHarness({ panes: [] });
  h.deps.readPane = async () => '  ready\n──────────────\n❯\n──────────────\n  opus 5 xhigh\n  hint';
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.send({ sessionId: 'sess-closed', text: 'from another agent', strictTarget: true }),
    (error) => error.code === 'NO_LIVE_PANE',
  );
  assert.deepEqual(h.resumeCalls, [], 'nothing launched for the agent');
  await send.send({ sessionId: 'sess-closed', text: 'from Pat', resumeOnly: true }).catch(() => {});
  assert.equal(h.resumeCalls.length, 1, 'Pat\'s own send still resumes');
});

// Round nine: the image checks read the wide frame.
test('a paste that makes the prompt box one line taller is still confirmed', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const conversation = Array.from({ length: 6 }, (_, i) => `line ${i + 1}`).join('\n');
  // Thirteen lines drawn UNDER the prompt (status line, background tasks):
  // before the paste the 3-line box plus these is exactly 16 lines; the chip
  // wraps the box to 4, and a 16-line read loses its top edge.
  const below = Array.from({ length: 13 }, (_, i) => `  status ${i + 1}`).join('\n');
  let pasted = false;
  // Like the desktop's reader: a frame is cut to the LAST n lines (16 by default).
  h.deps.readPane = async (paneId, lines = 16) => {
    const prompt = pasted ? `${PROMPT_RULE}\n❯ [Image #1] a caption long enough\n  that it wraps\n${PROMPT_RULE}` : `${PROMPT_RULE}\n❯ \n${PROMPT_RULE}`;
    return `${conversation}\n${prompt}\n${below}`.split('\n').slice(-lines).join('\n');
  };
  const base = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => { const result = base(paneId, text); if (text === IMAGE_PASTE) pasted = true; return result; };
  const send = createSessionSend(h.deps);
  await send.send({ sessionId: 's-tall', text: 'see', images: ['/cache/shot.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }).catch(() => {});
  const debts = path.join(path.dirname(h.deps.sendLogFile), 'pane-locks', 'clipboard-debts');
  assert.ok(h.sequence.some(([kind]) => kind === 'clipboard'), 'pasted through the clipboard');
  assert.equal(fs.existsSync(debts) ? fs.readdirSync(debts).filter((n) => n.endsWith('.json')).length : 0, 0, 'the chip was seen: no debt left');
});

// Round eleven: a screenshot paste the pane has not read blocks new writes.
test('a text send never rides behind a screenshot paste the pane has not read', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const claude = frozenClaude(h);
  const send = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  await assert.rejects(send.send({ sessionId: 's-shot', text: 'see this', images: ['/cache/shot.png'], pane: target }));
  // Still frozen: the next message waits, then refuses, typing nothing.
  await assert.rejects(
    send.send({ sessionId: 's-shot', text: 'an unrelated message', pane: target }),
    (error) => error.code === 'EARLIER_IMAGE_UNRESOLVED',
  );
  assert.deepEqual(typed(h), [IMAGE_PASTE], 'only the earlier paste');
  // Claude wakes and draws the screenshot in its prompt: refused until it is sent or cleared.
  claude.screen = `conversation\n${PROMPT_RULE}\n❯ [Image #1] \n${PROMPT_RULE}\n  ⏵⏵ bypass permissions on`;
  await assert.rejects(
    send.send({ sessionId: 's-shot', text: 'an unrelated message', pane: target }),
    (error) => error.code === 'EARLIER_IMAGE_IN_PROMPT',
  );
  // Round twelve: a plain retry is refused too while the screenshot sits there.
  await assert.rejects(
    send.send({ sessionId: 's-shot', text: 'an unrelated message', pane: target }),
    (error) => error.code === 'EARLIER_IMAGE_IN_PROMPT',
  );
  assert.deepEqual(typed(h), [IMAGE_PASTE]);
  // Pat sends or clears it: the prompt no longer holds the chip, and the pane is free.
  claude.screen = `conversation\n${PROMPT_RULE}\n❯ \n${PROMPT_RULE}\n  ⏵⏵ bypass permissions on`;
  await send.send({ sessionId: 's-shot', text: 'an unrelated message', pane: target }).catch(() => {});
  assert.ok(typed(h).includes('an unrelated message'), 'typed once the screenshot left the prompt');
});

test('a screenshot paste the pane drew past and lost no longer blocks it', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const claude = frozenClaude(h);
  const send = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  await assert.rejects(send.send({ sessionId: 's-shot', text: 'see this', images: ['/cache/shot.png'], pane: target }));
  claude.screen = claude.screen.replace('4m 11s', '4m 40s'); // it drew; the prompt is still empty
  await send.send({ sessionId: 's-shot', text: 'the next message', pane: target }).catch(() => {});
  assert.ok(typed(h).includes('the next message'), 'typed once the paste was shown to be lost');
});

// Round eleven: the strict target is checked again at the input boundary.
test('a /clear that lands after the in-lock check stops a strict send before its first keystroke', async () => {
  const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-strict-inbox-'));
  const saved = process.env.HARBOR_INBOX_DIR;
  process.env.HARBOR_INBOX_DIR = inboxDir;
  try {
    const peer = require('../../src/shared/peer-inbox.cjs');
    const OLD = '0a1b2c3d-1111-2222-3333-444455556666';
    const NEW = '0a1b2c3d-9999-2222-3333-444455556666';
    const h = makeHarness({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', agent_session: { kind: 'id', value: OLD } }], controlled: 'pane-1' });
    composerPane(h);
    // The delivery starts (inside the lock, after its check); the /clear lands now.
    h.deps.terminalBridge.holdControl = () => {
      fs.mkdirSync(inboxDir, { recursive: true });
      fs.writeFileSync(peer.recordPath(OLD), JSON.stringify({ sessionId: OLD, clearedInto: NEW, at: Date.now() }));
    };
    const send = createSessionSend(h.deps);
    await assert.rejects(
      send.send({ sessionId: OLD, text: 'for the old conversation', pane: { paneId: 'pane-1', workspaceId: 'ws-1' }, strictTarget: true }),
      (error) => error.code === 'SESSION_CLEARED',
    );
    assert.deepEqual(typed(h), [], 'nothing typed into the new conversation');
  } finally {
    if (saved === undefined) delete process.env.HARBOR_INBOX_DIR; else process.env.HARBOR_INBOX_DIR = saved;
  }
});

// Round twelve: the draft and the target are checked on the last read before Enter.
test('a draft replaced and a /clear landing during the last read before Enter get no Enter', async () => {
  const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-strict-inbox-'));
  const saved = process.env.HARBOR_INBOX_DIR;
  process.env.HARBOR_INBOX_DIR = inboxDir;
  try {
    const peer = require('../../src/shared/peer-inbox.cjs');
    const OLD = '0a1b2c3d-1111-2222-3333-444455556666';
    const NEW = '0a1b2c3d-9999-2222-3333-444455556666';
    const h = makeHarness({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', agent_session: { kind: 'id', value: OLD } }], controlled: 'pane-1' });
    composerPane(h);
    const draw = h.deps.readPane;
    let shown = 0;
    h.deps.readPane = async (...args) => {
      const frame = await draw(...args);
      if (!String(frame).includes('for the old conversation')) return frame;
      shown += 1;
      if (shown < 3) return frame; // the read after typing, and the hold check
      // The read just before Enter: /clear ran, and the box holds the new conversation's draft.
      fs.mkdirSync(inboxDir, { recursive: true });
      fs.writeFileSync(peer.recordPath(OLD), JSON.stringify({ sessionId: OLD, clearedInto: NEW, at: Date.now() }));
      return `conversation\n${PROMPT_RULE}\n❯ the new conversation's own draft\n${PROMPT_RULE}`;
    };
    const send = createSessionSend(h.deps);
    await assert.rejects(
      send.send({ sessionId: OLD, text: 'for the old conversation', pane: { paneId: 'pane-1', workspaceId: 'ws-1' }, strictTarget: true }),
      (error) => error.code === 'DRAFT_CHANGED' || error.code === 'SESSION_CLEARED',
    );
    assert.equal(typed(h).filter((x) => x === '\r').length, 0, 'no Enter');
  } finally {
    if (saved === undefined) delete process.env.HARBOR_INBOX_DIR; else process.env.HARBOR_INBOX_DIR = saved;
  }
});

// Round twelve: a strict refusal before typing leaves no record of typing.
test('a strict send refused before its first keystroke leaves no pending record', async () => {
  const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-strict-inbox-'));
  const saved = process.env.HARBOR_INBOX_DIR;
  process.env.HARBOR_INBOX_DIR = inboxDir;
  try {
    const peer = require('../../src/shared/peer-inbox.cjs');
    const OLD = '0a1b2c3d-1111-2222-3333-444455556666';
    const NEW = '0a1b2c3d-9999-2222-3333-444455556666';
    const h = makeHarness({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', agent_session: { kind: 'id', value: OLD } }], controlled: 'pane-1' });
    composerPane(h);
    h.deps.terminalBridge.holdControl = () => {
      fs.mkdirSync(inboxDir, { recursive: true });
      fs.writeFileSync(peer.recordPath(OLD), JSON.stringify({ sessionId: OLD, clearedInto: NEW, at: Date.now() }));
    };
    const send = createSessionSend(h.deps);
    await assert.rejects(
      send.send({ sessionId: OLD, text: 'for the old conversation', pane: { paneId: 'pane-1', workspaceId: 'ws-1' }, strictTarget: true }),
      (error) => error.code === 'SESSION_CLEARED',
    );
    assert.equal(fs.existsSync(path.join(path.dirname(h.deps.sendLogFile), 'pane-locks', 'pane-1.pending.json')), false);
  } finally {
    if (saved === undefined) delete process.env.HARBOR_INBOX_DIR; else process.env.HARBOR_INBOX_DIR = saved;
  }
});

// Round thirteen: the draft at Enter is the draft the hold verified, attachments included.
test('a screenshot chip drawn in front of the message before Enter stops the Enter', async () => {
  for (const from of [2, 3]) { // 2: at the hold's read; 3: at the last read before Enter
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    composerPane(h);
    const draw = h.deps.readPane;
    let shown = 0;
    h.deps.readPane = async (...args) => {
      const frame = await draw(...args);
      if (!String(frame).includes('intended reply')) return frame;
      shown += 1;
      // The composer draws its glyph with a no-break space, the echo above it with a plain one.
      return shown < from ? frame : String(frame).replace(/❯([ \u00a0])(?![\s\S]*❯[ \u00a0])/, '❯$1[Image #99] ');
    };
    const send = createSessionSend(h.deps);
    await assert.rejects(
      send.send({ sessionId: 's-chip', text: 'intended reply', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
      (error) => error.code === 'DRAFT_CHANGED',
      `chip from read ${from}`,
    );
    assert.equal(typed(h).filter((x) => x === '\r').length, 0, `no Enter (chip from read ${from})`);
  }
});

// Round thirteen: a debt whose Harbor exited before recording a screen keeps blocking a frozen pane.
test('a screenshot debt with no screen on record never ends on two identical frames', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  frozenClaude(h);
  const debts = path.join(path.dirname(h.deps.sendLogFile), 'pane-locks', 'clipboard-debts');
  fs.mkdirSync(debts, { recursive: true });
  fs.writeFileSync(path.join(debts, 'pane-1.json'), JSON.stringify({ beforeMax: 0 }));
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.send({ sessionId: 's-restart', text: 'an unrelated message', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'EARLIER_IMAGE_UNRESOLVED',
  );
  assert.deepEqual(typed(h), [], 'nothing typed behind the queued chord');
  const debt = JSON.parse(fs.readFileSync(path.join(debts, 'pane-1.json'), 'utf8'));
  assert.ok(debt.screen, 'the first read is now the debt\'s baseline');
});

// Round thirteen: Codex's spare Enter checks the target too.
// Round twenty-one: the registry's two-week cleanup keeps /clear markers.
test('an agent\'s message to a session cleared a month ago is still refused after the registry cleanup', async () => {
  const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-strict-inbox-'));
  const saved = process.env.HARBOR_INBOX_DIR;
  process.env.HARBOR_INBOX_DIR = inboxDir;
  try {
    const peer = require('../../src/shared/peer-inbox.cjs');
    const OLD = '0a1b2c3d-1111-2222-3333-444455556666';
    const NEW = '0a1b2c3d-9999-2222-3333-444455556666';
    const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    fs.writeFileSync(peer.recordPath(OLD), JSON.stringify({ sessionId: OLD, clearedInto: NEW, at: monthAgo }));
    await peer.pruneRecords({ HARBOR_INBOX_DIR: inboxDir });
    // The Claude pane still advertises its launch id after /clear.
    const h = makeHarness({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', agent_session: { kind: 'id', value: OLD } }], controlled: 'pane-1' });
    composerPane(h);
    const send = createSessionSend(h.deps);
    await assert.rejects(
      send.send({ sessionId: OLD, text: 'for the old conversation', pane: { paneId: 'pane-1', workspaceId: 'ws-1' }, strictTarget: true }),
      (error) => error.code === 'SESSION_CLEARED',
    );
    assert.deepEqual(typed(h), [], 'nothing typed into the new conversation');
  } finally {
    if (saved === undefined) delete process.env.HARBOR_INBOX_DIR; else process.env.HARBOR_INBOX_DIR = saved;
  }
});

// Round twenty-two: a resume of the old session in another process does not make the cleared pane hold it.
test('an agent\'s message is not typed into the cleared pane while the old session runs, or ran, elsewhere', async () => {
  const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-strict-inbox-'));
  const saved = process.env.HARBOR_INBOX_DIR;
  process.env.HARBOR_INBOX_DIR = inboxDir;
  try {
    const peer = require('../../src/shared/peer-inbox.cjs');
    const OLD = '0a1b2c3d-1111-2222-3333-444455556666';
    const NEW = '0a1b2c3d-9999-2222-3333-444455556666';
    const env = { HARBOR_INBOX_DIR: inboxDir };
    const pipe = (n) => `\\\\.\\pipe\\LOCAL\\cc-msg-${String(n).repeat(32)}`;
    await peer.writeRecord({ sessionId: OLD, socket: pipe(1), token: 'ab'.repeat(16) }, env);
    await peer.writeRecord({ sessionId: NEW, socket: pipe(1), token: 'ab'.repeat(16) }, env);
    await peer.writeRecord({ sessionId: OLD, socket: pipe(2), token: 'ab'.repeat(16) }, env); // resumed elsewhere
    for (const stage of ['while it runs elsewhere', 'after that process exited']) {
      if (stage === 'after that process exited') await peer.dropRecord(OLD, env, { socket: pipe(2) });
      const h = makeHarness({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', agent_session: { kind: 'id', value: OLD } }], controlled: 'pane-1' });
      composerPane(h);
      const send = createSessionSend(h.deps);
      await assert.rejects(
        send.send({ sessionId: OLD, text: 'for the old conversation', pane: { paneId: 'pane-1', workspaceId: 'ws-1' }, strictTarget: true }),
        (error) => error.code === 'SESSION_CLEARED',
        stage,
      );
      assert.deepEqual(typed(h), [], `nothing typed into the new conversation (${stage})`);
    }
  } finally {
    if (saved === undefined) delete process.env.HARBOR_INBOX_DIR; else process.env.HARBOR_INBOX_DIR = saved;
  }
});

// Round twenty-three: a second process clearing and resuming the session keeps the first pane's marker.
test('an agent\'s message is not typed into the cleared pane after another process cleared and resumed the session', async () => {
  const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-strict-inbox-'));
  const saved = process.env.HARBOR_INBOX_DIR;
  process.env.HARBOR_INBOX_DIR = inboxDir;
  try {
    const peer = require('../../src/shared/peer-inbox.cjs');
    const A = '0a1b2c3d-1111-2222-3333-444455556666';
    const B = '0a1b2c3d-9999-2222-3333-444455556666';
    const C = '0a1b2c3d-7777-2222-3333-444455556666';
    const env = { HARBOR_INBOX_DIR: inboxDir };
    const pipe = (n) => `\\\\.\\pipe\\LOCAL\\cc-msg-${String(n).repeat(32)}`;
    const token = 'ab'.repeat(16);
    await peer.writeRecord({ sessionId: A, socket: pipe(1), token }, env);
    await peer.writeRecord({ sessionId: B, socket: pipe(1), token }, env); // pane P: /clear A into B
    await peer.writeRecord({ sessionId: A, socket: pipe(2), token }, env); // process Q resumes A
    await peer.writeRecord({ sessionId: C, socket: pipe(2), token }, env); // Q: /clear A into C
    await peer.writeRecord({ sessionId: A, socket: pipe(2), token }, env); // Q resumes A again
    await peer.dropRecord(A, env, { socket: pipe(2) }); // Q exits
    const h = makeHarness({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', agent_session: { kind: 'id', value: A } }], controlled: 'pane-1' });
    composerPane(h);
    const send = createSessionSend(h.deps);
    await assert.rejects(
      send.send({ sessionId: A, text: 'for the old conversation', pane: { paneId: 'pane-1', workspaceId: 'ws-1' }, strictTarget: true }),
      (error) => error.code === 'SESSION_CLEARED',
    );
    assert.deepEqual(typed(h), [], 'nothing typed into pane P, which runs B');
  } finally {
    if (saved === undefined) delete process.env.HARBOR_INBOX_DIR; else process.env.HARBOR_INBOX_DIR = saved;
  }
});

test('a /clear landing after a Codex Enter stops the spare Enter of a strict send', async () => {
  const inboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-strict-inbox-'));
  const saved = process.env.HARBOR_INBOX_DIR;
  process.env.HARBOR_INBOX_DIR = inboxDir;
  try {
    const peer = require('../../src/shared/peer-inbox.cjs');
    const OLD = '0a1b2c3d-1111-2222-3333-444455556666';
    const NEW = '0a1b2c3d-9999-2222-3333-444455556666';
    const h = makeHarness({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', agent_session: { kind: 'id', value: OLD } }], controlled: 'pane-1' });
    codexPane(h, { swallowEnters: 1, burstReads: 2 });
    const base = h.deps.terminalBridge.sendInput;
    let enters = 0;
    h.deps.terminalBridge.sendInput = (paneId, text) => {
      const result = base(paneId, text);
      if (text === '\r' && ++enters === 1) {
        fs.mkdirSync(inboxDir, { recursive: true });
        fs.writeFileSync(peer.recordPath(OLD), JSON.stringify({ sessionId: OLD, clearedInto: NEW, at: Date.now() }));
      }
      return result;
    };
    const send = createSessionSend(h.deps);
    const text = `Reply with just OK. ${proofWords.repeat(6)}marker`;
    await assert.rejects(
      send.send({ sessionId: OLD, text, provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' }, strictTarget: true }),
      (error) => error.code === 'SESSION_CLEARED',
    );
    assert.equal(typed(h).filter((x) => x === '\r').length, 1, 'no spare Enter into the new conversation');
  } finally {
    if (saved === undefined) delete process.env.HARBOR_INBOX_DIR; else process.env.HARBOR_INBOX_DIR = saved;
  }
});

// Round thirty: a picture's caption that starts with "/" is a message, not a command.
test('a picture captioned with a leading slash is typed and checked as a message', async () => {
  const caption = '/compact is visible in this screenshot';
  for (const dropCaption of [true, false]) {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    const pane = composerPane(h, { dropTypings: dropCaption ? 1 : 0 });
    const send = createSessionSend(h.deps);
    const message = { sessionId: 's-slash-cap', text: caption, images: ['/cache/one.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } };
    if (dropCaption) {
      await assert.rejects(send.send(message), (error) => error.code === 'PROMPT_NEVER_HELD');
      assert.equal(typed(h).filter((x) => x === '\r').length, 0, 'the picture is not submitted without its caption');
    } else {
      const result = await send.send(message);
      assert.equal(result.delivery, 'confirming', 'confirmed as a message, not best-effort');
      assert.ok(typed(h).includes(caption), 'typed whole, not split as a command token');
      assert.deepEqual(pane.echoed, [`[Image #1] ${caption}`]);
    }
  }
});

// Round twenty-nine: one failed read never routes a picture around its chip check.
test('a picture send whose prompt read fails once reads again, and still needs its chip before Enter', async () => {
  for (const converts of [false, true]) {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    delete h.deps.pasteClaudeImagesFromClipboard;
    const pane = composerPane(h, converts ? { pathChips: 'whole-line' } : {});
    const draw = h.deps.readPane;
    let failed = false;
    h.deps.readPane = async (paneId, lines, source) => {
      if (source === undefined && !failed) { failed = true; throw new Error('one unreadable frame'); }
      return draw(paneId, lines, source);
    };
    const send = createSessionSend(h.deps);
    const message = { sessionId: 's-once', text: '', images: ['C:\\cache\\shot.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } };
    if (converts) {
      const result = await send.send(message);
      assert.equal(result.delivery, 'delivered', 'read again, pasted, attached');
      assert.deepEqual(pane.echoed, ['[Image #1]']);
    } else {
      await assert.rejects(send.send(message), (error) => error.code === 'IMAGE_NOT_ATTACHED');
      assert.equal(typed(h).filter((x) => x === '\r').length, 0, 'a path left as text is never submitted');
    }
  }
});

// Round twenty-eight: a picture by path must become an attachment, and only this send's.
test('a picture no longer on disk is refused before anything is typed', async () => {
  for (const phone of [false, true]) {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    delete h.deps.pasteClaudeImagesFromClipboard;
    if (phone) delete h.deps.setXClipboardImage;
    h.deps.imageFileReady = async (imagePath) => !imagePath.endsWith('gone.png');
    composerPane(h, { pathChips: 'whole-line' });
    const send = createSessionSend(h.deps);
    await assert.rejects(
      send.send({ sessionId: 's-gone', text: 'look', images: ['C:\\cache\\here.png', 'C:\\cache\\gone.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
      (error) => error.code === 'IMAGE_MISSING',
    );
    assert.deepEqual(typed(h), [], `${phone ? 'phone' : 'desktop'}: nothing typed`);
  }
});

test('a picture path Claude leaves as text is refused with no Enter, and owes nothing afterwards', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  delete h.deps.pasteClaudeImagesFromClipboard;
  const pane = composerPane(h, {}); // this Claude converts no path
  const send = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  await assert.rejects(
    send.send({ sessionId: 's-literal', text: 'look at this', images: ['C:\\cache\\unreadable.png'], pane: target }),
    (error) => error.code === 'IMAGE_NOT_ATTACHED',
  );
  assert.equal(typed(h).filter((x) => x === '\r').length, 0, 'no Enter');
  assert.equal(typed(h).filter((x) => x === 'look at this').length, 0, 'the caption was not typed behind it');
  assert.match(pane.draft, /unreadable\.png/, 'the path is left in the prompt for Pat to clear');
  // Nothing is owed: the next send is refused at once for the draft, not held
  // waiting for a chip that will never come.
  await assert.rejects(send.send({ sessionId: 's-literal', text: 'next', pane: target }), (error) => error.code === 'PROMPT_BUSY');
});

test('a caption that is itself an image path stays text: only the attached picture becomes a chip', async () => {
  for (const phone of [false, true]) {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    delete h.deps.pasteClaudeImagesFromClipboard;
    if (phone) delete h.deps.setXClipboardImage;
    const pane = composerPane(h, { pathChips: 'whole-line' });
    const send = createSessionSend(h.deps);
    const caption = '"C:\\Users\\me\\Pictures\\other.png"';
    await send.send({ sessionId: 's-cap-path', text: caption, images: ['C:\\cache\\shot.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
    assert.deepEqual(pane.echoed, [`[Image #1]${caption}`], `${phone ? 'phone' : 'desktop'}: one attachment, the caption as written`);
  }
});

// Round twenty-seven: pictures by path with no caption are pasted, and taken by their chips.
test('pictures sent by path with no caption are pasted, so they attach, and count as delivered once their chips are submitted', async () => {
  for (const count of [1, 2]) {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    delete h.deps.setXClipboardImage;
    const pane = composerPane(h, { pathChips: 'whole-line' });
    const send = createSessionSend(h.deps);
    const shots = [PHONE_SHOT, PHONE_SHOT.replace('387201e8', '9a0b1c2d')].slice(0, count);
    const result = await send.send({ sessionId: 's-pics', text: '', images: shots, pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
    const writes = typed(h).filter((x) => x !== '\r');
    assert.equal(writes.length, count, `${count}: one write per picture`);
    assert.ok(writes.every((w) => w.startsWith('\x1b[200~')), `${count}: each path went as a paste, not typed keys`);
    assert.deepEqual(pane.echoed, [count === 1 ? '[Image #1]' : '[Image #1][Image #2]'], `${count}: the pictures were submitted attached`);
    assert.equal(result.delivery, 'delivered', `${count} picture(s): delivered`);
  }
});

test('a desktop screenshot goes by path, and Harbor never touches the clipboard', async () => {
  for (const text of ['look at this', '']) {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    delete h.deps.pasteClaudeImagesFromClipboard; // the production default
    const pane = composerPane(h, { pathChips: 'whole-line' });
    const send = createSessionSend(h.deps);
    const result = await send.send({ sessionId: 's-desk', text, images: ['C:\\Users\\me\\.cache\\harbor\\pastes\\shot.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
    assert.deepEqual(h.sequence.filter(([kind]) => kind === 'clipboard'), [], `${text || 'no caption'}: the clipboard was never written`);
    assert.equal(typed(h).filter((x) => x === IMAGE_PASTE).length, 0, 'no paste chord');
    assert.deepEqual(pane.echoed, [`[Image #1]${text}`], `${text || 'no caption'}: submitted with the picture attached`);
    assert.equal(result.delivery, text ? 'confirming' : 'delivered');
  }
});

// Round twenty-six: a captionless picture's only evidence is the Enter watch.
test('a picture with no caption that Claude never takes is reported not sent, on an open pane and after a resume', async () => {
  const cases = [
    { label: 'desktop, open pane', phone: false, resume: false },
    { label: 'phone, open pane', phone: true, resume: false },
    { label: 'desktop, after a resume', phone: false, resume: true },
  ];
  for (const c of cases) {
    for (const swallowEnters of [3, 0]) {
      const h = makeHarness({ panes: [c.resume ? 'pane-old' : 'pane-1'], controlled: c.resume ? null : 'pane-1' });
      if (c.phone) delete h.deps.setXClipboardImage;
      composerPane(h, { swallowEnters, ...(c.phone ? { pathChips: 'whole-line' } : {}) });
      const send = createSessionSend(h.deps);
      const message = c.resume
        ? { sessionId: 's-pic-resume', text: '', images: ['/cache/one.png'] }
        : { sessionId: 's-pic', text: '', images: [c.phone ? PHONE_SHOT : '/cache/one.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } };
      if (swallowEnters) {
        await assert.rejects(send.send(message), (error) => error.code === 'NOT_TAKEN', `${c.label}: refused`);
        assert.equal(typed(h).filter((x) => x === '\r').length, 3, `${c.label}: the Enter and both spares, nothing more`);
      } else {
        const result = await send.send(message);
        assert.equal(result.delivery, 'delivered', `${c.label}: taken`);
      }
    }
  }
});

// Round twenty-four: the chip proves Claude read A clipboard image, not this one.
test('a screenshot whose clipboard was replaced before Claude read it is not submitted, and the pane stays blocked', async () => {
  for (const stillThere of [false, true]) {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    const pane = composerPane(h);
    h.deps.setXClipboardImage = async (imagePath) => {
      h.sequence.push(['clipboard', imagePath]);
      return { stillOnClipboard: async () => stillThere };
    };
    const send = createSessionSend(h.deps);
    const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
    if (stillThere) {
      await send.send({ sessionId: 's-clip', text: 'look at this', images: ['/cache/one.png'], pane: target });
      assert.deepEqual(pane.echoed, ['[Image #1] look at this'], 'the same image on the clipboard: sent');
      continue;
    }
    await assert.rejects(
      send.send({ sessionId: 's-clip', text: 'look at this', images: ['/cache/one.png'], pane: target }),
      (error) => error.code === 'CLIPBOARD_CHANGED',
    );
    assert.equal(typed(h).filter((x) => x === '\r').length, 0, 'no Enter with a picture that may not be ours');
    await assert.rejects(
      send.send({ sessionId: 's-clip', text: 'an unrelated message', pane: target }),
      (error) => error.code === 'EARLIER_IMAGE_IN_PROMPT',
    );
    assert.equal(typed(h).filter((x) => x === 'an unrelated message').length, 0, 'nothing typed behind it');
  }
});

test('the clipboard writer tells whether the clipboard still holds the image it wrote', async () => {
  const { createPlatform } = require('../../src/main/platform/index.js');
  const pixels = (n) => Buffer.alloc(16, n);
  const imageOf = (n) => ({ isEmpty: () => n === null, getSize: () => ({ width: 2, height: 2 }), toBitmap: () => pixels(n) });
  let held = null;
  const electron = {
    nativeImage: { createFromPath: () => imageOf(1) },
    clipboard: { writeImage: (image) => { held = image; }, readImage: () => held || imageOf(null) },
  };
  const platform = createPlatform('win32', { electron });
  const written = await platform.clipboardImage('C:/shot.png');
  assert.equal(await written.stillOnClipboard(), true, 'unchanged');
  held = imageOf(2);
  assert.equal(await written.stillOnClipboard(), false, 'another image copied over it');
  held = null;
  assert.equal(await written.stillOnClipboard(), false, 'text (no image) copied over it');
});

// Round fourteen: a draft Harbor did not type is never typed behind, whatever this send writes first.
test('a draft already in Claude\'s prompt is never typed behind: text, screenshot and slash command are refused', async () => {
  const messages = {
    text: { text: 'intended reply' },
    image: { text: 'look at this', images: ['/cache/one.png'] },
    slash: { text: '/effort high' },
  };
  for (const [kind, message] of Object.entries(messages)) {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    const pane = composerPane(h, { initialDraft: 'half-written note [Image #1] ', imagesBefore: 1 });
    const send = createSessionSend(h.deps);
    await assert.rejects(
      send.send({ sessionId: `s-busy-${kind}`, ...message, pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
      (error) => error.code === 'PROMPT_BUSY',
      kind,
    );
    assert.deepEqual(typed(h), [], `nothing typed (${kind})`);
    assert.equal(h.sequence.some(([what]) => what === 'clipboard'), false, `clipboard untouched (${kind})`);
    assert.equal(pane.draft, 'half-written note [Image #1] ', `the draft is left alone (${kind})`);
  }
});

// Round fourteen: a spare Enter runs the first Enter's draft test.
test('a spare Enter is not pressed once a chip is drawn in front of a swallowed message', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  composerPane(h, { swallowEnters: 1 });
  const draw = h.deps.readPane;
  h.deps.readPane = async (...args) => {
    const frame = await draw(...args);
    if (!typed(h).includes('\r')) return frame;
    // The composer draws its glyph with a no-break space, the echo above it with a plain one.
    return String(frame).replace(/❯([  ])(?![\s\S]*❯[  ])/, '❯$1[Image #99] ');
  };
  const send = createSessionSend(h.deps);
  await send.send({ sessionId: 's-spare-chip', text: 'intended reply', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }).catch(() => {});
  assert.equal(typed(h).filter((x) => x === '\r').length, 1, 'no spare Enter into the changed draft');
});

test('resending the message after that refused spare does not submit the chip in front of it', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  composerPane(h, { swallowEnters: 1 });
  const draw = h.deps.readPane;
  h.deps.readPane = async (...args) => {
    const frame = await draw(...args);
    if (!typed(h).includes('\r')) return frame;
    return String(frame).replace(/❯([  ])(?![\s\S]*❯[  ])/, '❯$1[Image #99] ');
  };
  const send = createSessionSend(h.deps);
  const text = `Please look again. ${proofWords.repeat(4)}marker`;
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  await send.send({ sessionId: 's-resend-chip', text, pane: target }).catch(() => {});
  await assert.rejects(send.send({ sessionId: 's-resend-chip', text, pane: target }));
  assert.equal(typed(h).filter((x) => x === '\r').length, 1, 'the resend pressed no Enter into the changed draft');
  assert.equal(typed(h).filter((x) => x !== '\r').length, 1, 'and typed nothing');
});

// Round fifteen: an Enter-only retry needs evidence of the whole draft.
test('resending the message after a refused spare does not submit text drawn in front of it', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  composerPane(h, { swallowEnters: 1 });
  const draw = h.deps.readPane;
  h.deps.readPane = async (...args) => {
    const frame = await draw(...args);
    if (!typed(h).includes('\r')) return frame;
    return String(frame).replace(/❯([ \u00a0])(?![\s\S]*❯[ \u00a0])/, '❯$1stranger text ');
  };
  const send = createSessionSend(h.deps);
  const text = `Please look again. ${proofWords.repeat(4)}marker`;
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  await send.send({ sessionId: 's-resend-text', text, pane: target }).catch(() => {});
  await assert.rejects(send.send({ sessionId: 's-resend-text', text, pane: target }));
  assert.equal(typed(h).filter((x) => x === '\r').length, 1, 'the resend pressed no Enter into the changed draft');
  assert.equal(typed(h).filter((x) => x !== '\r').length, 1, 'and typed nothing');
});

test('a message that showed up late behind other text is not submitted by the resend', async () => {
  const message = 'line one of the handoff\nline two of the handoff\nline three of the handoff';
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1', promptEchoes: false });
  let released = false;
  h.deps.readPane = async () => {
    const shown = released ? `stranger text ${message.split('\n').join('\n  ')}` : '';
    return `${PROMPT_RULE}\n❯ ${shown}\n${PROMPT_RULE}\n  personal  ·  Opus 5.5`;
  };
  const send = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  await assert.rejects(send.send({ sessionId: 's-late-behind', text: message, pane: target }), (e) => e.code === 'PROMPT_NEVER_HELD');
  released = true;
  await assert.rejects(send.send({ sessionId: 's-late-behind', text: message, pane: target }), (e) => e.code === 'PROMPT_HOLDS_MORE');
  assert.equal(typed(h).filter((x) => x === '\r').length, 0, 'no Enter');
});

// Round fifteen: a screenshot with no caption gets the last look before its Enter too.
test('text drawn after a caption-less screenshot at any read before Enter is never submitted', async () => {
  for (const provider of ['claude', 'codex']) {
    const reads = provider === 'claude' ? 4 : 3; // chip reads before the Enter; the last is the final check
    for (let from = 1; from <= reads; from += 1) {
      const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
      if (provider === 'claude') composerPane(h); else codexPane(h);
      const draw = h.deps.readPane;
      let shown = 0;
      h.deps.readPane = async (...args) => {
        const frame = String(await draw(...args));
        const line = provider === 'claude' ? /(❯[ \u00a0][^\n]*\[Image #1\])/ : /(› [^\n]*\[Image #1\])(?![\s\S]*› )/;
        if (!line.test(frame)) return frame;
        shown += 1;
        return shown < from ? frame : frame.replace(line, '$1 stranger text');
      };
      const send = createSessionSend(h.deps);
      const image = provider === 'claude' ? '/cache/one.png' : 'C:/virtual/example.png';
      await send.send({ sessionId: `s-bare-${provider}`, text: '', images: [image], provider, pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }).catch(() => {});
      assert.equal(typed(h).filter((x) => x === '\r').length, 0, `no Enter (${provider}, text from chip read ${from})`);
    }
  }
});

// Round sixteen: chips are checked by identity, not by number. `boxEditRun`
// sends on a fresh pane and edits every frame from the `from`-th one showing
// `marker` (before the first Enter); with no edit it reports that count.
async function boxEditRun(provider, message, { marker = '[Image #1]', from = Infinity, edit = (f) => f, phone = false, paneOptions = null } = {}) {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  // `phone`: no clipboard, so images go as path lines Claude draws as chips
  // (or, with `paneOptions: {}`, leaves drawn as the paths themselves).
  if (phone) delete h.deps.setXClipboardImage;
  if (provider === 'claude') composerPane(h, paneOptions ?? (phone ? { pathChips: 'whole-line' } : {})); else codexPane(h);
  const draw = h.deps.readPane;
  let shown = 0;
  h.deps.readPane = async (...args) => {
    const frame = String(await draw(...args));
    if (typed(h).includes('\r') || !frame.includes(marker)) return frame;
    shown += 1;
    return shown < from ? frame : edit(frame);
  };
  const send = createSessionSend(h.deps);
  await send.send({ sessionId: `s-edit-${provider}`, provider, pane: { paneId: 'pane-1', workspaceId: 'ws-1' }, ...message }).catch(() => {});
  return { h, shown };
}

test('a screenshot chip replaced or dropped after it was confirmed is never submitted, captioned or not', async () => {
  const shot = (provider, n = 1) => Array.from({ length: n }, (_, i) => (provider === 'claude' ? `/cache/shot-${i}.png` : `C:/virtual/shot-${i}.png`));
  const cases = [];
  for (const provider of ['claude', 'codex']) {
    const swap = (f) => f.replace('[Image #1]', '[Image #99]');
    cases.push({ provider, label: 'no caption, swapped', message: { text: '', images: shot(provider) }, edit: swap });
    cases.push({ provider, label: 'captioned, swapped', message: { text: 'look at this', images: shot(provider) }, edit: swap });
    cases.push({ provider, label: 'no caption, one of two dropped', marker: '[Image #2]', message: { text: '', images: shot(provider, 2) }, edit: (f) => f.replace('[Image #2]', ''), lastOnly: true });
  }
  for (const c of cases) {
    const { shown, h: clean } = await boxEditRun(c.provider, c.message, { marker: c.marker });
    assert.equal(typed(clean).filter((x) => x === '\r').length, 1, `${c.provider} ${c.label}: sent when nothing changes`);
    // The hold's read and the last read before Enter (the confirmation itself is the chip's origin).
    for (const from of c.lastOnly ? [shown] : [shown - 1, shown]) {
      const { h } = await boxEditRun(c.provider, c.message, { marker: c.marker, from, edit: c.edit });
      assert.equal(typed(h).filter((x) => x === '\r').length, 0, `${c.provider} ${c.label}: no Enter (from chip read ${from} of ${shown})`);
    }
  }
});

// Round seventeen: a caption never goes without its picture.
test('a caption that lost its screenshot is never submitted: a leftover tail, a quoted marker, a phone path', async () => {
  const caption = 'please look at this screenshot of the failing build';
  const cases = [
    { label: 'tail of the caption left, chip gone', message: { text: caption, images: ['/cache/one.png'] }, edit: (f) => f.replace(`[Image #1] ${caption}`, 'this screenshot of the failing build') },
    { label: 'chip gone, caption quotes its marker', message: { text: 'compare with [Image #1] from before', images: ['/cache/one.png'] }, edit: (f) => f.replace('[Image #1] compare', 'compare') },
    { label: 'phone route, path chip gone', phone: true, message: { text: caption, images: [PHONE_SHOT] }, edit: (f) => f.replace('[Image #1]', '') },
  ];
  for (const c of cases) {
    const { shown, h: clean } = await boxEditRun('claude', c.message, { phone: c.phone });
    assert.equal(typed(clean).filter((x) => x === '\r').length, 1, `${c.label}: sent when nothing changes`);
    for (const from of [shown - 1, shown]) {
      const { h } = await boxEditRun('claude', c.message, { phone: c.phone, from, edit: c.edit });
      assert.equal(typed(h).filter((x) => x === '\r').length, 0, `${c.label}: no Enter (from chip read ${from} of ${shown})`);
    }
  }
});

// Round eighteen: the phone route's paths are matched as whole tokens, each visible one counted once.
test('a phone send missing one of its pictures is never submitted: a quoted placeholder', async () => {
  const cases = [
    {
      label: 'caption quotes a paste placeholder, path chip gone',
      message: { text: 'see [Pasted text #42 +2 lines] and check the failing build', images: [PHONE_SHOT] },
      edit: (f) => f.replace('[Image #1]', ''),
    },
    // Two paths that squash alike, left as text: no longer a case, because a
    // path Claude leaves as text is refused (round twenty-eight, its own test).
  ];
  for (const c of cases) {
    const options = { phone: true, paneOptions: c.paneOptions, marker: c.marker };
    const { shown, h: clean } = await boxEditRun('claude', c.message, options);
    assert.equal(typed(clean).filter((x) => x === '\r').length, 1, `${c.label}: sent when nothing changes`);
    for (const from of [shown - 1, shown]) {
      const { h } = await boxEditRun('claude', c.message, { ...options, from, edit: c.edit });
      assert.equal(typed(h).filter((x) => x === '\r').length, 0, `${c.label}: no Enter (from read ${from} of ${shown})`);
    }
  }
});

// Round nineteen: a caption collapsed into a paste placeholder hides its quotes.
test('a screenshot whose caption quotes its chip and is collapsed into a placeholder is sent', async () => {
  const caption = 'see [Image #1] above\nline two of the note\nline three of the note';
  const collapse = (f) => f.replace(/see \[Image #1\] above\n\s*line two of the note\n\s*line three of the note/, '[Pasted text #2 +2 lines]');
  const cases = [
    { label: 'clipboard chip', options: {}, message: { text: caption, images: ['/cache/one.png'] } },
    { label: 'phone path chip', options: { phone: true }, message: { text: caption, images: [PHONE_SHOT] } },
  ];
  for (const c of cases) {
    const { h } = await boxEditRun('claude', c.message, { ...c.options, marker: 'line three of the note', from: 1, edit: collapse });
    assert.equal(typed(h).filter((x) => x === '\r').length, 1, `${c.label}: sent`);
  }
});

// Round twenty: only the path lines Harbor added are pictures to check.
test('a screenshot whose collapsed caption names a file is sent, not taken for a second picture', async () => {
  const caption = 'line one of the note\nline two of the note\nSave this as review.png';
  const cases = [
    {
      label: 'clipboard chip',
      options: {},
      message: { text: caption, images: ['/cache/one.png'] },
      collapse: (f) => f.replace(/line one of the note\n\s*line two of the note\n\s*Save this as review\.png/, '[Pasted text #2 +2 lines]'),
    },
    {
      // This stand-in draws the caption's last line as a chip of its own.
      label: 'phone path chip',
      options: { phone: true },
      message: { text: caption, images: [PHONE_SHOT] },
      collapse: (f) => f.replace(/\[Image #1\]\[Image #2\]line one of the note\n\s*line two of the note/, '[Image #1][Pasted text #2 +2 lines]'),
    },
  ];
  for (const c of cases) {
    let collapsed = 0;
    const edit = (f) => { const out = c.collapse(f); if (out !== f) collapsed += 1; return out; };
    const { h } = await boxEditRun('claude', c.message, { ...c.options, marker: 'line two of the note', from: 1, edit });
    assert.ok(collapsed > 0, `${c.label}: the caption was drawn collapsed`);
    assert.equal(typed(h).filter((x) => x === '\r').length, 1, `${c.label}: sent`);
  }
});

test('a message that quotes a chip in its own words is sent, not taken for a stray attachment', async () => {
  for (const provider of ['claude', 'codex']) {
    const { h } = await boxEditRun(provider, { text: 'the chip reads [Image #3] in the box' });
    assert.equal(typed(h).filter((x) => x === '\r').length, 1, `${provider}: sent`);
  }
});

test('a lone paste placeholder is not taken for the earlier try of a message that never showed', async () => {
  const message = 'line one of the handoff\nline two of the handoff\nline three of the handoff';
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1', promptEchoes: false });
  let released = false;
  h.deps.readPane = async () => `${PROMPT_RULE}\n❯ ${released ? '[Pasted text #99 +2 lines]' : ''}\n${PROMPT_RULE}\n  personal  ·  Opus 5.5`;
  const send = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  await assert.rejects(send.send({ sessionId: 's-placeholder', text: message, pane: target }), (e) => e.code === 'PROMPT_NEVER_HELD');
  released = true;
  await assert.rejects(send.send({ sessionId: 's-placeholder', text: message, pane: target }));
  assert.equal(typed(h).filter((x) => x === '\r').length, 0, 'no Enter for a placeholder nothing ties to this send');
});

test('a Codex spare Enter is not pressed once other text is drawn in front of a swallowed message', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  codexPane(h, { swallowEnters: 1 });
  const draw = h.deps.readPane;
  h.deps.readPane = async (...args) => {
    const frame = await draw(...args);
    if (!typed(h).includes('\r')) return frame;
    return String(frame).replace(/› (?![\s\S]*› )/, '› stranger text ');
  };
  const send = createSessionSend(h.deps);
  await send.send({ sessionId: 's-codex-spare', text: 'Reply with just OK.', provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }).catch(() => {});
  assert.equal(typed(h).filter((x) => x === '\r').length, 1, 'no spare Enter into the changed box');
});

// Round fourteen: a recovered screenshot debt whose first frame already shows the chip says so at once.
test('a screenshot debt with no screen on record whose first frame shows the chip is in the prompt at once', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const frozen = frozenClaude(h);
  frozen.screen = frozen.screen.replace('❯ \n', '❯ [Image #1] \n');
  const debts = path.join(path.dirname(h.deps.sendLogFile), 'pane-locks', 'clipboard-debts');
  fs.mkdirSync(debts, { recursive: true });
  fs.writeFileSync(path.join(debts, 'pane-1.json'), JSON.stringify({ paneId: 'pane-1', beforeMax: 0 }));
  let waited = 0;
  const sleep = h.deps.sleep;
  h.deps.sleep = async (...args) => { waited += 1; return sleep(...args); };
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.send({ sessionId: 's-restart-chip', text: 'an unrelated message', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'EARLIER_IMAGE_IN_PROMPT',
  );
  assert.deepEqual(typed(h), [], 'nothing typed behind the screenshot');
  assert.ok(waited < 10, `no wait for a redraw (${waited} sleeps)`);
  const debt = JSON.parse(fs.readFileSync(path.join(debts, 'pane-1.json'), 'utf8'));
  assert.equal(debt.inPrompt, true, 'the clipboard is free, the pane stays blocked');
});

// Keys whose confirmation never came may have been written: never typed again
// (Sol's review, round two). A definite refusal is retried after re-taking control.
test('keys whose confirmation never came are not typed again, and the send stops with its record kept', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  composerPane(h);
  let calls = 0;
  h.deps.terminalBridge.sendInputAcked = async () => { calls += 1; return { ok: false, ambiguous: true, reason: 'no answer from the session daemon: input request timed out after 10000ms' }; };
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.send({ sessionId: 's-unconfirmed', text: 'hello there', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'INPUT_UNCONFIRMED',
  );
  assert.equal(calls, 1, 'one write, no retry');
  assert.ok(fs.existsSync(path.join(path.dirname(h.deps.sendLogFile), 'pane-locks', 'pane-1.pending.json')), 'the pending record stays, so the next send waits instead of typing again');
});

test('the record of a send is on disk BEFORE its keys go out', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  composerPane(h);
  const file = path.join(path.dirname(h.deps.sendLogFile), 'pane-locks', 'pane-1.pending.json');
  let recordedFirst = null;
  const sendInput = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    if (recordedFirst === null && text === 'hello there') recordedFirst = fs.existsSync(file);
    return sendInput(paneId, text);
  };
  const send = createSessionSend(h.deps);
  const result = await send.send({ sessionId: 's-record-first', text: 'hello there', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.equal(result.ok, true);
  assert.equal(recordedFirst, true);
  assert.equal(fs.existsSync(file), false, 'and retired once the prompt showed it');
});

test('a send whose record cannot be written types nothing', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  composerPane(h);
  // A FILE where the lock directory should be: nothing can be recorded there.
  fs.writeFileSync(path.join(path.dirname(h.deps.sendLogFile), 'pane-locks'), 'not a directory');
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.send({ sessionId: 's-unrecordable', text: 'hello there', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'PENDING_RECORD_FAILED' || error.code === 'PANE_BUSY' || /pane-locks|ENOTDIR|EEXIST/.test(error.message),
  );
  assert.deepEqual(typed(h), [], 'nothing typed');
});

test('a Claude that wakes late after the image chord gets a full window to attach it', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = composerPane(h);
  const inner = h.deps.readPane;
  let chord = false;
  let baseline = null;
  let calls = 0;
  h.deps.readPane = async (...args) => {
    if (!chord) { baseline = await inner(...args); return baseline; }
    calls += 1;
    if (calls <= 200) return baseline; // frozen past the 12 s window
    if (calls <= 250) return `${baseline}\n✻ waking`; // redraws, no marker yet
    return inner(...args);
  };
  const sendInput = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => { if (text === IMAGE_PASTE) chord = true; return sendInput(paneId, text); };
  const send = createSessionSend(h.deps);
  const result = await send.send({ sessionId: 's-img-late', text: 'look at this', images: ['/cache/one.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.equal(result.ok, true);
  assert.equal(pane.draft, '');
});

test('image marker timeout is an honest send error and text is never typed', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let tick = 0;
  h.deps.readPane = async () => `✻ Working… (${tick++}s)\nconversation\n${PROMPT_RULE}\n❯ \n${PROMPT_RULE}`;
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
//
// `pathChips` draws a pasted image path the way CLI 2.1.299 does (its paste
// handler, read from the binary 2026-10-14): the paste is split at every
// newline and at every space that starts a path, each segment that names an
// image file becomes an [Image #N] chip, and the chips come first, followed by
// the other segments joined with newlines. `initialDraft` is text an earlier
// attempt left in the prompt. `drawAfter(draft)` is text the prompt draws
// after the draft that nobody typed (Claude's completion of a trailing slash
// word); `dropTypings` loses that many typings, as a prompt that took none of
// the keys does.
const PASTE_SEGMENT_SPLIT = / (?=\/|[A-Za-z]:\\)/;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;
// `cutsLongTyping` models Claude CLI 2.1.316 on Windows (isolated probe,
// 2026-11-04): a run typed without paste markers is read in 1,024-character
// pieces and only the LAST piece reaches the prompt.
const lastTypedPiece = (text) => (text.length > 1024 ? text.slice(-(text.length % 1024 || 1024)) : text);
// `alive`: the CLI redraws on every read (a working spinner), so an unshown
// typing is LOST rather than queued behind a stall (waitForPromptToHold).
// `wrapImageChips`: the chip wraps at its space, as behind a long message.
function composerPane(h, { swallowEnters = 0, renderDelayReads = 0, pathChips = false, initialDraft = '', imagesBefore = 0, drawAfter = null, dropTypings = 0, cutsLongTyping = false, alive = false, wrapImageChips = false, wrapAt = 0 } = {}) {
  let draft = initialDraft;
  let dropped = 0;
  const state = { reads: 0 };
  let swallowed = 0;
  let images = imagesBefore;
  let hideReads = 0;
  const echoed = [];
  const divider = '─'.repeat(60);
  h.prompt.echo = false; // this stand-in draws its own prompt
  const drawPaste = (text) => {
    if (!pathChips) return text;
    // 2.1.311 and later: a line converts only when every segment of it is a
    // path; any other line stays literal (binary, read 2026-10-28).
    if (pathChips === 'whole-line') {
      const lines = text.split('\n').filter((l) => l.trim());
      const isPathLine = (l) => l.split(PASTE_SEGMENT_SPLIT).filter((s) => s.trim()).every((s) => IMAGE_FILE.test(s.trim().replace(/^"(.*)"$/, '$1')));
      const pathLines = lines.filter(isPathLine);
      if (!pathLines.length) return text;
      const chips = pathLines.flatMap((l) => l.split(PASTE_SEGMENT_SPLIT).filter((s) => s.trim())).map(() => { images += 1; return `[Image #${images}]`; }).join('');
      return `${chips}${lines.filter((l) => !isPathLine(l)).join('\n  ')}`;
    }
    const segments = text.split(PASTE_SEGMENT_SPLIT).flatMap((s) => s.split('\n')).filter((s) => s.trim());
    const isPath = (s) => IMAGE_FILE.test(s.trim().replace(/^"(.*)"$/, '$1'));
    const paths = segments.filter(isPath);
    if (!paths.length) return text;
    const chips = paths.map(() => { images += 1; return `[Image #${images}]`; }).join('');
    return `${chips}${segments.filter((s) => !isPath(s)).join('\n  ')}`;
  };
  // A submitted prompt is echoed above the box, as Claude draws it; a busy CLI
  // shows nothing new for `renderDelayReads` reads after each keystroke.
  h.deps.readPane = async () => {
    state.reads += 1;
    const typedShown = hideReads > 0 ? '' : draft;
    const after = typedShown && drawAfter ? `${typedShown}${drawAfter(typedShown)}` : typedShown;
    // `wrapAt`: the prompt cuts each row at that width, inside a word too.
    const shown = wrapAt ? after.replace(new RegExp(`(.{${wrapAt}})(?=.)`, 'g'), '$1\n  ') : after;
    if (hideReads > 0) hideReads -= 1;
    const above = echoed.map((line) => `❯ ${line}`).join('\n');
    const spinner = alive ? `✻ Working… (${state.reads}s)\n` : '';
    return `${spinner}conversation\n${above}\n${divider}\n❯ ${shown}\n${divider}\n  personal  ·  Opus 5.5\n  ⏵⏵ auto mode on`;
  };
  const sendInput = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    const result = sendInput(paneId, text);
    if (text === '\r') {
      if (swallowed < swallowEnters) swallowed += 1;
      else if (draft) { echoed.push(draft); draft = ''; }
    } else if (text === IMAGE_PASTE) {
      images += 1;
      draft += wrapImageChips ? `[Image\n  #${images}] ` : `[Image #${images}] `;
    } else if (dropped < dropTypings) {
      dropped += 1;
    } else if (text.startsWith('\x1b[200~')) {
      draft += drawPaste(text.replace(/\x1b\[20[01]~/g, ''));
      hideReads = renderDelayReads;
    } else {
      draft += cutsLongTyping ? lastTypedPiece(text) : text;
      hideReads = renderDelayReads;
    }
    return result;
  };
  return { get draft() { return draft; }, get echoed() { return echoed; }, get reads() { return state.reads; } };
}

const typed = (h) => h.sent.map(({ text }) => text);

// A Codex 0.165.0 pane, drawn the way the real one is (fixtures/codex-box): the
// transcript echoes each submitted prompt with "›", the box is the last "›"
// line with its text wrapped under it, and one footer line names the model,
// folder and thread title. On Windows a paste reaches Codex as keystrokes, so
// for `burstReads` reads after typing the box shows nothing (the paste-burst
// buffer), and `swallowEnters` Enters land inside the burst as a newline.
// `screen` replaces the whole pane (a dialog instead of the box); `dropTyping`
// loses what is typed; `reads` counts every read. A paste that is only an
// image path becomes "[Image #N] " in the box, numbered per message, as Codex's
// handle_paste_image_path draws it. `glyph` is the box's own prompt mark: "›",
// or "»" for a Codex on ultra effort, whose transcript rows keep "›" (measured
// on 0.166.0, 2026-11-05).
function codexPane(h, { swallowEnters = 0, burstReads = 0, screen = null, dropTyping = false, title = 'proof', frames = false, failUntil = null, prefill = '', initialDraft = '', working = false, dropsSymbols = false, glyph = '›' } = {}) {
  let draft = initialDraft;
  let swallowed = 0;
  let hidden = 0;
  let frame = 0;
  let images = 0;
  const echoed = [];
  const state = { reads: 0 };
  h.prompt.echo = false;
  const wrap = (text) => text.split('\n').flatMap((line) => {
    const out = [];
    for (let at = 0; at < line.length || at === 0; at += 116) out.push(line.slice(at, at + 116));
    return out;
  }).join('\n  ');
  const box = (text) => ([...text].length > 1000 ? `[Pasted Content ${[...text].length} chars]` : wrap(text));
  h.deps.readPane = async () => {
    state.reads += 1;
    if (failUntil && failUntil()) throw new Error('pane unreadable');
    if (screen) return screen;
    const shown = hidden > 0 ? '' : draft;
    if (hidden > 0) hidden -= 1;
    const above = echoed.map((text) => `› ${box(text)}\n\n• OK\n`).join('\n');
    const busy = frames ? `\n• Working (${frame += 1}s • esc to interrupt)\n` : '';
    // `prefill`: text someone else left in the box. `working`: a running turn,
    // whose footer is key hints with the context left at the right edge.
    const inBox = prefill + (shown ? box(shown) : '');
    const status = working ? `\n◦ Working (44s • esc to interrupt)\n` : busy;
    const footer = working ? `  tab to queue message${' '.repeat(80)}21% context left` : `  GPT-6.1-Sol low · ~\\dev\\proof · ${title}`;
    return `  >_ OpenAI Codex (v0.165.0)\n\n${above}${status}\n${glyph} ${inBox || (echoed.length ? 'Ask a follow-up question' : 'Ask Codex to do anything')}\n\n${footer}`;
  };
  const sendInput = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    const result = sendInput(paneId, text);
    if (screen || dropTyping) return result;
    if (text === '\r') {
      if (swallowed < swallowEnters) { swallowed += 1; draft += '\n'; } else if (draft.trim()) { echoed.push(draft.trim()); draft = ''; images = 0; }
    } else {
      // `dropsSymbols`: the real Codex 0.166.0 on Windows loses non-ASCII punctuation
      // and symbols (measured 2026-11-01; letters, accents and emoji survive).
      const pasted = text.replace(/\x1b\[20[01]~/g, '').replace(dropsSymbols ? /[\u00a0-\uffff]/gu : /(?!)/u, (ch) => (/[\p{L}\p{M}\p{N}]/u.test(ch) ? ch : ''));
      if (/^"?[^"\n]+\.(png|jpe?g|gif|webp)"?$/i.test(pasted)) { images += 1; draft += `[Image #${images}] `; } else draft += pasted;
      hidden = burstReads;
    }
    return result;
  };
  return Object.assign(state, { get draft() { return draft; }, get echoed() { return echoed; } });
}

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

// 2026-10-14, Pat from the phone: "FYI" with a screenshot sat on "sending" for
// three minutes and was refused, and the next session's first message ("What's
// the deal? Fix please", also with a screenshot) was refused while Claude
// actually submitted it. The phone server has no clipboard, so it types the
// upload's path on an "Image:" line above the message, and CLI 2.1.299 turns a
// pasted image path into an [Image #N] chip. The prompt showed the message, as
// the fixture below (the real screen with the session's prose replaced), and
// the check compared it against a path that was no longer there.
const PHONE_SHOT = 'C:\\Users\\me\\AppData\\Roaming\\harbor\\server-upload\\run-1\\387201e8.png';

test('composerSendState reads a pasted image path that Claude drew as an image chip', () => {
  const chipped = enterFixture('image-path-chip-2.1.299.txt');
  assert.equal(composerSendState(chipped, { text: `Image: ${PHONE_SHOT}\nFYI`, pasted: true }), 'holds');
  assert.equal(composerSendState(chipped, { text: `Image: ${PHONE_SHOT}\nFYA`, pasted: true }), 'pending');
  // The path left the text only because an image went in; no chip, no match.
  const unchipped = `${PROMPT_RULE}\n❯ Image:\n  FYI\n${PROMPT_RULE}\n  personal  ·  Opus 5.5`;
  assert.equal(composerSendState(unchipped, { text: `Image: ${PHONE_SHOT}\nFYI`, pasted: true }), 'pending');
  // A CLI that leaves the path as text still matches the way it always did.
  const literal = `${PROMPT_RULE}\n❯ Image: ${PHONE_SHOT}\n  FYI\n${PROMPT_RULE}\n  personal  ·  Opus 5.5`;
  assert.equal(composerSendState(literal, { text: `Image: ${PHONE_SHOT}\nFYI`, pasted: true }), 'holds');
  // Submitted: Claude echoes the chip and the text above an empty box.
  const submitted = `❯ [Image #13]Image:\n  FYI\n  ⎿  [Image #13]\n${PROMPT_EMPTY}`;
  assert.equal(composerSendState(submitted, { text: `Image: ${PHONE_SHOT}\nFYI`, pasted: true }), 'taken');
});

test('a short phone message with an image is sent when Claude draws the path as an image chip', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  delete h.deps.setXClipboardImage;
  const pane = composerPane(h, { pathChips: true, imagesBefore: 12 });
  const send = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };

  await send.send({ sessionId: 's-phone-fyi', text: 'FYI', images: [PHONE_SHOT], pane: target });
  await send.send({ sessionId: 's-phone-fyi', text: 'What\u2019s the deal? Fix please', images: [PHONE_SHOT], pane: target });

  // Each picture is pasted by itself and its chip seen before the caption is
  // typed (round twenty-eight).
  assert.deepEqual(typed(h), [
    `\x1b[200~"${PHONE_SHOT}"\x1b[201~`, 'FYI', '\r',
    `\x1b[200~"${PHONE_SHOT}"\x1b[201~`, 'What\u2019s the deal? Fix please', '\r',
  ], 'each typed once, each submitted with one Enter');
  assert.equal(pane.draft, '');
  assert.deepEqual(pane.echoed, ['[Image #13]FYI', '[Image #14]What\u2019s the deal? Fix please']);
});

// 2026-10-28, Claude Code 2.1.311: a path that shares its line with other words
// is no longer attached, so the old "Image: <path>" line reached Claude as
// literal text (drive-prompt-gate-win.js on 2.1.312: "image attached: false").
// The path on a line of its own still converts, on 2.1.299 and on 2.1.312.
test('a phone image is attached by Claude 2.1.311 and later: its path goes on a line of its own (two-sided)', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  delete h.deps.setXClipboardImage;
  const pane = composerPane(h, { pathChips: 'whole-line', imagesBefore: 12 });
  const send = createSessionSend(h.deps);

  await send.send({ sessionId: 's-phone-2-1-311', text: 'FYI', images: [PHONE_SHOT], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });

  assert.deepEqual(typed(h), [`\x1b[200~"${PHONE_SHOT}"\x1b[201~`, 'FYI', '\r']);
  assert.deepEqual(pane.echoed, ['[Image #13]FYI'], 'the image is attached and the path is gone from the message');
});

test('two phone images each get a line of their own', async () => {
  const second = PHONE_SHOT.replace('387201e8', '5c0d9a11');
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  delete h.deps.setXClipboardImage;
  const pane = composerPane(h, { pathChips: 'whole-line', imagesBefore: 2 });
  const send = createSessionSend(h.deps);
  await send.send({ sessionId: 's-phone-two', text: 'compare these', images: [PHONE_SHOT, second], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.deepEqual(typed(h), [`\x1b[200~"${PHONE_SHOT}"\x1b[201~`, `\x1b[200~"${second}"\x1b[201~`, 'compare these', '\r']);
  assert.deepEqual(pane.echoed, ['[Image #3][Image #4]compare these']);
});

// Round twenty-eight: each picture is pasted by itself, and the first paste
// needs an empty prompt (round fourteen), as the desktop's always did. A chip
// cannot say which picture it is, so an earlier try in the prompt is left for
// Pat to send or clear, and nothing is typed twice.
test('a phone image message already in the prompt is never typed again: the send is refused and the prompt left as it was', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  delete h.deps.setXClipboardImage;
  const pane = composerPane(h, { pathChips: true, initialDraft: '[Image #13]FYI', imagesBefore: 13 });
  const send = createSessionSend(h.deps);

  await assert.rejects(
    send.send({ sessionId: 's-phone-again', text: 'FYI', images: [PHONE_SHOT], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'PROMPT_BUSY',
  );
  assert.deepEqual(typed(h), [], 'nothing typed on top of it, and no Enter');
  assert.equal(pane.draft, '[Image #13]FYI', 'the earlier try is left in the prompt');
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
    return `✻ Working… (${reads}s)\nconversation\n${PROMPT_EMPTY}`;
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

// 2026-10-14: the phone server had never typed into a cdt-app pane that had run
// for 12 hours, so it called that pane "still starting up" and gave a refused
// send the three-minute wait. The daemon's spawn time decides instead.
test('a pane the daemon started long ago is not treated as starting, even by a Harbor that never typed into it', async () => {
  const longAgo = new Date(Date.now() - 12 * 60 * 60_000).toISOString();
  const justNow = new Date().toISOString();
  for (const [createdAt, starting] of [[longAgo, false], [justNow, true]]) {
    const h = makeHarness({
      panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', created_at: createdAt }],
      controlled: 'pane-1',
      promptEchoes: false,
    });
    let reads = 0;
    h.deps.readPane = async () => { reads += 1; return `✻ Working… (${reads}s)\nconversation\n${PROMPT_EMPTY}`; };
    const send = createSessionSend(h.deps);
    const details = [];
    send.emitter.on('status', (s) => { if (s.phase === 'sending' && s.detail) details.push(s.detail); });
    await assert.rejects(
      send.send({ sessionId: 's-old-pane', text: 'never shown in this prompt', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
      (error) => error.code === 'PROMPT_NEVER_HELD',
    );
    if (starting) {
      assert.ok(reads > 1000, `a pane spawned just now keeps the startup wait (${reads} reads)`);
      assert.match(details[0] || '', /still starting up/);
    } else {
      assert.ok(reads < 120, `a pane spawned 12 hours ago gives up in seconds (${reads} reads)`);
      assert.deepEqual(details, [], 'and never says Claude is starting up');
    }
  }
});

test('a Claude that draws nothing for minutes after the typing gets the message once it shows: typed once, one Enter, no refusal', async () => {
  // 2026-11-18: starved panes drew nothing for minutes; the 7.5 s wait refused,
  // the next send pasted again, and the copies stacked when Claude woke. An
  // established pane (spawned hours ago), so the wait is the stall rule's and
  // not a starting Claude's; 1,000 frozen reads is 2.5 minutes, inside the
  // three-minute stall window.
  const longAgo = new Date(Date.now() - 12 * 60 * 60_000).toISOString();
  const h = makeHarness({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', created_at: longAgo }], controlled: 'pane-1' });
  const pane = composerPane(h, { renderDelayReads: 1000 });
  const send = createSessionSend(h.deps);
  const details = [];
  send.emitter.on('status', (s) => { if (s.phase === 'sending' && s.detail) details.push(s.detail); });

  const result = await send.send({ sessionId: 's-stalled', text: NEW_SESSION_MESSAGE, pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });

  assert.equal(result.ok, true);
  assert.deepEqual(typed(h), [NEW_SESSION_MESSAGE, '\r'], 'typed once, submitted once');
  assert.equal(pane.draft, '');
  assert.ok(details.some((d) => /has not drawn anything since Harbor typed/.test(d)), 'the bar says why it is waiting');
});

test('a second send after a refusal waits for the first typing instead of typing the message again', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  // Drawing all along (alive) but slower than the whole first wait, so the
  // first send is refused and the typing lands during the second.
  const pane = composerPane(h, { renderDelayReads: 1300, alive: true });
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
  let tick = 0;
  h.deps.readPane = async () => `✻ Working… (${tick++}s)\n${PROMPT_EMPTY}`; // drawing all along: the keys are lost, not queued
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
  const pane = composerPane(h, { renderDelayReads: 1300, alive: true });
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

// 2026-11-04, Pat from the phone: "I'm in a death loop on this mobile session
// where it won't let me send messages". His message ended "Send to me via /dm",
// and Claude 2.1.316 drew the rest of the matching command after it ("/dml-log
// +3"), which only Tab takes. Harbor read that as part of the message, refused
// every send as "never shown", and each give-up let the next send type the
// message again behind the copy already there, until the prompt held three.
const GHOST_MESSAGE = 'Not sure I quite loved the back of the card (with the name and details). Can you clean that up?\n\n'
  + 'Then can you make a simple high quality animation of the front flipping over to show the detail, and shuffling '
  + 'through each of the three cards? Send it to me via /dm';
const endsInSlashWord = (draft) => (/(?:^|\s)\/[\w:.-]*$/.test(draft) ? 'l-log +3' : '');
const LONG_AGO = () => new Date(Date.now() - 12 * 60 * 60_000).toISOString();

test('a named session draws its title in the prompt box top edge, and the box is still found (2.1.321 layout)', () => {
  // 2026-11-18: the Navigator's prompt edge read "─(143) Gate decision G-107 ... ─";
  // with no plain top edge Harbor found no box and every send into it failed.
  const screen = enterFixture('titled-border-2.1.321.txt');
  const found = composerBox(screen);
  assert.ok(found, 'the box is found under a titled top edge');
  assert.equal(found.inside, 'pleaseconfirmthebuildplanforthesecondlanebeforenoon');
  assert.equal(composerSendState(screen, { text: 'please confirm the build plan for the second lane before noon' }), 'holds');
  const empty = screen.replace(/❯ .*\n/, '❯ \n');
  assert.equal(composerSendState(empty, { text: 'please confirm the build plan for the second lane before noon' }), 'pending');
  // Prose is still never an edge: a title needs box-drawing on both ends.
  const { isPromptEdgeLine, isDividerLine } = require('../../src/shared/divider.cjs');
  assert.equal(isPromptEdgeLine('── note ──'), false);
  assert.equal(isPromptEdgeLine('Some prose ─ here ─'), false);
  assert.equal(isDividerLine(screen.split('\n')[6]), false, 'dialog parsers keep the strict edge');
});

test('a prompt that draws the rest of a trailing slash word after the message holds the message (real 2.1.316 layout)', () => {
  const screen = enterFixture('slash-ghost-2.1.316.txt');
  assert.equal(composerSendState(screen, { text: GHOST_MESSAGE, pasted: true }), 'holds');
  // Only the completion's own shape is drawn: letters touching the typed word,
  // then " +N". Other words after it are text someone typed.
  const box = (inside) => `${PROMPT_RULE}\n❯ ${inside}\n${PROMPT_RULE}\n  personal  ·  Opus 5.5`;
  assert.equal(composerSendState(box('send it via /dml-log'), { text: 'send it via /dm' }), 'holds');
  assert.equal(composerSendState(box('send it via /dm +2'), { text: 'send it via /dm' }), 'holds');
  assert.equal(composerSendState(box('send it via /dm now please'), { text: 'send it via /dm' }), 'pending');
  assert.equal(composerSendState(box('send it via /dm l-log +3'), { text: 'send it via /dm' }), 'pending');
  // No slack for a message that does not end in a slash word, or a shell command.
  assert.equal(composerSendState(box('send it via email-later'), { text: 'send it via email' }), 'pending');
  assert.equal(composerSendState(`${PROMPT_RULE}\n! ls /devices\n${PROMPT_RULE}\n  ! for bash mode`, { text: '!ls /dev' }), 'pending');
});

test('a message ending in a slash word is sent once although Claude draws the rest of the command after it', async () => {
  const h = makeHarness({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', created_at: LONG_AGO() }], controlled: 'pane-1' });
  const pane = composerPane(h, { drawAfter: endsInSlashWord });
  const send = createSessionSend(h.deps);

  const result = await send.send({ sessionId: 's-ghost', text: GHOST_MESSAGE, pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });

  assert.equal(result.ok, true);
  assert.deepEqual(typed(h), [`\x1b[200~${GHOST_MESSAGE}\x1b[201~`, '\r'], 'typed once, one Enter');
  assert.deepEqual(pane.echoed, [GHOST_MESSAGE]);
});

test('a resend finds its earlier try in the prompt beside the drawn completion and presses Enter only', async () => {
  const short = 'ping me via /dm';
  const h = makeHarness({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', created_at: LONG_AGO() }], controlled: 'pane-1' });
  const pane = composerPane(h, { initialDraft: short, drawAfter: endsInSlashWord });
  const send = createSessionSend(h.deps);

  await send.send({ sessionId: 's-ghost-resend', text: short, pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });

  assert.deepEqual(typed(h), ['\r'], 'nothing typed twice');
  assert.deepEqual(pane.echoed, [short]);
});

test('sends after a refused one never type a second copy behind the text already in the prompt', async () => {
  const h = makeHarness({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', created_at: LONG_AGO() }], controlled: 'pane-1' });
  // A prompt that shows the message with something Harbor cannot read after it.
  const pane = composerPane(h, { drawAfter: () => ' ⟦unreadable⟧' });
  const send = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };

  await assert.rejects(send.send({ sessionId: 's-stack', text: GHOST_MESSAGE, pane: target }), (e) => e.code === 'PROMPT_NEVER_HELD');
  const readsAfterFirst = pane.reads;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      send.send({ sessionId: 's-stack', text: GHOST_MESSAGE, pane: target }),
      (e) => e.code === 'PROMPT_HOLDS_UNMATCHED' && /nothing was typed or sent/.test(e.message),
    );
  }
  assert.deepEqual(typed(h), [`\x1b[200~${GHOST_MESSAGE}\x1b[201~`], 'one copy typed, no Enter');
  assert.equal(pane.draft, GHOST_MESSAGE, 'the prompt holds exactly one copy');
  assert.ok(pane.reads - readsAfterFirst < 20, `refused at once, not after a three-minute wait (${pane.reads - readsAfterFirst} reads)`);
  // A different message is refused the same way, never typed behind it.
  await assert.rejects(send.send({ sessionId: 's-stack', text: 'something else entirely', pane: target }), (e) => e.code === 'PROMPT_HOLDS_UNMATCHED');
  assert.equal(typed(h).length, 1);
});

test('after a refusal, an empty prompt in a Claude that has been running a while gets the message typed fresh at once', async () => {
  const h = makeHarness({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', created_at: LONG_AGO() }], controlled: 'pane-1' });
  const pane = composerPane(h, { dropTypings: 1, alive: true });
  const send = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  const message = 'these keys were lost the first time';

  await assert.rejects(send.send({ sessionId: 's-lost-running', text: message, pane: target }), (e) => e.code === 'PROMPT_NEVER_HELD');
  const readsAfterFirst = pane.reads;
  await send.send({ sessionId: 's-lost-running', text: message, pane: target });

  assert.deepEqual(typed(h), [message, message, '\r']);
  assert.deepEqual(pane.echoed, [message]);
  assert.ok(pane.reads - readsAfterFirst < 100, `no three-minute wait for typing that is gone (${pane.reads - readsAfterFirst} reads)`);
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
  // A stable, non-shell screen: two identical reads is what "settled" means.
  const pane = codexPane(h);
  const send = createSessionSend(h.deps);
  await send.send({
    sessionId: 'pane:fresh-codex',
    text: 'the whole message must survive',
    provider: 'codex',
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });
  assert.ok(pane.reads >= 2, `a fresh pane must be READ until it settles before typing, saw ${pane.reads} reads`);
  assert.match(h.sent.map(({ text }) => text).join(''), /the whole message must survive/);
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
// 2026-11-09: over 60 s on the same box under load, past the 45 s the budget had.
test('a fresh pane that has drawn nothing yet gets the boot budget, not the busy one', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let t = 0;
  h.deps.clock = () => t;
  h.deps.sleep = async (ms) => { t += ms; };
  const order = [];
  h.deps.readPane = async () => {
    const text = t < 70_000 ? '' : 'Cursor Agent v2026.09.26\n → Plan, search, build anything';
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

test('a fresh pane that never draws anything is refused after the boot budget, and nothing is typed', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let t = 0;
  h.deps.clock = () => t;
  h.deps.sleep = async (ms) => { t += ms; };
  h.deps.readPane = async () => '';
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.send({
      sessionId: 'pane:fresh-cursor-dead',
      text: 'this must not be typed',
      provider: 'cursor',
      pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
    }),
    (error) => error.code === 'PROVIDER_NEVER_DREW' && /Harbor typed and sent nothing/.test(error.message) && /Your text is kept/.test(error.message),
  );
  assert.ok(t >= 90_000 && t < 92_000, `the refusal comes at the end of the 90 s budget, came at ${t} ms`);
  assert.deepEqual(h.sent, [], 'no byte may reach a pane that never drew');
});

test('a blank fresh pane says why the send is slow, once, after the ordinary budget', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let t = 0;
  h.deps.clock = () => t;
  h.deps.sleep = async (ms) => { t += ms; };
  h.deps.readPane = async () => (t < 40_000 ? '' : 'Cursor Agent v2026.11.05\n → Plan, search, build anything');
  const send = createSessionSend(h.deps);
  const details = [];
  send.emitter.on('status', (event) => details.push(event.detail || ''));
  await send.send({
    sessionId: 'pane:fresh-cursor-notice',
    text: 'typed after the notice',
    provider: 'cursor',
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });
  assert.equal(details.filter((detail) => /Cursor has not drawn its screen yet/.test(detail)).length, 1, details.join(' | '));
  assert.match(h.sent.map(({ text }) => text).join(''), /typed after the notice/);
});

test('a resumed cursor pane that stays blank for 70 s still gets the message', async () => {
  const h = makeHarness({ panes: [], controlled: null });
  let t = 0;
  h.deps.clock = () => t;
  h.deps.sleep = async (ms) => { t += ms; };
  let resumedAt = null;
  h.deps.readPane = async () => (resumedAt === null || t - resumedAt < 70_000 ? '' : 'Cursor Agent v2026.11.05\n → Plan, search, build anything');
  h.deps.launchActions.resumeProviderSession = async ({ id }) => { resumedAt = t; h.state.panes.push({ pane_id: 'pane-fresh', workspace_id: 'ws-1', agent_session: { kind: 'id', value: id } }); };
  h.deps.getSessionMeta = async () => ({ cwd: '/home/x/dev/harbor', provider: 'cursor' });
  const send = createSessionSend(h.deps);
  const res = await send.send({ sessionId: 's-cursor-slow', text: 'after a slow resume', provider: 'cursor' });
  assert.equal(res.resumed, true);
  assert.match(h.sent.filter((s) => s.paneId === 'pane-fresh').map((s) => s.text).join(''), /after a slow resume/);
});

// The Resume buttons (desktop index.js, phone compose.js) call this with no
// options, so the boot budget has to be the default (2026-11-09 review).
test('waitForProviderReady with no options waits out a blank resumed pane for 70 s', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let t = 0;
  h.deps.clock = () => t;
  h.deps.sleep = async (ms) => { t += ms; };
  h.deps.readPane = async () => (t < 70_000 ? '' : 'Cursor Agent v2026.11.05\n → Plan, search, build anything');
  const send = createSessionSend(h.deps);
  assert.equal(await send.waitForProviderReady('pane-1'), true);
  assert.ok(t >= 70_000 && t < 75_000, `ready once drawn and settled, at ${t} ms`);
});

test('a fresh pane that is drawing but never settles still gives up on the old 15 s budget', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let t = 0;
  h.deps.clock = () => t;
  h.deps.sleep = async (ms) => { t += ms; };
  let typedAt = null;
  // Mid-turn output: never two identical reads.
  codexPane(h, { frames: true });
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
  codexPane(h, { failUntil: () => { if (t >= 16_000) return false; gateReads += 1; return true; } });
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
  const pane = codexPane(h);
  const send = createSessionSend(h.deps);
  await send.send({
    sessionId: 'pane:unresolved',
    text: 'this is a codex session even though nobody said so',
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });
  assert.ok(pane.reads >= 2, `an unresolved provider must still settle, saw ${pane.reads} reads`);
});

// Codex 0.159.3 can draw an account-security banner over an EMPTY composer that
// takes a bare `1` keypress as "Set up security" (actionable_banner.rs
// handle_inline_banner_key: empty composer, no paste burst, digit 1..N). A
// single-line message typed raw that starts with "1" lost its first character
// to the banner. A bracketed paste is a Paste event, never a key, so a codex
// message always goes in as one; claude keeps its measured raw single line.
test('a single-line codex message is pasted, so a banner over the empty composer cannot take its first key', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  codexPane(h);
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
  const pane = codexPane(h);
  const send = createSessionSend(h.deps);
  const payload = (text) => ({
    sessionId: 'pane:fresh-codex', text, provider: 'codex',
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });
  await send.send(payload('first'));
  const afterFirst = pane.reads;
  await send.send(payload('second'));
  assert.ok(
    pane.reads - afterFirst < afterFirst,
    `the second send must not repeat the settle: ${afterFirst} reads then ${pane.reads - afterFirst}`,
  );
});

// CODEX'S BOX, READ FROM REAL CAPTURES (Codex 0.165.0, 120 columns, 2026-10-29,
// scripts/drive-codex-send-win.js under load; only the temp-home warning Codex
// prints for a throwaway CODEX_HOME was cut). "stuck" screens are messages
// Harbor reported as sent that sat in the box; "taken" is one Codex submitted.
const codexFixture = (name) => fs.readFileSync(path.join(__dirname, '../fixtures/codex-box', name), 'utf8');
const proofWords = 'the quick brown fox jumps over the lazy dog ';
test('codexBoxState reads the real Codex box: stuck, taken, placeholder, footer title and the update screen', () => {
  const stuck = codexFixture('codex-0.165.0-stuck-300-120.txt');
  assert.equal(codexBoxState(stuck, { text: `Reply with just OK. ${proofWords.repeat(6)}codex-proof-cbf58805` }), 'exact');
  // The earlier message is in the transcript above, not in the box.
  assert.equal(codexBoxState(stuck, { text: 'Reply with just OK. codex-proof-ddd816c8' }), 'other');
  const taken = codexFixture('codex-0.165.0-taken-120.txt');
  assert.equal(codexBoxState(taken, { text: 'Reply with just OK. codex-proof-ddd816c8' }), 'other');
  // 2,020 characters drawn as 2,021: the swallowed Enter joined the paste.
  const placeholder = codexFixture('codex-0.165.0-stuck-placeholder-120.txt');
  assert.equal(codexBoxState(placeholder, { text: `Reply with just OK. ${proofWords.repeat(45)}codex-proof-f00df00d` }), 'exact');
  assert.equal(codexBoxState(placeholder, { text: `Reply with just OK. ${proofWords.repeat(30)}codex-proof-f00df00d` }), 'other');
  // The footer's thread title repeats the first message; it is not the box.
  const emptyBox = stuck.replace(/\n› Reply with just OK\. the quick[\s\S]*?(?=\n\s+GPT-6\.1-Sol)/, '\n› Ask Codex to do anything');
  assert.match(emptyBox.trimEnd(), /· Reply with OK codex-proof-ddd816c8$/, 'the real footer carries the title');
  assert.equal(codexBoxState(emptyBox, { text: 'Reply with OK codex-proof-ddd816c8' }), 'other');
  // "› 1. Update now" over key hints is a dialog, never the box.
  assert.equal(codexBoxState(codexFixture('codex-0.165.0-update-screen-120.txt'), { text: 'x' }), 'noprompt');
});

// A CODEX ON ULTRA EFFORT DRAWS ITS BOX WITH "»" (2026-11-05, Pat: "codex not
// working on new session"). Codex 0.166.0 starts with "›" and, once startup
// ends, redraws the box as "» Ask Codex to do anything" on ultra and on no
// other effort (measured on gpt-6-astra and gpt-6.1-sol, every effort, in a
// throwaway home); the transcript keeps "›" for earlier prompts. Harbor knew
// only "›", saw no box, and refused every send into an Ultra pane with "Codex
// is not showing its prompt box". These are the real screens, captured from
// Codex 0.166.0 on gpt-6.1-sol ultra at 120 columns.
test('codexBoxState reads a real Ultra Codex box drawn with »: empty and holding a wrapped draft', () => {
  const empty = codexFixture('codex-0.166.0-ultra-empty-120.txt');
  assert.match(empty, /^» Ask Codex to do anything$/mu, 'the real Ultra box glyph');
  assert.equal(codexBoxDraft(empty), '');
  assert.equal(codexBoxState(empty, { text: 'hello' }), 'other');
  const draft = codexFixture('codex-0.166.0-ultra-draft-120.txt');
  const text = `Reply with just OK. ${proofWords.repeat(4)}codex-ultra-7f3a91c2`;
  assert.equal(codexBoxState(draft, { text }), 'exact');
  assert.equal(codexBoxState(draft, { text: 'Reply with just OK. codex-ultra-00000000' }), 'other');
});

test('a send into an Ultra Codex (box drawn with ») is typed, submitted and confirmed', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = codexPane(h, { glyph: '»' });
  const send = createSessionSend(h.deps);

  await send.send({ sessionId: 'pane:pane-1', provider: 'codex', text: 'Fresh session, first message', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });

  assert.deepEqual(pane.echoed, ['Fresh session, first message']);
  assert.equal(pane.draft, '');
  assert.equal(typed(h).filter((t) => t === '\r').length, 1, 'one Enter, taken');
});

// A LONG PASTE TAKES CODEX SECONDS TO SHOW (2026-11-05, Pat's 21,300-character
// handoff): on Windows it arrives one key event per character and nothing is
// drawn until the last one, measured at 0.7 to 0.85 ms per character (21,300
// characters: 14.7 s at 4 load workers, 18.0 s at 10). The old wait was 60
// reads whatever the size. In this fake each read is one wait step.
test('a 21,300-character Codex message that takes 150 reads to show is sent once, and the status says why it waits', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = codexPane(h, { glyph: '»', burstReads: 150 });
  const send = createSessionSend(h.deps);
  const details = [];
  send.emitter.on('status', (s) => { if (s.phase === 'sending' && s.detail) details.push(s.detail); });
  let text = '';
  while (text.length < 21_300) text += proofWords;
  text = text.slice(0, 21_300).trimEnd() + 'x';

  await send.send({ sessionId: 'pane:pane-1', provider: 'codex', text, pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });

  assert.equal(pane.echoed.length, 1, 'submitted once');
  assert.equal(pane.echoed[0], text.trim());
  assert.equal(typed(h).filter((t) => t === '\r').length, 1);
  assert.ok(details.some((d) => /still taking in your message \(21,300 characters/.test(d)), `the wait is explained: ${JSON.stringify(details)}`);
});

test('a long Codex message whose box never shows it still fails honestly after a bounded wait', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = codexPane(h, { burstReads: 1_000_000 });
  const send = createSessionSend(h.deps);
  let text = '';
  while (text.length < 21_300) text += proofWords;
  text = text.slice(0, 21_300).trimEnd() + 'x';

  await assert.rejects(
    send.send({ sessionId: 'pane:pane-1', provider: 'codex', text, pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'PROMPT_NEVER_HELD',
  );
  assert.equal(typed(h).filter((t) => t === '\r').length, 0, 'no Enter on a box that never showed it');
  // 60 reads plus 3 ms per character at 250 ms per read, plus the reads before typing.
  assert.ok(pane.reads < 60 + Math.ceil((21_300 * 3) / 250) + 40, `bounded: ${pane.reads} reads`);
});

test('an Ultra Codex box that already holds someone else\'s text is still refused as busy, not typed into', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  codexPane(h, { glyph: '»', prefill: 'a half-written note from someone else' });
  const send = createSessionSend(h.deps);

  await assert.rejects(
    send.send({ sessionId: 'pane:pane-1', provider: 'codex', text: 'my message', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'CODEX_BOX_BUSY',
  );
  assert.deepEqual(typed(h), [], 'nothing typed into a busy Ultra box');
});

// A REAL SPLIT PASTE (Codex 0.166.0, 154 columns, 2026-11-01): the first
// character reached Codex 40 ms before the rest, so it was typed and the other
// 1,182 became the paste. Fable's 1,183-character message most likely sat in
// Astra's box in this shape while every check said "never shown" (an inference
// from the counts: no screen from that moment was kept; this capture is a
// reproduction).
const splitMessage = ('FABLE 03:06Z, URGENT. ' + 'the quick brown fox jumps over the lazy dog, ').repeat(26).slice(0, 1183);
test('codexBoxState: a message drawn as a typed first character plus a pasted block is in the box', () => {
  const split = codexFixture('codex-0.166.0-split-paste-154.txt');
  assert.match(split, /^› F\[Pasted Content 1182 chars\]$/m, 'the real capture holds the split shape');
  assert.equal(codexBoxState(split, { text: splitMessage }), 'exact');
  // A different message of the same length is not this one: its first character differs.
  assert.equal(codexBoxState(split, { text: `X${splitMessage.slice(1)}` }), 'other');
  // Nor is a much shorter or longer one.
  assert.equal(codexBoxState(split, { text: splitMessage.slice(0, 900) }), 'other');
  assert.equal(codexBoxState(split, { text: `${splitMessage}${proofWords.repeat(3)}` }), 'other');
  // The same split at the other end, and twice: typed runs at their own places.
  const withBox = (box) => split.replace('› F[Pasted Content 1182 chars]', `› ${box}`);
  // The last character typed instead of the first.
  assert.equal(codexBoxState(withBox('[Pasted Content 1182 chars],'), { text: splitMessage.replace(/.$/u, ',') }), 'exact');
  // Two typed characters, then two pastes (each over Codex's 1,000-character threshold).
  const long = `FA${'x'.repeat(1200)}${'y'.repeat(1198)}`;
  assert.equal(codexBoxState(withBox('FA[Pasted Content 1200 chars][Pasted Content 1198 chars]'), { text: long }), 'exact');
  assert.equal(codexBoxState(withBox('FB[Pasted Content 1181 chars]'), { text: splitMessage }), 'other');
  // A placeholder can never be a short message, split or not.
  assert.equal(codexBoxState(withBox('F[Pasted Content 1182 chars]'), { text: 'Fix it' }), 'other');
  // A match through a pasted block is reported as opaque: its text cannot be read.
  assert.deepEqual(codexBoxMatch(split, { text: splitMessage }), { state: 'exact', opaque: true , clipped: false });
});

// ASTRA'S COUNTEREXAMPLES (adversarial review, 2026-11-01), each once accepted.
test('codexBoxState: no slack lets extra, missing or foreign content pass as this message', () => {
  const split = codexFixture('codex-0.166.0-split-paste-154.txt');
  const withBox = (box) => split.replace('› F[Pasted Content 1182 chars]', `› ${box}`);
  const xs = `F${'x'.repeat(1182)}`;
  // Two extra typed characters after the paste.
  assert.equal(codexBoxState(withBox('F[Pasted Content 1182 chars]xx'), { text: xs }), 'other');
  // Two characters of the message missing.
  assert.equal(codexBoxState(withBox('F[Pasted Content 1182 chars]'), { text: `${xs}NO` }), 'other');
  // Slack does not compound across pastes.
  const box3 = 'A[Pasted Content 1000 chars]B[Pasted Content 1001 chars]C[Pasted Content 1001 chars]D'.replace('1000 chars', '1001 chars');
  const text3 = `A${'x'.repeat(1001)}1234B${'y'.repeat(1001)}1234C${'z'.repeat(1001)}1234DWXYZ`;
  assert.equal(codexBoxState(withBox(box3), { text: text3 }), 'other');
  // An image chip in the box of a text-only send is someone else's.
  assert.equal(codexBoxState(withBox('[Image #9]F[Pasted Content 1182 chars]'), { text: xs }), 'other');
  // ...but this send's own image chip is set aside.
  assert.equal(codexBoxState(withBox('[Image #1]F[Pasted Content 1182 chars]'), { text: xs, imageMarker: '[Image #1]' }), 'exact');
  // A placeholder at or under 1,000 characters is literal text, never a paste.
  assert.equal(codexBoxState(withBox('F[Pasted Content 12 chars]'), { text: `F${'x'.repeat(12)}` }), 'other');
  const literal = `Explain [Pasted Content 12 chars] ${'x'.repeat(1182)}`;
  assert.equal(codexBoxState(withBox('Explain [Pasted Content 12 chars] [Pasted Content 1182 chars]'), { text: literal }), 'exact');
  // Whitespace typed before the paste is not drawn; both readings are tried.
  assert.equal(codexBoxState(withBox('F[Pasted Content 1182 chars]'), { text: `F   ${'x'.repeat(1182)}` }), 'exact');
  assert.equal(codexBoxState(withBox('[Pasted Content 1182 chars]'), { text: `   ${'x'.repeat(1182)}` }), 'exact');
  // An Enter swallowed into the LAST paste counts one more than the message.
  assert.equal(codexBoxState(withBox('F[Pasted Content 1183 chars]'), { text: xs }), 'exact');
});

test('a Codex message that starts "1. " is still the box: it sits over the model footer', () => {
  const screen = '› Reply with just OK.\n\n• OK\n\n› 1. fix the header\n\n  GPT-6.1-Sol low · ~\\dev\\proof · proof';
  assert.equal(codexBoxState(screen, { text: '1. fix the header' }), 'exact');
  // Codex's "open in another app" lock dialog (transcribed from a live pane,
  // docs/orchestration/2026-10-28-codex-ux) draws no box at all.
  const locked = '  This conversation is open in another app          r to retry\n      Close it there and press R to continue here.\n   r retry   f fork   esc/ctrl+c/q exit   ctrl+t transcript';
  assert.equal(codexBoxState(locked, { text: 'hello' }), 'noprompt');
});

test('an Enter Codex swallowed into the paste is pressed again while the message still sits in its box', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = codexPane(h, { swallowEnters: 1, burstReads: 2 });
  const send = createSessionSend(h.deps);
  const text = `Reply with just OK. ${proofWords.repeat(6)}marker`;
  await send.send({ sessionId: 'pane:codex-swallow', text, provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.deepEqual(typed(h), [`\x1b[200~${text}\x1b[201~`, '\r', '\r']);
  assert.equal(pane.draft, '');
  assert.deepEqual(pane.echoed, [text]);
});

test('an Enter Codex took is never pressed twice, and the long-paste placeholder counts as the message', async () => {
  for (const text of ['Reply with just OK.', `Reply with just OK. ${proofWords.repeat(45)}marker`]) {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    const pane = codexPane(h, { burstReads: 3 });
    const send = createSessionSend(h.deps);
    await send.send({ sessionId: 'pane:codex-taken', text, provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
    assert.deepEqual(typed(h), [`\x1b[200~${text}\x1b[201~`, '\r'], `${text.length} characters`);
    assert.deepEqual(pane.echoed, [text]);
  }
});

test('a Codex box that never shows the text gets no Enter and an honest refusal', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  codexPane(h, { dropTyping: true });
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.send({ sessionId: 'pane:codex-dropped', text: 'this never reaches the box', provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'PROMPT_NEVER_HELD' && /Codex's box never showed your text/.test(error.message),
  );
  assert.equal(typed(h).includes('\r'), false, 'no Enter into a box that does not hold the message');
});

// A BOX THAT ALREADY HOLDS TEXT IS NEVER TYPED INTO (2026-10-31, a live Astra
// pane): another session's typer left a 1,489-character paste unsent, Harbor
// typed a message after it, and every retry added another copy. Synthetic
// screens in the shape of that capture.
test('a Codex box holding someone else\'s paste or draft is refused before one key, on every retry', async () => {
  const text = `Please look again. ${proofWords.repeat(24)}marker`;
  for (const [prefill, said] of [['[Pasted Content 1489 chars]', /a pasted block of 1489 characters/], ['[Pasted Content 1489 chars][Pasted Content 1058 chars]', /2 pasted blocks \(1489, 1058 characters\)/], ['half a note I was writing', /other text/]]) {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    codexPane(h, { prefill });
    const send = createSessionSend(h.deps);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(
        send.send({ sessionId: 'pane:codex-busy', text, provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
        (error) => error.code === 'CODEX_BOX_BUSY' && said.test(error.message),
      );
    }
    assert.deepEqual(typed(h), [], `nothing typed into a box holding "${prefill}"`);
  }
});

test('a retry whose own earlier try is the whole Codex box presses Enter without typing it again', async () => {
  // Visible text proves itself: a short message drawn in full is this message.
  const shortText = 'Please look again at the retry test.';
  const hShort = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const shortPane = codexPane(hShort, { initialDraft: shortText });
  await createSessionSend(hShort.deps).send({ sessionId: 'pane:codex-retry', text: shortText, provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.deepEqual(typed(hShort), ['\r']);
  assert.deepEqual(shortPane.echoed, [shortText]);

  // A pasted block proves only its shape, so the Enter-only retry needs this
  // Harbor's own record of typing it: the first send types it and Codex
  // swallows both Enters (CODEX_NOT_SUBMITTED), the resend presses Enter only.
  const text = `Please look again. ${proofWords.repeat(30)}marker`;
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = codexPane(h, { swallowEnters: 2 });
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.send({ sessionId: 'pane:codex-retry', text, provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'CODEX_NOT_SUBMITTED',
  );
  const before = typed(h).length;
  await send.send({ sessionId: 'pane:codex-retry', text, provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.deepEqual(typed(h).slice(before), ['\r'], 'the resend types nothing new');
  assert.deepEqual(pane.echoed, [text]);
});

// A PASTED BLOCK OF THE RIGHT SHAPE IS NOT PROOF OF OWNERSHIP (Astra's
// adversarial review, 2026-11-01): a stranger's paste of this message's length
// used to be "the earlier try" and got Enter. Without this Harbor's own record
// of typing it, the box is busy.
test('a Codex box holding a pasted block shaped like this message, which this Harbor never typed, is refused', async () => {
  const text = `Please look again. ${proofWords.repeat(30)}marker`;
  for (const initialDraft of [text, `P${'x'.repeat([...text].length - 1)}`]) {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    const pane = codexPane(h, { initialDraft });
    await assert.rejects(
      createSessionSend(h.deps).send({ sessionId: 'pane:codex-stranger', text, provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
      (error) => error.code === 'CODEX_BOX_BUSY' && /a pasted block of \d+ characters/.test(error.message),
    );
    assert.deepEqual(typed(h), [], 'no key, no Enter');
    assert.deepEqual(pane.echoed, []);
  }
});

test('a send into a working Codex reads the box over its key-hint footer', async () => {
  const text = "also - please adjust your settings to be on 'max' effort or tell me how to";
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = codexPane(h, { working: true, burstReads: 2 });
  await createSessionSend(h.deps).send({ sessionId: 'pane:codex-working', text, provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.deepEqual(typed(h), [`\x1b[200~${text}\x1b[201~`, '\r']);
  assert.deepEqual(pane.echoed, [text]);
});

test('codexBoxDraft reads only the box rows, so an unseen footer cannot make an empty box look full', () => {
  assert.equal(codexBoxDraft('• OK\n\n› Ask a follow-up question\n\n  some hint line Codex has never drawn before'), '');
  assert.equal(codexBoxDraft('• OK\n\n›\n\n  ? for shortcuts                      100% context left'), '');
  assert.equal(codexBoxDraft('• OK\n\n› [Pasted Content 1489 chars]\n\n  GPT-6-Astra high · C:\\dev\\proof · proof'), '[PastedContent1489chars]');
  assert.equal(codexBoxDraft('• OK\n\n› a draft\n  that wraps\n\n  tab to queue message                21% context left'), 'adraftthatwraps');
  assert.equal(codexBoxDraft(codexFixture('codex-0.165.0-update-screen-120.txt')), null);
});

test('with no Codex box on screen (the update screen) nothing is typed at all', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  codexPane(h, { screen: codexFixture('codex-0.165.0-update-screen-120.txt') });
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.send({ sessionId: 'pane:codex-update', text: '2026-10-28 notes: please read', provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'CODEX_NO_PROMPT',
  );
  assert.deepEqual(typed(h), [], 'not one key: the update screen takes 1, 2, 3 and Enter');
});

// Both effort menus send "/effort <level>" for every provider. Codex has no
// /effort ("Unrecognized command"); /model --reasoning=<level> keeps its model
// and changes the effort (Codex 0.165.0 chatwidget/model_command.rs).
test('an effort change into a codex pane goes in as /model --reasoning=<level>; claude keeps /effort', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  codexPane(h);
  const send = createSessionSend(h.deps);
  await send.send({ sessionId: 'pane:codex-effort', text: '/effort high', provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.deepEqual(typed(h), ['/model ', '--reasoning=high', '\r']);
  const c = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  composerPane(c);
  await createSessionSend(c.deps).send({ sessionId: 's-claude-effort', text: '/effort high', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.equal(typed(c)[0], '/effort ');
});

// The effort menus' "/model --reasoning=<level>" reaches Codex as keystrokes,
// and the live drive (2026-11-05, 4 load workers) left it sitting in the box,
// effort unchanged, while Harbor said sent: the fixed 160 ms before Enter fell
// inside Codex's paste-burst window. Enter now waits for the box to show the
// command, and a swallowed Enter gets one more.
test('a Codex slash command presses Enter only once its box shows it, and once more if Codex swallowed it', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = codexPane(h, { swallowEnters: 1, burstReads: 2 });
  let lastRead = '';
  const shownAtEnter = [];
  const readPane = h.deps.readPane;
  h.deps.readPane = async (...args) => (lastRead = await readPane(...args));
  const sendInput = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    if (text === '\r') shownAtEnter.push(/^› \/model --reasoning=high\s*$/mu.test(lastRead));
    return sendInput(paneId, text);
  };
  const send = createSessionSend(h.deps);

  await send.send({ sessionId: 'pane:codex-effort-burst', text: '/effort high', provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });

  assert.deepEqual(typed(h), ['/model ', '--reasoning=high', '\r', '\r']);
  assert.deepEqual(shownAtEnter, [true, true], 'every Enter came after a read that showed the command in the box');
  assert.deepEqual(pane.echoed, ['/model --reasoning=high']);
});

test('a Codex slash command that opens a dialog gets no spare Enter', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  codexPane(h);
  const picker = '  Select Model and Effort\n\n› 1. gpt-6.1-sol\n  2. gpt-6-astra\n\n  Press enter to confirm or esc to go back';
  let opened = false;
  const readPane = h.deps.readPane;
  h.deps.readPane = async (...args) => (opened ? picker : readPane(...args));
  const sendInput = h.deps.terminalBridge.sendInput;
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    if (text === '\r') opened = true;
    return sendInput(paneId, text);
  };

  await createSessionSend(h.deps).send({ sessionId: 'pane:codex-picker', text: '/model', provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });

  assert.deepEqual(typed(h), ['/model ', '\r'], 'one Enter: a second would pick the first row');
});

test('a Codex slash command still in the box after two Enters is reported, not called sent', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  codexPane(h, { swallowEnters: 99 });

  await assert.rejects(
    createSessionSend(h.deps).send({ sessionId: 'pane:codex-effort-stuck', text: '/effort high', provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'CODEX_NOT_SUBMITTED' && /has not run/.test(error.message),
  );
  assert.deepEqual(typed(h), ['/model ', '--reasoning=high', '\r', '\r']);
});

test('Codex safety rewrites and sibling dialogs refuse slash commands before typing', async () => {
  const screens = [
    '  Here are a few ways I can help:\n  Choosing a rewrite sends it in a new chat.\n\n› 1. Overview\n  2. Recovery\n  3. Prevention\n\n  enter select · esc back',
    codexFixture('codex-0.165.0-update-screen-120.txt'),
    '  This conversation is open in another app\n  r retry   f fork   esc/ctrl+c/q exit',
  ];
  for (const screen of screens) {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    codexPane(h, { screen });
    await assert.rejects(
      createSessionSend(h.deps).send({ sessionId: 'pane:codex-choice', text: '/effort high', provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
      error => error.code === 'CODEX_NO_PROMPT',
    );
    assert.deepEqual(typed(h), [], 'a setting command must not select a dialog action');
  }
});

test('Codex transcript selection never treats a historical prompt as its composer', async () => {
  const footers = [
    'arrows/hjkl/w/b/e move · 0/$/g/G ends · v/space/V mark · / find · enter/q/esc close',
    '  arrows/hjkl/w/b/e move · 0/$/g/G ends · v/space/V mark · / find · enter/q/esc close',
    'v mark · enter/q close',
    'y/ctrl+c copy · enter copy & latest · esc clear · q close',
    'enter copy · q close',
  ];
  for (const footer of footers) {
    const screen = `› Previous synthetic message\n\nSynthetic response\n\n${footer}`;
    assert.equal(codexBoxState(screen, { text: '/effort high' }), 'noprompt');
    for (const text of ['/effort high', 'A new synthetic message']) {
      const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
      codexPane(h, { screen });
      await assert.rejects(
        createSessionSend(h.deps).send({ sessionId: 'pane:codex-selection', text, provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
        error => error.code === 'CODEX_NO_PROMPT',
      );
      assert.deepEqual(typed(h), []);
    }
  }
  const searchOverlay = '/ T R A N S C R I P T / / /\n\n› Previous synthetic message\n\nFind: sample';
  assert.equal(codexBoxState(searchOverlay, { text: 'sample' }), 'noprompt');
  assert.equal(codexBoxState('› Previous synthetic message\n\nFind: sample\nenter accept · esc cancel', { text: 'sample' }), 'noprompt');
  assert.equal(codexBoxState('› enter copy · q close\n  GPT-6-Sol low · ~/project', { text: 'enter copy · q close' }), 'exact');
});

test('a Codex thread locked by the Codex app gets no keys and a refusal that says to close it there', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  codexPane(h, { screen: '  This conversation is open in another app          r to retry\n      Close it there and press R to continue here.\n   r retry   f fork   esc/ctrl+c/q exit   ctrl+t transcript' });
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.send({ sessionId: 'pane:codex-locked', text: 'quick fix please', provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'CODEX_NO_PROMPT' && /open in the Codex app/.test(error.message),
  );
  assert.deepEqual(typed(h), [], 'r, f and q are that dialog\'s keys');
});

test('Codex provider and writer notices own input even with historical prompt rows', async () => {
  const screens = [
    codexFixture('codex-0.167.0-provider-mismatch-120.txt'),
    codexFixture('codex-0.167.0-provider-missing-40.txt'),
    '› Previous synthetic message\n\n' + codexFixture('codex-0.167.0-writer-remapped.txt'),
    '› Previous synthetic message\n\n  Model provider blocked by policy\n  c continue in new chat · n start\n  fresh · esc other\n  chats',
    '› Previous synthetic message\n\n  This conversation is open in another app\n  r retry   f fork   ←/esc command center   ⌃c/q exit   ⌃t\n  transcript',
    '› Previous synthetic message\n\n  This conversation is open in another app\n  r retry   f fork   esc/ctrl+c/q exit   ctrl+t transcript',
  ];
  for (const screen of screens) {
    assert.equal(codexBoxState(screen, { text: '/effort high' }), 'noprompt');
    for (const text of ['/effort high', 'Previous synthetic message']) {
      const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
      codexPane(h, { screen });
      const send = createSessionSend(h.deps);
      await assert.rejects(send.send({ sessionId: 'pane:provider-notice', text, provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }), error => error.code === 'CODEX_NO_PROMPT');
      assert.deepEqual(typed(h), [], 'neither text nor Enter may choose a new chat');
      const menu = await send.getMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
      assert.equal(menu?.fallback, true, 'the refused send has an answer panel');
    }
    const recovered = screen + '\n\n› Ask Codex to do anything\n\n  GPT-6-Sol low · ~/project';
    assert.equal(codexBoxDraft(recovered), '', 'a recovered composer ends the notice');
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    codexPane(h, { screen: recovered });
    assert.equal(await createSessionSend(h.deps).getMenu({ pane: { paneId: 'pane-1' } }), null);
  }
  assert.equal(codexBoxState('› n start fresh · esc other chats\n\n  GPT-6-Sol low · ~/project', { text: 'n start fresh · esc other chats' }), 'exact', 'quoting the footer in a real composer is ordinary text');
  assert.equal(codexBoxState('› Please read the transcript\n\n  GPT-6-Sol low · ~/project', { text: 'Please read the transcript' }), 'exact');
});

test('Codex resume-only reports a notice honestly and a usable composer as ready', async () => {
  for (const [screen, needsAnswer] of [
    [codexFixture('codex-0.167.0-provider-mismatch-120.txt'), true],
    [codexFixture('codex-0.167.0-writer-remapped.txt'), true],
    ['› Ask Codex to do anything\n\n  GPT-6-Sol low · ~/project', false],
  ]) {
    const h = makeHarness({ panes: [], controlled: null, readFrames: [screen], promptEchoes: false });
    h.deps.getSessionMeta = async () => ({ provider: 'codex', cwd: '/work' });
    h.deps.launchActions.resumeProviderSession = async ({ id }) => h.state.panes.push({ pane_id: 'pane-fresh', workspace_id: 'ws-1', cwd: '/work', agent: 'codex', agent_session: { kind: 'id', value: id } });
    const send = createSessionSend(h.deps), statuses = [];
    send.emitter.on('status', entry => statuses.push(entry));
    const result = await send.send({ sessionId: 'saved-codex', text: '', provider: 'codex', resumeOnly: true });
    assert.equal(result.resumed, true);
    assert.deepEqual(typed(h), []);
    if (needsAnswer) {
      assert.match(statuses.at(-1).detail, /needs your answer/);
      assert.doesNotMatch(statuses.at(-1).detail, /ready/);
    } else assert.match(statuses.at(-1).detail, /resumed and ready/);
  }
});

test('Codex swallowing both Enters is an honest error, and the resend presses Enter without typing it twice', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = codexPane(h, { swallowEnters: 2 });
  const send = createSessionSend(h.deps);
  const text = `Reply with just OK. ${proofWords.repeat(6)}marker`;
  const payload = { sessionId: 'pane:codex-stuck', text, provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } };
  await assert.rejects(send.send(payload), (error) => error.code === 'CODEX_NOT_SUBMITTED');
  assert.deepEqual(typed(h), [`\x1b[200~${text}\x1b[201~`, '\r', '\r']);
  h.sent.length = 0;
  await send.send(payload);
  assert.deepEqual(typed(h), ['\r'], 'the message already in the box is submitted, not typed again');
  assert.deepEqual(pane.echoed, [text]);
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
  composerPane(h, { pathChips: 'whole-line' });
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

// Claude 2.1.311 attaches a pasted path only when it has its line to itself, so
// a Claude pane gets one quoted path per line (a bare POSIX path would start the
// message with "/" and be typed as a slash command); another CLI keeps the label.
test('two headless images are both delivered, each quoted path pasted by itself, ahead of the text', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  delete h.deps.setXClipboardImage;
  composerPane(h, { pathChips: 'whole-line' });
  const send = createSessionSend(h.deps);
  await send.send({
    sessionId: 's-headless-two',
    text: 'compare these',
    images: ['/srv/upload/a.png', '/srv/upload/b.png'],
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });
  const body = h.sent.map(({ text }) => text).join('');
  assert.equal(body, '\x1b[200~"/srv/upload/a.png"\x1b[201~\x1b[200~"/srv/upload/b.png"\x1b[201~compare these\r', 'each path a paste of its own, never a slash command typed raw');
  assert.doesNotMatch(body, /Images?:/);
});

// Codex attaches a paste that is only an image path (handle_paste_image_path),
// so a Codex pane gets each image as its own pasted, quoted path, desktop and
// phone alike; the "Images:" label left Codex a path to read (2026-10-29).
test('images into a codex pane are attached by their pasted paths, from the phone and the desktop', async () => {
  for (const clipboard of [false, true]) {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    const pane = codexPane(h);
    const clipped = [];
    if (clipboard) h.deps.setXClipboardImage = async (file) => { clipped.push(file); };
    else delete h.deps.setXClipboardImage;
    const send = createSessionSend(h.deps);
    await send.send({
      sessionId: 's-codex-images',
      text: 'compare these',
      images: ['/srv/upload/a.png', '/srv/upload/b.png'],
      provider: 'codex',
      pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
    });
    assert.deepEqual(typed(h), [
      '\x1b[200~"/srv/upload/a.png"\x1b[201~',
      '\x1b[200~"/srv/upload/b.png"\x1b[201~',
      '\x1b[200~compare these\x1b[201~',
      '\r',
    ], clipboard ? 'desktop' : 'phone');
    assert.deepEqual(pane.echoed, ['[Image #1] [Image #2] compare these']);
    assert.deepEqual(clipped, [], 'no clipboard and no paste chord for codex');
  }
});

test('an image Codex never attaches stops the send before the text or Enter', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  codexPane(h);
  delete h.deps.setXClipboardImage;
  const send = createSessionSend(h.deps);
  await assert.rejects(
    send.send({ sessionId: 's-codex-bad-image', text: 'look', images: ['/srv/upload/notes.txt'], provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    /Codex never attached the image/,
  );
  assert.deepEqual(typed(h), ['\x1b[200~"/srv/upload/notes.txt"\x1b[201~'], 'nothing after the path');
});

test('clipboard failure is an honest send error before Ctrl+V or text', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.setXClipboardImage = async () => { throw new Error('clipboard failed'); };
  h.deps.readPane = async () => `conversation\n${PROMPT_RULE}\n❯ \n${PROMPT_RULE}`; // a drawn prompt box: without one, images go by path (rounds six and eight)
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

// 2026-11-04, Pat: "i keep having text get cut off in this chat". Every
// one-line send over 1,024 characters since Oct 30 reached Claude as its last
// piece only (1,611 sent, 587 arrived; 1,092 sent, 68 arrived), because it was
// typed in one write and the CLI keeps only the last 1,024-character piece of a
// typed run. A paste is one piece however it is read.
const longLine = (n, tag = 'w') => {
  let s = '';
  for (let i = 0; s.length < n; i += 1) s += `${tag}${String(i).padStart(4, '0')} `;
  return s.slice(0, n).trimEnd() + 'Z';
};

test('a long one-line message goes as one paste and arrives whole, never cut to its last 1,024-character piece', async () => {
  for (const n of [700, 1092, 1611, 2600]) {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    const pane = composerPane(h, { cutsLongTyping: true });
    const send = createSessionSend(h.deps);
    const text = longLine(n);
    await send.send({ sessionId: `s-long-${n}`, text, pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
    assert.deepEqual(typed(h), [`\x1b[200~${text}\x1b[201~`, '\r'], `${text.length} characters`);
    assert.deepEqual(pane.echoed, [text], `${text.length} characters arrive whole`);
  }
});

test('a one-line message under the paste mark is still typed as keys', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = composerPane(h, { cutsLongTyping: true });
  const send = createSessionSend(h.deps);
  const text = longLine(698);
  await send.send({ sessionId: 's-short', text, pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.deepEqual(typed(h), [text, '\r']);
  assert.deepEqual(pane.echoed, [text]);
});

test('a slash command with long one-line arguments pastes them (the 2026-11-04 /acclimate lost its front)', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const send = createSessionSend(h.deps);
  const args = longLine(1169);
  await send.send({ sessionId: 's-slash-long', text: `/acclimate ${args}`, pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.deepEqual(typed(h), ['/acclimate ', `\x1b[200~${args}\x1b[201~`, '\r']);
});

test('a long typed answer in a question card goes into its text row as one paste', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let highlight = 1;
  let field = null;
  h.deps.readPane = async () => TEXT_MENU
    .map((line, i) => {
      if (i < 1 || i > 4) return line;
      const body = i === 3 && field != null ? `  3. ${field.slice(-40)}` : line;
      return `${highlight === i ? '❯' : ' '}${body.slice(1)}`;
    })
    .join('\n');
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    h.sent.push({ paneId, text });
    if (text === '\x1b[B') highlight = Math.min(4, highlight + 1);
    else if (text === '\x1b[A') highlight = Math.max(1, highlight - 1);
    else if (text !== '\r' && text !== '\x1b' && highlight === 3) {
      field = `${field || ''}${text.startsWith('\x1b[200~') ? text.replace(/\x1b\[20[01]~/g, '') : lastTypedPiece(text)}`;
    }
    return { ok: true };
  };
  closesOnEnter(h);
  const send = createSessionSend(h.deps);
  const answer = longLine(1611, 'a');
  const res = await send.answerMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' }, action: { type: 'text', index: 3, text: answer } });
  assert.equal(res.ok, true);
  assert.ok(h.sent.some((s) => s.text === `\x1b[200~${answer}\x1b[201~`), 'the answer is one paste');
  assert.equal(field, answer, 'the whole answer reached the row');
});

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
  codexPane(h);
  const codexRead = h.deps.readPane;
  h.deps.readPane = async (paneId, ...rest) => (paneId === 'pane-1' ? CRASHED_SHELL_SCREEN : codexRead(paneId, ...rest));
  const providerResumes = [];
  h.deps.launchActions.resumeProviderSession = async (args) => {
    providerResumes.push(args);
    h.state.panes.push({ pane_id: 'pane-fresh', workspace_id: 'ws-1', agent_session: { kind: 'id', value: args.id } });
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

// The CLI draws a switch's answer only after its Enter: before it, the idle
// screen; after it, `frames` in order (the send reads the screen before its
// Enter too, to count the command's echoes).
// `before`: the screen until the Enter (the idle one unless given).
const afterEnterScreens = (h, frames, idle = 'conversation\n❯', before = idle) => {
  h.deps.readPane = async () => (h.sent.some(({ text }) => text === '\r') ? (frames.shift() ?? idle) : before);
};

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
  afterEnterScreens(h, panes);
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
  afterEnterScreens(h, panes);
  const send = createSessionSend(h.deps);

  await send.send({
    sessionId: 's-effort-dialog',
    text: '/effort low',
    provider: 'claude',
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });

  assert.deepEqual(h.sent.map(({ text }) => text), ['/effort ', 'low', '\r', '1', '\r']);
});

// The real 2.1.303 dialog wraps its explanation at the pane edge, at a
// different word per capture; the one-line match missed both (Pat, 2026-10-21).
for (const [fixtureName, level] of [['claude-2.1.303-effort-xhigh-120.txt', 'xhigh'], ['claude-2.1.303-effort-high-120.txt', 'high']]) {
  test(`Claude /effort confirms the real wrapped cache warning (${fixtureName})`, async () => {
    const dialog = fs.readFileSync(path.join(__dirname, '../fixtures/effort-switch', fixtureName), 'utf8');
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    const panes = ['conversation\n❯', dialog, 'conversation\n❯'];
    afterEnterScreens(h, panes);
    const send = createSessionSend(h.deps);

    await send.send({
      sessionId: `s-effort-wrapped-${level}`,
      text: `/effort ${level}`,
      provider: 'claude',
      pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
    });

    assert.deepEqual(h.sent.map(({ text }) => text), ['/effort ', level, '\r', '1', '\r']);
  });
}

// Claude Code 2.1.312 (captured 2026-10-28, both layouts): the /model warning is
// titled "Switch model?" and its sentence now ends "gets re-read." without "on
// your next message". Neither half of the old match fit it, so a model change
// from Harbor stopped on the open dialog. Two lines were edited out of the real
// captures: the fullscreen top edge carried live plan usage (now a plain edge),
// and the inline capture's earlier /effort command and its result were removed.
for (const fixtureName of ['claude-2.1.312-model-sonnet-120.txt', 'claude-2.1.312-model-sonnet-fullscreen-120.txt']) {
  test(`Claude /model confirms the real 2.1.312 cache warning (${fixtureName})`, async () => {
    const dialog = fs.readFileSync(path.join(__dirname, '../fixtures/effort-switch', fixtureName), 'utf8');
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    const panes = ['conversation\n❯', dialog, 'conversation\n❯'];
    afterEnterScreens(h, panes);
    const send = createSessionSend(h.deps);

    await send.send({
      sessionId: `s-model-2-1-312-${fixtureName.length}`,
      text: '/model sonnet',
      provider: 'claude',
      pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
    });

    assert.deepEqual(h.sent.map(({ text }) => text), ['/model ', 'sonnet', '\r', '1', '\r']);
  });
}

// 2026-11-19, CLI 2.1.321 (four of seven live drives): the CLI drew only the
// echoed command, no box and no result, for longer than the old 4.5-second
// watch, then opened the dialog, which stayed open.
test('a /model cache warning that opens late is still answered; a switch with no dialog ends at its result', async () => {
  const dialog = fs.readFileSync(path.join(__dirname, '../fixtures/effort-switch', 'claude-2.1.312-model-sonnet-120.txt'), 'utf8');
  const echoOnly = 'conversation\n\n❯ /model sonnet\n';
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const late = ['conversation\n❯', ...Array(15).fill(echoOnly), dialog, 'conversation\n❯'];
  afterEnterScreens(h, late);
  await createSessionSend(h.deps).send({ sessionId: 's-model-late', text: '/model sonnet', provider: 'claude', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.deepEqual(typed(h), ['/model ', 'sonnet', '\r', '1', '\r'], 'the late dialog is answered');

  const g = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let reads = 0;
  const settled = `${echoOnly}  ⎿  Set model to Sonnet 5.5\n\n────\n❯ \n────`;
  const frames = ['conversation\n❯', echoOnly, echoOnly];
  g.deps.readPane = async () => { reads += 1; return g.sent.some(({ text }) => text === '\r') ? (frames.shift() ?? settled) : 'conversation\n❯'; };
  await createSessionSend(g.deps).send({ sessionId: 's-model-plain', text: '/model sonnet', provider: 'claude', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.deepEqual(typed(g), ['/model ', 'sonnet', '\r'], 'nothing answered when no dialog opens');
  assert.ok(reads < 20, `the watch ends at the command's result (${reads} reads)`);
});

// Round forty: only an open dialog after an actual switch command is answered,
// and only a NEW echo's result ends the watch early.
test('a switch watch answers only an open dialog after a real /model, and an older result never ends it', async () => {
  const dialog = fs.readFileSync(path.join(__dirname, '../fixtures/effort-switch', 'claude-2.1.312-model-sonnet-120.txt'), 'utf8');
  const quoted = ['● The dialog reads:', '  Switch model?', '  This conversation is cached for the current model. Switching to Sonnet 5.5 means the full history gets re-read.', '  ❯ 1. Yes, switch to Sonnet 5.5', '    2. No, go back'].join('\n');
  // A screenshot captioned "/model sonnet" is words, under prose quoting the dialog.
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = composerPane(h);
  const draw = h.deps.readPane;
  h.deps.readPane = async (...args) => String(await draw(...args)).replace('conversation\n', `conversation\n${quoted}\n`);
  await createSessionSend(h.deps).send({ sessionId: 's-caption-model', text: '/model sonnet', images: ['/cache/one.png'], pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.equal(typed(h).includes('1'), false, 'no "1" typed after a screenshot whose caption names /model');
  assert.equal(pane.echoed.length, 1, 'one message submitted');
  // A real /model under the same quoted prose and an idle prompt: nothing answered.
  const q = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  afterEnterScreens(q, [], `conversation\n${quoted}\n${PROMPT_RULE}\n❯ \n${PROMPT_RULE}`);
  await createSessionSend(q.deps).send({ sessionId: 's-quoted', text: '/model sonnet', provider: 'claude', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.deepEqual(typed(q), ['/model ', 'sonnet', '\r'], 'a quoted dialog above the prompt is history');
  // The same command's earlier echo and result are still on screen; the new
  // echo is drawn late and the dialog six seconds after.
  const old = 'conversation\n❯ /model sonnet\n  ⎿  Set model to Sonnet 5.5\n❯ /model opus\n  ⎿  Set model to Opus 5.5\n';
  const g = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  afterEnterScreens(g, [...Array(12).fill(old), dialog, 'conversation\n❯'], old);
  await createSessionSend(g.deps).send({ sessionId: 's-model-again', text: '/model sonnet', provider: 'claude', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.deepEqual(typed(g), ['/model ', 'sonnet', '\r', '1', '\r'], 'the late dialog is answered, not cut off by the older result');
});

// Round forty-one: positive evidence of an open dialog, an unknown baseline
// from a blank read, and one wall-clock deadline over slow reads.
test('a switch watch needs the dialog drawn last, keeps a blank baseline unknown, and ends on its clock', async () => {
  const dialog = fs.readFileSync(path.join(__dirname, '../fixtures/effort-switch', 'claude-2.1.312-model-sonnet-120.txt'), 'utf8');
  const quoted = ['● The dialog reads:', '  Switch model?', '  This conversation is cached for the current model. Switching to Sonnet 5.5 means the full history gets re-read.', '  ❯ 1. Yes, switch to Sonnet 5.5', '    2. No, go back'].join('\n');
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  // Quoted prose above a BARE prompt (no box edges).
  const q = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  afterEnterScreens(q, [], `conversation\n${quoted}\n\n❯ `);
  await createSessionSend(q.deps).send({ sessionId: 's-bare', text: '/model sonnet', provider: 'claude', pane: target });
  assert.deepEqual(typed(q), ['/model ', 'sonnet', '\r'], 'a quoted dialog above a bare prompt gets no "1"');
  // The read before the Enter comes back blank; the older echo and result show next.
  const old = 'conversation\n❯ /model sonnet\n  ⎿  Set model to Sonnet 5.5\n❯ /model opus\n  ⎿  Set model to Opus 5.5\n';
  const b = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  b.prompt.echo = false;
  const frames = [...Array(12).fill(old), dialog, 'conversation\n❯'];
  b.deps.readPane = async () => (b.sent.some(({ text }) => text === '\r') ? (frames.shift() ?? 'conversation\n❯') : '');
  await createSessionSend(b.deps).send({ sessionId: 's-blank', text: '/model sonnet', provider: 'claude', pane: target });
  assert.deepEqual(typed(b), ['/model ', 'sonnet', '\r', '1', '\r'], 'a blank baseline never makes the older result new');
  // Every read after the Enter hangs: the watch ends on its own clock.
  process.env.HARBOR_SWITCH_WATCH_MS = '600';
  try {
    const s = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    s.deps.readPane = async () => (s.sent.some(({ text }) => text === '\r') ? new Promise(() => {}) : 'conversation\n❯');
    const started = Date.now();
    await createSessionSend(s.deps).send({ sessionId: 's-slow', text: '/model sonnet', provider: 'claude', pane: target });
    assert.ok(Date.now() - started < 5000, `the send ends near its 600 ms watch (${Date.now() - started} ms)`);
  } finally {
    delete process.env.HARBOR_SWITCH_WATCH_MS;
  }
});

// Round forty-two: one dialog, read as one; a blank frame never closes it.
test('a switch watch never answers another dialog under an older warning, and a blank frame never reads as closed', async () => {
  const dialog = fs.readFileSync(path.join(__dirname, '../fixtures/effort-switch', 'claude-2.1.312-model-sonnet-120.txt'), 'utf8');
  const edge = '─'.repeat(120);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  const olderWarning = [edge, '  Switch model?', '  This conversation is cached for the current model. Switching to Opus 5.5 means the full history gets re-read.', '  ❯ 1. Yes, switch to Opus 5.5', '    2. No, go back'].join('\n');
  const editDialog = ['  Do you want to make this edit to notes.md?', '  ❯ 1. Yes', '    2. No'].join('\n');
  for (const [label, screen] of [
    ['an edit confirmation with its own edge', `conversation\n${olderWarning}\n● Done.\n❯ /model sonnet\n${edge}\n${editDialog}\n`],
    ['an edit confirmation with none', `conversation\n${olderWarning}\n● Done.\n❯ /model sonnet\n${editDialog}\n`],
  ]) {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    afterEnterScreens(h, [], screen, 'conversation\n❯');
    await createSessionSend(h.deps).send({ sessionId: `s-other-${label.length}`, text: '/model sonnet', provider: 'claude', pane: target });
    assert.deepEqual(typed(h), ['/model ', 'sonnet', '\r'], `no "1" for ${label}`);
  }
  // The answer is typed, a blank frame follows, and the dialog is still open.
  const b = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  b.prompt.echo = false;
  afterEnterScreens(b, [dialog, '', ...Array(12).fill(dialog)], dialog, 'conversation\n❯');
  await assert.rejects(
    createSessionSend(b.deps).send({ sessionId: 's-blank-close', text: '/model sonnet', provider: 'claude', pane: target }),
    /could not confirm the Claude model\/effort switch/,
    'a dialog still open is never reported answered',
  );
});

// SYNTHETIC regression guard, not a capture: the /effort dialog is the same
// 2.1.312 component with "Change effort level?" and "for the current effort
// level" (binary template, 2026-10-28). A live probe does not type /effort any
// more, because it saves the level into the real config home (it did once).
// The title alone already matched before 2.1.312, so this pins, it does not prove.
test('SYNTHETIC: Claude /effort confirms the 2.1.312 sentence without "on your next message"', async () => {
  const dialog = [
    '   Change effort level?',
    '   Your next response will be slower and use more tokens',
    '',
    '   This conversation is cached for the current effort level. Switching to high means the full history gets re-read.',
    '',
    '   ❯ 1. Yes, switch to high',
    '     2. No, go back',
  ].join('\n');
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const panes = ['conversation\n❯', dialog, 'conversation\n❯'];
  afterEnterScreens(h, panes);
  const send = createSessionSend(h.deps);

  await send.send({
    sessionId: 's-effort-2-1-312',
    text: '/effort high',
    provider: 'claude',
    pane: { paneId: 'pane-1', workspaceId: 'ws-1' },
  });

  assert.deepEqual(h.sent.map(({ text }) => text), ['/effort ', 'high', '\r', '1', '\r']);
});

// The sentence alone, with no title in view (a short read can lose the top of
// the dialog), must be enough for both endings. Red before 2.1.312's ending was
// accepted: this is the spec that isolates the optional "on your next message".
for (const ending of ['re-read on your next message.', 're-read.']) {
  test(`Claude /model confirms the cache warning from its sentence alone ("...${ending}")`, async () => {
    const dialog = [
      `This conversation is cached for the current model. Switching to Sonnet 5.5 means the full history gets ${ending}`,
      '',
      '❯ 1. Yes, switch to Sonnet 5.5',
      '  2. No, go back',
    ].join('\n');
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    const panes = ['conversation\n❯', dialog, 'conversation\n❯'];
    afterEnterScreens(h, panes);
    const send = createSessionSend(h.deps);
    await send.send({ sessionId: `s-sentence-${ending.length}`, text: '/model sonnet', provider: 'claude', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
    assert.deepEqual(h.sent.map(({ text }) => text), ['/model ', 'sonnet', '\r', '1', '\r']);
  });
}

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
  h.deps.readPane = async () => h.sent.some(({ text }) => text === '\r')
    ? MODEL_SWITCH_DIALOG
    : '› Ask Codex to do anything\n  GPT-6-Sol low · ~/project';
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
    // Claude queues the text exactly as typed, newlines kept (real enqueue
    // records, 2026-11-19); round thirty-seven compares it exactly.
    await fsp.appendFile(file, `${JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content: 'please   queue\nthis',
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

// Live-caught 2026-10-13: Pat answered three numbered questions with "1. yes
// ... 2. ... 3. ...", so Claude's prompt line read "❯ 1. yes - ...", which is a
// menu's selected row. The send stopped with "a prompt appeared in the session
// while Harbor was typing", the answer panel offered keys over his own draft,
// its Enter submitted it, and the retry typed it again: Claude got it twice.
// Real 2.1.296 screens (idle, and mid-turn), words replaced.
test('a draft that starts with a numbered list is not a question', async () => {
  for (const name of ['idle-composer-numbered-draft-2.1.296.txt', 'working-turn-numbered-draft-2.1.296.txt']) {
    for (const blockedHint of [false, true]) {
      const h = makeHarness({ panes: ['pane-1'] });
      h.deps.readPane = async () => composerFixture(name);
      const send = createSessionSend(h.deps);
      assert.equal(await send.getMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' }, blockedHint }), null,
        `${name} (blocked hint ${blockedHint}) is a prompt with a draft in it`);
    }
  }
});

test('a numbered message is typed, shown, and submitted once', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = composerPane(h);
  const send = createSessionSend(h.deps);
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  const short = '1. yes, ship it\n2. dont clean up the old workbook\n3. sure you can add them';
  await send.send({ sessionId: 's-numbered', text: short, pane: target });
  assert.deepEqual(typed(h), [`\x1b[200~${short}\x1b[201~`, '\r']);
  assert.equal(pane.draft, '');
  // Too tall for its prompt line to be in the ten-line tail, sent while the
  // first one is echoed above the box as "❯ 1. yes, ship it".
  const tall = Array.from({ length: 12 }, (_, i) => `${i + 1}. item number ${i + 1}`).join('\n');
  await send.send({ sessionId: 's-numbered', text: tall, pane: target });
  assert.deepEqual(typed(h).slice(2), [`\x1b[200~${tall}\x1b[201~`, '\r']);
  assert.equal(pane.draft, '');
});

test('a menu row under a divider is still a question when nothing closes it', async () => {
  // AskUserQuestion draws "Chat about this" directly under a divider, the one
  // menu row shaped like a prompt line. Real capture with the pointer moved.
  const asked = fs.readFileSync(path.join(__dirname, '../fixtures/askuserquestion/real-claude-120x60.txt'), 'utf8')
    .split('\n')
    .map((line) => line.replace(/^❯(\s*1\.)/, ' $1').replace(/^ {2}(5\. Chat about this)/, '❯ $1'))
    .join('\n');
  assert.match(asked, /^❯ 5\. Chat about this/m);
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1', promptEchoes: false, readFrames: [asked] });
  const send = createSessionSend(h.deps);
  assert.ok(await send.getMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }), 'the question gets its card');
  await assert.rejects(send.send({ sessionId: 's-asked', text: 'continue', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }));
  assert.ok(!typed(h).includes('\r'), 'no Enter into a live question');

  // The parser does not know this one, so only the classifier stands between
  // it and a dead end: a divider above a pointer row is not a prompt box.
  const novel = ['Pick a look', PROMPT_RULE, '❯ 1. Dark', '  2. Light', '', ' Syntax theme: plain (ctrl+t to disable)'].join('\n');
  const n = makeHarness({ panes: ['pane-1'] });
  n.deps.readPane = async () => novel;
  assert.ok((await createSessionSend(n.deps).getMenu({ pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }))?.fallback);
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
    resumeSession: async ({ id }) => { h.state.panes.push({ pane_id: 'pane-fresh', workspace_id: 'ws-1', agent_session: { kind: 'id', value: id } }); },
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

// PAT'S PHONE TEXT INTO CODEX (2026-11-01, three refusals while he watched):
// "didn’t…" arrived in Astra's box as "didnt", so the box never matched and no
// Enter was pressed. Codex sends now carry the ASCII twins.
test('a Codex send with smart punctuation types its ASCII twins and is submitted', async () => {
  const text = 'It should have done a lot more research\u2026 If it didn\u2019t then it didn\u2019t do what I asked \u2013 \u201cfully\u201d';
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.platform = 'win32';
  const pane = codexPane(h, { dropsSymbols: true });
  await createSessionSend(h.deps).send({ sessionId: 'pane:codex-phone', text, provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  const ascii = 'It should have done a lot more research... If it didn\'t then it didn\'t do what I asked - "fully"';
  assert.deepEqual(typed(h), [`\x1b[200~${ascii}\x1b[201~`, '\r']);
  assert.deepEqual(pane.echoed, [ascii]);
});

test('codexSafeText: twins for smart punctuation, letters and emoji kept, other symbols named as dropped', () => {
  assert.deepEqual((({ text, dropped }) => ({ text, dropped }))(codexSafeText('didn\u2019t\u2026 \u201cok\u201d a\u2013b \u2192 caf\u00e9 \ud83d\ude80')), { text: 'didn\'t... "ok" a-b -> café \ud83d\ude80', dropped: [] });
  assert.deepEqual((({ text, dropped }) => ({ text, dropped }))(codexSafeText('3\u00b0C \u2713 a\u00a0b\u200bc')), { text: '3C  a bc', dropped: ['\u00b0', '\u2713', '\u200b'] });
  // Measured round 2 (2026-11-01): Codex drops the emoji joiner and combining
  // marks but keeps CJK punctuation and full-width forms; a decomposed é is
  // composed first so it survives.
  assert.deepEqual((({ text, dropped }) => ({ text, dropped }))(codexSafeText('cafe\u0301 a\u00f7b \ud83d\udc69\u200d\ud83d\udcbb \u3002\uff01')), { text: 'café a/b \ud83d\udc69\ud83d\udcbb \u3002\uff01', dropped: ['\u200d'] });
  assert.deepEqual((({ text, dropped }) => ({ text, dropped }))(codexSafeText('plain ascii')), { text: 'plain ascii', dropped: [] });
});

// 2026-11-01: while a message waits in Claude's queue the box shows a dim
// "Press up to edit queued messages", which the command bar offered on Tab.
test('getSuggestion never offers one of Claude\'s own box hints', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  let next = 'Press up to edit queued messages';
  h.deps.readSuggestion = async () => next;
  const api = createSessionSend(h.deps);
  const pane = { paneId: 'pane-1', workspaceId: 'ws-1' };
  assert.equal(await api.getSuggestion({ pane }), null);
  next = 'Try "refactor <filepath>"';
  assert.equal(await api.getSuggestion({ pane }), null);
  next = 'run the tests again';
  assert.equal(await api.getSuggestion({ pane }), 'run the tests again');
});

// ASTRA'S ROUND-2 REVIEW (2026-11-01), each counterexample as a spec.
test('round 2: removing what Codex cannot show never turns a message into a command or into nothing', async () => {
  for (const [text, why] of [['\u2713/exit', /start with "\/" and run as a Codex command/], ['\u2713 \u2714', /be empty/]]) {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    h.deps.platform = 'win32';
    codexPane(h);
    await assert.rejects(
      createSessionSend(h.deps).send({ sessionId: 'pane:codex-guard', text, provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
      (error) => error.code === 'CODEX_TEXT_UNSENDABLE' && why.test(error.message),
    );
    assert.deepEqual(typed(h), [], `nothing typed for ${JSON.stringify(text)}`);
  }
});

test('round 2: the Codex text rule applies on Windows only, where it was measured', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.platform = 'darwin';
  codexPane(h);
  await createSessionSend(h.deps).send({ sessionId: 'pane:codex-mac', text: 'didn\u2019t', provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.deepEqual(typed(h), ['\x1b[200~didn\u2019t\x1b[201~', '\r']);
});

test('round 2: a normalized Codex send is confirmed against the text that was sent, not the original', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 'rollout.jsonl');
  await fsp.writeFile(file, '');
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.platform = 'win32';
  h.deps.getSessionMeta = async () => ({ cwd: '/x', path: file, provider: 'codex' });
  const pane = codexPane(h, { dropsSymbols: true });
  process.env.HARBOR_CONFIRM_TIMEOUT_MS = '600';
  try {
    const send = createSessionSend(h.deps);
    const statuses = [];
    send.emitter.on('status', (value) => statuses.push(value));
    const res = await send.send({ sessionId: 'codex-smart-confirm', text: 'It didn\u2019t work \u2014 again', provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
    assert.equal(res.delivery, 'confirming');
    assert.deepEqual(pane.echoed, ["It didn't work - again"]);
    await fsp.appendFile(file, `${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: "It didn't work - again" } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(statuses.some((s) => s.phase === 'error'), false, `no false error: ${JSON.stringify(statuses)}`);
  } finally {
    delete process.env.HARBOR_CONFIRM_TIMEOUT_MS;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('round 2: no slack on a whole placeholder, and a box that only spells a placeholder is not proof', () => {
  const footer = '  GPT-6-Astra high · C:\\dev\\proof · proof';
  const screenWith = (box) => `• OK\n\n› ${box}\n\n${footer}`;
  assert.notEqual(codexBoxMatch(screenWith('[Pasted Content 1182 chars]'), { text: `${'x'.repeat(1182)}NO` }).state, 'exact');
  assert.notEqual(codexBoxMatch(screenWith('[Pasted Content 1184 chars]'), { text: 'x'.repeat(1182) }).state, 'exact');
  assert.notEqual(codexBoxMatch(screenWith('[Pasted Content 1000 chars]'), { text: 'x'.repeat(1000) }).state, 'exact');
  assert.deepEqual(codexBoxMatch(screenWith('F[Pasted Content 1182 chars]'), { text: 'F[Pasted Content 1182 chars]' }), { state: 'exact', opaque: true , clipped: false });
  // A message that mentions a large placeholder matches either reading, opaquely.
  assert.deepEqual(codexBoxMatch(screenWith('Explain [Pasted Content 1200 chars] [Pasted Content 1182 chars]'), { text: `Explain [Pasted Content 1200 chars] ${'x'.repeat(1182)}` }), { state: 'exact', opaque: true , clipped: false });
  // Harbor's own record of two Enters pressed into its paste covers exactly two more.
  assert.equal(codexBoxMatch(screenWith('F[Pasted Content 1184 chars]'), { text: `F${'x'.repeat(1182)}`, extra: 2 }).state, 'exact');
  assert.notEqual(codexBoxMatch(screenWith('F[Pasted Content 1185 chars]'), { text: `F${'x'.repeat(1182)}`, extra: 2 }).state, 'exact');
});

test('round 2: a box holding other text after Enter is not "sent", and gets no second Enter', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = codexPane(h);
  const original = h.deps.terminalBridge.sendInput;
  let entered = false;
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    if (text === '\r' && !entered) { entered = true; return original(paneId, ' and something else'); }
    return original(paneId, text);
  };
  // Round 3: with no transcript to read (a pane: window), that is an error the
  // user sees, never "sent".
  const send = createSessionSend(h.deps);
  const statuses = [];
  send.emitter.on('status', (value) => statuses.push(value.phase));
  await assert.rejects(
    send.send({ sessionId: 'pane:codex-changed', text: 'hello there', provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'CODEX_UNCONFIRMED',
  );
  assert.equal(statuses.includes('sent'), false, `never reported sent: ${statuses.join(' ')}`);
  assert.deepEqual(typed(h), ['\x1b[200~hello there\x1b[201~', ' and something else'], 'one Enter only, swallowed into the box here');
  assert.deepEqual(pane.echoed, []);
  const log = await readSendLog(h.deps.sendLogFile, (rows) => rows.some((r) => r.phase === 'enter-state'));
  assert.equal(log.find((r) => r.phase === 'enter-state')?.state, 'unconfirmed', 'not reported as taken');
  assert.ok(log.some((r) => r.phase === 'codex-box-changed-after-enter'));
});

test('round 2: other text appearing in front of the message while Harbor types it stops the Enter', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  codexPane(h);
  const read = h.deps.readPane;
  h.deps.readPane = async (...args) => {
    const screen = await read(...args);
    return typed(h).length ? screen.replace('› hello there', '› FOREIGN hello there') : screen;
  };
  await assert.rejects(
    createSessionSend(h.deps).send({ sessionId: 'pane:codex-race', text: 'hello there', provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'CODEX_BOX_CHANGED',
  );
  assert.deepEqual(typed(h), ['\x1b[200~hello there\x1b[201~'], 'no Enter');
});

test('round 2: a retry record is for the exact text; whitespace inside it matters', async () => {
  const text = `print('a b') ${'x'.repeat(1200)}`;
  const other = `print('ab ') ${'x'.repeat(1200)}`;
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  codexPane(h, { swallowEnters: 2 });
  const send = createSessionSend(h.deps);
  await assert.rejects(send.send({ sessionId: 'pane:codex-ws', text, provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }), (error) => error.code === 'CODEX_NOT_SUBMITTED');
  await assert.rejects(
    send.send({ sessionId: 'pane:codex-ws', text: other, provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'CODEX_BOX_BUSY',
  );
});

// ASTRA'S ROUND 3 (2026-11-01). A box that shows only the END of a message is
// that message only when Codex marked it clipped (the "↑" at the right edge of
// its first row, real capture at 50 columns); and a row under the status line
// must not be read as part of the box.
test('round 3: a clipped Codex box is recognised by its marker, and an unclipped end is not enough', () => {
  const clippedScreen = codexFixture('codex-0.166.0-clipped-draft-50.txt');
  const text = Array.from({ length: 99 }, (_, i) => `w${String(i).padStart(2, '0')}-abcde`).join(' ').slice(0, 990);
  assert.deepEqual(codexBoxMatch(clippedScreen, { text }), { state: 'holds', opaque: false, clipped: true });
  assert.match(codexBoxDraft(clippedScreen), /^w45-abcdew46/, 'the marker is not part of the draft');
  const footer = '  GPT-6-Astra high · C:\\dev\\proof · proof';
  const shortBox = `• OK\n\n› ${'x'.repeat(40)}\n\n${footer}`;
  assert.deepEqual(codexBoxMatch(shortBox, { text: `Do not deploy. ${'x'.repeat(40)}` }), { state: 'holds', opaque: false, clipped: false });
});

test('round 3: an unclipped box that shows only the end of the message gets no Enter', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  codexPane(h);
  const read = h.deps.readPane;
  h.deps.readPane = async (...args) => {
    const screen = await read(...args);
    return typed(h).length ? screen.replace(/› Do not deploy\. /, '› ') : screen;
  };
  await assert.rejects(
    createSessionSend(h.deps).send({ sessionId: 'pane:codex-partial', text: `Do not deploy. ${'x'.repeat(40)}`, provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }),
    (error) => error.code === 'CODEX_BOX_CHANGED',
  );
  assert.equal(typed(h).includes('\r'), false, 'no Enter');
});

test('round 3: a Codex send that changed characters says exactly what changed', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.platform = 'win32';
  codexPane(h, { dropsSymbols: true });
  const send = createSessionSend(h.deps);
  const statuses = [];
  send.emitter.on('status', (value) => statuses.push(value));
  await send.send({ sessionId: 'pane:codex-note', text: 'Open a\u2013b.txt \u2713', provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  const sent = statuses.find((value) => value.phase === 'sent');
  assert.match(sent.detail, /with \u2013 as -/);
  assert.match(sent.detail, /without \u2713/);
  assert.deepEqual(codexSafeText('a\u2019b\u2019c').mapped, [['\u2019', "'"]]);
});

// Live-caught while proving round 3 (2026-11-01): a fresh Codex's first message
// is echoed with "Waiting for startup · esc cancel" under it and no box drawn.
// That is delivery, not "other text left in the box".
test('round 3: a fresh Codex echoing the message while it starts up has taken it', async () => {
  const text = 'Reply with just OK. it didn\'t... "quoted" - dash';
  const header = '⚠ Heads up, you have less than 25% of your weekly limit left. Run /status for a breakdown.\n\n  >_ OpenAI Codex (v0.166.0)\n     ~\\work\n  permissions: YOLO mode\n\n';
  for (const gap of ['\n', '\n\n']) {
    const screen = `${header}› ${text}${gap}  Waiting for startup  · esc cancel\n`;
    assert.equal(codexBoxDraft(screen), null, 'no box is drawn');
    assert.equal(codexStartupEcho(screen, { text }), true);
    assert.equal(codexStartupEcho(screen, { text: 'something else' }), false);
  }
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = codexPane(h);
  const read = h.deps.readPane;
  h.deps.readPane = async (...args) => (typed(h).includes('\r') ? `${header}› hello there\n  Waiting for startup  · esc cancel\n` : read(...args));
  const statuses = [];
  const send = createSessionSend(h.deps);
  send.emitter.on('status', (value) => statuses.push(value.phase));
  await send.send({ sessionId: 'pane:codex-fresh', text: 'hello there', provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.deepEqual(typed(h), ['\x1b[200~hello there\x1b[201~', '\r'], 'one Enter');
  assert.ok(statuses.includes('sent'));
  assert.ok(pane);
});

// ASTRA'S ROUND 4 (2026-11-01), each counterexample as a spec.
test('round 4: only the whole measured startup layout is a delivered echo', () => {
  const footer = '  GPT-6-Astra high · C:\\dev\\proof · proof';
  // A still-filled two-line box over its status line: a draft, not an echo.
  const draft = `• OK\n\n› hello\n  Waiting for startup · esc cancel\n\n${footer}`;
  assert.equal(codexStartupEcho(draft, { text: 'hello' }), false);
  assert.notEqual(codexBoxDraft(draft), null, 'it is a box');
  // Extra rows between the echo and the status: not this message.
  assert.equal(codexStartupEcho('› hello\n\n  EXTRA UNSENT TEXT\n  Waiting for startup · esc cancel', { text: 'hello' }), false);
  // A real echo with a paragraph break, status row last: delivered.
  assert.equal(codexStartupEcho('  >_ OpenAI Codex\n\n› first part\n\n  second part\n  Waiting for startup  · esc cancel\n', { text: 'first part\n\nsecond part' }), true);
});

test('round 4: an assistant reply quoting the message does not confirm a Codex send', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 'rollout.jsonl');
  await fsp.writeFile(file, '');
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.getSessionMeta = async () => ({ cwd: '/x', path: file, provider: 'codex' });
  codexPane(h);
  const original = h.deps.terminalBridge.sendInput;
  let entered = false;
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    if (text === '\r' && !entered) { entered = true; return original(paneId, ' still here'); }
    return original(paneId, text);
  };
  process.env.HARBOR_CONFIRM_TIMEOUT_MS = '700';
  try {
    const send = createSessionSend(h.deps);
    const statuses = [];
    send.emitter.on('status', (value) => statuses.push(value.phase));
    const res = await send.send({ sessionId: 'codex-quote', text: 'hello', provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
    assert.equal(res.delivery, 'confirming');
    await fsp.appendFile(file, `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(statuses.includes('sent'), false, `not confirmed by the assistant: ${statuses.join(' ')}`);
    assert.equal(statuses.at(-1), 'error');
  } finally {
    delete process.env.HARBOR_CONFIRM_TIMEOUT_MS;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('round 4: a later send owns the status; an older confirmation cannot overwrite it', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 'rollout.jsonl');
  await fsp.writeFile(file, '');
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  h.deps.platform = 'win32';
  h.deps.getSessionMeta = async () => ({ cwd: '/x', path: file, provider: 'codex' });
  codexPane(h);
  const original = h.deps.terminalBridge.sendInput;
  let entered = false;
  h.deps.terminalBridge.sendInput = (paneId, text) => {
    if (text === '\r' && !entered) { entered = true; return original(paneId, ' still here'); }
    return original(paneId, text);
  };
  process.env.HARBOR_CONFIRM_TIMEOUT_MS = '1500';
  try {
    const send = createSessionSend(h.deps);
    const statuses = [];
    send.emitter.on('status', (value) => statuses.push(value.phase));
    await send.send({ sessionId: 'codex-own', text: 'hello', provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
    await assert.rejects(send.send({ sessionId: 'codex-own', text: '\u2713/exit', provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } }), (error) => error.code === 'CODEX_TEXT_UNSENDABLE');
    await fsp.appendFile(file, `${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hello' } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(statuses.at(-1), 'error', `the newer refusal stays: ${statuses.join(' ')}`);
  } finally {
    delete process.env.HARBOR_CONFIRM_TIMEOUT_MS;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('round 4: the change note names special spaces and joined accents', () => {
  assert.match(codexChangeNote(codexSafeText('a\u00a0b')), /U\+00A0 \(a special space\) as a plain space/);
  assert.match(codexChangeNote(codexSafeText('cafe\u0301')), /accents joined to their letters/);
  assert.equal(codexChangeNote(codexSafeText('plain')), null);
});

test('round 4: an image-only Codex send is not stopped by the text check', async () => {
  const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
  const pane = codexPane(h);
  await createSessionSend(h.deps).send({ sessionId: 'pane:codex-image', text: '', images: ['C:/virtual/example.png'], provider: 'codex', pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
  assert.ok(typed(h).includes('\r'), `Enter pressed: ${JSON.stringify(typed(h))}`);
  assert.equal(pane.echoed.length, 1);
});

// 2026-11-02, Pat's screenshot into this very session: "failed: could not
// confirm the message reached the session" on a message that had arrived. A
// mid-turn send with a picture is queued as "[Image #8] <text>", and the
// queued_command that carries the picture stores its prompt as a list of parts.
test('2026-11-02: a queued image send confirms by its enqueue, and only with the images it sent', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 't.jsonl');
  const text = 'i dont have a way to send messages now that are queued';
  await fsp.writeFile(file, `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: `[Image #8] ${text}` })}\n`);
  const send = createSessionSend(makeHarness({ panes: ['pane-1'] }).deps);
  const prepared = { path: file, preSize: 0 };
  assert.equal(await send.confirmDelivery('s', text, { prepared, images: 1, timeoutMs: 1200 }), true);
  // A text-only send is not confirmed by someone's message that adds a picture.
  await assert.rejects(send.confirmDelivery('s', text, { prepared, images: 0, timeoutMs: 1200 }), (e) => e.code === 'UNCONFIRMED');
  // Nor by a chip count that is not what it sent.
  await assert.rejects(send.confirmDelivery('s', text, { prepared, images: 2, timeoutMs: 1200 }), (e) => e.code === 'UNCONFIRMED');
  await fsp.rm(dir, { recursive: true, force: true });
});

// Round thirty: a line of the message's own that Claude turned into a picture is
// not in the transcript as text; the converted form confirms too.
test('a message whose own path line Claude turned into a picture confirms in its converted form', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 't.jsonl');
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
  const send = createSessionSend(makeHarness({ panes: ['pane-1'] }).deps);
  // chips: what the verified draft showed (round thirty-two); null when it showed no conversion.
  const confirm = async (records, text, { images = 0, chips = null } = {}) => {
    await fsp.writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return send.confirmDelivery('s', text, { prepared: { path: file, preSize: 0 }, images, chips, timeoutMs: 1200 });
  };
  const turn = (said, pictures = 1) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: said }, ...Array(pictures).fill(image)] } });
  const unconfirmed = (e) => e.code === 'UNCONFIRMED';
  const text = 'compare with this one\n"C:\\Users\\me\\Pictures\\other.png"';
  const three = { chips: ['[Image #3]'] };
  // A text-only message: a user turn, and a queued one.
  assert.equal(await confirm([turn('[Image #3] compare with this one')], text, three), true, 'user turn');
  assert.equal(await confirm([{ type: 'queue-operation', operation: 'enqueue', content: '[Image #3] compare with this one' }], text, three), true, 'queued');
  // A caption beside a sent picture: two chips queued, one sent and one converted.
  assert.equal(await confirm([{ type: 'queue-operation', operation: 'enqueue', content: '[Image #4] [Image #5] compare with this one' }], text, { images: 1, chips: ['[Image #4]', '[Image #5]'] }), true, 'caption with a sent picture');
  // Every line a path: only the pictures arrive, exactly those.
  const paths = '"C:\\a.png"\n"C:\\b.png"';
  const both = { chips: ['[Image #1]', '[Image #2]'] };
  assert.equal(await confirm([turn('[Image #1] [Image #2]', 2)], paths, both), true, 'pictures only');
  await assert.rejects(confirm([turn('[Image #1]')], paths, both), unconfirmed, 'one picture is not two');
  await assert.rejects(confirm([turn('[Image #3] a different message')], text, three), unconfirmed, 'another message');
  // Round thirty-one: its words alone, or the wrong picture count, are not this send.
  await assert.rejects(confirm([{ type: 'user', message: { role: 'user', content: 'compare with this one' } }], text, three), unconfirmed, 'the words alone, no picture');
  await assert.rejects(confirm([{ type: 'queue-operation', operation: 'enqueue', content: 'compare with this one' }], text, three), unconfirmed, 'a plain enqueue');
  await assert.rejects(confirm([turn('[Image #3] compare with this one', 2)], text, three), unconfirmed, 'two pictures for one');
  // Round thirty-two: the same words with ANOTHER send's picture (an earlier
  // try taken in late) are not this send, and nothing converted unless the
  // verified draft showed it.
  await assert.rejects(confirm([turn('[Image #2] compare with this one')], text, three), unconfirmed, 'another picture, same words');
  await assert.rejects(confirm([{ type: 'queue-operation', operation: 'enqueue', content: '[Image #2] compare with this one' }], text, three), unconfirmed, 'another picture, queued');
  await assert.rejects(confirm([turn('[Image #2] [Image #1]', 2)], paths, { chips: ['[Image #3]', '[Image #4]'] }), unconfirmed, 'other pictures only');
  await assert.rejects(confirm([turn('[Image #3] compare with this one')], text), unconfirmed, 'no conversion seen in the draft');
  // Round thirty-three: attachments are the LEADING chips. A label quoted in
  // prose is words: it neither confirms another send's picture nor makes a
  // caption that quotes one fail.
  await assert.rejects(confirm([turn('[Image #2] compare with this one, see [Image #3]')], text, three), unconfirmed, 'another picture, this chip only quoted');
  const quoting = 'look at [Image #3] again\n"C:\\Users\\me\\Pictures\\other.png"';
  assert.equal(await confirm([{ type: 'queue-operation', operation: 'enqueue', content: '[Image #4] [Image #5] look at [Image #3] again' }], quoting, { images: 1, chips: ['[Image #4]', '[Image #5]', '[Image #3]'] }), true, 'a caption quoting a label');
  assert.equal(await confirm([turn('[Image #4] [Image #5] look at [Image #3] again', 2)], quoting, { images: 1, chips: ['[Image #4]', '[Image #5]', '[Image #3]'] }), true, 'the same as a user turn');
  await fsp.rm(dir, { recursive: true, force: true });
});

// Round thirty-five: another session's words never confirm a typed send, and a
// late check never speaks over a newer send.
test('a peer message through the native inbox never confirms a typed send, and a record must be the whole message', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 't.jsonl');
  const send = createSessionSend(makeHarness({ panes: ['pane-1'] }).deps);
  const confirm = async (record, text = 'continue', options = {}) => {
    await fsp.writeFile(file, `${JSON.stringify(record)}\n`);
    return send.confirmDelivery('s', text, { prepared: { path: file, preSize: 0 }, timeoutMs: 1200, ...options });
  };
  const unconfirmed = (e) => e.code === 'UNCONFIRMED';
  const wrapped = '<cross-session-message from-name="Router">\nPlease continue with the next part\n</cross-session-message>';
  await assert.rejects(confirm({ type: 'queue-operation', operation: 'enqueue', content: wrapped }), unconfirmed, 'the peer\'s enqueue');
  await assert.rejects(confirm({ type: 'user', message: { role: 'user', content: wrapped } }), unconfirmed, 'the peer\'s turn');
  await assert.rejects(confirm({ type: 'user', isMeta: true, message: { role: 'user', content: 'Another Claude session sent a message: continue' } }), unconfirmed, 'Claude\'s note about it');
  await assert.rejects(confirm({ type: 'user', message: { role: 'user', content: 'Please continue with the next part' } }), unconfirmed, 'a longer message holding the word');
  await assert.rejects(confirm({ type: 'user', message: { role: 'user', content: '<cross-session-message from-name="Router">\ncontinue\n</cross-session-message>' } }), unconfirmed, 'a peer saying exactly the same');
  assert.equal(await confirm({ type: 'user', message: { role: 'user', content: 'continue' } }), true, 'the typed message itself');
  assert.equal(await confirm({ type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>\n<command-args>haiku</command-args>' } }, '/model haiku', { optional: true }), true, 'a real slash command by its tag');
  await fsp.rm(dir, { recursive: true, force: true });
});

// Round thirty-six: words compared with their spaces, only recognized records,
// and the typed words out of Claude's own paste wrapper.
test('a delivery record confirms only as a recognized record holding exactly the typed words', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 't.jsonl');
  const send = createSessionSend(makeHarness({ panes: ['pane-1'] }).deps);
  const confirm = async (record, text) => {
    await fsp.writeFile(file, `${JSON.stringify(record)}\n`);
    return send.confirmDelivery('s', text, { prepared: { path: file, preSize: 0 }, timeoutMs: 1200 });
  };
  const unconfirmed = (e) => e.code === 'UNCONFIRMED';
  const user = (content) => ({ type: 'user', message: { role: 'user', content } });
  const notes = 'Use C:/work/release notes.txt';
  await assert.rejects(confirm(user('Use C:/work/releasenotes.txt'), notes), unconfirmed, 'another file whose name lacks the space');
  await assert.rejects(confirm({ type: 'queue-operation', operation: 'enqueue', content: 'Use C:/work/releasenotes.txt' }, notes), unconfirmed, 'the same, queued');
  // Round thirty-seven: exact words (a line break is not a space; indentation is content).
  await assert.rejects(confirm(user('Use C:/work/release\nnotes.txt'), notes), unconfirmed, 'a line break where a space was is another message');
  assert.equal(await confirm(user('Use C:/work/release notes.txt  \r\n'), notes), true, 'trailing spaces and line endings aside, the same message');
  await assert.rejects(confirm({ type: 'summary', summary: 'continue', leafUuid: 'x' }, 'continue'), unconfirmed, 'a session summary');
  await assert.rejects(confirm({ type: 'progress', data: { message: 'continue' } }, 'continue'), unconfirmed, 'a shape not known as a delivery');
  const prose = 'the tag <cross-session-message shows up in the log';
  assert.equal(await confirm(user(prose), prose), true, 'prose naming the peer tag is typed words');
  const pasted = 'line one of the note\nline two of the note';
  assert.equal(await confirm(user(`<pasted_content id="9d3b">\n${pasted}\n</pasted_content id="9d3b">`), pasted), true, 'Claude\'s paste pair unwrapped');
  assert.equal(await confirm({ type: 'queue-operation', operation: 'enqueue', content: `<pasted_content id="9d3b">\n${pasted}\n</pasted_content id="9d3b">` }, pasted), true, 'the same, queued');
  // Cursor: no type, the words framed in <user_query>.
  const cursor = (words) => ({ role: 'user', message: { content: [{ type: 'text', text: `<timestamp>Thursday, Nov 19, 2026</timestamp>\n<user_query>\n${words}\n</user_query>` }] } });
  assert.equal(await confirm(cursor('hello there'), 'hello there'), true, 'a Cursor turn');
  await assert.rejects(confirm(cursor('hello there'), 'hello'), unconfirmed, 'a Cursor turn that only holds the words');
  await fsp.rm(dir, { recursive: true, force: true });
});

// Round thirty-seven: exact words, the literal text first, and Codex's typed item.
test('a record confirms only with the exact typed words: indentation, literal tags and Codex instruction items', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 't.jsonl');
  const send = createSessionSend(makeHarness({ panes: ['pane-1'] }).deps);
  const confirm = async (record, text) => {
    await fsp.writeFile(file, `${JSON.stringify(record)}\n`);
    return send.confirmDelivery('s', text, { prepared: { path: file, preSize: 0 }, timeoutMs: 1000 });
  };
  const unconfirmed = (e) => e.code === 'UNCONFIRMED';
  const user = (content) => ({ type: 'user', message: { role: 'user', content } });
  // Indentation is content.
  const inside = 'if ready:\n    run_first()\n    run_second()';
  const outside = 'if ready:\n    run_first()\nrun_second()';
  await assert.rejects(confirm(user(outside), inside), unconfirmed, 'another snippet, user turn');
  await assert.rejects(confirm({ type: 'queue-operation', operation: 'enqueue', content: outside }, inside), unconfirmed, 'another snippet, queued');
  assert.equal(await confirm(user(inside), inside), true, 'the snippet itself');
  // A tag the message itself holds is its words; only a part the CLI adds is set aside.
  const literal = 'Document this example:\n<system-reminder>be brief</system-reminder>';
  assert.equal(await confirm(user(literal), literal), true, 'a message holding a literal reminder tag');
  await assert.rejects(confirm(user(literal), 'Document this example:'), unconfirmed, 'its first line alone');
  assert.equal(await confirm(user([{ type: 'text', text: '<system-reminder>the CLI added this</system-reminder>' }, { type: 'text', text: 'hello there' }]), 'hello there'), true, 'a reminder part of its own is the CLI\'s');
  // Codex: the typed item, never its instruction items.
  const codexTurn = { type: 'response_item', payload: { type: 'message', role: 'user', content: [
    { type: 'input_text', text: '# AGENTS.md instructions\n<INSTRUCTIONS>\nAlways run focused tests before finishing.\n</INSTRUCTIONS>' },
    { type: 'input_text', text: 'Review the settings file.' },
  ] } };
  await assert.rejects(confirm(codexTurn, 'run focused tests'), unconfirmed, 'words inside AGENTS.md');
  assert.equal(await confirm(codexTurn, 'Review the settings file.'), true, 'the typed item');
  await assert.rejects(confirm({ type: 'event_msg', payload: { type: 'user_message', message: 'Please run focused tests now' } }, 'run focused tests'), unconfirmed, 'a user_message only holding the words');
  await fsp.rm(dir, { recursive: true, force: true });
});

// Rounds thirty-eight and thirty-nine: a draft is this send only with this
// send's spaces, the screen alone settles only a one-row draft, and a record of
// a different draft vetoes the screen.
test('an Enter-only retry needs the draft drawn with the send\'s own spaces, in Claude and Codex', async () => {
  const notes = 'Use C:/work/release notes.txt';
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  const claude = async (draft, options = {}) => {
    const h = makeHarness({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', created_at: LONG_AGO() }], controlled: 'pane-1' });
    const pane = composerPane(h, { initialDraft: draft, ...options });
    const send = createSessionSend(h.deps);
    let code = 'sent';
    try { await send.send({ sessionId: 's-spaces', text: notes, pane: target }); } catch (error) { code = error.code; }
    return { code, typed: typed(h), pane };
  };
  const other = await claude('Use C:/work/releasenotes.txt');
  assert.notEqual(other.code, 'sent', 'another file\'s name is refused');
  assert.equal(other.typed.includes('\r'), false, 'no Enter on the other filename');
  assert.equal(other.pane.draft, 'Use C:/work/releasenotes.txt', 'the prompt is left as it was');
  const same = await claude(notes);
  assert.equal(same.code, 'sent', 'the same message on one row');
  assert.deepEqual(same.typed, ['\r'], 'Enter only, nothing typed again');
  // Wrapped, the screen cannot tell "release notes" from "releasenotes" cut in two.
  for (const wrapAt of [19, 17]) {
    const wrapped = await claude(notes, { wrapAt });
    assert.notEqual(wrapped.code, 'sent', `a wrapped draft is not settled by the screen alone (row width ${wrapAt})`);
    assert.equal(wrapped.typed.includes('\r'), false);
  }
  const codex = async (draft) => {
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    codexPane(h, { initialDraft: draft });
    const send = createSessionSend(h.deps);
    let code = 'sent';
    try { await send.send({ sessionId: 'pane:pane-1', provider: 'codex', text: notes, pane: target }); } catch (error) { code = error.code; }
    return { code, typed: typed(h) };
  };
  const codexOther = await codex('Use C:/work/releasenotes.txt');
  assert.notEqual(codexOther.code, 'sent', 'Codex: another file\'s name is refused');
  assert.equal(codexOther.typed.includes('\r'), false, 'Codex: no Enter on the other filename');
  const codexSame = await codex(notes);
  assert.equal(codexSame.code, 'sent', 'Codex: the same message');
  assert.deepEqual(codexSame.typed, ['\r'], 'Codex: Enter only');
});

test('a record of a different earlier draft vetoes an Enter-only retry the screen cannot tell apart', async () => {
  const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
  const run = async (first, second, options) => {
    const h = makeHarness({ panes: [{ pane_id: 'pane-1', workspace_id: 'ws-1', created_at: LONG_AGO() }], controlled: 'pane-1' });
    const pane = composerPane(h, { swallowEnters: 50, ...options });
    const send = createSessionSend(h.deps);
    let firstOutcome = 'sent';
    try { firstOutcome = (await send.send({ sessionId: 's-veto', text: first, pane: target })).delivery; } catch (error) { firstOutcome = error.code; }
    assert.ok(pane.draft, `the first send's draft stays in the prompt (${firstOutcome})`);
    const before = typed(h).length;
    let code = 'sent';
    try { await send.send({ sessionId: 's-veto', text: second, pane: target }); } catch (error) { code = error.code; }
    return { code, after: typed(h).slice(before), pane, firstOutcome };
  };
  // Claude ignored the first send's Enters; its draft wraps between "release" and "notes.txt".
  const files = await run('Use C:/work/releasenotes.txt', 'Use C:/work/release notes.txt', { wrapAt: 19 });
  assert.notEqual(files.code, 'sent', 'the new request is refused');
  assert.deepEqual(files.after, [], 'no Enter on the old filename, nothing typed');
  // The earlier draft's picture is drawn as the same chip a new picture would be.
  const pictures = await run('C:\\shots\\older.png\nlook at this', 'C:\\shots\\newer.png\nlook at this', { pathChips: true });
  assert.notEqual(pictures.code, 'sent', 'a new picture request is refused');
  assert.deepEqual(pictures.after, [], 'no Enter on the older picture');
  // The same request again, on the record's word, still gets Enter only.
  const again = await run('Use C:/work/release notes.txt', 'Use C:/work/release notes.txt', { wrapAt: 19 });
  assert.deepEqual(again.after.filter((key) => key !== '\r'), [], 'the same request is never typed twice');
});

test('a Codex record confirms a picture send only when it carries the pictures', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 't.jsonl');
  const send = createSessionSend(makeHarness({ panes: ['pane-1'] }).deps);
  const confirm = async (record, text, images) => {
    await fsp.writeFile(file, `${JSON.stringify(record)}\n`);
    return send.confirmDelivery('s', text, { prepared: { path: file, preSize: 0 }, timeoutMs: 1000, images, paths: images ? ['C:\\Users\\pat\\shot.png'] : [] });
  };
  const unconfirmed = (e) => e.code === 'UNCONFIRMED';
  const caption = 'what is wrong on this screen';
  // Codex 0.17x: each picture an input_image item, the typed words their own item.
  const item = (pictures, shot = 'C:\\Users\\pat\\shot.png') => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [
    ...Array.from({ length: pictures }, (_, n) => [
      { type: 'input_text', text: `<image name=[Image #${n + 1}] path="${shot}">` },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      { type: 'input_text', text: '</image>' },
    ]).flat(),
    { type: 'input_text', text: caption },
  ] } });
  await assert.rejects(confirm(item(0), caption, 1), unconfirmed, 'a text-only turn with the caption');
  await assert.rejects(confirm({ type: 'event_msg', payload: { type: 'user_message', message: caption } }, caption, 1), unconfirmed, 'a text-only user_message');
  await assert.rejects(confirm(item(2), caption, 1), unconfirmed, 'a turn with another number of pictures');
  assert.equal(await confirm(item(1), caption, 1), true, 'the picture turn');
  assert.equal(await confirm(item(1, 'c:/users/pat/shot.png'), caption, 1), true, 'the same path, slashes and case aside');
  // Round thirty-nine: the pictures must be the send's own, by path.
  await assert.rejects(confirm(item(1, 'C:\\Users\\pat\\older.png'), caption, 1), unconfirmed, 'an older screenshot with the same caption');
  await assert.rejects(confirm({ type: 'event_msg', payload: { type: 'user_message', message: caption, images: ['data:image/png;base64,AAAA'] } }, caption, 1), unconfirmed, 'an encoded picture names no path');
  assert.equal(await confirm({ type: 'event_msg', payload: { type: 'user_message', message: caption, local_images: ['C:\\Users\\pat\\shot.png'] } }, caption, 1), true, 'a user_message naming it');
  await assert.rejects(confirm(item(1), caption, 0), unconfirmed, 'a picture turn is not a text-only send');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a Codex screenshot receipt larger than the line limit still confirms: its encoded picture is dropped as it streams', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 't.jsonl');
  const send = createSessionSend(makeHarness({ panes: ['pane-1'] }).deps);
  const shot = 'C:\\Users\\pat\\big.png';
  const record = { type: 'response_item', payload: { type: 'message', role: 'user', content: [
    { type: 'input_text', text: `<image name=[Image #1] path="${shot}">` },
    { type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(10 * 1024 * 1024)}`, detail: 'high' },
    { type: 'input_text', text: '</image>' },
    { type: 'input_text', text: 'is this layout right' },
  ] } };
  const line = JSON.stringify(record);
  for (const keyCut of [null, 5, 16]) {
    // keyCut: pad so the "image_url":"data: key is split by the 1 MB read boundary.
    let lead = '';
    if (keyCut) {
      const at = line.indexOf('"image_url":"data:');
      const skeleton = JSON.stringify({ type: 'progress', pad: '' });
      lead = `${JSON.stringify({ type: 'progress', pad: 'x'.repeat(1024 * 1024 - keyCut - at - 1 - skeleton.length) })}\n`;
    }
    await fsp.writeFile(file, `${lead}${line}\n`);
    assert.equal(await send.confirmDelivery('s', 'is this layout right', { prepared: { path: file, preSize: 0 }, timeoutMs: 3000, images: 1, paths: [shot] }), true, keyCut ? `key cut ${keyCut} characters in` : 'whole');
  }
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a late delivery check never overwrites the status of a newer send', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const before = process.env.HARBOR_CONFIRM_TIMEOUT_MS;
  process.env.HARBOR_CONFIRM_TIMEOUT_MS = '1500';
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  try {
    const file = path.join(dir, 't.jsonl');
    await fsp.writeFile(file, '');
    const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
    composerPane(h);
    h.deps.getSessionMeta = async () => ({ cwd: '/x', path: file });
    const send = createSessionSend(h.deps);
    const statuses = [];
    send.emitter.on('status', (s) => statuses.push(s.phase));
    const target = { paneId: 'pane-1', workspaceId: 'ws-1' };
    await send.send({ sessionId: 's-seq', text: 'first message, never in the transcript', pane: target });
    await send.send({ sessionId: 's-seq', text: 'second message', pane: target });
    await fsp.appendFile(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'second message' } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(statuses.at(-1), 'sent', `the newer send keeps its status: ${statuses.join(' > ')}`);
  } finally {
    if (before === undefined) delete process.env.HARBOR_CONFIRM_TIMEOUT_MS; else process.env.HARBOR_CONFIRM_TIMEOUT_MS = before;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// Round thirty-four: a screenshot send is held to its own draft's chips too, and
// a long line is judged whole or not at all.
test('a screenshot send confirms only on a record that starts with its own chips and carries its picture', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 't.jsonl');
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
  const send = createSessionSend(makeHarness({ panes: ['pane-1'] }).deps);
  const caption = 'what is wrong with this screen';
  const confirm = async (record) => {
    await fsp.writeFile(file, `${JSON.stringify(record)}\n`);
    return send.confirmDelivery('s', caption, { prepared: { path: file, preSize: 0 }, images: 1, chips: ['[Image#3]'], timeoutMs: 1200 });
  };
  const unconfirmed = (e) => e.code === 'UNCONFIRMED';
  assert.equal(await confirm({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `[Image #3] ${caption}` }, image] } }), true, 'its own picture');
  assert.equal(await confirm({ type: 'queue-operation', operation: 'enqueue', content: `[Image #3] ${caption}` }), true, 'queued');
  assert.equal(await confirm({ type: 'attachment', attachment: { type: 'queued_command', prompt: [{ type: 'text', text: `[Image #3] ${caption}` }, image] } }), true, 'queued_command');
  await assert.rejects(confirm({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `[Image #2] ${caption}` }, image] } }), unconfirmed, 'an older screenshot, same caption');
  await assert.rejects(confirm({ type: 'queue-operation', operation: 'enqueue', content: `[Image #2] ${caption}` }), unconfirmed, 'an older one queued');
  await assert.rejects(confirm({ type: 'user', message: { role: 'user', content: caption } }), unconfirmed, 'the caption alone');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a message too long to parse in one read is matched whole, never by its first 60 characters', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 't.jsonl');
  const send = createSessionSend(makeHarness({ panes: ['pane-1'] }).deps);
  const start = `please review this long note ${'y'.repeat(60)}`;
  const text = `${start}${'y'.repeat(1_500_000)}`;
  const codexUser = (message) => ({ type: 'event_msg', payload: { type: 'user_message', message } });
  const confirm = async (record) => {
    await fsp.writeFile(file, `${JSON.stringify(record)}\n`);
    return send.confirmDelivery('s', text, { prepared: { path: file, preSize: 0 }, timeoutMs: 2000 });
  };
  await assert.rejects(confirm(codexUser(`${start}${'z'.repeat(1_500_000)}`)), (e) => e.code === 'UNCONFIRMED', 'the same start, another message');
  assert.equal(await confirm(codexUser(text)), true, 'the same message, read whole');
  await fsp.rm(dir, { recursive: true, force: true });
});

// Round thirty-two: the chips the verified draft showed reach the delivery check.
test('a sent message whose path line Claude converts confirms only by the chips its draft showed', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const before = process.env.HARBOR_CONFIRM_TIMEOUT_MS;
  process.env.HARBOR_CONFIRM_TIMEOUT_MS = '1500';
  try {
    for (const chip of ['[Image #1]', '[Image #7]']) {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
      const file = path.join(dir, 't.jsonl');
      await fsp.writeFile(file, '');
      const h = makeHarness({ panes: ['pane-1'], controlled: 'pane-1' });
      composerPane(h, { pathChips: 'whole-line' });
      h.deps.getSessionMeta = async () => ({ cwd: '/x', path: file });
      const send = createSessionSend(h.deps);
      const errors = [];
      send.emitter.on('status', (s) => { if (s.phase === 'error') errors.push(s.detail); });
      const text = 'compare with this one\n"C:\\Users\\me\\Pictures\\other.png"';
      const result = await send.send({ sessionId: 's-conv', text, pane: { paneId: 'pane-1', workspaceId: 'ws-1' } });
      assert.equal(result.delivery, 'confirming');
      // The draft drew "[Image #1]"; the transcript gets that chip, or another send's.
      await fsp.appendFile(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `${chip} compare with this one` }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] } })}\n`);
      if (chip === '[Image #1]') {
        // Past its 1.5 s check with no error: it confirmed.
        await new Promise((resolve) => setTimeout(resolve, 2500));
        assert.deepEqual(errors, [], 'its own chip confirms');
      } else {
        // The refusal is awaited, not timed: under a loaded gate it can come
        // after 2.5 s (a run with three suites in parallel failed here).
        for (const end = Date.now() + 10_000; Date.now() < end && !errors.length;) await new Promise((resolve) => setTimeout(resolve, 50));
        assert.ok(errors.some((e) => /could not confirm/.test(e)), 'another send\'s chip does not');
      }
      await fsp.rm(dir, { recursive: true, force: true });
    }
  } finally {
    if (before === undefined) delete process.env.HARBOR_CONFIRM_TIMEOUT_MS; else process.env.HARBOR_CONFIRM_TIMEOUT_MS = before;
  }
});

test('a line too large to read whole confirms only as a delivery record, never a tool result quoting the words', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 't.jsonl');
  const send = createSessionSend(makeHarness({ panes: ['pane-1'] }).deps);
  const caption = 'please look at the failing build log';
  const bulk = 'log line\n'.repeat(170_000); // about 1.5 MB of words, no picture to strip
  for (const [where, content] of [['at its start', `${caption}\n${bulk}`], ['at its end', `${bulk}\n${caption}`]]) {
    const tool = { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content }] } };
    await fsp.writeFile(file, `${JSON.stringify(tool)}\n`);
    await assert.rejects(send.confirmDelivery('s', caption, { prepared: { path: file, preSize: 0 }, timeoutMs: 1500 }), (e) => e.code === 'UNCONFIRMED', `a tool result quoting it ${where} is not the message`);
  }
  const pasted = `${caption}\n${bulk}`;
  await fsp.writeFile(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: pasted } })}\n`);
  assert.equal(await send.confirmDelivery('s', pasted, { prepared: { path: file, preSize: 0 }, timeoutMs: 1500 }), true, 'a huge message of its own still confirms');
  await fsp.rm(dir, { recursive: true, force: true });
});

// Round thirty-one: a screenshot record runs to megabytes and straddles reads.
test('a large screenshot record confirms its caption, a leading slash included, wherever the reads fall', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 't.jsonl');
  const send = createSessionSend(makeHarness({ panes: ['pane-1'] }).deps);
  const big = (caption) => JSON.stringify({ type: 'user', message: { role: 'user', content: [
    { type: 'text', text: `[Image #1] ${caption}` },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR'.repeat(300_000) } },
  ] } });
  for (const caption of ['/compact is visible in this screenshot', 'plain words about it']) {
    for (const keyCut of [null, 3]) {
      // keyCut: pad so the image's "data":" key is split by the 1 MB read boundary.
      const record = big(caption);
      let lead = '';
      if (keyCut) {
        const at = record.indexOf('"data":"');
        const skeleton = JSON.stringify({ type: 'progress', pad: '' });
        lead = `${JSON.stringify({ type: 'progress', pad: 'x'.repeat(1024 * 1024 - keyCut - at - 1 - skeleton.length) })}\n`;
      }
      await fsp.writeFile(file, `${lead}${record}\n`);
      assert.equal(await send.confirmDelivery('s', caption, { prepared: { path: file, preSize: 0 }, images: 1, timeoutMs: 1500 }), true, `${caption}${keyCut ? ', key cut by the read boundary' : ''}`);
    }
  }
  assert.equal(send.confirmNeedle('/compact is visible', false), '/compact is visible', 'a message keeps its own words as the needle');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('2026-11-02: the queued_command that carries a picture confirms its send (its prompt is a list of parts)', async () => {
  const os = require('node:os');
  const fsp = require('node:fs/promises');
  const path = require('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-send-'));
  const file = path.join(dir, 't.jsonl');
  const text = 'now cant even see images? dude clean your shit up';
  await fsp.writeFile(file, `${JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: [
    { type: 'text', text: `[Image #9] ${text}` },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
  ], origin: { kind: 'human' } } })}\n`);
  const send = createSessionSend(makeHarness({ panes: ['pane-1'] }).deps);
  // The 60-character needle would find it too; a different message must not.
  assert.equal(await send.confirmDelivery('s', text, { prepared: { path: file, preSize: 0 }, images: 1, timeoutMs: 1200 }), true);
  await assert.rejects(send.confirmDelivery('s', 'a different message entirely', { prepared: { path: file, preSize: 0 }, images: 1, timeoutMs: 1200 }), (e) => e.code === 'UNCONFIRMED');
  await fsp.rm(dir, { recursive: true, force: true });
});
