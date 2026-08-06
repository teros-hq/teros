/**
 * useWakeLock
 *
 * Keeps the screen awake while `active` is true. Uses `expo-keep-awake`
 * which abstracts both platforms:
 * - **Web**: Screen Wake Lock API (`navigator.wakeLock.request('screen')`)
 * - **Native (iOS/Android)**: native keep-awake module
 *
 * On web, the browser automatically releases the wake lock when the tab
 * becomes hidden. This hook listens for `visibilitychange` and re-acquires
 * the lock when the tab becomes visible again (if still active).
 *
 * All errors are caught silently — if the device/browser doesn't support
 * wake locks, the hook is a no-op.
 */

import { useEffect, useRef } from 'react';
import {
  activateKeepAwakeAsync,
  deactivateKeepAwake,
} from 'expo-keep-awake';

const WAKE_LOCK_TAG = 'teros-voice-session';

export function useWakeLock(active: boolean): void {
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    if (!active) return;

    let isMounted = true;

    const acquire = () => {
      activateKeepAwakeAsync(WAKE_LOCK_TAG).catch((err) => {
        // Wake lock not supported or denied — silently ignore.
        // The voice session continues to work regardless.
        console.warn('[useWakeLock] Could not acquire wake lock:', err);
      });
    };

    const release = () => {
      deactivateKeepAwake(WAKE_LOCK_TAG).catch(() => {
        // Already released or never acquired — ignore.
      });
    };

    // Acquire on activation
    acquire();

    // On web, the browser releases the wake lock when the tab is hidden.
    // Re-acquire it when the tab becomes visible again.
    const handleVisibilityChange = () => {
      if (!activeRef.current || !isMounted) return;
      if (document.visibilityState === 'visible') {
        acquire();
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      isMounted = false;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      release();
    };
  }, [active]);
}
