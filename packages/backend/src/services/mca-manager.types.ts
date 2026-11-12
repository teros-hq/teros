/**
 * MCA Manager — Types and shared helpers
 *
 * Interfaces, type aliases, and pure helper functions used by McaManager
 * and its sub-modules.
 */

import type { HealthIssue, HealthStatus, McaToolAnnotations } from '@teros/shared';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ChildProcess } from 'child_process';
import { captureMessage } from '../lib/sentry';
import { createLogger } from '../lib/logger';
import type { AuthManager } from '../auth/auth-manager';
import type { SecretsManager } from '../secrets/secrets-manager';
import type { VolumeService } from './volume-service';

const log = createLogger('McaManager');

export const MAX_TOOL_OUTPUT_CHARS = 200_000;

/**
 * Truncate tool output if it exceeds the maximum allowed characters.
 *
 * `skipTruncation` is set by the UI path (`app.execute-tool`): windows fetch
 * data directly (no LLM context involved), so the 200K LLM-context guard must
 * not cut a large JSON payload in half — a truncated payload cannot be parsed
 * and the window silently renders an empty tree (2026-10-24 incident).
 */
export function truncateToolOutput(
  output: string,
  toolName: string,
  appId: string,
  skipTruncation = false,
): string {
  if (skipTruncation || output.length <= MAX_TOOL_OUTPUT_CHARS) {
    return output;
  }
  const originalLength = output.length;
  const truncatedOutput =
    output.slice(0, MAX_TOOL_OUTPUT_CHARS) +
    `\n\n[... OUTPUT TRUNCATED BY SYSTEM: ${originalLength.toLocaleString()} chars exceeded ${MAX_TOOL_OUTPUT_CHARS.toLocaleString()} char limit ...]`;
  captureMessage('Tool output truncated', 'warning', {
    toolName, appId, originalLength, truncatedLength: truncatedOutput.length, limit: MAX_TOOL_OUTPUT_CHARS,
  });
  log.warn({ toolName, originalLength, maxLength: MAX_TOOL_OUTPUT_CHARS }, 'Tool output truncated');
  return truncatedOutput;
}

/**
 * Static tool definition from tools.json
 */
export interface StaticToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, any>; required?: string[] };
  /**
   * Optional annotations propagated to the frontend (Renderer UX Guide v2 §8).
   * Validated against `McaToolAnnotationsSchema` at manifest load time —
   * see `loadStaticTools` in `mca-manager.tools.ts`.
   */
  annotations?: McaToolAnnotations;
}

/**
 * tools.json file format
 */
export interface ToolsJsonFile {
  $schema: string;
  mcaId: string;
  tools: StaticToolDefinition[];
}

/**
 * Tool definition (matches core's ToolDefinition + Teros-specific
 * annotations propagated from manifests).
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, any>; required?: string[] };
  /**
   * Annotations propagated from `manifest.tools[i].annotations`. Validated
   * against `McaToolAnnotationsSchema` at manifest load time. Read by the
   * executor to surface the irreversibility flag in the permission flow
   * (Renderer UX Guide v2 §8).
   */
  annotations?: McaToolAnnotations;
}

/**
 * MCA Status
 */
export type McaStatus = 'starting' | 'ready' | 'standby' | 'error' | 'disabled' | 'stopping';

export interface ExecutionConfig {
  command: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
}

/**
 * Health check result from an MCA
 */
export interface HealthCheckResult {
  status: HealthStatus | 'healthy' | 'unhealthy' | 'unknown';
  message?: string;
  issues?: HealthIssue[];
  details?: {
    secretsConfigured?: boolean;
    credentialsConfigured?: boolean;
    credentialsValid?: boolean;
    credentialsError?: string;
    connectivityOk?: boolean;
    [key: string]: any;
  };
  version?: string;
  uptime?: number;
  checkedAt: Date;
}

/**
 * Normalize health status to the new format
 */
export function normalizeHealthStatus(status: string): HealthStatus {
  switch (status) {
    case 'ready': case 'healthy': return 'ready';
    case 'not_ready': case 'unhealthy': return 'not_ready';
    case 'degraded': return 'degraded';
    default: return 'not_ready';
  }
}

/**
 * Check if health result indicates the MCA is ready to execute tools
 */
export function isHealthReady(health: HealthCheckResult | undefined): boolean {
  if (!health) return true;
  const normalizedStatus = normalizeHealthStatus(health.status);
  return normalizedStatus === 'ready' || normalizedStatus === 'degraded';
}

/**
 * Managed MCA instance (internal state)
 */
