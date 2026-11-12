/**
 * useReducedMotion — AC-UX12: respect `prefers-reduced-motion` everywhere.
 *
 * Extracted from the local pattern in useTypewriter.ts so every voice
 * surface (PresenceOrb breathing/echo/flash, VoiceErrorBanner countdown,
 * earcons) reads the SAME source of truth (ui-evolution §5 paso 6:
 * "hoy las animaciones no lo respetan" — this hook is the fix).
 *
 * On native there is no matchMedia — returns false (animations on), which
 * matches the platform's own Reduce Motion accessibility setting being out
 * of reach from JS here; the web (the primary voice surface today) is
 * fully covered.
 *
 * Reduced motion does NOT mean reduced information (UX §11.2): breathing /
 * pulses collapse to static color + label; the countdown becomes a static
 * "Reintentar" label. Sound (earcons) is not motion — it stays.
 */

import { useEffect, useState } from 'react';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  return reduced;
}
