'use strict';

const { watchPath } = require('../watch-path.js');

// THE ASK INBOX: Harbor's side of the hook lane (2026-09-05).
//
// bin/harbor-ask-hook writes each AskUserQuestion into <askDir> as JSON and
// waits. This provider keeps the heartbeat the hook checks, watches the
// directory, CLAIMS the requests whose session Harbor is showing (the hook
// steps aside for the rest), publishes the pending set to the renderer, and
// writes the answer or decline file the hook turns into the tool's own
// `answers`/`annotations` input. No pty is read and no key is typed anywhere
// in this file, which is the whole point.
//
// Ownership is a callback (`ownsSession(sessionId)` -> pane facts or null)
// because the truth lives in the sidebar bridge's live state; the inbox never
// guesses from the cwd. A request whose hook process has died, or that is
// older than the hook's own ceiling, is dropped so a crashed CLI cannot leave
// a card on screen forever.

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const proto = require('../../shared/ask-protocol.cjs');
const { validateContent, safeExternalUrl } = require('../../shared/elicitation.cjs');

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

function normalizeQuestions(toolInput) {
  const questions = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  return questions.map((q, index) => ({
    index,
    question: String(q?.question || '').trim(),
    header: String(q?.header || '').trim(),
    multiSelect: Boolean(q?.multiSelect),
    options: (Array.isArray(q?.options) ? q.options : []).map((o, optionIndex) => ({
      index: optionIndex,
      label: String(o?.label || '').trim(),
      description: String(o?.description || '').trim(),
      preview: typeof o?.preview === 'string' && o.preview.trim() ? o.preview : null,
    })),
  }));
}

