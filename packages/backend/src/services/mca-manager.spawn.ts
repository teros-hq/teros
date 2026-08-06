/**
 * MCA Manager — Spawn sub-module
 *
 * SpawnContext interface + spawn(), setupWatchdog(), waitForReady().
 * spawnContainer/spawnStdio/buildExecutionConfig live in mca-manager.spawn-impl.ts.
 */

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { captureException } from '../lib/sentry';
import { createLogger } from '../lib/logger';
import type { McaContainerManager } from './mca-container-manager';
import type { McaHttpClient } from './mca-http-client';
import type { McaService } from './mca-service';
import type { McaConnectionManager } from './mca-connection-manager';
import type { ManagedMca, McaManagerConfig } from './mca-manager.types';
import { spawnContainer, spawnStdio } from './mca-manager.spawn-impl';

const log = createLogger('McaManager');

export interface SpawnContext {
  mcas: Map<string, ManagedMca>;
  mcaService: McaService;
  containerManager: McaContainerManager;
  httpClients: Map<string, McaHttpClient>;
  connectionManager: McaConnectionManager | undefined;
  isShuttingDown: boolean;
  containerBackendHost: string;
  containerMongoHost: string;
  config: Required<Omit<McaManagerConfig, 'secretsManager' | 'authManager' | 'volumeService'>> &
    Pick<McaManagerConfig, 'secretsManager' | 'authManager' | 'volumeService'>;
  setupStderrLogging: (appId: string, appName: string, mcaId: string, transport: StdioClientTransport) => void;
  toEnvKey: (prefix: 'SECRET_MCA' | 'SECRET_USER', key: string) => string;
  performInitialHealthCheck: (appId: string) => Promise<void>;
}

export async function spawn(ctx: SpawnContext, appId: string, restartCount: number): Promise<ManagedMca> {
log.info({ appId, restartCount }, 'Spawning MCA');

// Get app and MCA catalog info
const app = await ctx.mcaService.getApp(appId);
if (!app) {
  throw new Error(`App not found: ${appId}`);
}

const mca = await ctx.mcaService.getMcaFromCatalog(app.mcaId);
if (!mca) {
  throw new Error(`MCA not found in catalog: ${app.mcaId}`);
}

// Check if this MCA should run in a container
if (mca.runtime?.transport === 'http') {
  return spawnContainer(ctx, appId, app, mca, restartCount);
}

// Otherwise, spawn as stdio process (legacy mode)
return spawnStdio(ctx, appId, app, mca, restartCount);
}

export function setupWatchdog(ctx: SpawnContext, appId: string, transport: StdioClientTransport): void {
// The transport emits 'close' when the process exits
transport.onclose = () => {
  if (ctx.isShuttingDown) return;

  const managed = ctx.mcas.get(appId);
  if (!managed) return; // Already cleaned up

  // If status is 'stopping', this is an intentional cleanup (idle timeout)
  // Don't count as a crash - just put back to standby for lazy restart
  if (managed.status === 'stopping') {
    log.debug({ appId }, 'McaManager operation');
    managed.status = 'standby';
    managed.restartCount = 0; // Reset restart count for clean shutdowns
    managed.client = null;
    managed.process = undefined;
    return;
  }

  log.warn({ appId }, 'MCA process died');
  managed.status = 'error';
  managed.lastError = 'Process exited unexpectedly';

  // Auto-restart if under limit
  if (managed.restartCount < ctx.config.maxRestarts) {
    log.debug({ appId }, 'McaManager operation');
    spawn(ctx, appId, managed.restartCount + 1).catch((err) => {
      log.error({ err, appId }, 'Failed to restart MCA');
    });
  } else {
    log.error({ appId, maxRestarts: ctx.config.maxRestarts }, 'MCA exceeded max restarts');
  }
};
}

export async function waitForReady(ctx: SpawnContext, appId: string, timeoutMs: number = 30000): Promise<ManagedMca> {
const startTime = Date.now();

while (Date.now() - startTime < timeoutMs) {
  const managed = ctx.mcas.get(appId);
  if (!managed) {
    throw new Error(`MCA disappeared while waiting: ${appId}`);
  }

  if (managed.status === 'ready') {
    managed.lastUsed = new Date();
    return managed;
  }

  if (managed.status === 'error') {
    throw new Error(`MCA failed to start: ${appId} - ${managed.lastError}`);
  }

  // Wait a bit before checking again
  await new Promise((resolve) => setTimeout(resolve, 100));
}

throw new Error(`Timeout waiting for MCA to start: ${appId}`);
}
