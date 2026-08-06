/**
 * Unit — mca-manager.health: checkHealth / performInitialHealthCheck /
 * updateHealthFromWebSocket / normalizeHealthStatus / isHealthReady (TER-484).
 *
 * El health-check decide si executeTool corta con MCA_NOT_READY — un mapeo
 * mal normalizado deja un MCA sano bloqueado (o uno roto pasando).
 */

import { describe, expect, it, mock } from 'bun:test';
import {
  checkAllHealth,
  checkHealth,
  getCachedHealthIfNotReady,
  getHealth,
  type HealthContext,
  performInitialHealthCheck,
  updateHealthFromWebSocket,
} from '../../src/services/mca-manager.health';
import {
  isHealthReady,
  type ManagedMca,
  normalizeHealthStatus,
} from '../../src/services/mca-manager.types';

function makeManaged(overrides: Partial<ManagedMca> = {}): ManagedMca {
  return {
    appId: 'app_x',
    mcaId: 'mca.test',
    appName: 'testapp',
    client: null,
    transport: null,
    tools: [],
    toolNameMapping: new Map(),
    status: 'ready',
    lastUsed: new Date(0),
    restartCount: 0,
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: fixture parcial
  } as any;
}

function makeCtx(overrides: Partial<HealthContext> = {}): HealthContext {
  return {
    mcas: new Map(),
    config: { maxRestarts: 3 },
    getOrSpawn: mock(async () => makeManaged()),
    registerApp: mock(async () => null),
    executeTool: mock(async () => ({ output: '', isError: false, mcaId: 'mca.test' })),
    ...overrides,
  };
}

function withHealthTool(
  managed: ManagedMca,
  callToolImpl: () => Promise<unknown>,
): ManagedMca {
  managed.toolNameMapping.set('testapp__health-check', '_health_check');
  // biome-ignore lint/suspicious/noExplicitAny: client MCP fake
  (managed as any).client = { callTool: mock(callToolImpl) };
  return managed;
}

// ===========================================================================
// normalizeHealthStatus / isHealthReady (types)
// ===========================================================================

describe('normalizeHealthStatus / isHealthReady', () => {
  it.each([
    ['ready', 'ready'],
    ['healthy', 'ready'],
    ['not_ready', 'not_ready'],
    ['unhealthy', 'not_ready'],
    ['degraded', 'degraded'],
    ['unknown', 'not_ready'],
    ['', 'not_ready'],
    ['banana', 'not_ready'],
  ])('normaliza %p → %p (default fail-closed)', (input, expected) => {
    expect(normalizeHealthStatus(input)).toBe(expected as string);
  });

  it('isHealthReady: sin health → true; ready/degraded → true; resto → false', () => {
    expect(isHealthReady(undefined)).toBe(true);
    expect(isHealthReady({ status: 'ready', checkedAt: new Date() })).toBe(true);
    expect(isHealthReady({ status: 'healthy', checkedAt: new Date() })).toBe(true);
    expect(isHealthReady({ status: 'degraded', checkedAt: new Date() })).toBe(true);
    expect(isHealthReady({ status: 'not_ready', checkedAt: new Date() })).toBe(false);
    expect(isHealthReady({ status: 'unhealthy', checkedAt: new Date() })).toBe(false);
    // biome-ignore lint/suspicious/noExplicitAny: status fuera del union a propósito
    expect(isHealthReady({ status: 'unknown' as any, checkedAt: new Date() })).toBe(false);
  });
});

// ===========================================================================
// checkHealth
// ===========================================================================

