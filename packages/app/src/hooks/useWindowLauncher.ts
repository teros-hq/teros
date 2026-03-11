/**
 * useWindowLauncher - Hook to open/focus a window from a route
 *
 * If a window of the same type already exists that matches the matcher,
 * it focuses it (activating its pane). Otherwise, it creates it in the active pane.
 *
 * @example
 * // En app/(workspace)/chat/[channelId].tsx
 * useWindowLauncher('chat', { channelId }, (props) => props.channelId === channelId);
 */

import { useEffect, useRef } from 'react';
import { useTilingStore } from '../store/tilingStore';

/**
 * Hook to launch a window from a route
 *
 * @param type - Window type (must be registered in windowRegistry)
 * @param props - Props for the window
 * @param matcher - Function to determine if an existing window is "the same"
 * @param enabled - If false, does nothing (useful while waiting for the workspace to load)
 */
export function useWindowLauncher(
  type: string,
  props: Record<string, any>,
  matcher: (windowProps: Record<string, any>) => boolean,
  enabled: boolean = true,
  inNewTab: boolean = false,
): void {
  const { findWindow, focusWindow, openWindow } = useTilingStore();
  const launchedRef = useRef(false);
  const propsKeyRef = useRef<string>('');

  // Create a stable key from props to detect changes
  const propsKey = JSON.stringify(props);

  useEffect(() => {
    if (!enabled) return;

    // If props changed, allow re-launching
    if (propsKeyRef.current !== propsKey) {
      launchedRef.current = false;
      propsKeyRef.current = propsKey;
    }

    // No re-lanzar si ya se hizo con estos props
    if (launchedRef.current) return;
    launchedRef.current = true;

    // Find existing window
    const existing = findWindow(type, matcher);

    if (existing) {
      console.log(`[WindowLauncher] Focusing existing ${type} window:`, existing.id);
      focusWindow(existing.id);
    } else {
      console.log(`[WindowLauncher] Opening new ${type} window with props:`, props);
      try {
        openWindow(type, props, inNewTab);
      } catch (e) {
        console.error(`[WindowLauncher] Failed to open ${type} window:`, e);
      }
    }
  }, [enabled, type, propsKey, matcher]);
}
