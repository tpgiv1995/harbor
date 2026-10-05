'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { execPath: guiNodeExec } = require('../support/gui-node.js');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { SessionClient } = require('../../src/daemon/client.js');
const {
  resolveJobPolicy, parseByteLimit, jobName, createSessionJob, openSessionJob,
  assignPid, queryJob, terminateJob, closeJob, armKillOnClose,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_JOB_MEMORY,
} = require('../../src/daemon/win-job.js');

const winTest = (name, fn) => test(name, { skip: process.platform !== 'win32' && 'Windows Job Objects are win32-only' }, fn);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function policy(tag) {
  return resolveJobPolicy({
    ...process.env,
    HARBOR_SESSIOND_DIR: path.join(process.cwd(), `.job-test-${process.pid}`),
    HARBOR_SESSIOND_JOB_NAMESPACE: `${tag}-${process.pid}-${Date.now()}`,
  });
}

function tree() {
  const code = `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,env:process.env,stdio:'ignore'});
    process.stdout.write(JSON.stringify({parent:process.pid,child:child.pid})+'\\n');
    setInterval(()=>{},1000);
  `;
  const parent = spawn(guiNodeExec, ['-e', code], { windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve, reject) => {
    let text = '';
    parent.once('error', reject);
    parent.stdout.on('data', (chunk) => {
      text += chunk;
      const end = text.indexOf('\n');
      if (end >= 0) resolve({ proc: parent, ...JSON.parse(text.slice(0, end)) });
    });
  });
}

async function gone(pid, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until && alive(pid)) await sleep(25);
  return !alive(pid);
}

test('1. policy is default-on only for the real Windows store; relocated stores must name a namespace', () => {
  assert.equal(resolveJobPolicy({}, 'linux').enabled, false);
  assert.equal(resolveJobPolicy({ HARBOR_SESSIOND_NO_JOB: '1' }, 'win32').enabled, false);
  assert.match(resolveJobPolicy({ HARBOR_SESSIOND_DIR: 'C:\\tmp\\x' }, 'win32').reason, /did not name/);
  if (process.platform === 'win32') assert.equal(policy('policy').enabled, true);
  assert.equal(parseByteLimit('12G'), 12 * 1024 ** 3);
  assert.equal(parseByteLimit('bogus'), null);
});

winTest('2. containment includes a child born after assignment and accounting is monotonic', async (t) => {
  const p = policy('containment');
  const job = createSessionJob('containment', p);
  let item;
  t.after(async () => {
    try { terminateJob(job); } catch {}
    closeJob(job);
    if (item) { try { item.proc.kill(); } catch {} }
  });
  // Assign before this process has spawned its grandchild: inheritance is the
  // property the real daemon->keeper->pty/MCP chain relies on.
  const code = `setTimeout(()=>{const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,env:process.env,stdio:'ignore'});process.stdout.write(c.pid+'\\n')},250);setInterval(()=>{},1000)`;
  const proc = spawn(guiNodeExec, ['-e', code], { windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
  item = { proc };
  assignPid(job, proc.pid);
  const childPid = await new Promise((resolve) => proc.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim()))));
  await sleep(100);
  const first = queryJob(job);
  assert.ok(first.pids.includes(proc.pid));
  assert.ok(first.pids.includes(childPid), 'a post-assignment grandchild did not inherit the job');
  const cpu = first.cpuUsec;
  await sleep(100);
  assert.ok(queryJob(job).cpuUsec >= cpu, 'job CPU accounting went backwards');
});

