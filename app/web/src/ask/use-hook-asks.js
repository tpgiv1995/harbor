import { useEffect, useState } from 'react';
import { replyStore } from '../../../src/renderer/stage/use-question-reply.js';
export function useHookAsks(client) {
  const [asks, setAsks] = useState([]);
  useEffect(() => {
    if (!client) return;
    let live = true;
    const receive = list => { if (live && Array.isArray(list)) { setAsks(list); replyStore.reconcile(list); } };
    const refresh = () => client.call('ask:list').then(receive).catch(() => {});
    refresh();
    const changed = client.onChannel('ask:changed', receive);
    const connected = client.onConnection?.(state => { if (state === 'connected') refresh(); });
    return () => { live = false; changed?.(); connected?.(); };
  }, [client]);
  return asks;
}
