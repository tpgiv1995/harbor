import { useCallback, useEffect, useState } from 'react';

export function useCapabilities(client, session) {
  const [capabilities, setCapabilities] = useState(null);
  const [options, setOptions] = useState(null);
  const [permissionMode, setPermissionMode] = useState(undefined);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!client || !session?.id) return;
    try {
      const caps = await client.call('capabilities:get', { sessionId: session.id });
      if (!caps?.ok) throw new Error(caps?.reason || 'Capabilities unavailable');
      setCapabilities(caps.capabilities);
      const [nextOptions, permission] = await Promise.all([
        client.call('new-session:options').catch(() => null),
        session.paneId
          ? client.call('capabilities:permission-mode', { paneId: session.paneId }).catch(() => ({ mode: null }))
          : Promise.resolve({ mode: null }),
      ]);
      setOptions(nextOptions);
      setPermissionMode(permission?.mode ?? null);
      setError(null);
    } catch (cause) {
      setError(String(cause?.message || cause));
    }
  }, [client, session?.id, session?.paneId]);

  useEffect(() => { refresh(); }, [refresh]);
  return { capabilities, options, permissionMode, setPermissionMode, error, refresh };
}