function createAskInbox(options = {}) {
  const observeOnly = Boolean(options.observeOnly);
  const dir = options.dir || proto.defaultAskDir(options.env || process.env);
  const ownsSession = typeof options.ownsSession === 'function' ? options.ownsSession : () => null;
  const heartbeatMs = Number.isFinite(options.heartbeatMs) ? options.heartbeatMs : proto.HEARTBEAT_MS;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 1000;
  const now = options.now || Date.now;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const isPidAlive = options.pidAlive || pidAlive;
  const emitter = new EventEmitter();
  const pending = new Map(); // id -> { id, sessionId, paneId, workspaceId, cwd, transcriptPath, questions, at, hookPid, answered }
  let heartbeatTimer = null;
  let pollTimer = null;
  let watcher = null;
  let closed = false;

  const writeHeartbeat = () => {
    try { proto.writeJsonAtomic(proto.heartbeatPath(dir), { pid: process.pid, at: now(), lanes: proto.LANES }); } catch (error) { log(`ask-inbox: heartbeat failed: ${error.message}`); }
  };

  const publish = () => emitter.emit('changed', list());

  const observable = (id, kind) => {
    const files = proto.filesFor(dir, id, kind);
    const request = proto.readJson(files.request);
    return proto.heartbeatFresh(dir, now(), proto.HEARTBEAT_STALE_MS, kind)
      && request && ownsSession(request.sessionId) && fs.existsSync(files.claim);
  };

  // Desktop and phone can answer the same request concurrently. Exclusive
  // creation makes the first answer authoritative across both processes.
  const writeAnswer = (id, kind, response) => {
    fs.writeFileSync(proto.filesFor(dir, id, kind).answer, JSON.stringify({ ...response, at: now() }), { flag: 'wx' });
  };

  function list() {
    return [...pending.values()].map((entry) => ({
      id: entry.id,
      sessionId: entry.sessionId,
      paneId: entry.paneId,
      workspaceId: entry.workspaceId,
      cwd: entry.cwd,
      at: entry.at,
      answered: entry.answered,
      questions: entry.questions,
      kind: entry.kind,
      prompt: entry.prompt,
    }));
  }

  function scan() {
    if (closed) return;
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    const seen = new Set();
    let changed = false;
    for (const name of names) {
      const suffix = name.match(/\.(request|permission\.pending|elicitation\.pending)\.json$/);
      if (!suffix) continue;
      const id = name.slice(0, -suffix[0].length);
      const kind = suffix[1] === 'request' ? 'ask' : suffix[1].split('.')[0];
      if (observeOnly && !observable(id, kind)) continue;
      seen.add(id);
      if (pending.has(id)) continue;
      const request = proto.readJson(path.join(dir, name));
      if (!request || !request.toolInput) continue;
      if ((request.kind || 'ask') !== kind) continue;
      const files = proto.filesFor(dir, id, kind);
      // A hook that is gone, or a request past the hook's own ceiling, is a
      // ghost: drop its files rather than show a question nobody is waiting on.
      const tooOld = now() - Number(request.at || 0) > proto.REQUEST_MAX_AGE_MS;
      if (tooOld || (request.hookPid && !isPidAlive(request.hookPid))) {
        if (observeOnly) continue;
        for (const file of [files.request, files.claim, files.answer, files.pass]) { try { fs.unlinkSync(file); } catch { /* absent */ } }
        log(`ask-inbox: dropped ghost request ${id} (${tooOld ? 'too old' : 'hook gone'})`);
        continue;
      }
      const owner = request.sessionId ? ownsSession(request.sessionId) : null;
      if (!owner) {
        if (observeOnly) continue;
        // Not ours (a terminal claude, a worker, a session with no window):
        // say so at once, so the hook steps aside now rather than waiting out
        // its claim window. The hook removes the pass with its request.
        if (!fs.existsSync(files.pass)) {
          try { proto.writeJsonAtomic(files.pass, { pid: process.pid, at: now() }); } catch { /* the claim window still covers it */ }
        }
        continue;
      }
      if (!observeOnly) {
        try { proto.writeJsonAtomic(files.claim, { pid: process.pid, at: now() }); }
        catch (error) { log(`ask-inbox: claim failed for ${id}: ${error.message}`); continue; }
      }
      pending.set(id, {
        id,
        kind,
        prompt: request.prompt,
        sessionId: request.sessionId,
        paneId: owner.paneId || null,
        workspaceId: owner.workspaceId || null,
        cwd: request.cwd || null,
        transcriptPath: request.transcriptPath || null,
        questions: normalizeQuestions(request.toolInput),
        at: Number(request.at) || now(),
        hookPid: request.hookPid || null,
        answered: fs.existsSync(files.answer),
      });
      log(`ask-inbox: claimed ${id} for session ${request.sessionId}`);
      changed = true;
    }
    // A request file that vanished was consumed by its hook (answered) or
    // withdrawn (the hook stepped aside, the CLI moved on): either way the
    // card must go. A request whose HOOK died while pending (the CLI was
    // killed, the hook hit its ceiling) leaves its file behind with nobody
    // waiting; that is a ghost too, and it is dropped with its files rather
    // than sitting on screen as a question that can never be delivered.
    for (const [id, entry] of [...pending.entries()]) {
      if (!seen.has(id)) { pending.delete(id); changed = true; continue; }
      if (entry.hookPid && !isPidAlive(entry.hookPid)) {
        const files = proto.filesFor(dir, id, entry.kind);
        if (!observeOnly) {
          for (const file of [files.request, files.claim, files.answer, files.pass]) { try { fs.unlinkSync(file); } catch { /* absent */ } }
        }
        pending.delete(id);
        log(`ask-inbox: dropped ${id}: its hook (pid ${entry.hookPid}) is gone`);
        changed = true;
      }
    }
    if (changed) publish();
  }

  // The hook is the only consumer of an answer: if it is gone (it stepped
  // aside at its claim deadline a beat before the claim landed, the CLI was
  // killed, its ceiling passed), reporting "sent" would be a lie the user
  // acts on (review finding, 2026-09-05). Drop the entry and say so; the
  // CLI's own dialog, if any, is where the question lives now.
  // Detect only. The card must still be mounted when the refusal reaches
  // it (a publish from inside the IPC handler unmounted the form before the
  // reply resolved, so the reason was never shown: review round 2); the next
  // scan drops the dead entry within a poll, after the user has read why.
  function hookGone(id, entry) {
    if (!entry.hookPid || isPidAlive(entry.hookPid)) return false;
    log(`ask-inbox: ${id}: its hook (pid ${entry.hookPid}) is gone; nothing to answer`);
    return true;
  }

  function answer(id, payload) {
    const entry = pending.get(id);
    if (!entry) return { ok: false, reason: 'that question is no longer pending' };
    if (observeOnly && !observable(id, entry.kind)) return { ok: false, reason: 'the desktop no longer owns this prompt' };
    if (entry.answered) return { ok: false, reason: 'that prompt was already answered' };
    if (hookGone(id, entry)) return { ok: false, reason: 'the question timed out before this answer; if Claude drew its own dialog, answer it there' };
    if (entry.kind !== 'ask') {
      let response;
      if (entry.kind === 'permission') {
        if (!['once', 'always', 'deny'].includes(payload?.choice)) {
          return { ok: false, reason: 'Choose a permission option' };
        }
        const decision = payload.choice === 'deny'
          ? { behavior: 'deny', message: String(payload.message || 'The user declined this request.') }
          : { behavior: 'allow' };
        if (payload.choice === 'always') {
          // Renderer input chooses the option, never the rules. Copy only the
          // measured suggestions attached to this request in the main process.
          decision.updatedPermissions = entry.prompt.persistent.updates;
        }
        response = { decision };
      } else {
        if (payload?.action === 'open-url') {
          const url = entry.prompt.mode === 'url' && safeExternalUrl(entry.prompt.url);
          if (!url || !options.openExternal) {
            return { ok: false, reason: 'This URL cannot be opened here' };
          }
          return Promise.resolve(options.openExternal(url)).then(
            () => ({ ok: true }),
            error => ({ ok: false, reason: String(error.message || error) }),
          );
        }
        if (!['accept', 'decline', 'cancel'].includes(payload?.action)) {
          return { ok: false, reason: 'Choose Accept, Decline, or Cancel' };
        }
        const formAccept = payload.action === 'accept' && entry.prompt.mode === 'form';
        if (formAccept) {
          const validation = validateContent(entry.prompt.schema, payload.content);
          if (!validation.ok) {
            return { ok: false, reason: 'Complete the required fields', errors: validation.errors };
          }
        }
        response = { action: payload.action, ...(formAccept ? { content: payload.content } : {}) };
      }
      try {
        writeAnswer(id, entry.kind, response);
      } catch (error) {
        return { ok: false, reason: `could not write the answer: ${error.message}` };
      }
      entry.answered = true;
      publish();
      return { ok: true };
    }
    const answers = payload && payload.answers && typeof payload.answers === 'object' ? payload.answers : null;
    // CLI 2.1.288 submits an all-skipped sheet as answers: {}.
    if (!answers || Array.isArray(answers)) return { ok: false, reason: 'no answer payload to send' };
    const annotations = payload.annotations && typeof payload.annotations === 'object' ? payload.annotations : undefined;
    try {
      writeAnswer(id, entry.kind, { answers, ...(annotations ? { annotations } : {}) });
    } catch (error) {
      return { ok: false, reason: `could not write the answer: ${error.message}` };
    }
    entry.answered = true;
    publish();
    return { ok: true };
  }

  function decline(id, reason) {
    const entry = pending.get(id);
    if (!entry) return { ok: false, reason: 'that question is no longer pending' };
    if (observeOnly && !observable(id, entry.kind)) return { ok: false, reason: 'the desktop no longer owns this prompt' };
    if (entry.kind === 'permission') return answer(id, { choice: 'deny', message: reason });
    if (entry.kind === 'elicitation') return answer(id, { action: 'decline' });
    if (entry.answered) return { ok: false, reason: 'that prompt was already answered' };
    if (hookGone(id, entry)) return { ok: false, reason: 'the question timed out before this reply; if Claude drew its own dialog, answer it there' };
    const text = String(reason || '').trim() || 'The user declined to answer this question in Harbor.';
    try {
      writeAnswer(id, entry.kind, { decline: text });
    } catch (error) {
      return { ok: false, reason: `could not write the decline: ${error.message}` };
    }
    entry.answered = true;
    publish();
    return { ok: true };
  }

  function start() {
    if (heartbeatTimer || pollTimer) return;
    fs.mkdirSync(dir, { recursive: true });
    if (!observeOnly) {
      writeHeartbeat();
      heartbeatTimer = setInterval(writeHeartbeat, heartbeatMs);
      heartbeatTimer.unref?.();
    }
    try {
      watcher = watchPath(dir, () => scan());
      watcher.on('error', () => { /* the poll covers a watcher that dies */ });
    } catch { watcher = null; }
    pollTimer = setInterval(scan, pollMs);
    pollTimer.unref?.();
    scan();
  }

  function stop() {
    closed = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pollTimer) clearInterval(pollTimer);
    heartbeatTimer = null;
    pollTimer = null;
    try { watcher?.close(); } catch { /* already closed */ }
    watcher = null;
    // No heartbeat means every waiting hook steps aside and the CLI draws its
    // own dialog: a closed Harbor never strands a question.
    if (!observeOnly) {
      try { fs.unlinkSync(proto.heartbeatPath(dir)); } catch { /* absent */ }
    }
  }

  return { emitter, dir, start, stop, scan, list, answer, decline, normalizeQuestions };
}

module.exports = { createAskInbox, normalizeQuestions };
