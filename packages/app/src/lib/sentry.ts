/**
 * Sentry Error Tracking for React Native/Expo
 *
 * Centralized Sentry configuration for the mobile/web app.
 *
 * The SDK (~1 MB minified) is NOT in the entry bundle: `initSentry()` schedules a
 * dynamic import for when the browser is idle after the first screen, and every
 * call made before the SDK arrives is queued and replayed. Errors thrown while it
 * loads are caught by two tiny window listeners and replayed too. Without a DSN
 * the SDK is never fetched.
 *
 * @spec LOADP-REQ-3
 */

import Constants from 'expo-constants';
import type * as SentryNamespace from '@sentry/react-native';

type Sdk = typeof SentryNamespace;
type SeverityLevel = SentryNamespace.SeverityLevel;
type Breadcrumb = SentryNamespace.Breadcrumb;

const MAX_QUEUE = 50;

let sdk: Sdk | null = null;
let started = false;
let initialized = false;
const queue: Array<(s: Sdk) => void> = [];

function hasDsn(): boolean {
  return !!process.env.EXPO_PUBLIC_SENTRY_DSN;
}

/** Run now when the SDK is loaded, otherwise once it is (bounded queue, oldest dropped). */
function whenReady<T>(fn: (s: Sdk) => T): T | undefined {
  if (sdk) return fn(sdk);
  queue.push(fn as (s: Sdk) => void);
  if (queue.length > MAX_QUEUE) queue.shift();
  return undefined;
}

function init(s: Sdk, dsn: string): void {
  const isProduction = process.env.NODE_ENV === 'production';

  s.init({
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
  console.log('[Sentry] Initialized with environment:', isProduction ? 'production' : 'development');
}

/** Web: capture what throws before the SDK is here; the SDK's own handlers take over after. */
function listenEarly(): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
  const onError = (e: ErrorEvent) => whenReady((s) => s.captureException(e.error ?? e.message));
  const onRejection = (e: PromiseRejectionEvent) => whenReady((s) => s.captureException(e.reason));
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}

function whenIdle(fn: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
    .requestIdleCallback;
  if (ric) ric(fn, { timeout: 4000 });
  else setTimeout(fn, 1500);
}

/**
 * Start error tracking. Call as early as possible; the SDK itself loads when the
 * browser is idle (LOADP-REQ-3).
 */
export function initSentry(): void {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

  if (!dsn) {
    console.log('[Sentry] No DSN configured, error tracking disabled');
    return;
  }

  if (started) {
    console.log('[Sentry] Already initialized');
    return;
  }
  started = true;

  const stopEarly = listenEarly();
  whenIdle(() => {
    import('@sentry/react-native')
      .then((loaded) => {
        sdk = loaded;
        stopEarly();
        init(loaded, dsn);
        for (const fn of queue.splice(0)) fn(loaded);
      })
      .catch((err) => console.warn('[Sentry] SDK failed to load, error tracking off:', err));
  });
}

/**
 * Capture an exception manually
 */
export function captureException(
  error: Error | unknown,
  context?: Record<string, any>,
): string | undefined {
  if (!hasDsn()) {
    console.error('[Sentry] Not initialized, logging error:', error);
    return undefined;
  }

  return whenReady((s) => s.captureException(error, { extra: context }));
}

/**
 * Capture a message (for non-error events)
 */
export function captureMessage(
  message: string,
  level: SeverityLevel = 'info',
  context?: Record<string, any>,
  tags?: Record<string, string>,
): string | undefined {
  if (!hasDsn()) {
    console.log('[Sentry] Not initialized, logging message:', message);
    return undefined;
  }

  return whenReady((s) => s.captureMessage(message, { level, extra: context, tags }));
}

/**
 * Set user context for all subsequent events
 */
export function setUser(user: { id: string; email?: string; username?: string } | null): void {
  if (!hasDsn()) return;
  whenReady((s) => s.setUser(user));
}

/**
 * Set custom tags for all subsequent events
 */
export function setTag(key: string, value: string): void {
  if (!hasDsn()) return;
  whenReady((s) => s.setTag(key, value));
}

/**
 * Add breadcrumb for debugging
 */
export function addBreadcrumb(breadcrumb: Breadcrumb): void {
  if (!hasDsn()) return;
  whenReady((s) => s.addBreadcrumb(breadcrumb));
}

/**
 * Check if Sentry is initialized
 */
export function isInitialized(): boolean {
  return initialized;
}
