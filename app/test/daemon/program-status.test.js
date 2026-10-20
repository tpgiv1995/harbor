'use strict';
const { execPath: guiNodeExec } = require('../support/gui-node.js');

// CLAUDE'S PROGRAM STATUS (OSC 7501). The CLI reports working / blocked / done
// itself, but only to a terminal that answers its `7501;?` probe. The headless
// screen parses the reports, the keeper answers the probe and persists each
// change. The app half (the session-daemon client's event, the rail patch, the
// notifier) is test/main/program-status.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { ScreenModel, parseProgramStatus, PROGRAM_STATUS_REPLY, PROBE_ANSWER_INTERVAL_MS } = require('../../src/daemon/screen.js');

const KEEPER = path.resolve(__dirname, '../../src/daemon/keeper.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const osc = (data, st = '\x07') => `\x1b]7501;${data}${st}`;

test('status reports parse as the CLI writes them (shapes measured on 2.1.301)', () => {
  assert.deepEqual(parseProgramStatus('state=working:app=claude-code'), { state: 'working', kind: null, title: null, msg: null, progress: null });
  assert.deepEqual(parseProgramStatus(`state=blocked:app=claude-code:kind=permission:msg=${b64('approve Write: /tmp/x.txt')}`),
    { state: 'blocked', kind: 'permission', title: null, msg: 'approve Write: /tmp/x.txt', progress: null });
  assert.equal(parseProgramStatus(`state=working:app=claude-code:progress=42:title=${b64('Build')}`).progress, 42);
  assert.equal(parseProgramStatus('state=clear'), null);
  // A per-id report is a sub-task, not the session; a report without a state is noise.
  assert.equal(parseProgramStatus('state=working:app=claude-code:id=agent-1'), undefined);
  assert.equal(parseProgramStatus('app=claude-code'), undefined);
  // Control characters in a decoded message never reach the UI.
  assert.equal(parseProgramStatus(`state=working:msg=${b64('a\x1b[31mb\nc')}`).msg, 'a [31mb c');
});

test('the screen answers the probe, tracks the status and reports only changes', async () => {
  const screen = new ScreenModel({ cols: 80, rows: 24 });
  let probes = 0;
  const changes = [];
  screen.onProbe = () => { probes += 1; };
  screen.onStatus = (status) => changes.push(status?.state ?? 'clear');
  await screen.write(osc('?', '\x1b\\'));
  assert.equal(probes, 1);
  await screen.write(`hello ${osc('state=idle:app=claude-code')}world`);
  await screen.write(osc('state=working:app=claude-code'));
  await screen.write(osc('state=working:app=claude-code'));
  await screen.write(osc(`state=working:app=claude-code:msg=${b64('Running tests')}`));
  await screen.write(osc('state=done:app=claude-code', '\x1b\\'));
  const read = await screen.read(0);
  assert.equal(read.status.state, 'done');
  assert.match(read.visible, /hello world/, 'the escape never lands on screen');
  assert.deepEqual(changes, ['idle', 'working', 'working', 'done']);
  await screen.write(osc('state=clear'));
  assert.equal((await screen.read(0)).status, null);
  // The reply starts with "?" (all the CLI checks) but is not the probe itself.
  assert.equal(PROGRAM_STATUS_REPLY, '\x1b]7501;?ok\x1b\\');
});

// A pty hands the keeper whatever bytes it has, so a report can arrive in
// pieces: split inside the introducer, the payload, a base64 field, or between
// the ESC and the backslash of ST.
test('a report split across pty chunks is parsed whole and never painted', async () => {
  const report = osc(`state=blocked:app=claude-code:kind=permission:msg=${b64('approve Bash: npm test')}`, '\x1b\\');
  for (const cuts of [[1], [2, 6], [12], [report.indexOf('msg=') + 6], [report.length - 1], [3, 9, 20, report.length - 1]]) {
    const screen = new ScreenModel({ cols: 80, rows: 24 });
    const changes = [];
    screen.onStatus = (status) => changes.push(status);
    let at = 0;
    for (const cut of [...cuts, report.length]) {
      await screen.write(report.slice(at, cut));
      at = cut;
    }
    await screen.write('after');
    assert.equal(changes.length, 1, `one report for cuts ${cuts}`);
    assert.equal(changes[0].state, 'blocked');
    assert.equal(changes[0].msg, 'approve Bash: npm test');
    assert.equal((await screen.read(0)).visible.split('\n')[0].trimEnd(), 'after', `nothing painted for cuts ${cuts}`);
  }
  // The probe split the same way is still answered once.
  const screen = new ScreenModel({ cols: 80, rows: 24 });
  let probes = 0;
  screen.onProbe = () => { probes += 1; };
  for (const piece of ['\x1b]', '75', '01;', '?', '\x07']) await screen.write(piece);
  assert.equal(probes, 1);
});

// The reply used to be byte-identical to the probe, so a tty that echoes
// input handed it back as a new probe and the keeper answered again, forever.
test('an echoed reply is never answered, and probes are answered at most once per interval', async () => {
  const screen = new ScreenModel({ cols: 80, rows: 24 });
  let clock = 1_000_000;
  screen.now = () => clock;
  const answers = [];
  // The keeper's wiring with an echoing tty: every answer comes straight back.
  screen.onProbe = () => { answers.push(clock); screen.write(PROGRAM_STATUS_REPLY); };
  await screen.write(osc('?'));
  await sleep(20); await screen.write('');
  assert.equal(answers.length, 1, 'the echoed `?ok` is not a probe');
  await screen.write(osc('?ok'));
  await screen.write(osc('?x'));
  assert.equal(answers.length, 1, 'only the exact probe `?` is answered');
  clock += 100;
  await screen.write(osc('?'));
  assert.equal(answers.length, 1, 'a second probe inside the interval is not answered');
  clock += PROBE_ANSWER_INTERVAL_MS;
  await screen.write(osc('?', '\x1b\\'));
  assert.equal(answers.length, 2, 'a probe after the interval is');
});

// Title and progress are never persisted, so a change in them alone must not
// count as a status change (it would rewrite the keeper's state file).
test('a title or progress change alone is not a status change, but is kept for a screen read', async () => {
  const screen = new ScreenModel({ cols: 80, rows: 24 });
  const changes = [];
  screen.onStatus = (status) => changes.push(status?.seq ?? null);
  await screen.write(osc(`state=working:app=claude-code:progress=10:title=${b64('Build')}`));
  await screen.write(osc(`state=working:app=claude-code:progress=55:title=${b64('Build')}`));
  await screen.write(osc(`state=working:app=claude-code:progress=55:title=${b64('Test')}`));
  assert.deepEqual(changes, [1], 'one change: the progress and title moves are not');
  const read = (await screen.read(0)).status;
  assert.equal(read.progress, 55);
  assert.equal(read.title, 'Test');
  assert.equal(read.seq, 1);
  await screen.write(osc(`state=working:app=claude-code:progress=55:title=${b64('Test')}:msg=${b64('Running tests')}`));
  assert.deepEqual(changes, [1, 2], 'a new step (msg) is a change');
});

// The CLI's msg is elided, so two prompts can carry the same text. Every
// status CHANGE gets a new sequence number; a repeat keeps it.
test('every status change gets the next sequence number; a repeat keeps it', async () => {
  const screen = new ScreenModel({ cols: 80, rows: 24 });
  const seqs = [];
  screen.onStatus = (status) => seqs.push(status?.seq ?? null);
  const prompt = osc(`state=blocked:app=claude-code:kind=permission:msg=${b64('approve Write: …/work/probe.txt')}`);
  await screen.write(osc('state=working:app=claude-code'));
  await screen.write(prompt);
  const first = (await screen.read(0)).status;
  assert.equal(first.state, 'blocked');
  assert.equal(first.seq, 2);
  await screen.write(prompt); // the CLI repeating itself is the same prompt
  assert.equal((await screen.read(0)).status.seq, 2);
  await screen.write(osc('state=working:app=claude-code'));
  await screen.write(prompt); // the SAME text, but a new prompt
  const second = (await screen.read(0)).status;
  assert.equal(second.msg, first.msg);
  assert.equal(second.seq, 4, 'the second same-text prompt is told apart by its seq');
  await screen.write(osc('state=clear'));
  assert.equal((await screen.read(0)).status, null);
  await screen.write(osc('state=clear'));
  await screen.write(prompt);
  assert.equal((await screen.read(0)).status.seq, 6, 'monotonic across a clear');
  assert.deepEqual(seqs, [1, 2, 3, 4, null, 6]);
});

// A stand-in CLI: probe, wait for the terminal's answer in raw mode (the real
// CLI reads it the same way), and only then report statuses. It records the
// exact answer it got.
const FAKE_CLI = `
const fs = require('node:fs');
process.stdin.setRawMode(true);
process.stdout.write('\\x1b]7501;?\\x07');
let seen = '';
process.stdin.on('data', (chunk) => {
  seen += chunk.toString('utf8');
  if (!seen.includes('\\x1b]7501;?')) return;
  process.stdin.removeAllListeners('data');
  fs.writeFileSync(process.argv[2], JSON.stringify(seen));
  process.stdout.write('answered\\r\\n\\x1b]7501;state=working:app=claude-code\\x07');
  setTimeout(() => process.stdout.write('\\x1b]7501;state=blocked:app=claude-code:kind=permission:msg=${b64('approve Write: /tmp/x')}\\x07'), 300);
});
setInterval(() => {}, 1000);
`;

test('a real keeper answers the probe with ?ok and persists the CLI status', { skip: process.platform === 'win32' && 'POSIX pty harness' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'hps-'));
  const socketPath = path.join(dir, 'k.sock');
  const statePath = path.join(dir, 'state.json');
  const configPath = path.join(dir, 'config.json');
  const logPath = path.join(dir, 'keeper.log');
  const cliPath = path.join(dir, 'fake-cli.js');
  const answerPath = path.join(dir, 'answer.json');
  fs.writeFileSync(cliPath, FAKE_CLI);
  fs.writeFileSync(configPath, JSON.stringify({
    id: 'program-status-test',
    argv: [process.execPath, cliPath, answerPath],
    cwd: dir, env: { PATH: process.env.PATH }, cols: 80, rows: 24,
    agent: 'claude', agent_session: null, created_at: new Date().toISOString(),
    state_path: statePath, keeper_socket: socketPath,
  }));
  const logFd = fs.openSync(logPath, 'a');
  const keeper = spawn(guiNodeExec, [KEEPER, configPath], { windowsHide: true, stdio: ['ignore', logFd, logFd] });
  fs.closeSync(logFd);
  t.after(async () => {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state.pid) { try { process.kill(-state.pid, 'SIGKILL'); } catch { try { process.kill(state.pid, 'SIGKILL'); } catch {} } }
    } catch {}
    if (keeper.exitCode === null) { keeper.kill('SIGKILL'); await new Promise((r) => keeper.once('exit', r)); }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const readState = () => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return {}; } };
  const deadline = Date.now() + 8000;
  while (readState().agent_status !== 'blocked' && Date.now() < deadline) await sleep(50);
  const state = readState();
  assert.equal(state.agent_status, 'blocked', `status never arrived: ${JSON.stringify(state)}\n${fs.readFileSync(logPath, 'utf8')}`);
  assert.equal(state.agent_status_kind, 'permission');
  assert.equal(state.agent_status_msg, 'approve Write: /tmp/x');
  assert.equal(state.agent_status_seq, 2, 'working was change 1, the prompt change 2');
  assert.equal(JSON.parse(fs.readFileSync(answerPath, 'utf8')), PROGRAM_STATUS_REPLY, 'the CLI got `?ok`, not its own probe back');
});
