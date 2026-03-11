/**
 * Health Check Helpers for MCAs
 *
 * Provides a builder pattern for constructing health check results
 * with standardized issue codes and actions.
 */

import type {
  HealthAction,
  HealthActionType,
  HealthCheckResult,
  HealthIssue,
  HealthIssueCode,
  HealthStatus,
} from '@teros/shared';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Secrets context for health checks
 *
 * MCAs should pass their cached secrets to the builder so it can
 * check if required secrets are available.
 */
export interface SecretsContext {
  /** System secrets (from backend, configured by admins) */
  system?: Record<string, string> | null;
  /** User secrets (from backend, configured by users) */
  user?: Record<string, string> | null;
}

// ============================================================================
// HEALTH CHECK BUILDER
// ============================================================================

/**
 * Builder for constructing health check results
 *
 * @example
 * ```typescript
 * // Pass cached secrets to the builder
 * const health = new HealthCheckBuilder({
 *   system: cachedSystemSecrets,
 *   user: cachedUserSecrets,
 * })
 *   .setVersion('1.0.0')
 *   .requireSystemSecret('CLIENT_ID')
 *   .requireUserSecret('ACCESS_TOKEN', {
 *     description: 'Connect your Google account',
 *     url: `${process.env.MCA_BACKEND_URL}/auth/connect`
 *   })
 *   .build();
 * ```
 */
export class HealthCheckBuilder {
  private issues: HealthIssue[] = [];
  private version?: string;
  private uptime?: number;
  private startTime: number;
  private secrets: SecretsContext;

  constructor(secrets?: SecretsContext) {
    this.startTime = Date.now();
    this.secrets = secrets || {};
  }

  /**
   * Set the MCA version
   */
  setVersion(version: string): this {
    this.version = version;
    return this;
  }

  /**
   * Set the MCA uptime in seconds
   */
  setUptime(seconds: number): this {
    this.uptime = seconds;
    return this;
  }

  /**
   * Add a health issue
   */
  addIssue(code: HealthIssueCode, message: string, action?: HealthAction): this {
    this.issues.push({ code, message, action });
    return this;
  }

  /**
   * Add issue if condition is true
   */
  addIssueIf(
    condition: boolean,
    code: HealthIssueCode,
    message: string,
    action?: HealthAction,
  ): this {
    if (condition) {
      this.addIssue(code, message, action);
    }
    return this;
  }

  /**
   * Require an environment variable to exist
   */
  requireEnv(
    name: string,
    issueCode: HealthIssueCode,
    message: string,
    action?: HealthAction,
  ): this {
    if (!process.env[name]) {
      this.addIssue(issueCode, message, action);
    }
    return this;
  }

  /**
   * Check if a system secret exists
   */
  private hasSystemSecret(name: string): boolean {
    if (!this.secrets.system) return false;
    // Check both uppercase and original case
    return !!(
      this.secrets.system[name] ||
      this.secrets.system[name.toUpperCase()] ||
      this.secrets.system[name.toLowerCase()]
    );
  }

  /**
   * Check if a user secret exists
   */
  private hasUserSecret(name: string): boolean {
    if (!this.secrets.user) return false;
    // Check both uppercase and original case
    return !!(
      this.secrets.user[name] ||
      this.secrets.user[name.toUpperCase()] ||
      this.secrets.user[name.toLowerCase()]
    );
  }

  /**
   * Get a user secret value
   */
  private getUserSecret(name: string): string | undefined {
    if (!this.secrets.user) return undefined;
    return (
      this.secrets.user[name] ||
      this.secrets.user[name.toUpperCase()] ||
      this.secrets.user[name.toLowerCase()]
    );
  }

  /**
   * Require a system secret
   *
   * System secrets are configured by admins, not users.
   * They come from the backend via WebSocket (cachedSystemSecrets).
   */
  requireSystemSecret(name: string, customMessage?: string): this {
    const message = customMessage || `System configuration missing: ${name}`;

    if (!this.hasSystemSecret(name)) {
      this.addIssue('SYSTEM_CONFIG_MISSING', message, {
        type: 'admin_action',
        description: `Configure ${name} in MCA secrets`,
      });
    }
    return this;
  }

