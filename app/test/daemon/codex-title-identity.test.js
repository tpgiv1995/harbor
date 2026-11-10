'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { SessionClient } = require('../../src/daemon/client.js');
const { CODEX_IDENTITY_PIN, titlePrefix, createCodexTitleIdentity } = require('../../src/daemon/codex-title-identity.js');
const A='019f8250-89cc-73d3-9c1a-30007bced9ff', B='019f8251-89cc-73d3-9c1a-30007bced9ff', C='019f8252-89cc-73d3-9c1a-30007bced9ff';
const short=id=>id.slice(0,29)+'...'; const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('title sensor accepts only UUID evidence and stops after exit',()=>{
 assert.equal(titlePrefix(A),A);assert.equal(titlePrefix(short(B)),B.slice(0,29));assert.equal(titlePrefix('text '+A),null);
 let alive=true;const seen=[];const observe=createCodexTitleIdentity({agent:'codex',argv:['--no-daemon',CODEX_IDENTITY_PIN],isAlive:()=>alive,onTitle:p=>seen.push(p)});
 observe(short(A));observe(short(A));observe(B);alive=false;observe(C);assert.deepEqual(seen,[A.slice(0,29),B]);
 for(const agent of ['claude','cursor'])createCodexTitleIdentity({agent,argv:['--no-daemon',CODEX_IDENTITY_PIN],onTitle:()=>assert.fail('foreign title')})(A);
});
test('keeper records prefixes without self-annotation and rejects a mismatching linker request', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-title-'));
  const child = path.join(dir, 'child.cjs');
  fs.writeFileSync(child, `process.stdin.setRawMode(true);process.stdin.on('data', d => { const id = d.toString().includes('c') ? '${short(C)}' : d.toString().includes('b') ? '${short(B)}' : '${short(A)}'; process.stdout.write('\\x1b]2;'+id+'\\x07'); }); setInterval(()=>{},1000);`);
  const statePath = path.join(dir, 'state.json'), socketPath = path.join(dir, 'keeper.sock'), configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ id: 'title-test', argv: [process.execPath, child, '--no-daemon', '-c', CODEX_IDENTITY_PIN],
    cwd: dir, env: { ...process.env, CODEX_HOME: dir }, cols: 80, rows: 24, agent: 'codex', agent_session: A,
    created_at: new Date().toISOString(), state_path: statePath, keeper_socket: socketPath, harness_pid: process.pid }));
  const keeper = spawn(process.execPath, [path.resolve(__dirname, '../../src/daemon/keeper.js'), configPath], {
    env: { ...process.env, HARBOR_SESSIOND_NO_JOB: '1' }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = ''; keeper.stderr.on('data', data => { stderr += data; });
  const client = new SessionClient({ socketPath, requestTimeoutMs: 3000 }); client.on('error', () => {});
  t.after(async () => {
    try { await client.request('terminate', { signal: 'SIGKILL' }); } catch {}
    client.close(); await sleep(700);
    if (keeper.exitCode === null) { keeper.kill(); await sleep(150); }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  for (let i = 0; i < 120 && !fs.existsSync(statePath); i++) await sleep(100);
  assert(fs.existsSync(statePath), stderr); await sleep(200);
  await client.request('input', { text: 'b' });
  for (let i = 0; i < 60 && JSON.parse(fs.readFileSync(statePath)).codex_title?.prefix !== B.slice(0,29); i++) await sleep(100);
  assert.equal(JSON.parse(fs.readFileSync(statePath)).agent_session, A, 'title must not annotate before old main links');
  assert.equal(JSON.parse(fs.readFileSync(statePath)).codex_title.prefix,B.slice(0,29));
  await assert.rejects(client.request('annotate', { agent: 'codex', agent_session: A }), /current thread differs/);
  await client.request('annotate', {agent:'codex',agent_session:B});
  await client.request('resize', { cols: 90, rows: 25 });
  assert.equal(JSON.parse(fs.readFileSync(statePath)).agent_session, B);
  await client.request('input', { text: 'c' }); await sleep(250);
  assert.equal(JSON.parse(fs.readFileSync(statePath)).agent_session, B, 'child view does not rebind the parent');
  await client.request('input', { text: 'b' }); await sleep(250);
  assert.equal(JSON.parse(fs.readFileSync(statePath)).agent_session, B, 'returning to the parent keeps its identity');
});
