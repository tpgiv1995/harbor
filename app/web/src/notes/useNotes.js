import { useCallback, useEffect, useState } from 'react';
import notesModel from '../../../src/shared/notes-model.cjs';
import { CONNECTION } from '../rpc/client.js';

const { normalizeDoc } = notesModel;

export function useNotes(client) {
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const refresh = useCallback(async () => {
    if (!client || client.getState() !== CONNECTION.connected) return;
    try {
      const result = await client.call('notes:read');
      if (result?.ok) {
        setDoc(normalizeDoc(result.doc));
        setError(null);
      } else {
        setError(result?.reason || 'the notes file could not be read');
      }
    } catch (e) {
      setError(String(e?.message || e));
    }
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!client) return undefined;
    const unsubscribeChanged = client.onChannel('notes:changed', (payload) => {
      if (payload?.doc) {
        setDoc(normalizeDoc(payload.doc));
        setError(null);
      }
    });
    const unsubscribeConnection = client.onConnection((state) => {
      if (state === CONNECTION.connected) refresh();
    });
    return () => {
      unsubscribeChanged();
      unsubscribeConnection();
    };
  }, [client, refresh]);

  const mutate = useCallback(async (op) => {
    if (!client) {
      const result = { ok: false, reason: 'not connected' };
      setNotice(result.reason);
      return result;
    }
    const result = await client.call('notes:mutate', op)
      .catch((e) => ({ ok: false, reason: String(e?.message || e) }));
    if (result?.doc) setDoc(normalizeDoc(result.doc));
    setNotice(result?.ok ? null : (result?.reason || 'that change did not save'));
    return result || { ok: false };
  }, [client]);

  return {
    doc,
    error,
    notice,
    dismissNotice: useCallback(() => setNotice(null), []),
    mutate,
    refresh,
  };
}
