/**
 * MCA Manager — Health check sub-module
 *
 * HealthContext interface + checkHealth(), getHealth(), checkAllHealth(),
 * performInitialHealthCheck(), updateHealthFromWebSocket(), getCachedHealthIfNotReady().
 */

import type { HealthStatus, HealthIssue } from '@teros/shared';
import { captureException } from '../lib/sentry';
import { createLogger } from '../lib/logger';
import type { HealthCheckResult, ManagedMca, McaManagerConfig } from './mca-manager.types';
import { normalizeHealthStatus, isHealthReady } from './mca-manager.types';

const log = createLogger('McaManager');

export interface HealthContext {
  mcas: Map<string, ManagedMca>;
  config: Pick<Required<McaManagerConfig>, 'maxRestarts'>;
  getOrSpawn: (appId: string) => Promise<ManagedMca>;
  registerApp: (appId: string) => Promise<ManagedMca | null>;
  executeTool: (toolName: string, input: Record<string, any>, context?: any) => Promise<{ output: string; isError: boolean; mcaId: string; attachments?: Array<{ url: string; mime: string; filename?: string }> }>;
}

export async function checkHealth(ctx: HealthContext, appId: string, forceSpawn: boolean = true): Promise<HealthCheckResult> {
log.debug({ appId }, 'Checking health for app');

let managed = ctx.mcas.get(appId);

// If not registered, try to register it first
if (!managed) {
  const registered = await ctx.registerApp(appId);
  if (!registered) {
    return {
      status: 'unhealthy',
      message: `App not found: ${appId}`,
      checkedAt: new Date(),
    };
  }
  managed = registered;
}

// If disabled, return unhealthy
if (managed.status === 'disabled') {
  const result: HealthCheckResult = {
    status: 'unhealthy',
    message: 'MCA is disabled',
    checkedAt: new Date(),
  };
  managed.health = result;
  return result;
}

// If not ready and forceSpawn, try to spawn
if (managed.status !== 'ready' && forceSpawn) {
  try {
    await ctx.getOrSpawn(appId);
    managed = ctx.mcas.get(appId);
  } catch (error: any) {
    const result: HealthCheckResult = {
      status: 'unhealthy',
      message: `Failed to start MCA: ${error.message}`,
      details: {
        secretsConfigured: undefined,
        credentialsConfigured: undefined,
        credentialsError: error.message,
      },
      checkedAt: new Date(),
    };
    if (managed) {
      managed.health = result;
    }
    return result;
  }
}

// If still not ready after spawn attempt
if (!managed || managed.status !== 'ready' || !managed.client) {
  const result: HealthCheckResult = {
    status: 'unknown',
    message: `MCA not running (status: ${managed?.status || 'unknown'})`,
    checkedAt: new Date(),
  };
  if (managed) {
    managed.health = result;
  }
  return result;
}

// Check if MCA has _health_check tool
const hasHealthCheck =
  managed.toolNameMapping.has(`${managed.appName}__health-check`) ||
  Array.from(managed.toolNameMapping.values()).includes('_health_check');

if (!hasHealthCheck) {
  // No health check tool - infer from MCA status
  const result: HealthCheckResult = {
    status: managed.status === 'ready' ? 'healthy' : 'unknown',
    message:
      managed.status === 'ready'
        ? 'MCA is running (no health check tool available)'
        : `MCA status: ${managed.status}`,
    checkedAt: new Date(),
  };
  managed.health = result;
  return result;
}

// Call the health check tool
try {
  const toolResult = await managed.client.callTool({
    name: '_health_check',
    arguments: {},
  });

  // Parse result
  const content = toolResult.content as Array<{ type: string; text?: string }>;
  let healthData: any = {};

  for (const item of content) {
    if (item.type === 'text' && item.text) {
      try {
        healthData = JSON.parse(item.text);
      } catch {
        healthData = { message: item.text };
      }
    }
  }

  const result: HealthCheckResult = {
    status: toolResult.isError ? 'not_ready' : healthData.status || 'ready',
    message: healthData.message,
    issues: healthData.issues, // New format
    details: healthData.details, // Old format
    version: healthData.version,
    uptime: healthData.uptime,
    checkedAt: new Date(),
  };

  managed.health = result;
  log.debug({ appId, status: result.status }, 'Health check result');
  return result;
} catch (error: any) {
  const result: HealthCheckResult = {
    status: 'not_ready',
    message: `Health check failed: ${error.message}`,
    checkedAt: new Date(),
  };
  managed.health = result;
  return result;
}
}

export function getHealth(ctx: HealthContext, appId: string): HealthCheckResult | undefined {
return ctx.mcas.get(appId)?.health;
}

export async function checkAllHealth(ctx: HealthContext, forceSpawn: boolean = false): Promise<Map<string, HealthCheckResult>> {
const results = new Map<string, HealthCheckResult>();

for (const appId of ctx.mcas.keys()) {
  const result = await checkHealth(ctx, appId, forceSpawn);
  results.set(appId, result);
}

return results;
}

export async function performInitialHealthCheck(ctx: HealthContext, appId: string): Promise<void> {
const managed = ctx.mcas.get(appId);
if (!managed || managed.status !== 'ready') return;

// Check if MCA has _health_check tool
const hasHealthCheck =
  managed.toolNameMapping.has(`${managed.appName}__health-check`) ||
  Array.from(managed.toolNameMapping.values()).includes('_health_check');

if (!hasHealthCheck) {
  // No health check tool - assume ready
  managed.health = {
    status: 'ready',
    message: 'MCA is running (no health check tool)',
    checkedAt: new Date(),
  };
  return;
}

// Perform health check
try {
  await checkHealth(ctx, appId, false);
  log.debug({ appId }, 'McaManager operation');
} catch (error: any) {
  log.warn({ err: error, appId }, 'Initial health check failed');
}
}

export function updateHealthFromWebSocket(ctx: HealthContext, appId: string, status: HealthStatus, issues?: HealthIssue[]): void {
const managed = ctx.mcas.get(appId);
if (!managed) {
  log.warn({ appId }, 'Cannot update health for unknown appId');
  return;
}

managed.health = {
  status,
  issues,
  message: issues?.[0]?.message,
  checkedAt: new Date(),
};

log.debug({ appId, status }, 'Health updated via WebSocket');
}

export function getCachedHealthIfNotReady(ctx: HealthContext, appId: string): HealthCheckResult | null {
const managed = ctx.mcas.get(appId);
if (!managed) return null;

// If no health info, assume ready
if (!managed.health) return null;

// Check if ready
if (isHealthReady(managed.health)) return null;

// Not ready - return the cached health result
return managed.health;
}
