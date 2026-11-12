/**
 * useLayoutRestoreGate — the group layout's isReady gate for the tiling layout.
 *
 * Derived from the tilingStore's restore GENERATION, not the layoutRestored
 * boolean: the boolean latches true on the FIRST restore and never advances,
 * so on a workspace switch isReady would stay true while the NEW workspace's
 * restore is still in flight — consumers would judge the OLD workspace's
 * layout (the workspace-switch restore race). The generation advances on
 * every completed restore, so the gate re-arms per restore: it drops back to
 * false the moment a newer restore completes and rises again once that
 * restore has been observed, giving consumers a fresh, per-restore gate.
 */

import { useEffect, useState } from 'react';
import { useTilingStore } from '../../store/tilingStore';

export function useLayoutRestoreGate(): boolean {
  const [loaded, setLoaded] = useState(false);
  /** Last restore generation this gate observed (and armed itself against) */
  const [observedGeneration, setObservedGeneration] = useState(0);
  const restoreGeneration = useTilingStore((s) => s.restoreGeneration);
  const layoutRestored = useTilingStore((s) => s.layoutRestored);

  useEffect(() => {
    if (!layoutRestored) return;
    if (useTilingStore.getState().restoreGeneration !== observedGeneration) {
      // A NEWER restore has completed — re-arm the gate: record the new
      // generation and drop loaded until the re-armed gate is observed
      // (this effect re-runs and flips it back on).
      setLoaded(false);
      setObservedGeneration(useTilingStore.getState().restoreGeneration);
      return;
    }
    setLoaded(true);
  }, [layoutRestored, restoreGeneration, observedGeneration]);

  return loaded;
}
