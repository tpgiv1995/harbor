'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { legacyConfig } = require('../config/migrate.js');
const { scriptExecArgs } = require('../script-exec.js');

const CLAUDE_SESSIONS = path.resolve(__dirname, '../../../../bin/claude-sessions');
const AI_BIN = path.resolve(__dirname, '../../../../bin/ai');

function resolveProfile(profiles, id) {
  return profiles.find((profile) => profile.id === id)
    || profiles.find((profile) => profile.isDefault)
    || profiles[0]
    || null;
}

// WHAT THE bin/ SCRIPTS ACTUALLY PARSE TODAY, which is not what an earlier
// version of this file assumed. Live-caught 2026-07-28 when new sessions and
// resumes both stopped working: the profile id, not its configHome, is what
// `bin/claude-sessions --home` takes, and emitting a path there broke every
// resume. `resolveProfileHome` in bin/harbor-bin.cjs now accepts either, but the
// id remains the wire form because it is also what the index records per
// session, and one representation is better than two that can disagree.
function resolveResumeHome(detectedHome, profiles = legacyConfig().profiles) {
  return resolveProfile(profiles, detectedHome)?.id || null;
}

// This used to hold an allowlist of four literal names, because bin/claude-sessions
// once rejected any --home outside it and an unknown id aborted the whole resume.
// That stopped being true when `resolveProfileHome` learned to take a profile id,
// a configHome path, or a bare id it derives a home from, so the allowlist had
// quietly become a filter that dropped `--home` for exactly the people it was
// meant to protect: anyone whose profile is not called one of three specific
// things resumed on the DEFAULT account instead, silently.
//
// What the allowlist was ALSO doing, by accident, is the reason this is a shape
// test and not a longer list: bin/ derives a directory name from a bare id, so an
// id is untrusted input on the wire. Only a plain token may travel. Anything else
// (a path fragment, a traversal, whitespace) emits no flag at all, exactly as
// before, and the resume falls back to the session's own detected home.
const SAFE_PROFILE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function buildResumeArgv({ id, detectedHome, profiles = legacyConfig().profiles, liveOk = false }) {
  const home = resolveResumeHome(detectedHome, profiles);
  const argv = ['--resume-id', String(id)];
  if (home && SAFE_PROFILE_ID.test(home)) argv.push('--home', home);
  if (liveOk) argv.push('--live-ok');
  return argv;
}

// Codex/cursor resume rides bin/ai (workspace routing, timed herdr calls);
// claude resume stays on bin/claude-sessions (live-guard, config homes).
function buildProviderResumeArgv({ provider, id }) {
  return ['--provider', String(provider), '--resume-id', String(id)];
}

// AN ACCOUNT IS A CONFIG HOME, and that is now the only way it travels.
//
// `--home <configHome>` is set on the child as CLAUDE_CONFIG_DIR and works for
// ANY profile id, which is what matters for somebody with their own account
// names. Alongside it there used to be a per-account FLAG, one literal flag per
// account, which looked redundant and was not, because the unshipped launcher chose which
// config file to write folder trust into from that flag rather than from the
// environment. Harbor writes the trust marker itself now (bin/harbor-bin.cjs
// `preacceptFolderTrust`), against the home the child is actually pointed at, so
// the flags express nothing the path does not and are gone. A profile id no
// longer has to be one of three specific words.
function buildNewArgv({ account, profiles = legacyConfig().profiles, provider = 'claude', model = null, effort = 'default', sessionId = null }) {
  const profile = resolveProfile(profiles, account);
  const argv = [];
  if (profile?.configHome) argv.push('--home', profile.configHome);
  if (provider && provider !== 'claude') argv.push('--provider', provider);
  // 'default' means the provider's own default: no flag, exactly like a bare
  // launch (claude keeps the account's configured model; cursor-agent has no
  // model named "default" to pass).
  if (model && model !== 'default') argv.push('--model', model);
  // Effort is applied AT LAUNCH for every provider: bin/ai forwards it to the
  // claude CLI's own --effort flag and to codex's model_reasoning_effort. It
  // used to be typed in as "/effort <level>" once the composer settled, which
  // is what made a new session pause 5-10s and then eat whatever Pat had
  // started typing (2026-07-27).
  if (effort && effort !== 'default') argv.push('--effort', effort);
  if (provider === 'claude' && sessionId) argv.push('--session-id', sessionId);
  return argv;
}

