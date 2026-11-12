/**
 * Desktop Route — /workspace/[workspaceId]/desktop/[n]
 *
 * Session URL with the desktop segment: same shell behavior as the bare
 * workspace route (WorkspaceShellInit), plus a one-shot URL → state read:
 * once the layout restore gate passes, if [n] is a valid desktop index that
 * differs from the active one, switch to it (switchToDesktop —
 * bounds-checked and persists per-tab + device, exactly like the indicator).
 *
 * After that initial read, DesktopUrlSync (in the group layout) is the single
 * writer: desktop changes replace the URL, the URL never drives the desktop
 * again. An out-of-range [n] (e.g. /desktop/9 with 3 desktops) is ignored —
 * the active desktop stays, and the next state→URL sync corrects the URL.
 */

import { useEffect, useRef } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useTilingStore } from '../../../../../src/store/tilingStore';
import { WorkspaceShellInit } from '../../../../../src/components/workspace/WorkspaceShellInit';
import { useWorkspaceReady } from '../../../workspaceContext';

export default function DesktopRoute() {
  const { workspaceId, n } = useLocalSearchParams<{ workspaceId: string; n: string }>();
  const isReady = useWorkspaceReady();
  const desktops = useTilingStore((s) => s.desktops);
  const activeDesktopIndex = useTilingStore((s) => s.activeDesktopIndex);
  const switchToDesktop = useTilingStore((s) => s.switchToDesktop);
  const applied = useRef(false);

  // One-shot URL → active desktop, gated on the layout restore so it never
  // races restoreFromStorage (which also sets activeDesktopIndex).
  useEffect(() => {
    if (applied.current || !isReady || !n) return;
    applied.current = true;

    const parsed = Number.parseInt(n, 10);
    const isValid =
      Number.isInteger(parsed) && parsed >= 0 && parsed < desktops.length && parsed !== activeDesktopIndex;
    if (isValid) {
      switchToDesktop(parsed);
    }
  }, [isReady, n, desktops.length, activeDesktopIndex, switchToDesktop]);

  if (!workspaceId) return null;
  return <WorkspaceShellInit workspaceId={workspaceId} isReady={isReady} />;
}
