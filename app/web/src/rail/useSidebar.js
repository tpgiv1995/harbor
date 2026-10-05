import { useCallback, useEffect, useState } from 'react';
import { CONNECTION } from '../rpc/client.js';

export function useSidebar(client) {
  const [model, setModel] = useState({ projects: [] });
  const [loadError, setLoadError] = useState(null);

  const refresh = useCallback(async () => {
    if (!client || client.getState() !== CONNECTION.connected) return;
    try {
      const state = await client.call('sidebar:get-state');
      setModel(state?.model || { projects: [] });
      setLoadError(null);
    } catch (error) {
      setLoadError(String(error.message || error));
    }
  }, [client]);

  // The `sidebar:update` PUSH already carries this exact shape (compose.js
  // wires sidebar-bridge's 'update' event straight to it), so applying it
  // directly needs no round trip. Before this, every push made AppShell call
  // `refresh()`, which re-fetched the full state over RPC, whose response
  // (identical bytes to the push that triggered it) is NEVER coalesced the
  // way pushes are (live-caught 2026-08-07: this session alone has 891
  // sessions across 77 projects, so its own sidebar model is ~680KB, and
  // updates fire fast enough during active work that the uncoalesced
  // refetch responses piled up and overflowed the connection outright,
  // independent of any one session's size).
  const applyPush = useCallback((payload) => {
    if (payload?.model) setModel(payload.model);
  }, []);

  useEffect(() => {
    if (!client) return undefined;
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, [client, refresh]);

  return { model, loadError, refresh, applyPush };
}

