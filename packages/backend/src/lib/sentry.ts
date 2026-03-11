/**
 * Sentry Error Tracking
 *
 * Centralized Sentry configuration for the backend.
 * Captures unhandled exceptions, unhandled rejections, and manual error reports.
 */

import * as Sentry from '@sentry/node';

let initialized = false;

export interface SentryConfig {
  dsn?: string;
  environment?: string;
  release?: string;
  debug?: boolean;
}

/**
 * Initialize Sentry error tracking
 */
export function initSentry(config?: SentryConfig): void {
  const dsn = config?.dsn || process.env.SENTRY_DSN;

  if (!dsn) {
    console.log('[Sentry] No DSN configured, error tracking disabled');
    return;
  }

  if (initialized) {
    console.log('[Sentry] Already initialized');
    return;
  }

  Sentry.init({
    dsn,
    environment: config?.environment || process.env.NODE_ENV || 'development',
    release: config?.release || process.env.npm_package_version,
    debug: config?.debug || false,

    // Performance monitoring
    tracesSampleRate: 0.1, // 10% of transactions

    // Filter out noisy errors
    ignoreErrors: [
      // Network errors that are expected
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      // WebSocket close events
      'WebSocket is not open',
    ],

    // Add context to all events
    beforeSend(event, hint) {
      // Don't send in development unless explicitly enabled
      if (process.env.NODE_ENV === 'development' && !process.env.SENTRY_DEV_ENABLED) {
        console.log(
          '[Sentry] Would send event (dev mode):',
          event.message || event.exception?.values?.[0]?.value,
        );
        return null;
      }
      return event;
    },
  });

  initialized = true;
  console.log(
    '[Sentry] Initialized with environment:',
    config?.environment || process.env.NODE_ENV || 'development',
  );
}

/**
 * Capture an exception manually
 */
export function captureException(
  error: Error | unknown,
  context?: Record<string, any>,
): string | undefined {
  if (!initialized) {
    console.error('[Sentry] Not initialized, logging error:', error);
    return undefined;
  }

  return Sentry.captureException(error, {
    extra: context,
  });
}

/**
 * Capture a message (for non-error events)
 */
export function captureMessage(
  message: string,
  level: Sentry.SeverityLevel = 'info',
  context?: Record<string, any>,
): string | undefined {
  if (!initialized) {
    console.log('[Sentry] Not initialized, logging message:', message);
    return undefined;
  }

  return Sentry.captureMessage(message, {
    level,
    extra: context,
  });
}

/**
 * Set user context for all subsequent events
 */
export function setUser(user: { id: string; email?: string; username?: string } | null): void {
  Sentry.setUser(user);
}

/**
 * Set custom tags for all subsequent events
 */
export function setTag(key: string, value: string): void {
  Sentry.setTag(key, value);
}

/**
 * Set extra context for all subsequent events
 */
export function setExtra(key: string, value: any): void {
  Sentry.setExtra(key, value);
}

/**
 * Create a new scope for isolated context
 */
export function withScope(callback: (scope: Sentry.Scope) => void): void {
  Sentry.withScope(callback);
}

/**
 * Flush pending events (call before process exit)
 */
export async function flush(timeout: number = 2000): Promise<boolean> {
  return Sentry.flush(timeout);
}

/**
 * Check if Sentry is initialized
 */
export function isInitialized(): boolean {
  return initialized;
}

// Re-export Sentry for advanced usage
export { Sentry };