  /**
   * Require a user secret
   *
   * User secrets are configured by users (e.g., API keys, OAuth tokens).
   * They come from the backend via WebSocket (cachedUserSecrets).
   * If missing, provides an action URL for the user to configure.
   */
  requireUserSecret(name: string, action?: { description: string; url?: string }): this {
    if (!this.hasUserSecret(name)) {
      this.addIssue('AUTH_REQUIRED', `User authentication required`, {
        type: 'user_action',
        description: action?.description || 'Connect your account',
        url: action?.url,
      });
    }
    return this;
  }

  /**
   * Check OAuth tokens and add appropriate issues
   *
   * @param accessTokenName - Name of access token (e.g., 'ACCESS_TOKEN')
   * @param refreshTokenName - Name of refresh token (e.g., 'REFRESH_TOKEN')
   * @param connectUrl - URL for user to connect their account
   */
  checkOAuthTokens(accessTokenName: string, refreshTokenName: string, connectUrl?: string): this {
    const accessToken = this.getUserSecret(accessTokenName);
    const refreshToken = this.getUserSecret(refreshTokenName);

    if (!accessToken && !refreshToken) {
      this.addIssue('AUTH_REQUIRED', 'Account not connected', {
        type: 'user_action',
        description: 'Connect your account',
        url: connectUrl,
      });
    } else if (!accessToken && refreshToken) {
      // Has refresh token but no access token - might be expired
      this.addIssue('AUTH_EXPIRED', 'Access token expired, refresh required', {
        type: 'auto_retry',
        description: 'Token will be refreshed automatically',
      });
    }

    return this;
  }

  /**
   * Add a custom check function
   */
  check(fn: () => HealthIssue | null): this {
    const issue = fn();
    if (issue) {
      this.issues.push(issue);
    }
    return this;
  }

  /**
   * Add an async custom check function
   */
  async checkAsync(fn: () => Promise<HealthIssue | null>): Promise<this> {
    const issue = await fn();
    if (issue) {
      this.issues.push(issue);
    }
    return this;
  }

  /**
   * Build the health check result
   */
  build(): HealthCheckResult {
    // Determine status based on issues
    let status: HealthStatus = 'ready';

    if (this.issues.length > 0) {
      // Check if any issue is blocking (not auto_retry)
      const hasBlockingIssue = this.issues.some((issue) => issue.action?.type !== 'auto_retry');
      status = hasBlockingIssue ? 'not_ready' : 'degraded';
    }

    return {
      status,
      issues: this.issues.length > 0 ? this.issues : undefined,
      version: this.version,
      uptime: this.uptime,
    };
  }

  /**
   * Build and return as JSON string (for MCP tool response)
   */
  toJSON(): string {
    return JSON.stringify(this.build());
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Create a simple health result
 */
export function healthResult(status: HealthStatus, issues?: HealthIssue[]): HealthCheckResult {
  return {
    status,
    issues: issues && issues.length > 0 ? issues : undefined,
  };
}

/**
 * Create a health issue
 */
export function healthIssue(
  code: HealthIssueCode,
  message: string,
  action?: HealthAction,
): HealthIssue {
  return { code, message, action };
}

/**
 * Create a health action
 */
export function healthAction(
  type: HealthActionType,
  description: string,
  url?: string,
): HealthAction {
  return { type, description, url };
}

/**
 * Quick health check for ready status
 */
export function ready(version?: string): HealthCheckResult {
  return {
    status: 'ready',
    version,
  };
}

/**
 * Quick health check for not ready status
 */
export function notReady(issue: HealthIssue): HealthCheckResult {
  return {
    status: 'not_ready',
    issues: [issue],
  };
}

/**
 * Quick auth required response
 */
export function authRequired(connectUrl: string, description?: string): HealthCheckResult {
  return notReady({
    code: 'AUTH_REQUIRED',
    message: 'Account not connected',
    action: {
      type: 'user_action',
      description: description || 'Connect your account',
      url: connectUrl,
    },
  });
}

/**
 * Quick system config missing response
 */
export function systemConfigMissing(configName: string): HealthCheckResult {
  return notReady({
    code: 'SYSTEM_CONFIG_MISSING',
    message: `System configuration missing: ${configName}`,
    action: {
      type: 'admin_action',
      description: `Configure ${configName} in MCA secrets`,
    },
  });
}
