/**
 * WorkspaceShellInit — session-URL shell logic for /workspace/[workspaceId] routes
 *
 * After the deep-URL removal, /workspace/[workspaceId] is the real shell route
 * (the group layout paints the TilingLayout; the route itself renders null).
 * This component owns the session-URL semantics shared by the bare index and
 * the /desktop/[n] segment route:
 *
 * 1. The workspace segment is session truth: if the URL's workspaceId differs
 *    from the active one, switch (setActiveWorkspace) and STAY on this URL.
 *    No redirect back to "/" — that would loop with the root resolver.
 *
 * Renders null — pure side-effect component.
 *
 * NOTE (Pablo, 30-oct — dynamic desktops): the old effect 2 opened a default
 * conversations window when the active desktop had no layout. Removed: an
 * empty desktop must STAY empty (TilingLayout's EmptyLayout state). The
 * fallback fired on every desktop switch to an empty desktop (the route
 * remounts on /desktop/[n], resetting the once-per-workspace latch), which
 * made empty desktops unusable. First-run UX is covered by EmptyLayout's
 * "¿Qué abrimos?" actions.
 */

import { useEffect, useRef } from 'react';
import { useWorkspaceStore } from '../../store/workspaceStore';

interface WorkspaceShellInitProps {
  /** Workspace id from the URL segment */
  workspaceId: string;
  /** workspaceLoaded gate from the group layout — true once the tiling layout
   *  has been restored from storage. Unused since the default-window effect
   *  was removed (Pablo, 30-oct); kept in the interface so callers don't
   *  churn — remove when convenient. */
  isReady?: boolean;
}

export function WorkspaceShellInit({ workspaceId }: WorkspaceShellInitProps) {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const initializedFor = useRef<string | null>(null);

  // 1. URL → active workspace. setActiveWorkspace persists the choice and
  //    reloads that workspace's saved layout into the tilingStore.
  useEffect(() => {
    if (!workspaceId || activeWorkspaceId === workspaceId) return;
    setActiveWorkspace(workspaceId);
  }, [workspaceId, activeWorkspaceId, setActiveWorkspace]);

  // Track the initialized workspace so future re-introduction of a
  // first-paint effect has the same once-per-workspace semantics available.
  useEffect(() => {
    if (!workspaceId) return;
    if (initializedFor.current === workspaceId) return;
    if (activeWorkspaceId !== workspaceId) return;
    initializedFor.current = workspaceId;
  }, [workspaceId, activeWorkspaceId]);

  return null;
}
