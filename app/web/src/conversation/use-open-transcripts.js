import { useEffect, useRef } from 'react';

// Keep transcript blocks for every open session window so live voice can read
// any of them, not only the one on screen.
export function useOpenTranscripts(client, openIds) {
  const cacheRef = useRef(new Map());

  useEffect(() => {
    if (!client || !openIds.length) return undefined;
    const opened = new Set();

    const apply = (sessionId, payload) => {
      const prev = cacheRef.current.get(sessionId) || { blocks: [], header: null };
      let blocks = prev.blocks;
      if (Array.isArray(payload.replace)) blocks = payload.replace;
      else {
        if (payload.changed?.length) {
          const byKey = new Map(payload.changed.map((block) => [block.key, block]));
          blocks = blocks.map((block) => byKey.get(block.key) || block);
        }
        if (payload.append?.length) blocks = [...blocks, ...payload.append];
      }
      cacheRef.current.set(sessionId, { blocks, header: payload.header || prev.header });
    };

    const unsubscribe = client.onChannel('transcript:update', (payload) => {
      if (!payload?.sessionId || !openIds.includes(payload.sessionId)) return;
      apply(payload.sessionId, payload);
    });

    for (const sessionId of openIds) {
      if (opened.has(sessionId)) continue;
      opened.add(sessionId);
      client.call('transcript:open', { sessionId }).catch(() => {});
    }

    return () => {
      unsubscribe();
      for (const sessionId of openIds) {
        client.call('transcript:close', { sessionId }).catch(() => {});
        cacheRef.current.delete(sessionId);
      }
    };
  }, [client, openIds]);

  return cacheRef;
}
