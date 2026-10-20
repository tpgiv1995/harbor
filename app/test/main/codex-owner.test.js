'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');
const {
  createCodexOwnerProbe, createCodexTakeoverHandler, parsePsList, parsePsComm, parseCimList, OWNER_CODEX_APP,
  OWNER_HARBOR_PANE, harborPanesFromSnapshot, refuseBesideLiveCodexOwner,
  codexShape, isCodexProcess, isCodexAppProcess, isCodexAppRunning,
} = require('../../src/main/actions/codex-owner.js');
const { createSessionOperationGate } = require('../../src/main/actions/takeover.js');

const ID = '01a14169-2e08-7a93-9102-d8c1505b66c0';
const START = Date.parse('2026-10-15T12:00:00Z');
const meta = (originator, extra = {}) => ({ originator, source: originator === 'Codex Desktop' ? 'vscode' : 'cli', timestamp: new Date(START).toISOString(), cwd: '/work/app', ...extra });
const probe = (processes, sessionMeta, extra = {}) => createCodexOwnerProbe({
  listProcesses: async () => processes,
  readSessionMeta: async () => sessionMeta,
  ...extra,
});

test('a codex process whose argv names the thread is the verified owner', async () => {
  const owner = await probe([
    { pid: 10, ppid: 1, startedAt: START + 60_000, cmdline: `/opt/homebrew/bin/codex resume --no-daemon ${ID}` },
  ], meta('codex-tui'))(ID);
  assert.equal(owner.ownerGone, false);
  assert.equal(owner.verified, true);
  assert.equal(owner.pid, 10);
});

