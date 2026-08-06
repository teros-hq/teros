/**
 * useBashApp — resolves the appId of the bash MCA for a given workspace
 *
 * Looks for an installed app with mcaId === 'mca.teros.bash' in the workspace.
 * Returns { appId, loading } — appId is null if not found or still loading.
 */

import { useEffect, useState } from 'react';
import { getTerosClient } from '../../services/terosClientSingleton';

export function useBashApp(workspaceId?: string): { appId: string | null; loading: boolean } {
  const [appId, setAppId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const client = getTerosClient();

  useEffect(() => {
    if (!workspaceId || !client) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setAppId(null);

    client
      .listWorkspaceApps(workspaceId)
      .then((apps) => {
        const bash = apps.find((a: any) => a.mcaId === 'mca.teros.bash');
        setAppId(bash?.appId ?? null);
      })
      .catch(() => setAppId(null))
      .finally(() => setLoading(false));
  }, [workspaceId]);

  return { appId, loading };
}
