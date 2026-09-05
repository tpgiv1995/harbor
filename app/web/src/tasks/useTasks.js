import { useCallback, useEffect, useRef, useState } from 'react';
import tasksModel from '../../../src/shared/tasks-model.cjs';
import { CONNECTION } from '../rpc/client.js';

const { dayKey, msUntilDayRoll } = tasksModel;

export function useToday() {
  const [today, setToday] = useState(() => dayKey());
  const timerRef = useRef(null);

  useEffect(() => {
    let live = true;
    const schedule = () => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (!live) return;
        setToday(dayKey());
        schedule();
      }, msUntilDayRoll() + 1000);
    };
    schedule();
    const onFocus = () => setToday(dayKey());
    window.addEventListener('focus', onFocus);
    return () => {
      live = false;
      clearTimeout(timerRef.current);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  return today;
}

export function useTasks(client) {
  const [doc, setDoc] = useState(null);
  const [recovery, setRecovery] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const refresh = useCallback(async () => {
    if (!client || client.getState() !== CONNECTION.connected) return;
    try {
      const result = await client.call('tasks:read');
      if (result?.ok) {
        setDoc(result.doc);
        setRecovery(result.recovery || null);
        setError(null);
      } else {
        setError('the task file could not be read');
      }
    } catch (e) {
      setError(String(e?.message || e));
    }
  }, [client]);

  useEffect(() => {
    if (!client) return undefined;
    refresh();

    // Outside writers (desktop app, harbor-tasks CLI) mutate the same file;
    // the server pushes the new doc so the open phone view stays live.
    const unsubscribe = client.onChannel?.('tasks:changed', (payload) => {
      if (payload?.doc) setDoc(payload.doc);
    });

    // A reconnect is a new client on the server: the prior push subscription
    // is gone, so re-read rather than trusting whatever was on screen.
    const reconnected = client.onConnection?.((state) => {
      if (state === CONNECTION.connected) refresh();
    });

    return () => {
      unsubscribe?.();
      reconnected?.();
    };
  }, [client, refresh]);

  const applyDoc = useCallback((nextDoc) => {
    if (nextDoc) setDoc(nextDoc);
  }, []);

  const mutate = useCallback(async (op) => {
    if (!client) return { ok: false };
    const result = await client.call('tasks:mutate', op)
      .catch((e) => ({ ok: false, reason: String(e?.message || e) }));
    if (result?.doc) setDoc(result.doc);
    if (result?.recovery !== undefined) setRecovery(result.recovery || null);
    setNotice(result?.ok ? null : (result?.reason || 'that change did not save'));
    return result || { ok: false };
  }, [client]);

  return {
    doc,
    recovery,
    error,
    notice,
    dismissNotice: useCallback(() => setNotice(null), []),
    mutate,
    refresh,
    applyDoc,
  };
}
