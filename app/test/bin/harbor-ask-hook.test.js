'use strict';
// bin/harbor-ask-hook: the PreToolUse hook that hands an AskUserQuestion to
// Harbor and returns the answer as the tool's own input (2026-09-05).
//
// Two-sided by construction: every case where Harbor is NOT there must end in
// exit 0 with EMPTY stdout (the CLI then draws its dialog as before), and the
// one case where Harbor answers must print exactly the PreToolUse decision the
// CLI honours. The real script is spawned with a real stdin, against a temp
// ask dir, with the heartbeat and claim files played by the test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const proto = require('../../src/shared/ask-protocol.cjs');

const HOOK = path.resolve(__dirname, '../../../bin/harbor-ask-hook');

const INPUT = {
  session_id: 'sess-1',
  transcript_path: 'C:\\x\\sess-1.jsonl',
  cwd: 'C:\\dev\\proj',
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  tool_use_id: 'toolu_01ABC',
  tool_input: {
    questions: [
      { question: 'Which path?', header: 'Path', multiSelect: false, options: [{ label: 'Fast', description: 'a' }, { label: 'Careful', description: 'b', preview: 'x\ny' }] },
      { question: 'Deliver how? (pick any)', header: 'Delivery', multiSelect: true, options: [{ label: 'File', description: 'c' }, { label: 'Note', description: 'd' }] },
    ],
  },
};

function tmpDir() {
  return fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hb-ask-hook-'));
}

function runHook(dir, input, { during } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, HARBOR_ASK_DIR: dir },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const started = Date.now();
    child.on('exit', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(input));
    if (during) during(child);
  });
}

const heartbeat = (dir) => proto.writeJsonAtomic(proto.heartbeatPath(dir), { pid: process.pid, at: Date.now() });

test('no fresh heartbeat: the hook steps aside at once with no output', async () => {
  const dir = tmpDir();
  const r = await runHook(dir, INPUT);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.ok(r.ms < 2500, `stepped aside quickly (${r.ms}ms)`);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.request.json')).length, 0, 'no request left behind');
});

test('a tool that is not AskUserQuestion is ignored even with Harbor alive', async () => {
  const dir = tmpDir();
  heartbeat(dir);
  const r = await runHook(dir, { ...INPUT, tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('Harbor alive but the session is not claimed: step aside after the claim window, request withdrawn', async () => {
  const dir = tmpDir();
  heartbeat(dir);
  const r = await runHook(dir, INPUT);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.ok(r.ms >= proto.CLAIM_WAIT_MS - 200 && r.ms < proto.CLAIM_WAIT_MS + 3000, `waited about the claim window (${r.ms}ms)`);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.request.json')).length, 0, 'the unclaimed request is removed');
});

test('Harbor alive and passing on the session: the hook steps aside at once, not after the claim window', async () => {
  const dir = tmpDir();
  heartbeat(dir);
  const files = proto.filesFor(dir, 'toolu_01ABC');
  const r = await runHook(dir, INPUT, {
    during: () => {
      const tick = setInterval(() => {
        if (!fs.existsSync(files.request)) return;
        proto.writeJsonAtomic(files.pass, { pid: process.pid, at: Date.now() });
        clearInterval(tick);
      }, 50);
    },
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.ok(r.ms < proto.CLAIM_WAIT_MS - 500, `stepped aside well inside the claim window (${r.ms}ms)`);
  assert.equal(fs.existsSync(files.pass), false, 'the pass is removed with the request');
});

test('claimed and answered: the hook prints the allow decision with answers and notes, then cleans up', async () => {
  const dir = tmpDir();
  heartbeat(dir);
  const files = proto.filesFor(dir, 'toolu_01ABC');
  const r = await runHook(dir, INPUT, {
    during: () => {
      const tick = setInterval(() => {
        if (!fs.existsSync(files.request)) return;
        const request = proto.readJson(files.request);
        assert.equal(request.sessionId, 'sess-1');
        assert.equal(request.toolInput.questions.length, 2);
        assert.ok(request.hookPid > 0);
        proto.writeJsonAtomic(files.claim, { pid: process.pid, at: Date.now() });
        setTimeout(() => proto.writeJsonAtomic(files.answer, {
          answers: { 'Which path?': 'Careful', 'Deliver how? (pick any)': 'File, Note' },
          annotations: { 'Which path?': { notes: 'go slow' } },
        }), 300);
        clearInterval(tick);
      }, 50);
    },
  });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(out.hookSpecificOutput.updatedInput.answers, { 'Which path?': 'Careful', 'Deliver how? (pick any)': 'File, Note' });
  assert.deepEqual(out.hookSpecificOutput.updatedInput.annotations, { 'Which path?': { notes: 'go slow' } });
  assert.equal(out.hookSpecificOutput.updatedInput.questions.length, 2, 'the questions ride along unchanged');
  for (const file of Object.values(files)) assert.equal(fs.existsSync(file), false, `${path.basename(file)} cleaned up`);
});

test('claimed then declined: the hook prints a deny decision carrying the reason', async () => {
  const dir = tmpDir();
  heartbeat(dir);
  const files = proto.filesFor(dir, 'toolu_01ABC');
  const r = await runHook(dir, INPUT, {
    during: () => {
      const tick = setInterval(() => {
        if (!fs.existsSync(files.request)) return;
        proto.writeJsonAtomic(files.claim, { pid: process.pid, at: Date.now() });
        proto.writeJsonAtomic(files.answer, { decline: 'Do not proceed; ask me tomorrow.' });
        clearInterval(tick);
      }, 50);
    },
  });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, 'Do not proceed; ask me tomorrow.');
});

test('claimed, then Harbor goes away: the hook steps aside once the heartbeat is stale', async () => {
  const dir = tmpDir();
  heartbeat(dir);
  // Backdate the heartbeat past the stale line once the claim has landed.
  const files = proto.filesFor(dir, 'toolu_01ABC');
  const r = await runHook(dir, INPUT, {
    during: () => {
      const tick = setInterval(() => {
        if (!fs.existsSync(files.request)) return;
        proto.writeJsonAtomic(files.claim, { pid: process.pid, at: Date.now() });
        const old = new Date(Date.now() - proto.HEARTBEAT_STALE_MS - 5000);
        fs.utimesSync(proto.heartbeatPath(dir), old, old);
        clearInterval(tick);
      }, 50);
    },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '', 'no decision: the CLI draws its own dialog');
  assert.equal(fs.existsSync(files.request), false, 'request withdrawn');
});
