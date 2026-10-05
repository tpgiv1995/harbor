'use strict';
function createReplyStore() {
  const bySession = new Map(); const listeners = new Set();
  const publish = () => { for (const listener of listeners) listener(); };
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get(sessionId) { return bySession.get(sessionId) || null; },
    arm(ask) { bySession.set(ask.sessionId, { ...ask, collapsed: true }); publish(); },
    show(sessionId) { const ask=bySession.get(sessionId); if(ask){bySession.set(sessionId,{...ask,collapsed:false});publish();} },
    cancel(sessionId, askId) { if(!askId || bySession.get(sessionId)?.id===askId){bySession.delete(sessionId);publish();} },
    reconcile(asks) { let changed=false; for(const [sessionId,ask] of bySession) if(!asks.some(a=>a.id===ask.id&&!a.answered)){bySession.delete(sessionId);changed=true;} if(changed)publish(); },
  };
}
function quotePath(value) { const text=String(value); return /\s/.test(text) ? `"${text.replace(/"/g,'\\"')}"` : text; }
function frameReply(ask, text, paths = []) {
  // 2.1.288's native Chat row denies the tool with this clarification framing.
  // The composer already supplies the clarification, so do not ask for it again.
  return 'The user wants to clarify these questions. Take their response into account and reformulate the questions if appropriate.\n\nQuestions asked:\n'
    + (ask.questions || []).map(q=>`- "${q.question}"`).join('\n')
    + '\n\nUser response:\n' + String(text || '').trim()
    + (paths.length ? '\n' + paths.map(quotePath).join('\n') : '');
}
module.exports = { createReplyStore, frameReply, quotePath };
