/**
 * Unit — regression: cached 'not_ready' health must not block wake-on-demand
 * in executeTool (bug found by Alice 2026-10-16 on RAW during FVU E2E).
 *
 * The deadlock chain (pre-fix):
 *   registerApp() → status 'standby', no health
 *   checkHealth(app, forceSpawn=false) → caches {status:'unknown'} on the entry
 *   executeTool() → getCachedHealthIfNotReady() → isHealthReady() normalizes
 *                   'unknown' → 'not_ready' → returns MCA_NOT_READY WITHOUT ever
 *                   calling getOrSpawn(). The MCA stays asleep forever.
 *
 * Fix: executeTool only honors cached not-ready health when the MCA is actually
 * running (status 'ready'). checkHealth no longer caches 'unknown' snapshots on
 * dormant MCAs, and no longer treats a ready container MCA (client:null, live
 * httpClient) as "not running".
 */

import { describe, expect, it, mock } from 'bun:test';
import { checkHealth } from '../../src/services/mca-manager.health';
import { executeTool, type ToolsContext } from '../../src/services/mca-manager.tools';
import type { ManagedMca } from '../../src/services/mca-manager.types';

function makeManaged(overrides: Partial<ManagedMca> = {}): ManagedMca {
  return {
    appId: 'app_x',
    mcaId: 'mca.test',
    appName: 'testapp',
    client: null,
    transport: null,
    tools: [],
    toolNameMapping: new Map([['testapp_read-file', 'read_file']]),
    status: 'ready',
    lastUsed: new Date(0),
    restartCount: 0,
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: fixture parcial
  } as any;
}

function makeCtx(overrides: Partial<ToolsContext> = {}): ToolsContext {
  return {
    mcas: new Map(),
    // biome-ignore lint/suspicious/noExplicitAny: fake mínimo
    mcaService: { getApp: mock(async () => null) } as any,
    // biome-ignore lint/suspicious/noExplicitAny: fake mínimo
    containerManager: { touch: mock(() => {}) } as any,
    httpClients: new Map(),
    staticToolsCache: new Map(),
    containerBackendHost: 'host.docker.internal',
    // biome-ignore lint/suspicious/noExplicitAny: config parcial requerida
    config: { mcaBasePath: '/tmp', serverPort: 10001 } as any,
    getOrSpawn: mock(async () => makeManaged()),
    registerApp: mock(async () => null),
    ...overrides,
  };
}

// ===========================================================================
// executeTool × cached health — the three acceptance cases
// ===========================================================================

describe('executeTool: cached health vs wake-on-demand', () => {
  it('standby SIN health → getOrSpawn y ejecuta la tool (wake on-demand)', async () => {
    const getOrSpawn = mock(async () => {
      // Simulate the spawn flipping the entry to ready (container path: httpClient)
      const spawned = makeManaged({ status: 'ready', client: null });
      ctx.mcas.set('app_x', spawned);
      // biome-ignore lint/suspicious/noExplicitAny: httpClient fake
      ctx.httpClients.set('app_x', { callTool: mock(async () => ({ success: true, result: 'ok' })) } as any);
      return spawned;
    });
    const ctx = makeCtx({ getOrSpawn });
    ctx.mcas.set('app_x', makeManaged({ status: 'standby' })); // registrado tras restart, sin health

    const result = await executeTool(ctx, 'testapp_read-file', {}, { appId: 'app_x' });
    expect(getOrSpawn).toHaveBeenCalledWith('app_x');
    expect(result.isError).toBe(false);
    expect(result.output).toBe('ok');
  });

  it('standby CON health unknown cacheado → NO bloquea: getOrSpawn y ejecuta (el deadlock original)', async () => {
    const getOrSpawn = mock(async () => {
      const spawned = makeManaged({ status: 'ready', client: null });
      ctx.mcas.set('app_x', spawned);
      // biome-ignore lint/suspicious/noExplicitAny: httpClient fake
      ctx.httpClients.set('app_x', { callTool: mock(async () => ({ success: true, result: 'ok' })) } as any);
      return spawned;
    });
    const ctx = makeCtx({ getOrSpawn });
    // Pre-fix reality: an earlier checkHealth(false) cached 'unknown' on the
    // dormant entry — exactly what admin-infra-mca-health did after a restart.
    ctx.mcas.set(
      'app_x',
      makeManaged({
        status: 'standby',
        health: { status: 'unknown', message: 'MCA not running (status: standby)', checkedAt: new Date() },
      }),
    );

    const result = await executeTool(ctx, 'testapp_read-file', {}, { appId: 'app_x' });
    expect(getOrSpawn).toHaveBeenCalledWith('app_x');
    expect(result.isError).toBe(false);
    expect(result.output).toBe('ok');
    expect(result.output).not.toContain('MCA_NOT_READY');
  });

  it('ready CON health not_ready → SÍ corta con MCA_NOT_READY (MCA corriendo pero enfermo)', async () => {
    const getOrSpawn = mock(async () => makeManaged());
    const ctx = makeCtx({ getOrSpawn });
    ctx.mcas.set(
      'app_x',
      makeManaged({
        status: 'ready',
        health: { status: 'not_ready', message: 'OAuth caducado', checkedAt: new Date() },
      }),
    );

    const result = await executeTool(ctx, 'testapp_read-file', {}, { appId: 'app_x' });
    expect(getOrSpawn).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toEqual({
      error: 'MCA_NOT_READY',
      message: 'OAuth caducado',
      status: 'not_ready',
      issues: undefined,
    });
  });

  it('error CON health not_ready cacheado → NO bloquea: reintenta spawn (cooldown lo decide getOrSpawn)', async () => {
    const getOrSpawn = mock(async () => {
      const spawned = makeManaged({ status: 'ready', client: null });
      ctx.mcas.set('app_x', spawned);
      // biome-ignore lint/suspicious/noExplicitAny: httpClient fake
      ctx.httpClients.set('app_x', { callTool: mock(async () => ({ success: true, result: 'ok' })) } as any);
      return spawned;
    });
    const ctx = makeCtx({ getOrSpawn });
    ctx.mcas.set(
      'app_x',
      makeManaged({
        status: 'error',
        health: { status: 'not_ready', message: 'Failed to start MCA: boom', checkedAt: new Date() },
      }),
    );

    const result = await executeTool(ctx, 'testapp_read-file', {}, { appId: 'app_x' });
    expect(getOrSpawn).toHaveBeenCalledWith('app_x');
    expect(result.isError).toBe(false);
  });
});