describe('checkHealth', () => {
  it('app desconocida y registerApp null → unhealthy App not found', async () => {
    const ctx = makeCtx();
    const result = await checkHealth(ctx, 'app_nope');
    expect(result.status).toBe('unhealthy');
    expect(result.message).toBe('App not found: app_nope');
  });

  it('disabled → unhealthy y el resultado queda CACHEADO en managed.health', async () => {
    const ctx = makeCtx();
    const managed = makeManaged({ status: 'disabled' });
    ctx.mcas.set('app_x', managed);

    const result = await checkHealth(ctx, 'app_x');
    expect(result.status).toBe('unhealthy');
    expect(result.message).toBe('MCA is disabled');
    expect(managed.health).toBe(result);
  });

  it('not-ready + forceSpawn: getOrSpawn lanza → unhealthy con credentialsError', async () => {
    const ctx = makeCtx({
      getOrSpawn: mock(async () => {
        throw new Error('missing API key');
      }),
    });
    const managed = makeManaged({ status: 'standby' });
    ctx.mcas.set('app_x', managed);

    const result = await checkHealth(ctx, 'app_x', true);
    expect(result.status).toBe('unhealthy');
    expect(result.message).toBe('Failed to start MCA: missing API key');
    expect(result.details?.credentialsError).toBe('missing API key');
    expect(managed.health).toBe(result);
  });

  it('not-ready SIN forceSpawn → unknown sin intentar spawn', async () => {
    const getOrSpawn = mock(async () => makeManaged());
    const ctx = makeCtx({ getOrSpawn });
    ctx.mcas.set('app_x', makeManaged({ status: 'standby' }));

    const result = await checkHealth(ctx, 'app_x', false);
    expect(getOrSpawn).not.toHaveBeenCalled();
    expect(result.status).toBe('unknown');
    expect(result.message).toBe('MCA not running (status: standby)');
  });

  it('ready SIN _health_check → healthy inferido', async () => {
    const ctx = makeCtx();
    // biome-ignore lint/suspicious/noExplicitAny: client fake
    ctx.mcas.set('app_x', makeManaged({ client: {} as any }));

    const result = await checkHealth(ctx, 'app_x');
    expect(result.status).toBe('healthy');
    expect(result.message).toBe('MCA is running (no health check tool available)');
  });

  it('con _health_check: parsea el JSON del tool (status/issues/version/uptime)', async () => {
    const ctx = makeCtx();
    const managed = withHealthTool(makeManaged(), async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'degraded',
            issues: [{ code: 'RATE_LIMITED', message: 'upstream lento' }],
            version: '1.2.0',
            uptime: 42,
          }),
        },
      ],
      isError: false,
    }));
    ctx.mcas.set('app_x', managed);

    const result = await checkHealth(ctx, 'app_x');
    expect(result.status).toBe('degraded');
    expect(result.issues).toEqual([{ code: 'RATE_LIMITED', message: 'upstream lento' }]);
    expect(result.version).toBe('1.2.0');
    expect(result.uptime).toBe(42);
    expect(managed.health).toBe(result);
  });

  it('tool con isError → not_ready aunque el body diga otra cosa', async () => {
    const ctx = makeCtx();
    ctx.mcas.set('app_x', withHealthTool(makeManaged(), async () => ({
      content: [{ type: 'text', text: JSON.stringify({ status: 'ready' }) }],
      isError: true,
    })));

    const result = await checkHealth(ctx, 'app_x');
    expect(result.status).toBe('not_ready');
  });

  it('texto NO-JSON del tool → se conserva como message; sin status → ready', async () => {
    const ctx = makeCtx();
    ctx.mcas.set('app_x', withHealthTool(makeManaged(), async () => ({
      content: [{ type: 'text', text: 'todo bien' }],
      isError: false,
    })));

    const result = await checkHealth(ctx, 'app_x');
    expect(result.status).toBe('ready');
    expect(result.message).toBe('todo bien');
  });

  it('callTool que lanza → not_ready con el message', async () => {
    const ctx = makeCtx();
    ctx.mcas.set('app_x', withHealthTool(makeManaged(), async () => {
      throw new Error('socket cerrado');
    }));

    const result = await checkHealth(ctx, 'app_x');
    expect(result.status).toBe('not_ready');
    expect(result.message).toBe('Health check failed: socket cerrado');
  });
});

// ===========================================================================
// getHealth / checkAllHealth / performInitialHealthCheck / updateHealthFromWebSocket
// ===========================================================================

describe('resto de la superficie', () => {
  it('getHealth devuelve la cache del managed; undefined si no hay', () => {
    const ctx = makeCtx();
    expect(getHealth(ctx, 'nope')).toBeUndefined();
    const health = { status: 'ready' as const, checkedAt: new Date() };
    ctx.mcas.set('app_x', makeManaged({ health }));
    expect(getHealth(ctx, 'app_x')).toBe(health);
  });

  it('checkAllHealth recorre TODOS los apps registrados', async () => {
    const ctx = makeCtx();
    // biome-ignore lint/suspicious/noExplicitAny: client fake
    ctx.mcas.set('app_a', makeManaged({ appId: 'app_a', client: {} as any }));
    ctx.mcas.set('app_b', makeManaged({ appId: 'app_b', status: 'disabled' }));

    const results = await checkAllHealth(ctx);
    expect([...results.keys()].sort()).toEqual(['app_a', 'app_b']);
    expect(results.get('app_a')?.status).toBe('healthy');
    expect(results.get('app_b')?.status).toBe('unhealthy');
  });

  it('performInitialHealthCheck: no-ready → no-op; ready sin tool → health ready asumida', async () => {
    const ctx = makeCtx();
    const standby = makeManaged({ status: 'standby' });
    ctx.mcas.set('app_x', standby);
    await performInitialHealthCheck(ctx, 'app_x');
    expect(standby.health).toBeUndefined();

    const ready = makeManaged({ appId: 'app_y' });
    ctx.mcas.set('app_y', ready);
    await performInitialHealthCheck(ctx, 'app_y');
    expect(ready.health?.status).toBe('ready');
    expect(ready.health?.message).toBe('MCA is running (no health check tool)');
  });

  it('updateHealthFromWebSocket setea health con message del primer issue; appId desconocido → no-op', () => {
    const ctx = makeCtx();
    const managed = makeManaged();
    ctx.mcas.set('app_x', managed);

    updateHealthFromWebSocket(ctx, 'app_x', 'not_ready', [
      { code: 'AUTH_EXPIRED', message: 'token caducado' },
      { code: 'OTRA', message: 'secundaria' },
      // biome-ignore lint/suspicious/noExplicitAny: shape de HealthIssue parcial
    ] as any);

    expect(managed.health?.status).toBe('not_ready');
    expect(managed.health?.message).toBe('token caducado');

    // Desconocido: no crashea ni crea entry
    updateHealthFromWebSocket(ctx, 'app_nope', 'ready');
    expect(ctx.mcas.has('app_nope')).toBe(false);
  });

  it('getCachedHealthIfNotReady (health.ts): null sin managed/sin health/ready; cached si not_ready', () => {
    const ctx = makeCtx();
    expect(getCachedHealthIfNotReady(ctx, 'nope')).toBeNull();

    const sinHealth = makeManaged();
    ctx.mcas.set('app_a', sinHealth);
    expect(getCachedHealthIfNotReady(ctx, 'app_a')).toBeNull();

    const bad = makeManaged({ appId: 'app_b', health: { status: 'unhealthy', checkedAt: new Date() } });
    ctx.mcas.set('app_b', bad);
    expect(getCachedHealthIfNotReady(ctx, 'app_b')).toBe(bad.health ?? null);
  });
});
