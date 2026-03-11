/**
 * Auto-discovery — Scans handler directories and registers all domain modules
 *
 * Each domain directory must have an index.ts that exports:
 *   register(router: WsRouter, deps: any): void
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import type { WsRouter } from './WsRouter';

export interface DiscoverOptions {
  /** Absolute path to the handlers directory */
  handlersDir: string
  /** Dependencies to pass to each domain's register() function */
  deps: Record<string, unknown>
}

export async function discoverHandlers(router: WsRouter, options: DiscoverOptions): Promise<void> {
  const { handlersDir, deps } = options;

  let entries;
  try {
    entries = readdirSync(handlersDir, { withFileTypes: true });
  } catch {
    console.warn(`[WsRouter] Handlers directory not found: ${handlersDir}`);
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const indexPath = join(handlersDir, entry.name, 'index');
    try {
      const mod = await import(indexPath);
      if (typeof mod.register === 'function') {
        mod.register(router, deps);
        console.log(`✅ [WsRouter] Registered domain: ${entry.name}`);
      }
    } catch (error) {
      // Not a handler module or import error — skip silently
      // (could be a utility directory, etc.)
    }
  }
}
