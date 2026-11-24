'use strict';

// Live proof for the Gemini launch path (2026-11-23): drives the real `bin/ai --provider gemini` through an ISOLATED
// session daemon (its own store and socket, tied to this script's pid so it dies with it) with USERPROFILE pointing at a
// scratch home, in a scratch folder, on gemini-4-hydrogen low, and shows
//   1. a pane draws agy's input line with no dialog in the way (onboarding seeded in the SCRATCH home only, trust skipped
//      by the per-launch settings file),
//   2. after one tiny prompt (`-i`) the status tee file appears with the conversation id, and the link/dormancy helpers
//      resolve it,
//   3. a resume by `--conversation` reopens the conversation on the model it last answered with.
// Then it stops the daemon and deletes the scratch home (which is how the probe conversations are forgotten).
// Nothing here touches the real daemon, Harbor, the real profile or the worker home. Every child is windowless.
//
//   node app/scripts/probe-gemini-launch-win.js [--keep]
//
// It spends ONE small model call (the `-i` prompt). The Terms-of-Service screen is never answered: the scratch home's
// cache\onboarding.json is seeded as AGY-FACTS describes, in the scratch home only.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { SessionClient } = require('../src/daemon/client.js');
const { snapshotFromSessions } = require('../src/main/session-daemon/client.js');
const { resolveGeminiConfigSync } = require('../src/main/providers/gemini-config.js');
const { createProviderSessionLinker } = require('../src/main/providers/provider-session-link.js');
const { providerTranscriptFresh, awaitingAnswer } = require('../src/daemon/dormancy.js');

const KEEP = process.argv.includes('--keep');
const ROOT = path.resolve(__dirname, '../..');
const AI = path.join(ROOT, 'bin', 'ai');
const DAEMON = path.join(ROOT, 'app', 'src', 'daemon', 'daemon.js');
const PROMPT = 'Reply with exactly the word OK and nothing else. Use no tools.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 300) }); log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${String(detail).slice(0, 200)}]` : ''}`); };

