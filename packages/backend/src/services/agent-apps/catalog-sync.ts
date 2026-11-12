/**
 * Agent Apps Adapter — Catalog Sync
 *
 * Discovers available apps from all stations and returns
 * structured data that the host platform can persist however it wants.
 *
 * This module does NOT access any database or host-specific service.
 * The caller is responsible for persisting the results.
 *
 * ZERO external dependencies.
 */

import type {
  DiscoveredApp,
  RawToolDefinition,
  Logger,
  AdapterEventHandler,
} from './types';
import { consoleLogger } from './types';
import type { StationRegistry } from './station-registry';
import * as protocol from './protocol-client';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CatalogSyncConfig {
  registry: StationRegistry;
  logger?: Logger;
  onEvent?: AdapterEventHandler;
  /** Timeout for each station discovery (ms, default: 30_000) */
  perStationTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover an app from a single station by opening a temporary
 * catalog-sync session, listing tools, and closing.
 */
async function discoverOne(
  stationId: string,
  stationUrl: string,
  token: string | undefined,
  timeoutMs: number,
  logger: Logger,
): Promise<DiscoveredApp | null> {
  try {
    // 1. Initialize (idempotent on the registry, but we call protocol directly here)
    const initResp = await protocol.initialize(
      stationUrl,
      { name: 'catalog-sync', version: '1.0.0' },
      { directConnection: false },
      token,
      { timeoutMs },
      logger,
    );

    if (initResp.type === 'error') {
      logger.warn('Station init failed during sync', { stationId });
      return null;
    }

    const appId = (initResp as any).app?.id ?? stationId;
    const appVersion = (initResp as any).app?.version ?? '0.0.0';
    const appName = appId.replace(/^app\./, '').replace(/\./g, '-');

    // 2. Open temporary session
    const sessionResp = await protocol.sessionOpen(
      stationUrl,
      `catalog-sync-${appId}`,
      { userId: 'system', workspaceId: 'system' },
      token,
      { timeoutMs },
      logger,
    );

    if (sessionResp.type === 'error') {
      logger.warn('Session open failed during sync', { stationId, appId });
      return null;
    }

    const sessionId = (sessionResp as any).sessionId as string;

    // 3. List tools
    const toolsResp = await protocol.listTools(
      stationUrl,
      sessionId,
      token,
      { timeoutMs },
      logger,
    );

    const tools: RawToolDefinition[] = ((toolsResp as any).tools ?? []).map(
      (t: any) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        annotations: t.annotations,
      }),
    );

    // 4. Close temporary session (best-effort)
    await protocol.sessionClose(
      stationUrl,
      sessionId,
      'catalog-sync-complete',
      token,
      { timeoutMs: 5_000 },
      logger,
    ).catch(() => {});

    logger.info('Discovered app', { stationId, appId, toolCount: tools.length });

    return {
      appId,
      name: appName,
      version: appVersion,
      tools,
      stationId,
      stationUrl,
    };
  } catch (error: any) {
    logger.error('Discovery failed for station', { stationId, error: error.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Full sync
// ---------------------------------------------------------------------------

export interface SyncResult {
  discovered: DiscoveredApp[];
  errors: Array<{ stationId: string; error: string }>;
}

/**
 * Discover apps from ALL registered stations.
 *
 * Returns raw data — the caller decides how to persist it.
 * This keeps the module completely decoupled from any database.
 */
export async function discoverAll(config: CatalogSyncConfig): Promise<SyncResult> {
  const { registry, logger = consoleLogger, onEvent } = config;
  const timeoutMs = config.perStationTimeoutMs ?? 30_000;

  const statuses = registry.getStatuses();
  const discovered: DiscoveredApp[] = [];
  const errors: Array<{ stationId: string; error: string }> = [];

  // Discover from all stations in parallel
  const promises = statuses.map(async (status) => {
    const stationInfo = registry.get(status.id);
    if (!stationInfo) return;

    try {
      const app = await discoverOne(
        status.id,
        status.url,
        stationInfo.token,
        timeoutMs,
        logger,
      );

      if (app) {
        discovered.push(app);
        onEvent?.({ type: 'catalog:synced', discovered: 1, stationId: status.id });
      } else {
        errors.push({ stationId: status.id, error: 'Discovery returned null' });
      }
    } catch (error: any) {
      errors.push({ stationId: status.id, error: error.message });
    }
  });

  await Promise.allSettled(promises);

  logger.info('Catalog sync complete', {
    discovered: discovered.length,
    errors: errors.length,
  });

  return { discovered, errors };
}
