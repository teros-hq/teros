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
 * Teros identity attached to an error so it can be filtered/grouped in Sentry.
 *
 * `userId` becomes the Sentry `user` (the "users affected" count); the rest become
 * indexed tags. Applied PER EVENT via an isolation/current scope fork — never on
 * the global scope — so concurrent requests do not leak context into each other.
 * Teros runs a raw WS/HTTP server with no per-request isolation middleware, so
 * `Sentry.setUser()` at module scope WOULD bleed across concurrent connections.
 */
export interface SentryIdentity {
  userId?: string;
  workspaceId?: string;
  agentId?: string;
  channelId?: string;
  mcaId?: string;
  appId?: string;
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
 * Apply a Teros identity onto a Sentry scope. Only present fields are written —
 * `undefined` is never set so it cannot overwrite context inherited from an
 * outer scope (e.g. the per-request isolation scope).
 */
function applyIdentity(scope: Sentry.Scope, identity: SentryIdentity): void {
  if (identity.userId) scope.setUser({ id: identity.userId });
  if (identity.workspaceId) scope.setTag('workspace_id', identity.workspaceId);
  if (identity.agentId) scope.setTag('agent_id', identity.agentId);
  if (identity.channelId) scope.setTag('channel_id', identity.channelId);
  if (identity.mcaId) scope.setTag('mca_id', identity.mcaId);
  if (identity.appId) scope.setTag('app_id', identity.appId);
}

/** Whether an identity carries at least one field worth a scope fork. */
function hasIdentity(identity: SentryIdentity): boolean {
  return Boolean(
    identity.userId ||
      identity.workspaceId ||
      identity.agentId ||
      identity.channelId ||
      identity.mcaId ||
      identity.appId,
  );
}

/**
 * Capture an exception manually.
 *
 * @param context — free-form extra data (not indexed), kept under Sentry `extra`.
 * @param identity — optional Teros identity. When present, the capture runs inside
 *   a forked current scope (`withScope`) so the user/tags apply to THIS event only
 *   and never bleed onto concurrent captures. Use it at call sites that run detached
 *   from a per-request isolation scope (background workers, the agent turn, the
 *   permission closure). Inside a `runWithRequestContext` the identity is already on
 *   the isolation scope and this third argument is optional.
 */
export function captureException(
  error: Error | unknown,
  context?: Record<string, any>,
  identity?: SentryIdentity,
): string | undefined {
  if (!initialized) {
    console.error('[Sentry] Not initialized, logging error:', error);
    return undefined;
  }

  if (identity && hasIdentity(identity)) {
    return Sentry.withScope((scope) => {
      applyIdentity(scope, identity);
      return Sentry.captureException(error, { extra: context });
    });
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
 * Run `fn` inside a fresh ISOLATION scope carrying the given Teros identity.
 *
 * This is the request-isolation pattern Sentry recommends for servers without a
 * framework integration (Teros is raw WS/HTTP). Every error captured during `fn`
 * — manual or automatic — inherits the user/tags, and two concurrent units of
 * work (e.g. WS messages from two different users) get fully independent scopes,
 * so one user's identity never leaks onto the other's errors.
 *
 * Works for sync and async `fn`: the isolation scope propagates across `await`
 * boundaries via the SDK's AsyncLocalStorage context. When Sentry is not
 * initialized this is a transparent passthrough that just runs `fn`.
 */
export function runWithRequestContext<T>(identity: SentryIdentity, fn: () => T): T {
  if (!initialized) {
    return fn();
  }

  return Sentry.withIsolationScope((scope) => {
    applyIdentity(scope, identity);
    return fn();
  });
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
