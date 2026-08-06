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

export const MAX_TOOL_OUTPUT_CHARS = 40_000;

/**
 * Truncate tool output if it exceeds the maximum allowed characters.
 */
export function truncateToolOutput(output: string, toolName: string, appId: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) {
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
