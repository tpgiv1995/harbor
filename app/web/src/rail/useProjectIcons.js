import { useCallback, useEffect, useState } from 'react';
import { resolveIconUrl } from '../../../src/renderer/stage/project-icon-slug.cjs';
import { CONNECTION } from '../rpc/client.js';

export function useProjectIcons(client, serverUrl) {
  const [icons, setIcons] = useState({});

  const refresh = useCallback(async () => {
    if (!client || client.getState() !== CONNECTION.connected) return;
    try {
      const listed = await client.call('project-icons:list');
      const mapped = {};
      const base = (serverUrl || '').replace(/\/$/, '');
      for (const [slug, rel] of Object.entries(listed?.icons || {})) {
        mapped[slug] = rel.startsWith('http') ? rel : `${base}${rel}`;
      }
      setIcons(mapped);
    } catch {
      /* no icons is a supported state */
    }
  }, [client, serverUrl]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    refresh,
    iconUrl: (label) => resolveIconUrl(label, { userIcons: icons }),
  };
}