// ===========================================================================
// checkHealth — dormido ≠ enfermo
// ===========================================================================

describe('checkHealth: dormant MCAs are not poisoned', () => {
  function makeHealthCtx(overrides: Record<string, unknown> = {}) {
    return {
      mcas: new Map<string, ManagedMca>(),
      httpClients: new Map(),
      config: { maxRestarts: 3 },
      getOrSpawn: mock(async () => makeManaged()),
      registerApp: mock(async () => null),
      executeTool: mock(async () => ({ output: '', isError: false, mcaId: 'mca.test' })),
      ...overrides,
      // biome-ignore lint/suspicious/noExplicitAny: fixture parcial
    } as any;
  }

  it('standby SIN forceSpawn → devuelve unknown pero NO lo cachea en managed.health', async () => {
    const ctx = makeHealthCtx();
    const managed = makeManaged({ status: 'standby' });
    ctx.mcas.set('app_x', managed);

    const result = await checkHealth(ctx, 'app_x', false);
    expect(result.status).toBe('unknown');
    expect(result.message).toBe('MCA not running (status: standby)');
    // The poison vector is gone: nothing is cached on the dormant entry
    expect(managed.health).toBeUndefined();
  });

  it('ready (stdio, con client) SIN forceSpawn → healthy inferido y cacheado', async () => {
    const ctx = makeHealthCtx();
    const managed = makeManaged({
      // biome-ignore lint/suspicious/noExplicitAny: client MCP fake
      client: { callTool: mock(async () => ({ content: [] })) } as any,
    });
    ctx.mcas.set('app_x', managed);

    const result = await checkHealth(ctx, 'app_x', false);
    expect(result.status).toBe('healthy');
    expect(managed.health).toBe(result);
  });

  it('ready container MCA (client null + httpClient) → NO es "not running"; healthy inferido', async () => {
    const ctx = makeHealthCtx();
    const managed = makeManaged({ status: 'ready', client: null });
    ctx.mcas.set('app_x', managed);
    // biome-ignore lint/suspicious/noExplicitAny: httpClient fake
    ctx.httpClients.set('app_x', { callTool: mock(async () => ({ success: true })) } as any);

    const result = await checkHealth(ctx, 'app_x', false);
    expect(result.status).toBe('healthy');
    expect(result.message).toBe('MCA is running (no health check tool available)');
    expect(managed.health).toBe(result);
  });

  it('ready pero SIN client NI httpClient → unknown y SÍ cacheado (algo genuinamente raro)', async () => {
    const ctx = makeHealthCtx();
    const managed = makeManaged({ status: 'ready', client: null });
    ctx.mcas.set('app_x', managed);

    const result = await checkHealth(ctx, 'app_x', false);
    expect(result.status).toBe('unknown');
    expect(result.message).toBe('MCA not running (status: ready)');
    expect(managed.health).toBe(result);
  });
});
