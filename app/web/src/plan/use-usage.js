import { useCallback, useEffect, useState } from 'react';

export function useUsage(client, open) {
  const [usage, setUsage] = useState({});
  const [emails, setEmails] = useState({});
  const [error, setError] = useState(null);
  const refresh = useCallback(async () => {
    if (!client || !open) return;
    try {
      const [nextUsage, nextEmails] = await Promise.all([
        client.call('usage:get-all'), client.call('accounts:read-emails'),
      ]);
      setUsage(nextUsage || {}); setEmails(nextEmails || {}); setError(null);
    } catch (cause) { setError(String(cause?.message || cause)); }
  }, [client, open]);
  useEffect(() => { refresh(); }, [refresh]);
  return { usage, emails, error, refresh };
}
