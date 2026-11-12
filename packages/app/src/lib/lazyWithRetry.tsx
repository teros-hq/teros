/**
 * lazyWithRetry — React.lazy with timeout, retry, and preload support
 *
 * Wraps a dynamic import() so that stalled network requests (e.g. after
 * laptop sleep, WiFi→mobile switch, half-up VPN) never leave a Suspense
 * fallback visible forever.
 *
 * Features:
 * - Per-attempt timeout (default 15s) — rejects if the chunk download stalls
 * - Automatic retries with exponential backoff (default 3 retries, 1s base)
 * - `.preload()` method to warm the cache before the user opens a window
 * - On final failure, throws to the ErrorBoundary (which can show a retry button)
 *
 * Usage (replaces `lazy`):
 *   const MyComp = lazyWithRetry(() => import("./MyComp").then(m => ({ default: m.MyComp })));
 *
 * Preload:
 *   MyComp.preload(); // fire-and-forget, errors swallowed
 */

import { lazy, type ComponentType } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LazyWithRetryOptions {
  /** Timeout per attempt in ms (default: 15000) */
  timeout?: number;
  /** Max retry attempts after the first try (default: 3) */
  retries?: number;
  /** Base delay between retries in ms, doubled each attempt (default: 1000) */
  baseDelay?: number;
}

// ─── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates an async importer with timeout + retry logic.
 * Used both by the lazy wrapper and by `.preload()`.
 */
function createRetryableImport<T>(
  factory: () => Promise<{ default: T }>,
  options?: LazyWithRetryOptions,
): () => Promise<{ default: T }> {
  const { timeout = 15_000, retries = 3, baseDelay = 1_000 } = options ?? {};

  return async () => {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        // Race the import against a timeout so stalled connections reject
        const result = await Promise.race([
          factory(),
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error(`Chunk load timed out after ${timeout}ms`)),
              timeout,
            );
          }),
        ]);
        return result;
      } catch (error) {
        lastError = error as Error;
        if (attempt < retries) {
          const delay = baseDelay * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError ?? new Error('Chunk load failed after all retries');
  };
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Drop-in replacement for `React.lazy` that adds timeout + retry.
 *
 * Returns a LazyExoticComponent (same type as React.lazy) with an attached
 * `.preload()` method. This preserves full Suspense compatibility — React
 * sees a real lazy component and handles the thrown promise correctly.
 *
 * To retry after an error: change the `key` prop on the parent that renders
 * this component. That unmounts and remounts it, creating a fresh lazy
 * payload (the old one may hold a cached error).
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  options?: LazyWithRetryOptions,
): ComponentType<any> & { preload: () => Promise<void> } {
  const importWithRetry = createRetryableImport(factory, options);

  // Use React.lazy directly — this returns a LazyExoticComponent that
  // Suspense knows how to handle (it catches the thrown promise).
  const LazyComp = lazy(importWithRetry) as unknown as ComponentType<any> & {
    preload: () => Promise<void>;
  };

  // Fire-and-forget preload — errors are swallowed (will retry on actual render)
  LazyComp.preload = () =>
    importWithRetry().then(
      () => {},
      () => {},
    );

  return LazyComp;
}
