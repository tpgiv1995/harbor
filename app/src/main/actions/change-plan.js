'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { planMoveReason } = require('../../shared/plan-options.cjs');

// Preflight the shared transcript before ending anything. An independent copy
// is not a shared conversation and must never become a second writer.
async function verifySharedTranscript(meta, target, id, realpath = fs.realpath) {
  if (!meta?.path || path.basename(meta.path) !== `${id}.jsonl`) throw new Error('The conversation transcript is not available. Nothing was stopped.');
  const candidate = path.join(target.configHome, 'projects', path.basename(path.dirname(meta.path)), `${id}.jsonl`);
  let source, destination;
  try { [source, destination] = await Promise.all([realpath(meta.path), realpath(candidate)]); }
  catch { throw new Error('These plans do not share this conversation. Nothing was stopped.'); }
  if (source !== destination) throw new Error('These plans do not share this conversation. Nothing was stopped.');
}

function createPlanChange({ profiles, sidebar, sessionSend, sessionOwnerProbe, launchActions, links,
  emitLaunched, verifyTranscript = verifySharedTranscript, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  return async ({ id, detectedHome, movePlan }) => {
    if (movePlan?.confirmed !== true) throw new Error('Confirm the plan change first.');
    const target = profiles.find(p => p.id === detectedHome && (p.provider || 'claude') === 'claude');
    if (!target?.configHome) throw new Error('Choose a configured Claude plan.');
    const current = () => (sidebar.getState()?.model?.projects || []).flatMap(p => p.sessions || []).find(s => s.id === id);
    const check = () => {
      const row = current();
      const reason = planMoveReason(row, { working: row?.agentStatus === 'idle' || row?.agentStatus === 'ready' ? false : undefined });
      if (reason) throw new Error(reason);
      const source = profiles.find(p => p.id === row.home || p.configHome === row.home);
      if (!source || source.id !== movePlan.fromHome || row.paneId !== movePlan.paneId) throw new Error('This session changed since confirmation. Reopen its Plan choices.');
      if (source.id === target.id) throw new Error('This session already uses that plan.');
      return row;
    };
    const row = check();
    const meta = await sidebar.getSessionMeta(id);
    if (meta?.provider && meta.provider !== 'claude') throw new Error('Only Claude conversations can change plans.');
    await verifyTranscript(meta, target, id);
    // A missing or ambiguous ownership record is a refusal before exit.
    const owner = await sessionOwnerProbe(id);
    if (owner.ownerGone) throw new Error('This session is no longer running. Reopen it before changing plans.');
    return sessionSend.moveIdleSession({ sessionId: id, pane: { paneId: row.paneId, workspaceId: row.workspaceId } }, async exit => {
      check();
      const preIds = await sessionSend.paneIdSet();
      if (!preIds) throw new Error('The daemon could not list its panes. Nothing was stopped.');
      await exit();
      let gone = false;
      for (let n = 0; n < 40; n += 1) {
        await sleep(250);
        const proof = await sessionOwnerProbe(id);
        if (proof.ownerGone) { gone = true; break; }
      }
      if (!gone) throw new Error('Claude did not exit cleanly. The plan was not changed; no process was force-killed.');
      try {
        // The 90-second mtime guard is bypassed only after the existing owner
        // probe proves the old process gone AND finds no other session writer.
        const result = await launchActions.resumeSession({ id, detectedHome: target.id, liveOk: true });
        const fresh = await sessionSend.findFreshPane({ preIds, cwd: meta.cwd, sessionId: id });
        if (!fresh) throw new Error('the resumed pane did not appear');
        links.set(id, fresh);
        sidebar.noteLaunchedHome?.(id, target.id);
        const ready = await sessionSend.waitForResumedClaudeReady(fresh.paneId, fresh.workspaceId);
        if (!ready) throw new Error('Claude has not reached its composer');
        emitLaunched({ sessionId: id, ...fresh, cwd: meta.cwd, provider: 'claude', home: target.id, resumed: true });
        return { ...result, ok: true, sessionId: id, home: target.id, ...fresh };
      } catch (error) { throw new Error('The original Claude exited, but the plan change could not be completed: ' + error.message + '. The conversation is saved; reopen it before sending.'); }
    });
  };
}
module.exports = { createPlanChange, verifySharedTranscript };