winTest('3. TerminateJobObject kills an entire stubborn tree; killing only its old-path parent does not', async (t) => {
  const old = await tree();
  t.after(() => { for (const pid of [old.parent, old.child]) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  old.proc.kill('SIGKILL');
  assert.equal(await gone(old.parent), true);
  assert.equal(alive(old.child), true, 'the broken-side parent kill unexpectedly proved tree containment');

  const fixed = await tree();
  const job = createSessionJob('atomic', policy('atomic'));
  t.after(() => { try { terminateJob(job); } catch {} closeJob(job); });
  assignPid(job, fixed.parent);
  terminateJob(job);
  assert.equal(await gone(fixed.parent), true);
  assert.equal(await gone(fixed.child), true, 'atomic job termination left the grandchild alive');
});

winTest('4. a second owner reopens the stable name while another holder keeps it alive', async () => {
  const p = policy('handover');
  const created = createSessionJob('handover', p);
  const name = created.name;
  const reopened = openSessionJob('handover', p);
  assert.ok(reopened, `successor could not reopen ${name}`);
  assert.equal(reopened.name, jobName('handover', p));
  closeJob(created); // creating owner is gone; successor remains the holder
  assert.doesNotThrow(() => queryJob(reopened));
  closeJob(reopened); // last handle: kill-on-close semantic

  // Semantic change from the pre-job keeper: once ARMED (the keeper's act,
  // f8 M1: creation is deliberately unarmed so a sole-holder daemon death
  // cannot kill the session), losing the last handle reaps the pty tree
  // immediately instead of orphaning it.
  const treeItem = await tree();
  const lone = createSessionJob('last-holder', policy('last-holder'));
  assignPid(lone, treeItem.parent);
  armKillOnClose(lone);
  closeJob(lone);
  assert.equal(await gone(treeItem.parent), true);
  assert.equal(await gone(treeItem.child), true, 'last-handle close did not reap the inherited tree');
});

winTest('5. an assignment denial degrades without changing the child lifecycle', async () => {
  const job = createSessionJob('degrade', policy('degrade'));
  assert.throws(() => assignPid(job, 0xffffffff), /OpenProcess/);
  closeJob(job);
  const child = spawn(guiNodeExec, ['-e', 'setTimeout(()=>process.exit(0),50)'], { windowsHide: true, env: process.env, stdio: 'ignore' });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 0, 'job setup failure changed the pre-job child behavior');
});

winTest('6. a real sessiond session contains its pty grandchild and health reports jobs', async (t) => {
  const root = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-job-session-'));
  const socketPath = path.join(root, 'daemon.sock');
  const namespace = `session-${process.pid}-${Date.now()}`;
  const env = { ...process.env, HARBOR_SESSIOND_DIR: root, HARBOR_SESSIOND_SOCKET: socketPath, HARBOR_SESSIOND_JOB_NAMESPACE: namespace, HARBOR_NO_DAEMON_START: '1' };
  const daemon = spawn(guiNodeExec, [path.resolve(__dirname, '../../src/daemon/daemon.js')], { windowsHide: true, env, stdio: 'ignore' });
  let client; let job;
  t.after(async () => {
    try { terminateJob(job); } catch {}
    closeJob(job);
    client?.close();
    if (daemon.exitCode === null) daemon.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => daemon.once('exit', resolve)), sleep(3000)]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 200; i += 1) {
    try { client = new SessionClient({ socketPath }); await client.request('health'); break; }
    catch { client?.close(); client = null; await sleep(25); }
  }
  assert.ok(client, 'isolated daemon did not answer');
  const health = await client.request('health');
  assert.deepEqual(health.jobs, { enabled: true, sessions: 0 });
  const childCode = "const{spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,env:process.env,stdio:'ignore'});setInterval(()=>{},1000)";
  const session = await client.request('spawn', { argv: [guiNodeExec, '-e', childCode], cwd: root, env, cols: 80, rows: 24 });
  job = openSessionJob(session.id, resolveJobPolicy(env));
  await sleep(300);
  const info = queryJob(job);
  assert.ok(info.activeProcesses >= 4, `expected keeper, ConPTY, pty and grandchild; got ${info.pids.join(',')}`);
  assert.equal((await client.request('health')).jobs.sessions, 1);
  await client.request('terminate', { id: session.id, signal: 'SIGKILL' }).catch(() => {});
  assert.equal(await gone(info.pids.at(-1)), true, 'real session grandchild survived job termination');
});

