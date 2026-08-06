import { useState } from 'react';

/**
 * Tracks an image source and whether it failed to load, so callers can fall back
 * to a non-image placeholder (initials, icon…) on a 404/broken URL instead of
 * the browser's broken-image glyph.
 *
 * Resets on `src` change during render — the idiomatic React pattern for
 * "reset state when a prop changes" (no effect, so no stale flash and no
 * exhaustive-deps warning). A new URL always gets a fresh attempt.
 *
 * Returns `showImage` (whether to render the <img>/<Image>) and `onError`
 * (wire it to the image's onError).
 */
export function useImageWithFallback(src?: string): {
  showImage: boolean;
  onError: () => void;
} {
  const [failed, setFailed] = useState(false);
  const [prevSrc, setPrevSrc] = useState(src);

  if (src !== prevSrc) {
    setPrevSrc(src);
    setFailed(false);
  }

  return {
    showImage: !!src && !failed,
    onError: () => setFailed(true),
  };
}
