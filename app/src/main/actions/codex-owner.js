'use strict';

// WHO OWNS A CODEX SESSION THAT HARBOR HAS NO PANE FOR (2026-10-15).
//
// A Codex session written to in the last few minutes reads as "live outside
// Harbor" (shared/session-liveness), so a send went to the CLAUDE takeover,
// which looks for a statusline tee Codex never writes and failed "this session
// has no statusline tee". After three quiet minutes it read as dead instead,
// and `codex resume` ran with no live guard at all, beside a Codex desktop app
// or a codex CLI that still had the thread open: two writers on one rollout.
//
// What is measurable on macOS (0.160 and the Codex app):
//   * No process holds a rollout file open between writes (lsof on a live TUI,
//     sampled every 3 s for 30 s, and on every Codex app-server: nothing), so a
//     file-handle test cannot find the owner.
//   * A RESUMED CLI carries the thread id in its argv (`codex resume <id>`, and
//     every pane Harbor resumes). That is proof, and it is the only shape this
//     module will ever kill.
//   * A FRESH CLI carries no id. It can only be the writer if it started at or
//     before the session did and (where the cwd is readable) in the same folder.
//   * The rollout's session_meta names its writer: originator "Codex Desktop"
//     (the app, source "vscode"), "codex-tui", or "codex_exec". The app runs
//     `codex app-server` processes with no thread ids in them; Harbor never
//     signals the app, it only asks whether it is running.
// Product code never spawns Python; the process list is `ps` on POSIX and a CIM
// query on win32, injected by the composition root.

const OWNER_CODEX_APP = 'this Codex session belongs to the Codex app, which is running;'
  + ' Harbor will not write into it beside the app. Reply there, or quit the app and send again';

// WHAT A PROCESS IS, read from its executable and its codex SUBCOMMAND only.
// Tests that ran over the whole command line, prompt included, misread it:
// `codex fix the login page` read as the
// `update`-style "not a session" subcommands, a prompt with `app-server` or
// `--type=` in it read as the Codex app, and `/…/Codex Computer Use.app/…`
// split at its first space read as an executable called `Codex`. So:
//   * The executable is ps `comm=` (the whole argv[0], spaces and all) when
//     the command line starts with it, else the quoted first token (win32's
//     CommandLine), else the first word (the old reading, kept as the fallback
//     for a Linux comm, which is a truncated name and not a path).
//   * The rest is split into words, a double-quoted run being one word.
//   * The subcommand is the first word after the executable that is not a
//     flag or a flag's value (VALUE_FLAGS, from `codex --help`, 0.160.1).
//   * App tests read the executable path, plus `--type=` only among the flags
//     ahead of any positional word (where Chromium/Electron puts it).
// On POSIX ps joins argv with spaces, so a quoted prompt arrives as loose
// words; only the first one or two can ever be read as a subcommand, and an
// unknown first word is a prompt: a session, which is the conservative answer.