test('an app-written session is owned by the Codex app while it runs, and never verified for a kill', async () => {
  const appProcs = [{ pid: 20, ppid: 1, startedAt: START - 1, cmdline: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server --listen stdio://' }];
  const owner = await probe(appProcs, meta('Codex Desktop'))(ID);
  assert.deepEqual(owner, { ownerGone: false, kind: 'app', reason: OWNER_CODEX_APP });
  assert.deepEqual(await probe([], meta('Codex Desktop'))(ID), { ownerGone: true }, 'app closed: resume is safe');
});

test('a fresh CLI can only own a session it started no later than, in the same folder', async () => {
  const older = { pid: 30, ppid: 1, startedAt: START - 10_000, cmdline: '/opt/homebrew/bin/codex' };
  const younger = { pid: 31, ppid: 1, startedAt: START + 60_000, cmdline: '/opt/homebrew/bin/codex' };
  assert.equal((await probe([younger], meta('codex-tui'))(ID)).ownerGone, true);
  const maybe = await probe([older], meta('codex-tui'))(ID);
  assert.equal(maybe.ownerGone, false);
  assert.equal(maybe.verified, false, 'never a kill target');
  assert.equal((await probe([older], meta('codex-tui'), { readProcessCwd: async () => '/elsewhere' })(ID)).ownerGone, true);
  const resumesOther = { ...older, cmdline: '/opt/homebrew/bin/codex resume 01a10000-0000-7000-8000-000000000000' };
  assert.equal((await probe([resumesOther], meta('codex-tui'))(ID)).ownerGone, true);
});

const OTHER = '01a10000-0000-7000-8000-000000000000';
const pane = (pid, provider, sessionIds, paneId = `p${pid}`) => ({ paneId, workspaceId: 'w1', pid, provider, sessionIds });

test('a Codex pane on ANOTHER session and non-session codex subcommands are never owners', async () => {
  const procs = [
    { pid: 40, ppid: 1, startedAt: START - 5, cmdline: 'keeper' },
    { pid: 41, ppid: 40, startedAt: START - 5, cmdline: 'node /usr/lib/node_modules/@openai/codex/bin/codex.js --no-daemon' },
    { pid: 42, ppid: 1, startedAt: START - 5, cmdline: '/opt/homebrew/bin/codex sandbox -c x=1' },
  ];
  const owner = await probe(procs, meta('codex-tui'), { harborPanes: async () => [pane(40, 'codex', [OTHER])] })(ID);
  assert.deepEqual(owner, { ownerGone: true });
});

// `codex fork <id>` writes a NEW rollout; it read as the
// verified owner and adopt-on-send killed the user's independent fork.
test('a codex fork of this thread is never its owner, let alone a verified kill target', async () => {
  for (const cmdline of [
    `/opt/homebrew/bin/codex fork ${ID}`,
    `/opt/homebrew/bin/codex fork --profile work ${ID}`,
    `/opt/homebrew/bin/codex exec --json fork ${ID}`,
  ]) {
    const owner = await probe([{ pid: 11, ppid: 1, startedAt: START + 60_000, cmdline }], meta('codex-tui'))(ID);
    assert.deepEqual(owner, { ownerGone: true }, cmdline);
  }
  // A real resume stays verified, even when its prompt mentions forking.
  const resumed = await probe([
    { pid: 12, ppid: 1, startedAt: START + 60_000, cmdline: `/opt/homebrew/bin/codex resume ${ID} fork this repo` },
  ], meta('codex-tui'))(ID);
  assert.equal(resumed.verified, true);
  assert.equal(resumed.pid, 12);
  const execResume = await probe([
    { pid: 13, ppid: 1, startedAt: START + 60_000, cmdline: `/opt/homebrew/bin/codex exec resume ${ID}` },
  ], meta('codex-tui'))(ID);
  assert.equal(execResume.verified, true);
});

// Every descendant of every Harbor pane was ignored, so a
// codex on this thread inside Harbor read as "gone" and a second writer started.
test('a codex resume typed into a Harbor SHELL pane is reported as that pane, not gone and not killable', async () => {
  const procs = [
    { pid: 50, ppid: 1, startedAt: START - 5, cmdline: 'keeper' },
    { pid: 51, ppid: 50, startedAt: START - 5, cmdline: '-zsh' },
    { pid: 52, ppid: 51, startedAt: START + 60_000, cmdline: `/opt/homebrew/bin/codex resume ${ID}` },
  ];
  const owner = await probe(procs, meta('codex-tui'), { harborPanes: async () => [pane(50, null, [])] })(ID);
  assert.equal(owner.ownerGone, false);
  assert.equal(owner.kind, 'harbor');
  assert.equal(owner.verified, false, 'never a kill target');
  assert.equal(owner.paneId, 'p50');
});

test('a Harbor Codex pane already on this thread is the owner, whatever its argv says', async () => {
  // Launched on another thread, then /resume'd into this one.
  const procs = [
    { pid: 60, ppid: 1, startedAt: START - 5, cmdline: 'keeper' },
    { pid: 61, ppid: 60, startedAt: START - 5, cmdline: `/opt/homebrew/bin/codex resume ${OTHER}` },
  ];
  const owner = await probe(procs, meta('codex-tui'), { harborPanes: async () => [pane(60, 'codex', [ID])] })(ID);
  assert.deepEqual(owner, { ownerGone: false, kind: 'harbor', verified: false, paneId: 'p60', workspaceId: 'w1', reason: OWNER_HARBOR_PANE });
  // A /new into this thread: a fresh codex with no id at all.
  const fresh = [{ pid: 60, ppid: 1, cmdline: 'keeper' }, { pid: 62, ppid: 60, startedAt: START - 5, cmdline: '/opt/homebrew/bin/codex' }];
  assert.equal((await probe(fresh, meta('codex-tui'), { harborPanes: async () => [pane(60, null, [ID])] })(ID)).kind, 'harbor',
    'a codex running under the linked pane counts even before the daemon names the agent');
  // A dead pane (codex exited, link still cached) is not an owner.
  assert.deepEqual(await probe([{ pid: 60, ppid: 1, cmdline: '-zsh' }], meta('codex-tui'), { harborPanes: async () => [pane(60, null, [ID])] })(ID),
    { ownerGone: true });
});

test('a Codex pane\'s own process is set aside only when that pane is linked to a DIFFERENT session', async () => {
  const procs = [
    { pid: 70, ppid: 1, startedAt: START - 5, cmdline: 'keeper' },
    { pid: 71, ppid: 70, startedAt: START - 5, cmdline: 'node /usr/lib/node_modules/@openai/codex/bin/codex.js resume ' + ID },
    { pid: 72, ppid: 71, startedAt: START - 5, cmdline: '/usr/lib/node_modules/@openai/codex/vendor/codex-aarch64-apple-darwin resume ' + ID },
  ];
  // Linked elsewhere (it /resume'd away from this thread): wrapper and native binary both set aside.
  assert.deepEqual(await probe(procs, meta('codex-tui'), { harborPanes: async () => [pane(70, 'codex', [OTHER])] })(ID), { ownerGone: true });
  // Unlinked Codex pane: never set aside; Harbor's pane is reported, not killed.
  const unlinked = await probe(procs, meta('codex-tui'), { harborPanes: async () => [pane(70, 'codex', [])] })(ID);
  assert.equal(unlinked.kind, 'harbor');
  assert.equal(unlinked.verified, false);
  // A codex the pane's codex started through its tool shell is not the pane's own.
  const nested = [
    ...procs.slice(0, 2),
    { pid: 73, ppid: 71, startedAt: START + 60_000, cmdline: '/bin/bash -c codex' },
    { pid: 74, ppid: 73, startedAt: START + 60_000, cmdline: `/opt/homebrew/bin/codex resume ${ID}` },
  ];
  nested[1] = { ...nested[1], cmdline: 'node /usr/lib/node_modules/@openai/codex/bin/codex.js' };
  const inner = await probe(nested, meta('codex-tui'), { harborPanes: async () => [pane(70, 'codex', [OTHER])] })(ID);
  assert.equal(inner.ownerGone, false, 'the nested codex on this thread is still seen');
  assert.equal(inner.kind, 'harbor');
});

test('Harbor panes are read from the daemon snapshot plus the pane-link registry', () => {
  const snap = { snapshot: { panes: [
    { pane_id: 'a', workspace_id: 'w', pid: 10, agent: 'codex', agent_session: { value: ID } },
    { pane_id: 'b', workspace_id: 'w', pid: 11, agent: null, agent_session: null },
    { pane_id: 'c', workspace_id: 'w', pid: 12, agent: 'codex', agent_session: OTHER },
  ] } };
  assert.deepEqual(harborPanesFromSnapshot(snap, { [OTHER]: { paneId: 'b', workspaceId: 'w' }, [ID]: { paneId: 'a', workspaceId: 'w' } }), [
    { paneId: 'a', workspaceId: 'w', pid: 10, provider: 'codex', sessionIds: [ID] },
    { paneId: 'b', workspaceId: 'w', pid: 11, provider: null, sessionIds: [OTHER] },
    { paneId: 'c', workspaceId: 'w', pid: 12, provider: 'codex', sessionIds: [OTHER] },
  ]);
  assert.deepEqual(harborPanesFromSnapshot({ snapshot: { panes: [] } }, {}), []);
  assert.equal(harborPanesFromSnapshot(null, {}), null, 'no snapshot is unknown, never "no panes"');
});

test('an unreadable process table refuses rather than guessing', async () => {
  const p = createCodexOwnerProbe({ listProcesses: () => new Promise(() => {}), readSessionMeta: async () => null, deadlineMs: 20 });
  await assert.rejects(p(ID), /refusing to guess/);
});

test('ps and CIM process lists parse into pid, parent, start and argv', () => {
  const now = Date.parse('2026-10-15T12:10:00Z');
  assert.deepEqual(parsePsList('  10     1    01:02:03 /opt/homebrew/bin/codex resume x\n', now),
    [{ pid: 10, ppid: 1, startedAt: now - 3_723_000, cmdline: '/opt/homebrew/bin/codex resume x' }]);
  assert.deepEqual(parseCimList(JSON.stringify([{ ProcessId: 5, ParentProcessId: 4, CreationDate: '/Date(1792080000000)/', CommandLine: 'codex.exe' }])),
    [{ pid: 5, ppid: 4, startedAt: 1792080000000, cmdline: 'codex.exe' }]);
});

function takeover(owner, calls) {
  return createCodexTakeoverHandler({
    operationGate: createSessionOperationGate(),
    ownerProbe: async () => owner,
    killOwner: async (pid) => calls.push(['kill', pid]),
    getSessionMeta: async () => ({ cwd: '/work/app', provider: 'codex' }),
    paneIdSet: async () => new Set(),
    resumeProviderSession: async (args) => calls.push(['resume', args.provider, args.id]),
    findFreshPane: async () => ({ paneId: 'p9', workspaceId: 'w9' }),
    setPaneLink: () => {},
    requestFocusPane: async () => {},
    waitForProviderReady: async () => true,
    emitStatus: (s) => calls.push(['status', s.phase, s.detail]),
    emitLaunched: () => {},
  });
}

test('adopt-on-send for Codex: refuses the app, kills only a verified CLI, resumes a gone owner', async () => {
  let calls = [];
  await assert.rejects(takeover({ ownerGone: false, kind: 'app', reason: OWNER_CODEX_APP }, calls)({ sessionId: ID }), /Codex app/);
  assert.ok(!calls.some(([k]) => k === 'kill' || k === 'resume'));
  calls = [];
  await assert.rejects(takeover({ ownerGone: false, kind: 'cli', verified: false, pid: 3, reason: 'may own' }, calls)({ sessionId: ID }), /may own/);
  assert.ok(!calls.some(([k]) => k === 'kill'));
  calls = [];
  await takeover({ ownerGone: false, kind: 'cli', verified: true, pid: 7 }, calls)({ sessionId: ID });
  assert.deepEqual(calls.filter(([k]) => k !== 'status'), [['kill', 7], ['resume', 'codex', ID]]);
  calls = [];
  await takeover({ ownerGone: true }, calls)({ sessionId: ID });
  assert.deepEqual(calls.filter(([k]) => k !== 'status'), [['resume', 'codex', ID]]);
  assert.ok(!calls.some(([, phase, detail]) => phase === 'error' || /statusline tee/.test(detail || '')));
});

// The rail Resume went straight to
// resumeProviderSession with no owner check, so Resume beside the Codex app or
// a terminal codex started a second writer.
test('the resume guard refuses beside a live owner with the send path\'s wording, and passes a gone one', async () => {
  await assert.rejects(refuseBesideLiveCodexOwner(async () => ({ ownerGone: false, kind: 'app', reason: OWNER_CODEX_APP }), ID), /Codex app/);
  await assert.rejects(refuseBesideLiveCodexOwner(async () => ({ ownerGone: false, kind: 'cli', verified: true, pid: 9 }), ID),
    /still open somewhere else; reply there/);
  await assert.rejects(refuseBesideLiveCodexOwner(null, ID), /cannot check who has this Codex session open/);
  assert.deepEqual(await refuseBesideLiveCodexOwner(async () => ({ ownerGone: true }), ID), { ownerGone: true });
});

test('resume-session runs the Codex owner guard before it launches a codex resume', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/index.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('resume-session'");
  assert.ok(start > 0, 'resume-session handler found');
  const body = source.slice(start, source.indexOf('ipcMain.handle(', start + 10));
  const guard = body.search(/if \(meta\.provider === 'codex'\) await refuseBesideLiveCodexOwner\(codexOwnerProbe, id\);/);
  const launch = body.indexOf('launchActions.resumeProviderSession(');
  assert.ok(guard > 0, 'the guard is in the handler');
  assert.ok(launch > guard, 'the guard runs before the provider resume');
  assert.match(source, /^let codexOwnerProbe = null;$/m, 'the probe is reachable from registerIpc');
  assert.match(source, /^  codexOwnerProbe = createCodexOwnerProbe\(\{$/m, 'and assigned where the probe is built');
  assert.doesNotMatch(source, /excludePids/, 'no blanket exclusion of every pane\'s descendants');
});

// On Windows the cwd is unreadable, so the Codex
// app's own Codex.exe processes (started before a CLI session) read as a fresh
// CLI that "may own" it and refused every resume.
test('the Codex app\'s own Windows processes are never a fresh-CLI owner, and a real CLI still is', async () => {
  const appStart = START - 3_600_000;
  const msix = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1015.0.0_x64__2p2nqsd0c76g0\\app\\Codex.exe';
  const squirrel = 'C:\\Users\\pat\\AppData\\Local\\Programs\\Codex\\Codex.exe';
  const appTable = [
    { pid: 500, ppid: 4, startedAt: appStart, cmdline: `"${msix}"` },
    { pid: 501, ppid: 500, startedAt: appStart, cmdline: `"${msix}" --type=crashpad-handler --user-data-dir=C:\\Users\\pat\\AppData\\Roaming\\Codex /prefetch:7` },
    { pid: 502, ppid: 500, startedAt: appStart, cmdline: `"${msix}" --type=gpu-process --user-data-dir="C:\\Users\\pat\\AppData\\Roaming\\Codex" --gpu-preferences=UAAAAAAAAADgAAAEAAAAAAAAAAAAAAAAAABgAAEAAAA` },
    { pid: 503, ppid: 500, startedAt: appStart, cmdline: `"${msix}" --type=renderer --user-data-dir="C:\\Users\\pat\\AppData\\Roaming\\Codex" --app-path="C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1015.0.0_x64__2p2nqsd0c76g0\\app\\resources\\app.asar"` },
    { pid: 504, ppid: 500, startedAt: appStart, cmdline: `"${msix}" --type=utility --utility-sub-type=network.mojom.NetworkService --lang=en-US` },
    { pid: 505, ppid: 500, startedAt: appStart, cmdline: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1015.0.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe" app-server --listen stdio://' },
    { pid: 510, ppid: 4, startedAt: appStart, cmdline: `"${squirrel}" --type=renderer --user-data-dir="C:\\Users\\pat\\AppData\\Roaming\\Codex"` },
  ];
  const winProbe = (processes) => createCodexOwnerProbe({
    listProcesses: async () => processes,
    readSessionMeta: async () => meta('codex-tui', { cwd: 'C:\\work\\app' }),
    readProcessCwd: async () => null,
  });
  assert.deepEqual(await winProbe(appTable)(ID), { ownerGone: true }, 'the app is not a codex CLI');
  const cli = { pid: 600, ppid: 4, startedAt: START - 10_000, cmdline: '"C:\\Users\\pat\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe"' };
  const owner = await winProbe([...appTable, cli])(ID);
  assert.equal(owner.ownerGone, false);
  assert.equal(owner.pid, 600, 'a real fresh CLI started before the session is still named');
  assert.equal(owner.verified, false);
});

// The fresh-CLI branch used to run one lsof per candidate, in sequence and
// outside the deadline (about 1 s for 20 codex pids).
const { createProcessQuestions } = require('../../src/main/actions/codex-owner.js');

test('the fresh-CLI branch reads every real candidate\'s cwd in ONE batched call, never an app helper\'s', async () => {
  const macApp = '/Applications/Codex.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)';
  const table = [
    { pid: 700, ppid: 1, startedAt: START - 60_000, cmdline: `${macApp} --type=renderer --user-data-dir=/u/codex` },
    { pid: 701, ppid: 1, startedAt: START - 60_000, cmdline: '/Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://' },
    { pid: 702, ppid: 1, startedAt: START + 60_000, cmdline: '/opt/homebrew/bin/codex' }, // started after the session
    { pid: 703, ppid: 1, startedAt: START - 10_000, cmdline: '/opt/homebrew/bin/codex resume 0000aaaa-0000-0000-0000-000000000000' },
    { pid: 710, ppid: 1, startedAt: START - 10_000, cmdline: '/opt/homebrew/bin/codex' },
    { pid: 711, ppid: 1, startedAt: START - 10_000, cmdline: '/opt/homebrew/bin/codex' },
  ];
  const batches = [];
  const single = [];
  const readProcessCwd = async (pid) => { single.push(pid); return null; };
  const owner = await probe(table, meta('codex-tui'), {
    readProcessCwd,
    readProcessCwds: async (pids) => { batches.push(pids); return new Map([[710, '/elsewhere'], [711, '/work/app']]); },
  })(ID);
  assert.deepEqual(batches, [[710, 711]], 'one call, real candidates only');
  assert.deepEqual(single, []);
  assert.equal(owner.pid, 711, 'the candidate in the session folder');
  // The batch rides on readProcessCwd itself when the composition root passes
  // only that (createProcessQuestions attaches it).
  readProcessCwd.many = async (pids) => { batches.push(pids); return new Map(); };
  batches.length = 0;
  assert.equal((await probe(table, meta('codex-tui'), { readProcessCwd })(ID)).pid, 710, 'an unknown cwd rules nobody out');
  assert.deepEqual(batches, [[710, 711]]);
  assert.deepEqual(single, []);
});

test('with no folder on record no cwd is read, and a cwd read that hangs is refused by the deadline', async () => {
  const fresh = { pid: 720, ppid: 1, startedAt: START - 10_000, cmdline: '/opt/homebrew/bin/codex' };
  let reads = 0;
  const owner = await probe([fresh], meta('codex-tui', { cwd: null }), {
    readProcessCwd: async () => { reads += 1; return '/x'; },
  })(ID);
  assert.equal(owner.pid, 720);
  assert.equal(reads, 0, 'a cwd cannot rule anyone out without the session folder');
  const slow = probe([fresh], meta('codex-tui'), {
    deadlineMs: 30,
    readProcessCwd: () => new Promise((resolve) => { setTimeout(() => resolve('/elsewhere'), 400); }),
  });
  await assert.rejects(slow(ID), /process folders did not answer within 30ms/);
});

test('darwin cwds come from one lsof for every pid, and a pid that has exited does not lose the rest', async () => {
  const calls = [];
  const execFile = async (file, args) => {
    calls.push([file, ...args]);
    const error = new Error('lsof exited 1');
    error.stdout = 'p710\nfcwd\nn/work/app\np711\nfcwd\nn/Users/pat/other dir\n';
    throw error; // pid 799 is gone: lsof exits 1 but still prints the others
  };
  const questions = createProcessQuestions({ platform: 'darwin', execFile });
  const cwds = await questions.readProcessCwds([710, 711, 799]);
  assert.deepEqual([...cwds], [[710, '/work/app'], [711, '/Users/pat/other dir'], [799, null]]);
  assert.deepEqual(calls, [['/usr/sbin/lsof', '-a', '-p', '710,711,799', '-d', 'cwd', '-Fpn']]);
  assert.equal(questions.readProcessCwd.many, questions.readProcessCwds);
  assert.equal(await questions.readProcessCwd(711), '/Users/pat/other dir');
});

// Every test used to run over the WHOLE argv, prompt included.
// The subcommand is now only the first positional word after the executable,
// and the app tests read the executable path (plus a leading --type=).
const COMPUTER_USE = '/Users/user/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService';
const CASES = [
  // [label, process, isCodex, isApp, appRunning, shape subset]
  ['a fresh CLI whose prompt says "fix the login page"', { cmdline: '/opt/homebrew/bin/codex fix the login page' }, true, false, false, { sub: 'fix', session: true, verb: null }],
  ['a prompt that starts with a subcommand word ("update the readme")', { cmdline: 'node /usr/lib/node_modules/@openai/codex/bin/codex.js update the readme' }, true, false, false, { sub: 'update', session: false }],
  ['a resume whose prompt says "delete the old file"', { cmdline: `/opt/homebrew/bin/codex resume ${ID} delete the old file` }, true, false, false, { sub: 'resume', session: true, verb: 'resume', target: ID }],
  ['a prompt with app-server in it', { cmdline: '/opt/homebrew/bin/codex restart the app-server please' }, true, false, false, { sub: 'restart', session: true }],
  ['a prompt with --type= in it', { cmdline: `/opt/homebrew/bin/codex resume ${ID} pass --type=renderer to it` }, true, false, false, { verb: 'resume', target: ID }],
  ['a prompt saying "resume" on a fresh CLI', { cmdline: '/opt/homebrew/bin/codex please resume the work' }, true, false, false, { sub: 'please', verb: null }],
  ['a prompt saying "exec" on a fresh CLI', { cmdline: '/opt/homebrew/bin/codex exec' }, true, false, false, { sub: 'exec', session: true, verb: null }],
  ['codex exec resume <id>', { cmdline: `/opt/homebrew/bin/codex exec --json resume ${ID} keep going` }, true, false, false, { sub: 'exec', verb: 'resume', target: ID }],
  ['Harbor\'s own resume argv (flags and values before the id)', { cmdline: `/opt/homebrew/bin/codex resume -a on-request -s read-only -c approvals_reviewer=user --no-daemon -c tui.fullscreen_transcript=false --model gpt-6 -c model_reasoning_effort=high ${ID}` }, true, false, false, { verb: 'resume', target: ID }],
  ['a win32 quoted prompt containing app-server', { cmdline: `"C:\\Users\\pat\\AppData\\Roaming\\npm\\codex.exe" resume ${ID} "move the app-server code"` }, true, false, false, { verb: 'resume', target: ID }],
  ['a win32 quoted first prompt word that is a subcommand', { cmdline: '"C:\\tools\\codex.exe" "delete the old file"' }, true, false, false, { sub: 'delete the old file', session: true }],
  ['the real Codex Computer Use helper, with comm', { exe: COMPUTER_USE, cmdline: COMPUTER_USE }, false, true, false, null],
  ['the real Codex Computer Use helper, without comm (old reading)', { cmdline: COMPUTER_USE }, true, true, false, null],
  ['the app\'s bundled CLI running app-server after a -c value', { exe: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', cmdline: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c features.code_mode_host=true app-server --analytics-default-enabled' }, true, true, true, { sub: 'app-server', session: false }],
  ['a standalone codex app-server (the VS Code extension)', { cmdline: '/Users/pat/.vscode/extensions/openai.chatgpt-1/bin/macos-aarch64/codex app-server' }, true, false, true, { sub: 'app-server', session: false }],
  ['a Codex (Renderer) helper, with comm', { exe: '/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/155/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)', cmdline: '/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/155/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer) --type=renderer --user-data-dir=/u' }, false, true, true, null],
  ['the npm wrapper with node flags', { cmdline: 'node --max-old-space-size=4096 /usr/lib/node_modules/@openai/codex/bin/codex.js resume ' + ID }, true, false, false, { verb: 'resume', target: ID }],
  ['some other node script that mentions codex.js later', { cmdline: 'node /x/tool.js /usr/lib/node_modules/@openai/codex/bin/codex.jsx' }, false, false, false, null],
];

test('codex argv is classified by executable and subcommand, never by words in the prompt', () => {
  for (const [label, proc, codex, app, running, shape] of CASES) {
    assert.equal(isCodexProcess(proc), codex, `${label}: isCodexProcess`);
    assert.equal(isCodexAppProcess(proc), app, `${label}: isCodexAppProcess`);
    assert.equal(isCodexAppRunning(proc), running, `${label}: isCodexAppRunning`);
    if (shape) {
      const got = codexShape(proc);
      for (const [key, value] of Object.entries(shape)) assert.equal(got?.[key], value, `${label}: ${key}`);
    } else if (!codex) assert.equal(codexShape(proc), null, `${label}: no shape`);
  }
});

test('a prompt can no longer switch the owner guard off', async () => {
  const resumeHere = (prompt) => ({ pid: 80, ppid: 1, startedAt: START + 60_000, cmdline: `/opt/homebrew/bin/codex resume ${ID} ${prompt}` });
  for (const prompt of ['delete the old file', 'update the readme', 'move app-server out', 'use --type=foo', 'login page fix', 'fork this repo']) {
    const owner = await probe([resumeHere(prompt)], meta('codex-tui'))(ID);
    assert.equal(owner.verified, true, prompt);
    assert.equal(owner.pid, 80, prompt);
  }
  // A fresh CLI started before the session, whose prompt says those words, is still a candidate.
  for (const prompt of ['fix the login page', 'restart the app-server', 'pass --type=renderer', 'resume the old work', 'fork it']) {
    const owner = await probe([{ pid: 81, ppid: 1, startedAt: START - 10_000, cmdline: `/opt/homebrew/bin/codex ${prompt}` }], meta('codex-tui'))(ID);
    assert.equal(owner.ownerGone, false, prompt);
    assert.equal(owner.pid, 81, prompt);
    assert.equal(owner.verified, false, prompt);
  }
  // A prompt that only MENTIONS the id is not a verified owner (it never was a resume of it).
  const mentions = await probe([{ pid: 82, ppid: 1, startedAt: START + 60_000, cmdline: `/opt/homebrew/bin/codex summarize session ${ID}` }], meta('codex-tui'))(ID);
  assert.deepEqual(mentions, { ownerGone: true }, 'started after the session, not resuming it');
  // The real subcommands still read as not-a-session.
  for (const cmdline of [`/opt/homebrew/bin/codex delete ${ID}`, `/opt/homebrew/bin/codex archive ${ID}`, `/opt/homebrew/bin/codex queue ${ID} hello`]) {
    assert.deepEqual(await probe([{ pid: 83, ppid: 1, startedAt: START - 10_000, cmdline }], meta('codex-tui'))(ID), { ownerGone: true }, cmdline);
  }
});

test('a prompt with app-server in it does not make the Codex app "running"', async () => {
  const cli = { pid: 84, ppid: 1, startedAt: START + 60_000, cmdline: '/opt/homebrew/bin/codex fix the app-server crash' };
  assert.deepEqual(await probe([cli], meta('Codex Desktop'))(ID), { ownerGone: true });
});

// With no session meta, the helper (pid 66257 in the capture) refused a
// resume as "a codex CLI (pid 66257) that may own this session".
test('the Codex Computer Use helper is not a codex CLI once ps comm names its executable', async () => {
  const helper = { pid: 66257, ppid: 1, startedAt: START - 3_600_000, exe: COMPUTER_USE, cmdline: COMPUTER_USE };
  assert.deepEqual(await probe([helper], null)(ID), { ownerGone: true });
  // Even without comm (a failed comm call) it is now an app-family process, never a fresh CLI.
  assert.deepEqual(await probe([{ ...helper, exe: undefined }], null)(ID), { ownerGone: true });
});

test('POSIX process lists join ps comm= to command= by pid', async () => {
  assert.deepEqual([...parsePsComm(` 66257 ${COMPUTER_USE}\n   10 /opt/homebrew/bin/codex\nbogus\n`)],
    [[66257, COMPUTER_USE], [10, '/opt/homebrew/bin/codex']]);
  const calls = [];
  const execFile = async (file, args) => {
    calls.push([file, ...args]);
    if (args[1] === 'pid=,comm=') return { stdout: ` 66257 ${COMPUTER_USE}\n` };
    return { stdout: ` 66257     1    01:00 ${COMPUTER_USE}\n   10     1    01:00 /opt/homebrew/bin/codex resume x\n` };
  };
  const { createProcessQuestions: questions } = require('../../src/main/actions/codex-owner.js');
  const list = await questions({ platform: 'darwin', execFile }).listProcesses();
  assert.equal(list[0].exe, COMPUTER_USE);
  assert.equal(list[1].exe, undefined, 'not in the comm list: the old reading');
  assert.equal(isCodexProcess(list[0]), false);
  assert.deepEqual(calls.map((c) => c.slice(0, 3)).sort(), [['ps', '-axo', 'pid=,comm='], ['ps', '-axo', 'pid=,ppid=,etime=,command=']]);
  // A comm call that fails keeps the list.
  const failing = async (file, args) => {
    if (args[1] === 'pid=,comm=') throw new Error('ps died');
    return { stdout: '   10     1    01:00 /opt/homebrew/bin/codex\n' };
  };
  assert.equal((await questions({ platform: 'linux', execFile: failing }).listProcesses()).length, 1);
});

// A failed daemon snapshot read as "no panes", and a
// Harbor Codex pane's own `codex resume <id>` became a verified kill target.
test('a failed pane snapshot refuses instead of treating a pane\'s codex as foreign', async () => {
  const procs = [
    { pid: 90, ppid: 1, startedAt: START - 5, cmdline: 'keeper' },
    { pid: 91, ppid: 90, startedAt: START + 60_000, cmdline: `/opt/homebrew/bin/codex resume ${ID}` },
  ];
  for (const harborPanes of [async () => null, async () => { throw new Error('daemon down'); }, async () => harborPanesFromSnapshot(null, {})]) {
    await assert.rejects(probe(procs, meta('codex-tui'), { harborPanes })(ID), /could not read its own panes/);
  }
  // With no codex session process at all, nothing can hold the thread: the answer stands.
  const appOnly = [{ pid: 92, ppid: 1, startedAt: START, cmdline: '/Applications/Codex.app/Contents/Resources/codex app-server' }];
  assert.deepEqual(await probe(appOnly, meta('codex-tui'), { harborPanes: async () => null })(ID), { ownerGone: true });
  // And the takeover never kills on that path.
  const p = probe(procs, meta('codex-tui'), { harborPanes: async () => null });
  const killed = [];
  const run = createCodexTakeoverHandler({
    operationGate: createSessionOperationGate(), ownerProbe: p, killOwner: async (pid) => killed.push(pid),
    getSessionMeta: async () => ({ cwd: '/work/app', provider: 'codex' }), paneIdSet: async () => new Set(),
    resumeProviderSession: async () => killed.push('resume'), findFreshPane: async () => null, setPaneLink: () => {},
    requestFocusPane: async () => {}, waitForProviderReady: async () => true, emitStatus: () => {}, emitLaunched: () => {},
  });
  await assert.rejects(run({ sessionId: ID }), /could not read its own panes/);
  assert.deepEqual(killed, []);
});

test('a resume of another id is ruled out, but a resume by name or --last, or a fork of another thread, is not', async () => {
  const at = (cmdline) => [{ pid: 95, ppid: 1, startedAt: START - 10_000, cmdline }];
  assert.deepEqual(await probe(at(`/opt/homebrew/bin/codex resume ${OTHER}`), meta('codex-tui'))(ID), { ownerGone: true });
  assert.deepEqual(await probe(at(`/opt/homebrew/bin/codex fork ${ID}`), meta('codex-tui'))(ID), { ownerGone: true });
  for (const cmdline of ['/opt/homebrew/bin/codex resume --last', '/opt/homebrew/bin/codex resume my-thread', `/opt/homebrew/bin/codex fork ${OTHER}`]) {
    const owner = await probe(at(cmdline), meta('codex-tui'))(ID);
    assert.equal(owner.ownerGone, false, cmdline);
    assert.equal(owner.verified, false, cmdline);
  }
});

// A Harbor Codex pane launched on another thread that then /resume'd into this
// one keeps its old id, so its codex is set aside, and nothing on the process
// table names this thread. A write to this rollout while that pane ran, moments
// ago, is the only witness; resuming beside it would make a second writer.
test('a recent write while a set-aside Codex pane ran refuses as possibly that pane, and an old one does not', async () => {
  const procs = [
    { pid: 70, ppid: 1, startedAt: START - 5, cmdline: 'keeper' },
    { pid: 71, ppid: 70, startedAt: START + 1000, cmdline: `/opt/homebrew/bin/codex resume ${OTHER}` },
  ];
  const panes = async () => [pane(70, 'codex', [OTHER])];
  const now = START + 600_000;
  const at = (writtenAgoMs) => probe(procs, meta('codex-tui', { mtimeMs: now - writtenAgoMs }), { harborPanes: panes, now: () => now })(ID);
  const recent = await at(30_000);
  assert.equal(recent.ownerGone, false);
  assert.equal(recent.kind, 'harbor', 'reported, never a kill target');
  assert.match(recent.reason, /may have switched to it/);
  assert.deepEqual(await at(30 * 60_000), { ownerGone: true }, 'quiet for half an hour: nobody can be named');
  // A pane whose codex started after the write cannot have made it.
  const later = [procs[0], { ...procs[1], startedAt: now - 1000 }];
  assert.deepEqual(await probe(later, meta('codex-tui', { mtimeMs: now - 30_000 }), { harborPanes: panes, now: () => now })(ID), { ownerGone: true });
});

// The probe reads the rollout's first line. A compressed rollout used to be
// decompressed whole into a copy on disk first; it is now read in the stream.
test('session meta is read off the first line of a plain or a compressed rollout', async (t) => {
  const os = require('node:os');
  const zlib = require('node:zlib');
  const { readCodexSessionMeta } = require('../../src/main/codex-state.js');
  if (typeof zlib.zstdCompressSync !== 'function') { t.skip('this runtime has no zstd'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-codex-meta-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = JSON.stringify({ type: 'session_meta', payload: { originator: 'codex-tui', cwd: '/work/app', timestamp: '2026-10-15T12:00:00Z', instructions: 'x'.repeat(200_000) } });
  const body = `${first}\n${'{"type":"event_msg","payload":{"type":"task_started"}}\n'.repeat(50_000)}`;
  fs.writeFileSync(path.join(dir, 'a.jsonl'), body);
  fs.writeFileSync(path.join(dir, 'b.jsonl.zst'), zlib.zstdCompressSync(Buffer.from(body)));
  for (const name of ['a.jsonl', 'b.jsonl.zst']) {
    const read = await readCodexSessionMeta(path.join(dir, name));
    assert.equal(read.originator, 'codex-tui', name);
    assert.equal(read.cwd, '/work/app', name);
    assert.equal(Number.isFinite(read.mtimeMs), true, name);
  }
  assert.equal(await readCodexSessionMeta(path.join(dir, 'missing.jsonl')), null);
});