function createLaunchActions(options = {}) {
  const execFile = options.execFile;
  if (typeof execFile !== 'function') {
    throw new TypeError('createLaunchActions requires an injectable execFile function');
  }

  const resumesInFlight = new Map();
  const profiles = options.profiles || legacyConfig().profiles;

  // bin/claude-sessions refuses to resume a session whose transcript was
  // written in the last 90 seconds, reasoning that a hot transcript means a
  // live writer. For a human at the fzf picker that is a fair proxy. Inside
  // Harbor it is the WRONG SIGNAL, and it fails hardest in the exact case that
  // matters most, because a claude WRITES ITS TRANSCRIPT ON THE WAY OUT (an
  // away_summary and a last-prompt marker): a fleet of sessions killed
  // together, which is what a herdr daemon recovery or an oomd kill of the
  // daemon's cgroup does, all look LIVE for 90 seconds precisely BECAUSE they
  // just died. The guard reads the death rattle as a heartbeat and every Enter
  // refuses. Live-caught 2026-08-03: the daemon restarted at 20:14:13.665Z,
  // Harbor's send found its pane gone 78ms later, and two sessions then
  // refused four times over four minutes with Pat's typed messages stranded in
  // their composers ("i get that error all the time and youve never fixed it").
  //
  // Harbor can answer the real question instead of the proxy one: the
  // statusline tee names the owning pid, /proc says whether it still lives,
  // and a scan says whether anything else holds the id. That is the SAME
  // ladder adopt-on-send must satisfy before it may kill (actions/takeover.js
  // createSessionOwnerProbe), so there is one liveness decision here, not two
  // that can disagree. When it PROVES no live writer, the mtime heuristic is
  // simply wrong and must not outrank the proof; when it proves nothing, the
  // guard stands exactly as it did before. Unwired (tests, harnesses) it
  // proves nothing, so argv is byte-identical to the old behaviour.
  // Ambiguity is NEVER an authorization, and it must never be worse than the
  // old behaviour either: the probe throws on everything it cannot settle (no
  // tee, an unreadable start time, another live process holding the id), and
  // every one of those means "do not claim to know", not "abort the resume".
  // Owned here rather than at each wiring site, so a fourth composition root
  // cannot forget it and turn an unproven session into a failed send.
  const probeUnowned = options.isSessionUnowned || (async () => false);
  const isSessionUnowned = async (id) => {
    try { return Boolean(await probeUnowned(id)); }
    catch { return false; }
  };

  async function resumeSession({ id, detectedHome, liveOk = false }) {
    if (!id) throw new TypeError('resumeSession requires id');
    // Single-flight per session id: a double click must never spawn two
    // claude-go --resume processes for one transcript (two-writer corruption).
    // The whole body lives inside the promise registered below, ownership
    // probe included: awaiting anything BEFORE the map is populated reopens
    // the very race this guard exists to close.
    if (resumesInFlight.has(id)) return resumesInFlight.get(id);
    const run = (async () => {
      // liveOk from the caller means ownership is already settled (adopt-on-send
      // has just verified and killed the owner). Otherwise prove it here.
      const proven = liveOk || await isSessionUnowned(id);
      const argv = buildResumeArgv({ id, detectedHome, profiles, liveOk: proven });
      await new Promise((resolve, reject) => {
        const resume = scriptExecArgs(CLAUDE_SESSIONS, argv);
        execFile(...resume.execArgs, (error, _stdout, stderr) => {
          if (error) {
            const detail = String(stderr || '').trim().split('\n').pop() || error.message;
            const err = new Error(detail);
            err.cause = error;
            reject(err);
          } else resolve();
        });
      });
      return { argv, command: CLAUDE_SESSIONS };
    })().finally(() => {
      // Hold the guard briefly past completion; the pane needs a moment to
      // register before a re-click could pass guard_live again.
      setTimeout(() => resumesInFlight.delete(id), 5000).unref?.();
    });
    resumesInFlight.set(id, run);
    return run;
  }

  // Same single-flight map as claude resumes: one id, one resume process.
  async function resumeProviderSession({ provider, cwd, id }) {
    if (!provider || provider === 'claude') throw new TypeError('resumeProviderSession is codex/cursor only');
    if (!cwd) throw new TypeError(`resuming a ${provider} session requires its working folder`);
    if (!id) throw new TypeError('resumeProviderSession requires id');
    // A deleted project dir makes execFile throw a misleading binary ENOENT
    // (live-caught 2026-07-24: a cursor session whose repo was since removed).
    if (!require('node:fs').existsSync(cwd)) {
      throw new Error(`cannot resume this ${provider} session: its working folder ${cwd} no longer exists`);
    }
    if (resumesInFlight.has(id)) return resumesInFlight.get(id);
    const argv = buildProviderResumeArgv({ provider, id });
    const env = { ...process.env };
    delete env.HERDR_PANE_ID;
    delete env.HERDR_ACTIVE_PANE_ID;
    const run = new Promise((resolve, reject) => {
      const launch = scriptExecArgs(AI_BIN, argv, { cwd, env });
      execFile(launch.command, launch.args, launch.options, (error, _stdout, stderr) => {
        if (error) {
          const detail = String(stderr || '').trim().split('\n').pop() || error.message;
          const err = new Error(detail);
          err.cause = error;
          reject(err);
        } else resolve();
      });
    }).finally(() => {
      setTimeout(() => resumesInFlight.delete(id), 5000).unref?.();
    });
    resumesInFlight.set(id, run);
    await run;
    return { argv, command: AI_BIN, cwd };
  }

  let newSessionInFlight = null;

  async function newSession({ account, cwd, provider, model, effort }) {
    if (!cwd) throw new TypeError('newSession requires cwd');
    // Double-clicked "+" must not spawn two sessions.
    if (newSessionInFlight) return newSessionInFlight;
    const resolvedProvider = provider || 'claude';
    const sessionId = resolvedProvider === 'claude' ? randomUUID() : null;
    const argv = buildNewArgv({ account, profiles, provider: resolvedProvider, model, effort, sessionId });
    // A harbor dev-launched from inside a herdr pane inherits HERDR_PANE_ID,
    // which makes bin/ai SPLIT that pane instead of creating a workspace.
    const env = { ...process.env };
    delete env.HERDR_PANE_ID;
    delete env.HERDR_ACTIVE_PANE_ID;
    newSessionInFlight = new Promise((resolve, reject) => {
      const launch = scriptExecArgs(AI_BIN, argv, { cwd, env });
      execFile(launch.command, launch.args, launch.options, (error) => {
        setTimeout(() => { newSessionInFlight = null; }, 3000).unref?.();
        if (error) reject(error);
        else resolve({ argv, command: AI_BIN, cwd, sessionId });
      });
    });
    return newSessionInFlight;
  }

  return {
    CLAUDE_SESSIONS,
    AI_BIN,
    buildResumeArgv,
    resolveResumeHome,
    resumeSession,
    resumeProviderSession,
    newSession,
  };
}

module.exports = {
  CLAUDE_SESSIONS,
  AI_BIN,
  buildResumeArgv,
  buildProviderResumeArgv,
  buildNewArgv,
  resolveResumeHome,
  createLaunchActions,
};