const CODEX_NAME_RE = /^codex(?:-[\w.-]+)?(?:\.exe)?$/i; // npm ships codex-<target>.exe
const NODE_NAME_RE = /^node(?:\.exe)?$/i;
const CODEX_JS_RE = /[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js/i;
// The Codex desktop app itself (its bundle, its framework, ChatGPT.app's
// bundled CLI): "is the app running" and "is this one of the app's own".
const APP_PATH_RE = /Codex\.app|Codex Framework|ChatGPT\.app[\\/].*codex/i;
// More of the app family that is never a user's codex CLI: the packaged (MSIX)
// Windows install, the Codex Computer Use helper, anything inside a macOS
// bundle (`…/X.app/Contents/…`).
const APP_FAMILY_RE = /[\\/]WindowsApps[\\/]OpenAI\.[^\\/]*[\\/]|[\\/]computer-use[\\/]|\.app[\\/]Contents[\\/]/i;
const NOT_A_SESSION = new Set([
  'app-server', 'exec-server', 'mcp-server', 'mcp', 'sandbox', 'login', 'logout', 'debug', 'doctor', 'features',
  'completion', 'update', 'queue', 'archive', 'unarchive', 'delete', 'plugin', 'agents', 'remote-control', 'app',
  'apply', 'a', 'cloud', 'migrate-rollouts', 'help',
]);
const VALUE_FLAGS = new Set([
  '-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-i', '--image', '-m', '--model',
  '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval',
  '--thread-source', '--output-schema', '--color', '-o', '--output-last-message',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const asProc = (input) => (typeof input === 'string' ? { cmdline: input } : (input || {}));

function splitExecutable(input) {
  const proc = asProc(input);
  const text = String(proc.cmdline || '').replace(/^\s+/, '');
  const comm = typeof proc.exe === 'string' ? proc.exe.replace(/\s+$/, '') : '';
  if (comm && text.startsWith(comm) && (text.length === comm.length || /\s/.test(text[comm.length]))) {
    return { exe: comm, rest: text.slice(comm.length) };
  }
  const quoted = /^"([^"]*)"/.exec(text);
  if (quoted) return { exe: quoted[1], rest: text.slice(quoted[0].length) };
  const bare = /^\S*/.exec(text)[0];
  return { exe: bare, rest: text.slice(bare.length) };
}

// Words, a double-quoted run being part of one word (win32 CommandLine).
function splitWords(text) {
  const words = [];
  let word = '';
  let open = false;
  let any = false;
  for (const ch of String(text || '')) {
    if (ch === '"') { open = !open; any = true; continue; }
    if (!open && /\s/.test(ch)) {
      if (any) words.push(word);
      word = '';
      any = false;
      continue;
    }
    word += ch;
    any = true;
  }
  if (any) words.push(word);
  return words;
}

// { exe, args } for a codex process (native codex, or node running the npm
// package's codex.js), else null.
function codexCommand(input) {
  const { exe, rest } = splitExecutable(input);
  const name = exe.split(/[\\/]/).pop();
  if (CODEX_NAME_RE.test(name)) return { exe, args: splitWords(rest) };
  if (!NODE_NAME_RE.test(name)) return null;
  const script = CODEX_JS_RE.exec(rest);
  if (!script) return null;
  const after = rest.slice(script.index + script[0].length);
  if (after && !/^["\s]/.test(after)) return null;
  return { exe, args: splitWords(after.replace(/^"/, '')) };
}

// Positional words (flags and their values skipped) and the flags ahead of
// the first positional.
function positionalWords(args) {
  const positional = [];
  const leading = [];
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i];
    if (word === '--') { positional.push(...args.slice(i + 1)); break; }
    if (word.length > 1 && word.startsWith('-')) {
      if (!positional.length) leading.push(word);
      if (VALUE_FLAGS.has(word)) i += 1;
      continue;
    }
    positional.push(word);
  }
  return { positional, leading };
}

// What a codex process is doing: its subcommand, whether that can be a
// session at all, and for `resume`/`fork` (also under `exec`) the thread named.
function codexShape(input) {
  const command = codexCommand(input);
  if (!command) return null;
  const { positional, leading } = positionalWords(command.args);
  const sub = positional[0] ?? null;
  const at = sub === 'exec' || sub === 'e' ? 1 : 0;
  const verb = positional[at] === 'resume' || positional[at] === 'fork' ? positional[at] : null;
  return {
    exe: command.exe,
    sub,
    session: sub == null || !NOT_A_SESSION.has(sub),
    verb,
    target: verb ? positional[at + 1] ?? null : null,
    leading,
  };
}

const isCodexProcess = (input) => Boolean(codexCommand(input));

// The Codex desktop app's own processes, whatever their executable is called
// (an unguarded one refused every resume on Windows): the app bundle and its bundled CLI, the
// rest of the app family (APP_FAMILY_RE), and any Chromium/Electron child
// (`--type=renderer|gpu-process|utility|crashpad-handler` ahead of any
// positional word, which no codex CLI ever takes).
function isCodexAppProcess(input) {
  const { exe, rest } = splitExecutable(input);
  if (APP_PATH_RE.test(exe) || APP_FAMILY_RE.test(exe)) return true;
  return positionalWords(splitWords(rest)).leading.some((word) => /^--type=[\w-]+/.test(word));
}

// Is the Codex app (or an app-server, as the app and the VS Code extension
// run it) up: the app's own executable, or a codex whose SUBCOMMAND is
// app-server.
const isCodexAppRunning = (input) => APP_PATH_RE.test(splitExecutable(input).exe)
  || codexShape(input)?.sub === 'app-server';

const START_SLACK_MS = 5000;
// Pane pid -> shell -> bin/ai -> node codex.js -> native codex, plus slack.
const MAX_ANCESTRY_HOPS = 12;

const OWNER_HARBOR_PANE = 'this Codex session is already open in a Harbor pane; reply there';
const OWNER_HARBOR_PANE_MAYBE = 'this Codex session was written moments ago while a Harbor Codex pane on another session'
  + ' was running, and that pane may have switched to it (/resume); check your Codex windows, or wait a few minutes and send again';
// How recent a write still counts as "somebody is on it": the same window the
// rail uses to call a session with no pane live outside Harbor.
const RECENT_WRITE_MS = 3 * 60 * 1000;
const PANES_UNKNOWN = 'Harbor could not read its own panes (the daemon snapshot failed), so it cannot tell whether'
  + ' a codex on this machine is one of them; refusing to guess, retry shortly';

const sameId = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// One Harbor pane as the probe needs it, from the daemon snapshot and the
// pane-link registry: the pane's own pid, its detected agent, and every
// session id Harbor has tied to it (the daemon's agent_session and any link).
// NO snapshot (the daemon call failed, and the composition roots turn that
// into null) answers null, "unknown", never []: with
// no panes a Harbor Codex pane's own `codex resume <id>` read as a foreign,
// verified CLI, and adopt-on-send killed it.
function harborPanesFromSnapshot(snapshot, links = {}) {
  if (snapshot == null || typeof snapshot !== 'object') return null;
  const panes = (snapshot?.snapshot || snapshot)?.panes || [];
  return panes.map((pane) => {
    const own = typeof pane.agent_session === 'string' ? pane.agent_session : pane.agent_session?.value || null;
    const linked = Object.entries(links || {})
      .filter(([, link]) => link?.paneId && link.paneId === pane.pane_id)
      .map(([id]) => id);
    return {
      paneId: pane.pane_id || null,
      workspaceId: pane.workspace_id || null,
      pid: Number(pane.pid) || null,
      provider: pane.agent || null,
      sessionIds: [...new Set([own, ...linked].filter(Boolean))],
    };
  });
}

function createCodexOwnerProbe(options = {}) {
  const {
    listProcesses,     // async () => [{ pid, ppid?, startedAt?, cmdline }]
    readSessionMeta,   // async (sessionId) => { originator, source, timestamp, cwd, mtimeMs } | null
    readProcessCwd = async () => null, // async (pid) => cwd | null (unknown on win32)
    // async (pids) => Map(pid -> cwd | null): every candidate's cwd in ONE
    // call. Defaults to readProcessCwd.many (createProcessQuestions attaches
    // it), else one readProcessCwd per pid, all at once.
    readProcessCwds = null,
    // Harbor's own panes: async () => [{ paneId, workspaceId, pid, provider, sessionIds }]
    // (harborPanesFromSnapshot). A throw or null means "unknown": the probe
    // then refuses whenever a codex that could be a session is running. Only a Codex pane linked to ANOTHER session
    // has its own codex process set aside; everything else is judged like any
    // process on the machine (excluding every pane's descendants hid a
    // `codex resume <id>` typed into a Harbor shell pane, and a Harbor Codex
    // pane that had /resume'd into this thread).
    harborPanes = async () => [],
    deadlineMs = 6000,
    recentWriteMs = RECENT_WRITE_MS,
    now = Date.now,
  } = options;
  if (typeof listProcesses !== 'function' || typeof readSessionMeta !== 'function') {
    throw new TypeError('createCodexOwnerProbe requires listProcesses and readSessionMeta');
  }
  const batchedCwds = readProcessCwds || (typeof readProcessCwd.many === 'function' ? readProcessCwd.many : null);
  // pid -> cwd | null for every pid. A failed read is an unknown cwd, which
  // rules nobody out (the conservative answer), never a refusal.
  const readCwds = async (pids) => {
    if (batchedCwds) {
      const found = await Promise.resolve(batchedCwds(pids)).catch(() => null);
      return found instanceof Map ? found : new Map();
    }
    const each = await Promise.all(pids.map((pid) => Promise.resolve(readProcessCwd(pid)).catch(() => null)));
    return new Map(pids.map((pid, i) => [pid, each[i] || null]));
  };
  const withDeadline = (work, what) => {
    let timer;
    return Promise.race([
      Promise.resolve(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not answer within ${deadlineMs}ms; refusing to guess, retry shortly`)), deadlineMs);
      }),
    ]).finally(() => clearTimeout(timer));
  };

  return async function probeCodexOwner(sessionId) {
    if (!sessionId || /[\s/\\]/.test(String(sessionId))) throw new Error('not a Codex session id');
    const [processes, meta, panes] = await Promise.all([
      withDeadline(listProcesses(), 'the process list'),
      Promise.resolve(readSessionMeta(sessionId)).catch(() => null),
      Promise.resolve().then(() => harborPanes()).then((list) => (Array.isArray(list) ? list : null), () => null),
    ]);
    const byPid = new Map((processes || []).map((p) => [Number(p.pid), p]));
    const paneByPid = new Map((panes || []).filter((pane) => Number(pane?.pid)).map((pane) => [Number(pane.pid), pane]));
    // The Harbor pane a process runs under, and whether it is that pane's OWN
    // codex: every process from it up to the pane is codex until the first
    // non-codex ancestor, and no codex sits above that (a codex started from
    // the pane codex's tool shell is somebody else's).
    const placement = (proc) => {
      let leftCodex = false;
      let nested = false;
      const seen = new Set();
      for (let p = proc, hops = 0; p && hops < MAX_ANCESTRY_HOPS && !seen.has(Number(p.pid)); p = byPid.get(Number(p.ppid)), hops += 1) {
        seen.add(Number(p.pid));
        if (!isCodexProcess(p)) leftCodex = true;
        else if (leftCodex) nested = true;
        const pane = paneByPid.get(Number(p.pid));
        if (pane) return { pane, own: !nested };
      }
      return null;
    };
    const allCodex = (processes || [])
      .filter((p) => p?.cmdline && isCodexProcess(p))
      .map((p) => ({ proc: p, at: placement(p) }));
    const harborOwner = (pane) => ({
      ownerGone: false, kind: 'harbor', verified: false,
      paneId: pane?.paneId || null, workspaceId: pane?.workspaceId || null,
      reason: OWNER_HARBOR_PANE,
    });

    // 0. A Harbor pane already holds this session: that pane is the owner.
    // Report it (never a kill target) so the caller refuses or routes there.
    const linkedHere = (panes || []).find((pane) => (pane?.sessionIds || []).includes(sessionId)
      && (pane.provider === 'codex' || allCodex.some(({ at }) => at?.pane === pane)));
    if (linkedHere) return harborOwner(linkedHere);

    // Set aside only a Codex pane's own codex when Harbor knows that pane is
    // on a DIFFERENT session.
    const setAside = ({ at }) => Boolean(at && at.own && at.pane.provider === 'codex'
      && (at.pane.sessionIds || []).length > 0 && !(at.pane.sessionIds || []).includes(sessionId));
    const kept = allCodex.filter((entry) => !setAside(entry)).map((entry) => ({ ...entry, shape: codexShape(entry.proc) }));
    // A Harbor Codex pane that /resume'd into another thread keeps the id it
    // was launched or linked with, so its codex was just set aside. Nothing
    // on the process table can tell it is on THIS thread now, but a write to
    // this rollout while it ran, moments ago, means somebody is. Without that
    // a resume here made a second writer. After the window it is
    // indistinguishable from nobody (an idle /resume'd pane writes nothing).
    const maybeSwitched = () => {
      const writtenAt = Number(meta?.mtimeMs);
      if (!Number.isFinite(writtenAt) || now() - writtenAt > recentWriteMs) return null;
      return allCodex.find((entry) => setAside(entry) && !(Number(entry.proc.startedAt) > writtenAt))?.at.pane || null;
    };
    const harborMaybe = (pane) => ({ ...harborOwner(pane), reason: OWNER_HARBOR_PANE_MAYBE });

    // Without Harbor's own panes nothing can be placed: a codex here may be a
    // Harbor pane's own (never a kill target), and a pane on this thread can
    // carry another id in its argv. Refuse whenever a codex that could be a
    // session runs; with none, no pane can be holding this thread either.
    if (!panes && kept.some(({ proc, shape }) => shape?.session && !isCodexAppProcess(proc))) {
      throw new Error(PANES_UNKNOWN);
    }

    // a. A process RESUMING this thread id (`codex resume <id>`, also under
    // `exec`, the id the first word after `resume`): the owner, verified. An
    // id anywhere else in the argv (a prompt that mentions it, `fork <id>`,
    // `delete <id>`) is not: a fork writes its own rollout. One running
    // inside a Harbor pane (a shell pane, a pane not linked yet) is that
    // pane's: reported, never a kill target. One of the Codex app's own is the
    // app's: refused, never signalled.
    const namedEntry = kept.find(({ shape }) => shape?.session && shape.verb === 'resume' && sameId(shape.target, sessionId));
    const named = namedEntry?.proc;
    if (namedEntry?.at) return harborOwner(namedEntry.at.pane);
    if (named && isCodexAppProcess(named)) return { ownerGone: false, kind: 'app', reason: OWNER_CODEX_APP };
    if (named) {
      return {
        ownerGone: false, kind: 'cli', pid: Number(named.pid), verified: true,
        reason: `a codex process (pid ${named.pid}) still has this session open; reply there, or let Harbor take it over`,
      };
    }

    // b. Written by the Codex app: the app is the owner while it runs.
    const fromApp = /codex desktop/i.test(meta?.originator || '') || meta?.source === 'vscode';
    if (fromApp) {
      const appRunning = (processes || []).some((p) => p?.cmdline && isCodexAppRunning(p));
      if (appRunning) return { ownerGone: false, kind: 'app', reason: OWNER_CODEX_APP };
      const switched = maybeSwitched();
      return switched ? harborMaybe(switched) : { ownerGone: true };
    }

    // c. A fresh CLI with no id: only one that started no later than the session
    // did, in the same folder when the folder is readable, can be its writer.
    // The Codex app's own processes are never a fresh CLI: on Windows, where
    // the cwd is unreadable, its Codex.exe helpers refused every resume of a
    // CLI session started after the app launched; on macOS lsof's cwd `/`
    // only skipped them by luck.
    // Every test that needs no process call runs first, so a cwd is read only
    // for a real candidate, and all of them in one batched call under the
    // same deadline as the process list (one lsof per candidate in sequence,
    // unbounded, took about 1 s beside the Codex app's helpers).
    const sessionStart = Date.parse(meta?.timestamp || '');
    // A `resume` of another thread id is provably not this one's writer, and a
    // `fork` of THIS id writes a rollout of its own. A resume by name or
    // --last, or a fork of another thread (whose new rollout may be this one),
    // stays a candidate: it is never verified, so never killed.
    const candidates = kept.filter(({ proc, shape }) => {
      if (!shape?.session || isCodexAppProcess(proc)) return false;
      if (shape.verb === 'resume' && UUID_RE.test(shape.target || '') && !sameId(shape.target, sessionId)) return false;
      if (shape.verb === 'fork' && sameId(shape.target, sessionId)) return false;
      const startedAt = Number(proc.startedAt);
      return !(Number.isFinite(startedAt) && Number.isFinite(sessionStart) && startedAt > sessionStart + START_SLACK_MS);
    }).map(({ proc }) => proc);
    if (!candidates.length) {
      const switched = maybeSwitched();
      return switched ? harborMaybe(switched) : { ownerGone: true };
    }
    // With no folder on record a cwd cannot rule anyone out: none is read.
    const cwds = meta?.cwd
      ? await withDeadline(readCwds(candidates.map((proc) => Number(proc.pid))), 'the process folders')
      : new Map();
    const owner = candidates.find((proc) => {
      const cwd = cwds.get(Number(proc.pid)) || null;
      return !(cwd && cwd !== meta.cwd);
    });
    if (!owner) {
      const switched = maybeSwitched();
      return switched ? harborMaybe(switched) : { ownerGone: true };
    }
    return {
      ownerGone: false, kind: 'cli', pid: Number(owner.pid), verified: false,
      reason: `a codex CLI (pid ${owner.pid}) that may own this session is still running; reply there or quit it, then send again`,
    };
  };
}

// The resume guard for the rail Resume (the `resume-session` handler, desktop
// and phone server), with the send path's wording: a live owner
// refuses, by name, before anything is launched. A missing probe refuses too:
// resuming unchecked is exactly the two-writer bug.
async function refuseBesideLiveCodexOwner(ownerProbe, sessionId) {
  if (typeof ownerProbe !== 'function') {
    throw new Error('Harbor cannot check who has this Codex session open yet; retry shortly');
  }
  const owner = await ownerProbe(sessionId);
  if (owner && !owner.ownerGone) throw new Error(owner.reason || 'this Codex session is still open somewhere else; reply there');
  return owner;
}

// The Codex arm of adopt-on-send: refuse what cannot be proven, kill only an
// argv-verified owner, then resume the thread in a Harbor pane.
function createCodexTakeoverHandler(options = {}) {
  const {
    ownerProbe,
    killOwner,                 // async (pid) => void, throws when it survives
    assertSignalsAllowed = () => {},
    getSessionMeta,
    paneIdSet,
    resumeProviderSession,
    findFreshPane,
    setPaneLink,
    requestFocusPane,
    waitForProviderReady,
    emitStatus,
    emitLaunched,
    operationGate,
  } = options;
  return ({ sessionId }) => operationGate.run(sessionId, async () => {
    const status = (phase, detail) => emitStatus({ sessionId, phase, detail });
    try {
      status('taking-over', 'checking who has this Codex session open…');
      const meta = await getSessionMeta(sessionId).catch(() => null);
      if (!meta?.cwd) throw new Error('this Codex session\'s working folder is unknown; cannot resume it');
      const owner = await ownerProbe(sessionId);
      if (!owner.ownerGone) {
        if (!owner.verified || owner.kind !== 'cli') throw new Error(owner.reason);
        assertSignalsAllowed(owner.pid);
        status('taking-over', 'ending the codex process…');
        await killOwner(owner.pid);
      }
      const preIds = await paneIdSet();
      status('taking-over', owner.ownerGone ? 'owner already exited; resuming session…' : 'adopting session…');
      await resumeProviderSession({
        provider: 'codex',
        cwd: meta.cwd,
        id: sessionId,
        ...(meta.profileId ? { profileId: meta.profileId } : {}),
        ...(meta.configHome ? { configHome: meta.configHome } : {}),
      });
      const fresh = await findFreshPane({ preIds, cwd: meta.cwd });
      if (!fresh) throw new Error('resumed the Codex session, but Harbor could not identify its pane');
      setPaneLink(sessionId, fresh);
      await requestFocusPane({ paneId: fresh.paneId, workspaceId: fresh.workspaceId }).catch(() => {});
      if (!(await waitForProviderReady(fresh.paneId))) throw new Error('Codex resumed, but its composer never settled');
      emitLaunched({ sessionId, paneId: fresh.paneId, cwd: meta.cwd, resumed: true });
      status('sent', 'session adopted');
      return { ok: true, paneId: fresh.paneId };
    } catch (error) {
      status('error', String(error?.message || error));
      throw error;
    }
  });
}

// POSIX process list without Python: `ps` with elapsed time (etime is portable
// across macOS and procps; lstart's format is locale-bound).
function parsePsList(stdout, now = Date.now()) {
  const etimeToMs = (text) => {
    const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text).trim());
    if (!match) return null;
    const [, dd, hh, mm, ss] = match;
    return (((Number(dd || 0) * 24 + Number(hh || 0)) * 60 + Number(mm)) * 60 + Number(ss)) * 1000;
  };
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const elapsed = etimeToMs(match[3]);
    out.push({ pid: Number(match[1]), ppid: Number(match[2]), startedAt: elapsed == null ? null : now - elapsed, cmdline: match[4] });
  }
  return out;
}

// `ps -axo pid=,comm=`: pid -> the executable as ps names it. On macOS that is
// the whole argv[0], spaces included (`/Users/x/.codex/computer-use/Codex
// Computer Use.app/Contents/MacOS/SkyComputerUseService`); on Linux a
// truncated name, which only counts when the command line starts with it.
// comm is the LAST column, so a space in it cannot shift another field.
function parsePsComm(stdout) {
  const out = new Map();
  for (const line of String(stdout || '').split('\n')) {
    const match = /^\s*(\d+) (.*\S)\s*$/.exec(line);
    if (match) out.set(Number(match[1]), match[2]);
  }
  return out;
}

// The process list with each process's executable (`exe`) attached where ps
// named one; a process missing from the comm list keeps the old reading.
function withExecutables(processes, comms) {
  return processes.map((proc) => (comms.has(proc.pid) ? { ...proc, exe: comms.get(proc.pid) } : proc));
}

// win32's CIM answer: CreationDate arrives as "/Date(<ms>)/" from ConvertTo-Json.
function parseCimList(stdout) {
  if (!String(stdout || '').trim()) return [];
  const parsed = JSON.parse(String(stdout));
  return (Array.isArray(parsed) ? parsed : [parsed]).map((record) => {
    const created = /\/Date\((\d+)\)\//.exec(String(record.CreationDate || ''));
    return {
      pid: Number(record.ProcessId),
      ppid: Number(record.ParentProcessId),
      startedAt: created ? Number(created[1]) : (Date.parse(record.CreationDate || '') || null),
      cmdline: String(record.CommandLine || ''),
    };
  });
}

// The two process questions, per OS, with an injected execFile. No Python.
// POSIX asks ps twice, at once: argv (`command=`, unquoted, so a path with a
// space in it cannot be told from its arguments) and the executable
// (`comm=`). A failed comm call keeps the old reading.
// win32 is unchanged: CommandLine quotes a spaced executable path itself
// (unverified on a real Windows seat for this change).
function createProcessQuestions({ platform = process.platform, execFile, readlink }) {
  const psOptions = { encoding: 'utf8', timeout: 4000, maxBuffer: 32 * 1024 * 1024 };
  const listProcesses = platform === 'win32'
    ? async () => parseCimList((await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine|ConvertTo-Json -Compress'],
    { encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })).stdout)
    : async () => {
      const [full, comm] = await Promise.all([
        execFile('ps', ['-axo', 'pid=,ppid=,etime=,command='], psOptions),
        Promise.resolve().then(() => execFile('ps', ['-axo', 'pid=,comm='], psOptions)).catch(() => null),
      ]);
      return withExecutables(parsePsList(full.stdout), parsePsComm(comm?.stdout));
    };
  // darwin: ONE lsof for any number of pids (`-p a,b,c`, `-Fpn` answers a
  // p<pid> line then the n<path> of its cwd). lsof exits 1 when any pid has
  // gone; the survivors' lines are still on stdout.
  const lsofCwds = async (pids) => {
    const list = [...new Set(pids.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
    const out = new Map(list.map((pid) => [pid, null]));
    if (!list.length) return out;
    let stdout = '';
    try {
      ({ stdout } = await execFile('/usr/sbin/lsof', ['-a', '-p', list.join(','), '-d', 'cwd', '-Fpn'], { encoding: 'utf8', timeout: 3000 }));
    } catch (error) {
      stdout = error?.stdout || '';
    }
    let pid = null;
    for (const line of String(stdout).split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && out.has(pid) && out.get(pid) == null) out.set(pid, line.slice(1));
    }
    return out;
  };
  const readProcessCwd = platform === 'linux'
    ? async (pid) => readlink(`/proc/${pid}/cwd`).catch(() => null)
    : platform === 'darwin'
      ? async (pid) => (await lsofCwds([pid])).get(Number(pid)) ?? null
      : async () => null;
  // The batched form rides on the function itself, so a composition root that
  // passes only `readProcessCwd` to the probe gets it too.
  readProcessCwd.many = platform === 'darwin'
    ? lsofCwds
    : async (pids) => new Map(await Promise.all(pids.map(async (pid) => [Number(pid), await readProcessCwd(pid)])));
  return { listProcesses, readProcessCwd, readProcessCwds: readProcessCwd.many };
}

module.exports = {
  createCodexOwnerProbe, createCodexTakeoverHandler, createProcessQuestions, parsePsList, parsePsComm, parseCimList,
  harborPanesFromSnapshot, codexShape, isCodexProcess, isCodexAppProcess, isCodexAppRunning, refuseBesideLiveCodexOwner, OWNER_CODEX_APP, OWNER_HARBOR_PANE,
};
