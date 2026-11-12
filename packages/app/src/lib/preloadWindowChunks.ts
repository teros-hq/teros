/**
 * preloadWindowChunks — Batch preload helper for window lazy chunks
 *
 * Called by `tilingStore.restoreFromStorage` to warm the chunk cache
 * for all windows in the restored layout, before the user interacts.
 */

import type { ComponentType } from 'react';
import { windowRegistry } from '../services/windowRegistry';

/**
 * Preload JS chunks for the given window types by calling `.preload()`
 * on their lazy components. Fire-and-forget — errors are swallowed.
 */
export function preloadWindowChunks(windowTypes: string[]): void {
  for (const type of windowTypes) {
    const def = windowRegistry.get(type);
    if (!def) continue;

    const component = def.component as ComponentType<any> & {
      preload?: () => Promise<void>;
    };
    if (typeof component.preload === 'function') {
      component.preload();
    }
  }
}
