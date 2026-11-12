/**
 * DesktopUrlSync — unidirectional workspace/desktop → URL sync (session URL)
 *
 * The URL is a session URL: /workspace/[id]/desktop/[n] mirrors the active
 * workspace + active desktop. When either changes (desktop switch via the
 * navbar indicator, a window opening on another desktop, a workspace switch
 * via the navbar dropdown), the URL follows — with router.replace ONLY
 * (changing desktops is not history navigation).
 *
 * Deliberately NOT bidirectional and NOT per-window:
 * - URL → state happens exactly once, in the /desktop/[n] route on mount
 *   (gated on the layout restore).
 * - State → URL happens here — this is the single writer.
 *
 * The first observation after the gate passes records the current pair
 * WITHOUT writing, so landing on a bare /workspace/[id] (root resolver,
 * navbar logo) keeps the bare URL — the segment appears only once the
 * desktop (or workspace) actually changes.
 */

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'expo-router';
import { useTilingStore } from '../../store/tilingStore';
import { useWorkspaceStore } from '../../store/workspaceStore';

interface DesktopUrlSyncProps {
  /** True once the tiling layout has been restored (layout gate) */
  workspaceLoaded: boolean;
}

export function DesktopUrlSync({ workspaceLoaded }: DesktopUrlSyncProps) {
  const router = useRouter();
  const pathname = usePathname();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const activeDesktopIndex = useTilingStore((s) => s.activeDesktopIndex);
  const lastSynced = useRef<{ ws: string; desk: number } | null>(null);

  useEffect(() => {
    if (!workspaceLoaded || !activeWorkspaceId) return;
    // The root route is owned by the resolver — never write the session URL
    // from there (it would fight the / → /workspace/[id] replace).
    if (pathname === '/') return;

    const prev = lastSynced.current;
    const target = `/workspace/${activeWorkspaceId}/desktop/${activeDesktopIndex}`;
    const changed =
      prev !== null && (prev.ws !== activeWorkspaceId || prev.desk !== activeDesktopIndex);

    if (changed && pathname !== target) {
      router.replace(target);
    }
    lastSynced.current = { ws: activeWorkspaceId, desk: activeDesktopIndex };
  }, [workspaceLoaded, activeWorkspaceId, activeDesktopIndex, pathname, router]);

  return null;
}
