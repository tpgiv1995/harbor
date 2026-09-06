import { useCallback, useEffect, useState } from 'react';
import { useRpc } from '../rpc/rpc-context.jsx';

const EMPTY_QUEUE = { count: 0, items: [] };

function reasonFrom(error) {
  return String(error?.message || error || 'send failed');
}

export function useSend({ sessionId, paneId, onSent }) {
  const client = useRpc();
  const [queue, setQueue] = useState(EMPTY_QUEUE);
  const [status, setStatus] = useState(null);
  const [sending, setSending] = useState(false);

  const showResult = useCallback((result, fallback) => {
    if (result?.ok === false) {
      setStatus({ phase: 'error', detail: String(result.reason) });
      return false;
    }
    if (result == null) return true;
    if (result.ok !== true) {
      setStatus({ phase: 'error', detail: fallback });
      return false;
    }
    return true;
  }, []);

  const refreshQueue = useCallback(async () => {
    try {
      const next = await client.call('session:send-queue', { sessionId });
      setQueue(next || EMPTY_QUEUE);
    } catch (error) {
      setStatus({ phase: 'error', detail: reasonFrom(error) });
    }
  }, [client, sessionId]);

  useEffect(() => {
    setQueue(EMPTY_QUEUE);
    setStatus(null);
    refreshQueue();
    const unsubscribe = client.onChannel('send:status', (next) => {
      if (next?.sessionId !== sessionId) return;
      setStatus(next);
      if (next.queue) setQueue(next.queue);
      else refreshQueue();
    });
    // THE QUEUE ROW IS ONLY EVER AS FRESH AS THE LAST PUSH THAT LANDED, and a
    // dropped socket delivers no pushes. This row is what read "sending:
    // /clear" on Pat's phone for minutes after the send had actually finished
    // (2026-08-08): the terminal `send:status` was written while his connection
    // was closed, and nothing re-read the queue afterwards, so a stale row
    // outlived the work it described. Re-fetching on reconnect is the whole
    // fix; the server has always been the authority here.
    const reconnected = client.onConnection?.((state) => {
      if (state === 'connected') refreshQueue();
    });
    return () => { unsubscribe(); reconnected?.(); };
  }, [client, refreshQueue, sessionId]);

  const send = useCallback(async (text, images = []) => {
    setSending(true);
    setStatus(null);
    const pane = paneId ? { paneId } : null;
    try {
      const result = await client.call('session:send', {
        sessionId,
        text,
        images,
        pane,
        resumeOnly: false,
      });
      const ok = showResult(result, 'send failed');
      await refreshQueue();
      if (ok) onSent?.(result);
      return { ok, result };
    } catch (error) {
      const reason = reasonFrom(error);
      setStatus({ phase: 'error', detail: reason });
      return { ok: false, result: { ok: false, reason } };
    } finally {
      setSending(false);
    }
  }, [client, onSent, paneId, refreshQueue, sessionId, showResult]);

  const cancel = useCallback(async (sendId) => {
    try {
      const result = await client.call('session:cancel-send', { sessionId, sendId });
      showResult(result, 'cancel failed');
      await refreshQueue();
      return result;
    } catch (error) {
      setStatus({ phase: 'error', detail: reasonFrom(error) });
      return null;
    }
  }, [client, refreshQueue, sessionId, showResult]);

  const interrupt = useCallback(async () => {
    try {
      const result = await client.call('session:interrupt', { paneId });
      showResult(result, 'interrupt failed');
      return result;
    } catch (error) {
      setStatus({ phase: 'error', detail: reasonFrom(error) });
      return null;
    }
  }, [client, paneId, showResult]);

  return { cancel, interrupt, queue, send, sending, status };
}
