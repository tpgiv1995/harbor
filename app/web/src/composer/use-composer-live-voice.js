import { useCallback } from 'react';
import { useRpc } from '../rpc/rpc-context.jsx';
import { useOpenSessions } from '../nav/useOpenSessions.js';
import { useOpenTranscripts } from '../conversation/use-open-transcripts.js';
import { useLiveVoice } from '../voice/use-live-voice.js';
import { useSidebar } from '../rail/useSidebar.js';

export function useComposerLiveVoice() {
  const client = useRpc();
  const { openIds, activeId, setActive } = useOpenSessions();
  const { model } = useSidebar(client);
  const transcriptCache = useOpenTranscripts(client, openIds);

  const sessionsById = useCallback(() => {
    const map = new Map();
    for (const project of model?.projects || []) {
      for (const session of project.sessions || []) map.set(session.id, session);
    }
    return map;
  }, [model]);

  const getSessions = useCallback(async () => {
    const byId = sessionsById();
    return openIds.map((id) => {
      const row = byId.get(id);
      if (!row) return null;
      const data = transcriptCache.current.get(id);
      const header = data?.header || null;
      const state = header?.blocked ? 'waiting on you'
        : header?.working ? 'working'
          : row.isLive || row.paneId ? 'ready' : 'not running';
      return {
        id: row.id,
        project: !row.project || row.project === '~' ? 'home' : row.project,
        title: row.childTitle || row.title || 'Untitled session',
        state,
        model: header?.model?.name || row.model || null,
        contextPct: typeof header?.contextPct === 'number' ? header.contextPct : null,
        selected: row.id === activeId,
      };
    }).filter(Boolean);
  }, [openIds, sessionsById, transcriptCache, activeId]);

  const readSession = useCallback(async (sessionId, limit) => {
    const blocks = transcriptCache.current.get(sessionId)?.blocks || [];
    return blocks
      .filter((block) => (block.kind === 'user' || block.kind === 'assistant') && block.text)
      .slice(-limit)
      .map((block) => ({ who: block.kind === 'user' ? 'pat' : 'claude', text: String(block.text).slice(0, 1200) }));
  }, [transcriptCache]);

  const sendToSession = useCallback(async (targetId, messageText) => {
    const row = sessionsById().get(targetId);
    if (!row) return { ok: false, reason: 'that session window is not open any more' };
    return client.call('session:send', {
      sessionId: row.id,
      text: messageText,
      images: [],
      pane: row.paneId ? { paneId: row.paneId } : null,
      resumeOnly: false,
    }).catch((error) => ({ ok: false, reason: String(error?.message || error) }));
  }, [client, sessionsById]);

  const interruptSession = useCallback(async (targetId) => {
    const row = sessionsById().get(targetId);
    if (!row?.paneId) return { ok: false, reason: 'that session has no live pane to interrupt' };
    return client.call('session:interrupt', { paneId: row.paneId })
      .catch((error) => ({ ok: false, reason: String(error?.message || error) }));
  }, [client, sessionsById]);

  return useLiveVoice({
    client,
    getSessions,
    readSession,
    sendToSession,
    interruptSession,
    selectSession: setActive,
  });
}
