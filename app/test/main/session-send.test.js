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
} = require('../../src/main/session-send.js');

const resumeDialogFixture = (name) => fs.readFileSync(
  path.join(__dirname, '../fixtures/resume-summary-dialog', name),
  'utf8',
);

test('claudeProjectDir munges every non-alphanumeric to dash', () => {
  assert.equal(
    claudeProjectDir('/home/you/dev/harbor', '/home/you'),
    '/home/you/.claude/projects/-home-you-dev-harbor',
  );
  assert.equal(
    claudeProjectDir('/home/p/My Files.v2', '/home/p'),
    '/home/p/.claude/projects/-home-p-My-Files-v2',
  );
});

test('provider transcript discovery uses the real Codex and Cursor stores', () => {
  // Yesterday rides along: a session launched before midnight writes its
  // rollout into the next day's directory, so a today-only scan would read
  // every one of yesterday's rollouts as brand new.
  assert.deepEqual(providerTranscriptDirs('codex', '/work/x', '/home/test', new Date('2026-07-20T12:00:00Z')), [
    '/home/test/.codex/sessions/2026/07/20',
    '/home/test/.codex/sessions/2026/07/19',
  ]);
  assert.deepEqual(providerTranscriptDirs('cursor', '/work/x', '/home/test'), [
    '/home/test/.cursor/projects/work-x/agent-transcripts',
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

function makeHarness({ panes = [], readFrames = [], controlled = null } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-session-send-test-'));
  const sent = [];
  const focused = [];
  const sequence = [];
  const state = { controlledPaneId: controlled, panes: [...panes] };
  const reads = [...readFrames];
  const harness = {
    sent,
    focused,
    state,
    sized: [],
    resumeCalls: [],
    deps: {
      snapshot: async () => ({
        panes: state.panes.map((p) => (typeof p === 'string' ? { pane_id: p, workspace_id: 'ws-1' } : p)),
        workspaces: [{ workspace_id: 'ws-1', label: 'harbor' }],
      }),
      readPane: async () => (reads.length > 1 ? reads.shift() : reads[0] ?? ''),
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
  return harness;
}

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
    ['input', '\x16'],
    ['clipboard', '/cache/two.png'],
    ['input', '\x16'],
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
    ['input', '\x16'],
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
    assert.deepEqual(h.sent.map(({ text }) => text), ['\x16']);
    assert.equal(statuses.at(-1).phase, 'error');
  } finally {
    Date.now = realNow;
  }
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
  assert.equal(typed.includes('\x16'), false, 'must not press Ctrl+V without a clipboard');
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
  assert.deepEqual(h.sent.filter((s) => s.paneId === 'pane-fresh').map((s) => s.text), ['hello', '\r']);
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
  await new Promise((r) => setTimeout(r, 60));

  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
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
  await new Promise((r) => setTimeout(r, 60));

  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const resolve = lines.find((l) => l.phase === 'resolve');
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
