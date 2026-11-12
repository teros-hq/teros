/**
 * useResponsive — Hook to detect mobile vs desktop viewport
 *
 * Returns isMobile based on a breakpoint (768px).
 * Listens to window resize events and updates reactively.
 */

import { useState, useEffect } from 'react';

const MOBILE_BREAKPOINT = 768;

export function useResponsive() {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.innerWidth < MOBILE_BREAKPOINT : false,
  );

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    window.addEventListener('resize', handleResize);
    // Set initial value in case it changed between mount and effect
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return { isMobile };
}
