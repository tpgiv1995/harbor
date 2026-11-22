import { useEffect, useState } from 'react';
import { CONNECTION } from '../rpc/client.js';

// The configured plan list (the `profiles` of new-session:options, the list the
// New session sheet offers), so a plan id reads as its own name wherever the
// phone shows a plan: the header plan chip and the Plans sheet. Read once per
// connect, never polled: the server reads the list when it starts, so only a
// reconnect (after a server restart) can bring a new plan.
export function usePlanProfiles(client, connection) {
  const [profiles, setProfiles] = useState(null);
  useEffect(() => {
    if (!client || connection !== CONNECTION.connected) return undefined;
    let live = true;
    client.call('new-session:options')
      .then((options) => { if (live && Array.isArray(options?.profiles)) setProfiles(options.profiles); })
      .catch(() => {});
    return () => { live = false; };
  }, [client, connection]);
  return profiles;
}