export interface ManagedMca {
  appId: string;
  mcaId: string;
  appName: string;
  client: Client | null;
  transport: StdioClientTransport | null;
  process?: ChildProcess;
  tools: ToolDefinition[];
  toolNameMapping: Map<string, string>;
  status: McaStatus;
  lastUsed: Date;
  lastError?: string;
  restartCount: number;
  health?: HealthCheckResult;
  containerKey?: string;
  /** Timestamp of the last transition to 'error' — used for adaptive backoff. */
  errorAt?: Date;
}

/**
 * Next restartCount to pass to spawn() when (re)starting an MCA.
 *
 * A retry of an MCA already in 'error' counts as a restart attempt → +1. Without
 * this, container MCAs (no watchdog to bump restartCount, unlike stdio) keep it at
 * 0 forever, so the `restartCount >= maxRestarts` guard never trips and a failing
 * MCA gets re-spawned on every call (infinite loop). TER-559.
 */
export function computeNextRestartCount(
  existing: Pick<ManagedMca, 'status' | 'restartCount'> | undefined,
): number {
  if (existing?.status === 'error') return (existing.restartCount ?? 0) + 1;
  return existing?.restartCount ?? 0;
}

/**
 * Adaptive backoff schedule for MCAs in 'error' state.
 *
 * Instead of permanently blocking after maxRestarts failures, the MCA enters a
 * cooldown period that grows with each consecutive failure. Once the cooldown
 * elapses, the next getOrSpawn() call is allowed to retry. This lets transient
 * errors (network blips, temporary credential issues) self-heal without manual
 * intervention, while still protecting against rapid infinite respawn loops.
 *
 * Schedule (by restartCount at the time of the error):
 *   0 → 60s     (first failure, short retry)
 *   1 → 60s     (second failure, still short)
 *   2 → 3min    (third failure, backing off)
 *   3 → 5min    (fourth failure, significant backoff)
 *   4+ → 15min  (permanent cap — keeps trying but slowly)
 */
const ERROR_BACKOFF_MS = [
  60_000,       // restartCount 0 → 60s
  60_000,       // restartCount 1 → 60s
  3 * 60_000,   // restartCount 2 → 3min
  5 * 60_000,   // restartCount 3 → 5min
  15 * 60_000,  // restartCount 4+ → 15min (permanent cap)
];

export function getErrorBackoffMs(restartCount: number): number {
  const idx = Math.min(restartCount, ERROR_BACKOFF_MS.length - 1);
  return ERROR_BACKOFF_MS[idx];
}

/**
 * Check whether an MCA in 'error' state has waited long enough to retry.
 *
 * Returns { canRetry, remainingMs } where:
 * - canRetry = true if the cooldown has elapsed (or errorAt is missing)
 * - remainingMs = milliseconds until the next retry is allowed (0 if canRetry)
 */
export function checkErrorCooldown(
  existing: Pick<ManagedMca, 'status' | 'restartCount' | 'errorAt'> | undefined,
  now: Date = new Date(),
): { canRetry: boolean; remainingMs: number; cooldownMs: number } {
  if (!existing || existing.status !== 'error') {
    return { canRetry: true, remainingMs: 0, cooldownMs: 0 };
  }

  const cooldownMs = getErrorBackoffMs(existing.restartCount ?? 0);

  // No errorAt recorded — allow retry (legacy entries without the field)
  if (!existing.errorAt) {
    return { canRetry: true, remainingMs: 0, cooldownMs };
  }

  const elapsed = now.getTime() - existing.errorAt.getTime();
  const remainingMs = cooldownMs - elapsed;

  if (remainingMs <= 0) {
    return { canRetry: true, remainingMs: 0, cooldownMs };
  }

  return { canRetry: false, remainingMs, cooldownMs };
}

/**
 * MCA Manager configuration
 */
export interface McaManagerConfig {
  /** Base path where MCAs are installed (e.g., '/path/to/mcas') */
  mcaBasePath: string;
  /** SecretsManager for loading system secrets */
  secretsManager?: SecretsManager;
  /** AuthManager for loading user credentials */
  authManager?: AuthManager;
  /** VolumeService for resolving volume mounts */
  volumeService?: VolumeService;
  /** Max idle time before cleanup (default: 30 minutes) */
  maxIdleMs?: number;
  /** Max restart attempts before giving up (default: 3) */
  maxRestarts?: number;
  /** Cleanup interval (default: 5 minutes) */
  cleanupIntervalMs?: number;
  /** Server port for WebSocket URL generation */
  serverPort?: number;
  /** Directory for MCA logs (default: <mcaBasePath>/../logs/mcas) */
  logDir?: string;
  /** Enable file logging for MCAs (default: true) */
  enableMcaLogs?: boolean;
}

export type { HealthIssue, HealthStatus };