winTest('7. a dormant ending with jobs ON persists the honest exit record BEFORE the job dies (f8 H2)', async (t) => {
  // The first shape of the keeper's job kill fired on the next tick after
  // terminal.kill(), which killed the keeper before onExit or the
  // verified-gone poll could write the record: with jobs on, every dormancy
  // sleep read as a crash and sat exit:null until reconcile (<=60s)
  // synthesized one. The record must land within the keeper's own exit
  // window, dormant flag and reason intact, and the job must still take the
  // MCP grandchild with it afterwards.
  const root = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-job-dormant-'));
  const socketPath = path.join(root, 'daemon.sock');
  const namespace = `dormant-${process.pid}-${Date.now()}`;
  const env = { ...process.env, HARBOR_SESSIOND_DIR: root, HARBOR_SESSIOND_SOCKET: socketPath, HARBOR_SESSIOND_JOB_NAMESPACE: namespace, HARBOR_NO_DAEMON_START: '1' };
  const daemon = spawn(guiNodeExec, [path.resolve(__dirname, '../../src/daemon/daemon.js')], { windowsHide: true, env, stdio: 'ignore' });
  let client; let job;
  t.after(async () => {
    try { terminateJob(job); } catch {}
    closeJob(job);
    client?.close();
    if (daemon.exitCode === null) daemon.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => daemon.once('exit', resolve)), sleep(3000)]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 200; i += 1) {
    try { client = new SessionClient({ socketPath }); await client.request('health'); break; }
    catch { client?.close(); client = null; await sleep(25); }
  }
  assert.ok(client, 'isolated daemon did not answer');
  const childCode = "const{spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,env:process.env,stdio:'ignore'});setInterval(()=>{},1000)";
  const session = await client.request('spawn', { argv: [guiNodeExec, '-e', childCode], cwd: root, env, cols: 80, rows: 24 });
  job = openSessionJob(session.id, resolveJobPolicy(env));
  await sleep(400);
  const before = queryJob(job);
  assert.ok(before.activeProcesses >= 4, `tree not captured: ${before.pids.join(',')}`);
  // The KEEPER armed kill-on-close through the real chain (f8 M1): the
  // daemon creates the job unarmed, so an armed flag here proves the
  // keeper's own arm ran.
  assert.ok(before.limitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 'keeper never armed kill-on-close');
  const statePath = path.join(root, 'sessions', `${session.id}.json`);
  await client.request('terminate', { id: session.id, signal: 'SIGTERM', dormant: true, reason: 'win-job spec 7: dormant with jobs on' }).catch(() => {});
  // Well under reconcile's 60s: the KEEPER must write this record, and at the
  // pre-fix shape it provably cannot (it is dead before persist runs).
  const deadline = Date.now() + 10000;
  let exit = null;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state.exit) { exit = state.exit; break; }
    } catch { /* state mid-rewrite */ }
    await sleep(100);
  }
  assert.ok(exit, `no exit record within 10s: the keeper died before persisting (state at ${statePath})`);
  assert.equal(exit.dormant, true, `dormant flag lost: ${JSON.stringify(exit)}`);
  assert.match(exit.reason || '', /win-job spec 7/);
  assert.equal(await gone(before.pids.at(-1), 8000), true, 'MCP grandchild survived the ending');
});

winTest('8. the daemon creates the job UNARMED and the keeper arm preserves the memory limit (f8 M1)', () => {
  const p = resolveJobPolicy({
    ...process.env,
    HARBOR_SESSIOND_DIR: path.join(process.cwd(), `.job-test-${process.pid}`),
    HARBOR_SESSIOND_JOB_NAMESPACE: `arm-${process.pid}-${Date.now()}`,
    HARBOR_SESSIOND_SESSION_JOB_MEMORY_MAX: '512M',
  });
  const job = createSessionJob('arm-spec', p);
  try {
    const created = queryJob(job);
    assert.equal(created.limitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 0,
      'a freshly created job must be unarmed: a sole-holder daemon dying must not kill the session');
    assert.ok(created.limitFlags & JOB_OBJECT_LIMIT_JOB_MEMORY, 'memory limit flag missing at creation');
    assert.equal(created.jobMemoryLimitBytes, 512 * 1024 * 1024);
    armKillOnClose(job);
    const armed = queryJob(job);
    assert.ok(armed.limitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 'arm did not set kill-on-close');
    assert.ok(armed.limitFlags & JOB_OBJECT_LIMIT_JOB_MEMORY, 'arm dropped the memory limit flag');
    assert.equal(armed.jobMemoryLimitBytes, 512 * 1024 * 1024, 'arm dropped the memory limit value');
  } finally {
    try { terminateJob(job); } catch {}
    closeJob(job);
  }
});
