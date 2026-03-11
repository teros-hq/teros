/**
 * Sentry Error Tracking for React Native/Expo
 *
 * Centralized Sentry configuration for the mobile/web app.
 */

import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';

let initialized = false;

/**
 * Initialize Sentry error tracking
 * Should be called as early as possible in the app lifecycle
 */
export function initSentry(): void {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

  if (!dsn) {
    console.log('[Sentry] No DSN configured, error tracking disabled');
    return;
  }

  if (initialized) {
    console.log('[Sentry] Already initialized');
    return;
  }

  const isProduction = process.env.NODE_ENV === 'production';

  Sentry.init({
    dsn,
    environment: isProduction ? 'production' : 'development',
    release: Constants.expoConfig?.version || '1.0.0',

    // Enable debug in development
    debug: !isProduction,

    // Performance monitoring - lower in dev to reduce noise
    tracesSampleRate: isProduction ? 0.2 : 0.1,

    // Don't send events in development unless explicitly enabled
    enabled: isProduction || !!process.env.EXPO_PUBLIC_SENTRY_DEV_ENABLED,

    // Filter out noisy errors
    ignoreErrors: [
      // Network errors that are expected
      'Network request failed',
      'Failed to fetch',
      'NetworkError',
      // WebSocket close events
      'WebSocket is not open',
      'WebSocket closed',
    ],

    beforeSend(event) {
      // In development, just log instead of sending
      if (!isProduction && !process.env.EXPO_PUBLIC_SENTRY_DEV_ENABLED) {
        console.log(
          '[Sentry] Would send event:',
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
    isProduction ? 'production' : 'development',
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
 * Add breadcrumb for debugging
 */
export function addBreadcrumb(breadcrumb: Sentry.Breadcrumb): void {
  Sentry.addBreadcrumb(breadcrumb);
}

/**
 * Check if Sentry is initialized
 */
export function isInitialized(): boolean {
  return initialized;
}

// Re-export Sentry for advanced usage (e.g., ErrorBoundary)
export { Sentry };