async function until(fn, what, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch { /* keep waiting */ }
    await sleep(stepMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  // Resolve the real CLI BEFORE the profile moves: the resolver reads ~/.harbor/gemini.json under the current profile.
  const real = resolveGeminiConfigSync();
  if (!real) throw new Error('agy is not installed here; nothing to prove');
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const base = path.join('C:\\dev\\.orch\\gemini-provider-probe', `launch-${stamp}`);
  const dirs = {
    home: path.join(base, 'home'), ws: path.join(base, 'ws'), store: path.join(base, 'store'),
    ctx: path.join(base, 'ctx'), cache: path.join(base, 'cache'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const stateDir = path.join(dirs.home, '.gemini', 'antigravity-cli');
  fs.mkdirSync(path.join(stateDir, 'cache'), { recursive: true });
  // Seeded in the SCRATCH home only: the consent screens are the person's to answer, never Harbor's.
  fs.writeFileSync(path.join(stateDir, 'cache', 'onboarding.json'), JSON.stringify({
    consumerOnboardingComplete: true, enterpriseOnboardingComplete: true, onboardingComplete: true,
  }));
  const config = path.join(base, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ paths: { cacheDir: dirs.cache } }));
  const socketPath = path.join(dirs.store, 'daemon.sock');

  const daemon = spawn(process.execPath, [DAEMON], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env, HARBOR_SESSIOND_DIR: dirs.store, HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_NO_DAEMON_START: '1', HARBOR_SESSIOND_PARENT_PID: String(process.pid),
    },
  });
  let daemonErr = '';
  daemon.stderr.on('data', (c) => { daemonErr += c; });
  const client = new SessionClient({ socketPath, requestTimeoutMs: 15000 });
  const cleanup = async () => {
    try { for (const s of (await client.request('list')).sessions) await client.request('terminate', { id: s.id, signal: 'SIGKILL' }).catch(() => {}); } catch { /* going away */ }
    client.close();
    if (daemon.exitCode === null) { daemon.kill('SIGTERM'); await Promise.race([new Promise((r) => daemon.once('exit', r)), sleep(4000)]); }
    if (!KEEP) {
      await sleep(1500);
      for (let i = 0; i < 10; i += 1) { try { fs.rmSync(dirs.home, { recursive: true, force: true }); fs.rmSync(base, { recursive: true, force: true }); break; } catch { await sleep(500); } }
      log(fs.existsSync(dirs.home) ? `scratch home still present: ${dirs.home}` : 'scratch home deleted (the probe conversations went with it)');
    } else log(`kept scratch at ${base}`);
  };

  try {
    await until(async () => (await client.request('health')).ok, `the isolated daemon (${daemonErr})`, 20000);
    check('isolated daemon is not the real one', socketPath.startsWith(dirs.store), socketPath);

    const aiEnv = {
      ...process.env, USERPROFILE: dirs.home, HOMEDRIVE: undefined, HARBOR_SESSIOND_DIR: dirs.store, HARBOR_SESSIOND_SOCKET: socketPath,
      HARBOR_NO_DAEMON_START: '1', HARBOR_CONFIG_FILE: config, HARBOR_CONTEXT_DIR: dirs.ctx, HARBOR_AGY_BIN: real.bin,
    };
    const ai = (args) => new Promise((resolve, reject) => {
      execFile(process.execPath, [AI, ...args], { cwd: dirs.ws, env: aiEnv, windowsHide: true, timeout: 60000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}`)); else resolve(stdout.trim());
      });
    });
    const screenOf = async (id) => (await client.request('screen', { id, scrollback: 80 })).visible || '';
    const listed = async (id) => (await client.request('list')).sessions.find((s) => s.id === id);
    const sessionId = (out) => /sessiond session ([\w-]+)/.exec(out)?.[1];

    // ---- 1. a new pane, no prompt: agy draws its input line ----
    const out1 = await ai(['--provider', 'gemini', '--model', 'gemini-4-hydrogen', '--effort', 'low']);
    const id1 = sessionId(out1);
    check('bin/ai started a gemini pane in the isolated daemon', id1, out1);
    const idle = await until(async () => {
      const text = await screenOf(id1);
      return /\? for shortcuts/.test(text) && /^> ?/m.test(text) && /─{20,}/.test(text) ? text : null;
    }, 'the input line', 90000);
    fs.writeFileSync(path.join(base, 'screen-1-idle.txt'), idle);
    check('the pane draws the input line and the idle footer', true);
    check('no trust or terms dialog is in the way', !/Do you trust|Terms of Service|Choose your color scheme/.test(idle), idle.split('\n').slice(0, 3).join(' | '));
    // The model is only known to agy a moment after its first paint, so ask again until it shows (header or the tee's footer).
    const modelScreen = await until(async () => { const t = await screenOf(id1); return /Gemini 4 Hydrogen/.test(t) ? t : null; }, 'the model on screen', 20000).catch(() => idle);
    log(`footer: ${modelScreen.split('\n').filter((l) => /for shortcuts|esc to cancel/.test(l)).join(' | ')}`);
    check('launched on the requested model and effort', /Gemini 4 Hydrogen/.test(modelScreen) && !/Gemini 4 Neon \(/.test(modelScreen), modelScreen.split('\n').filter((l) => /Hydrogen/.test(l)).join(' | '));
    check('the idle screen does not look like a dialog needing an answer', !awaitingAnswer(idle, 'gemini'));
    const s1 = await listed(id1);
    check('the daemon names the pane gemini and records the scratch USERPROFILE as its home', s1.agent === 'gemini' && s1.provider_home === dirs.home, `${s1.agent} ${s1.provider_home}`);
    const settingsIdx = s1.argv.indexOf('--settings');
    const settingsFile = s1.argv[settingsIdx + 1];
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    check('the per-launch settings trust only this folder and name the .cmd status line', settings.trustedWorkspaces?.[0] === dirs.ws && /statusline\.cmd$/.test(settings.statusLine?.command || ''), JSON.stringify(settings));
    check('argv is the documented one', s1.argv.includes('--dangerously-skip-permissions') && s1.argv.join(' ').includes('--model gemini-4-hydrogen --effort low'), s1.argv.slice(1).join(' '));
    await client.request('terminate', { id: id1, signal: 'SIGKILL' });
    await until(async () => (await listed(id1))?.exit, 'the first pane to end', 15000);

    // ---- 2. a pane with an initial prompt (-i): the status tee names the conversation ----
    const out2 = await ai(['--provider', 'gemini', '--model', 'gemini-4-hydrogen', '--effort', 'low', PROMPT]);
    const id2 = sessionId(out2);
    check('a launch with an initial prompt starts a pane', id2, out2);
    const walked = [];
    let teeFile = null;
    let tee = null;
    const sample = setInterval(async () => {
      try {
        const info = await client.request('process', { id: id2 });
        const tree = info?.pid ? await client.request('proc-tree', { pid: info.pid }) : null;
        const rows = tree?.processes || [];
        walked.push(rows.map((r) => String(r.name || r.cmdline || '').split(/[\\/]/).pop().split(' ')[0].toLowerCase()).join('>'));
      } catch { /* sampling is best effort */ }
    }, 400);
    try {
      teeFile = await until(() => fs.readdirSync(dirs.ctx).find((n) => /^gemini-[0-9a-f-]{36}\.json$/i.test(n)), 'the status tee file', 120000);
      tee = JSON.parse(fs.readFileSync(path.join(dirs.ctx, teeFile), 'utf8'));
      await until(async () => { tee = JSON.parse(fs.readFileSync(path.join(dirs.ctx, teeFile), 'utf8')); return tee.agent_state === 'idle' && /\bOK\b/.test(await screenOf(id2)); }, 'the answer and the idle state', 120000);
    } finally { clearInterval(sample); }
    const convId = tee.conversation_id;
    log(`conversation ${convId}`);
    check('the tee appeared after the prompt and names the conversation', /^[0-9a-f-]{36}$/i.test(convId) && teeFile === `gemini-${convId}.json`, teeFile);
    check('the tee is the scratch profile\'s, with cwd, model, state and the real brain path', tee.home === dirs.home && tee.cwd === dirs.ws
      && tee.model?.effort === 'low' && tee.agent_state === 'idle' && fs.existsSync(tee.transcriptPath), `${tee.cwd} ${tee.model?.display_name} ${tee.agent_state}`);
    check('the tee never carries the account', !/"email"|@/.test(fs.readFileSync(path.join(dirs.ctx, teeFile), 'utf8')));
    const transcript = fs.readFileSync(tee.transcriptPath, 'utf8');
    check('transcript_full.jsonl holds the prompt as a USER_INPUT step', transcript.includes('<USER_REQUEST>') && transcript.includes(PROMPT));
    const chains = walked.filter(Boolean);
    const lastNames = chains.map((c) => c.split('>').pop());
    const transient = lastNames.filter((n) => /^(cmd|node|electron|harbor|conhost)/.test(n)).length;
    log(`process chains sampled while it ran: ${chains.length}; deepest child was a status-line child in ${transient}`);
    log(`distinct chains: ${[...new Set(chains)].slice(0, 6).join('  ||  ')}`);
    fs.writeFileSync(path.join(base, 'chains.txt'), chains.join('\n'));

    // the link helpers, against the daemon's real pane records (the same shape Harbor's rail reads)
    const sessions = (await client.request('list')).sessions;
    const snapshot = snapshotFromSessions(sessions, dirs.ws);
    const annotated = [];
    const linker = createProviderSessionLinker({
      home: dirs.home, contextDir: dirs.ctx, profiles: [],
      listPanes: () => snapshot.panes,
      paneAgentProcess: async () => null,
      readPaneText: async (paneId) => screenOf(paneId),
      annotateSessionIdentity: async (paneId, identity) => { annotated.push(identity); return client.request('annotate', { id: paneId, agent: identity.agent, agent_session: identity.agentSession }); },
      rememberLink: async () => {}, lookupSessionMeta: () => null,
    });
    await linker.resolveNow();
    linker.close();
    check('the linker bound the pane to the conversation from the tee (pane created_at + folder)', linker.get(id2) === convId, `${linker.get(id2)}`);
    const s2 = await listed(id2);
    check('the keeper accepted the gemini annotation', s2.agent === 'gemini' && s2.agent_session === convId, `${s2.agent} ${s2.agent_session}`);
    const fresh = await providerTranscriptFresh(s2, { geminiRoots: [], contextDir: dirs.ctx, now: Date.now(), freshMs: 10 * 60_000 });
    check('dormancy: a just-answered conversation reads fresh (the veto holds)', fresh === true);
    const stale = await providerTranscriptFresh(s2, { geminiRoots: [], contextDir: dirs.ctx, now: Date.now() + 3 * 3600_000, freshMs: 10 * 60_000 });
    check('dormancy: hours later, idle, it reads stale (may sleep)', stale === false);
    await providerTranscriptFresh({ ...s2, agent_session: null }, { geminiRoots: [], now: Date.now(), freshMs: 1 }).then(() => check('dormancy: unresolved identity throws', false), (e) => check('dormancy: unresolved identity throws', /unresolved/.test(e.message)));
    await client.request('terminate', { id: id2, signal: 'SIGKILL' });
    await until(async () => (await listed(id2))?.exit, 'the second pane to end', 15000);

    // ---- 3. resume by --conversation ----
    const out3 = await ai(['--provider', 'gemini', '--resume-id', convId]);
    const id3 = sessionId(out3);
    check('resume started a pane', id3, out3);
    const resumed = await until(async () => {
      const text = await screenOf(id3);
      return /\? for shortcuts/.test(text) && /\bOK\b/.test(text) ? text : null;
    }, 'the resumed conversation to draw', 90000);
    fs.writeFileSync(path.join(base, 'screen-3-resumed.txt'), resumed);
    check('the resumed pane shows the earlier prompt and answer, then the input line', resumed.includes('Reply with exactly the word OK') && /\? for shortcuts/.test(resumed));
    const s3 = await listed(id3);
    const argv3 = s3.argv.join(' ');
    check('resume argv names the conversation and recovers the model it last answered with', argv3.includes(`--conversation ${convId}`) && argv3.includes('--model gemini-4-hydrogen-low'), argv3.split(' ').slice(-4).join(' '));
    const resumedModel = await until(async () => { const t = await screenOf(id3); return /Gemini 4 Hydrogen/.test(t) ? t : null; }, 'the resumed model on screen', 20000).catch(() => resumed);
    log(`resumed footer: ${resumedModel.split('\n').filter((l) => /for shortcuts|esc to cancel/.test(l)).join(' | ')}`);
    check('the resumed pane runs Hydrogen, not agy\'s Neon High default', /Gemini 4 Hydrogen/.test(resumedModel) && !/Gemini 4 Neon/.test(resumedModel), resumedModel.split('\n').filter((l) => /Gemini 4/.test(l)).join(' | '));
    check('the daemon names the resumed pane gemini with the conversation from argv-time identity', s3.agent === 'gemini' && s3.agent_session === convId, `${s3.agent} ${s3.agent_session}`);
  } finally {
    await cleanup();
  }
  const failed = results.filter((r) => !r.ok);
  log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => { console.error(error); process.exitCode = 2; });
