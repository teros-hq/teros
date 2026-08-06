import { describe, expect, it, mock } from 'bun:test';
import { executeToolViaHttp } from '../../src/services/mca-manager.tools';

/**
 * Validates the stale-map self-healing in executeToolViaHttp: when the target
 * container is unreachable (CONNECTION_FAILED — idle-killed on the execution
 * host, OOM, agent restart), the stale entries are dropped, the MCA is
 * respawned once, and the call is retried — instead of surfacing "fetch
 * failed" to the user for a full idle window (2026-07-06 prod incident).
 */
describe('executeToolViaHttp stale-map self-healing', () => {
  const APP_ID = 'app_selfheal';

  function connectionFailedError() {
    const err: any = new Error('fetch failed');
    err.code = 'CONNECTION_FAILED';
    err.statusCode = 503;
    return err;
  }

  function buildManaged(status = 'ready') {
    return {
      appId: APP_ID,
      mcaId: 'mca.teros.core',
      containerKey: APP_ID,
      status,
      lastUsed: new Date(),
    } as any;
  }

  function buildHarness(opts: { respawnStatus?: string; retrySucceeds?: boolean } = {}) {
    const staleClient = {
      callTool: mock(async () => {
        throw connectionFailedError();
      }),
    } as any;
    const freshClient = {
      callTool: mock(async () => {
        if (opts.retrySucceeds === false) throw connectionFailedError();
        return { success: true, result: 'healed' };
      }),
    } as any;

    const mcas = new Map([[APP_ID, buildManaged()]]);
    const httpClients = new Map([[APP_ID, staleClient]]);
    const stop = mock(async () => {});
    const getOrSpawn = mock(async () => {
      const fresh = buildManaged(opts.respawnStatus ?? 'ready');
      mcas.set(APP_ID, fresh);
      httpClients.set(APP_ID, freshClient);
      return fresh;
    });

    const ctx = {
      mcas,
      httpClients,
      config: { serverPort: 10001 },
      containerManager: { touch: () => {}, stop },
      containerBackendHost: 'localhost',
      getOrSpawn,
    } as any;

    return { ctx, staleClient, freshClient, stop, getOrSpawn };
  }

  it('drops stale state, respawns once and retries successfully', async () => {
    const { ctx, staleClient, freshClient, stop, getOrSpawn } = buildHarness();

    const result = await executeToolViaHttp(ctx, buildManaged(), 'list-catalog', {}, staleClient);

    expect(result.isError).toBe(false);
    expect(result.output).toBe('healed');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(getOrSpawn).toHaveBeenCalledTimes(1);
    expect(staleClient.callTool).toHaveBeenCalledTimes(1);
    expect(freshClient.callTool).toHaveBeenCalledTimes(1);
  });

  it('does NOT loop: a second CONNECTION_FAILED after the respawn surfaces the error', async () => {
    const { ctx, staleClient, getOrSpawn } = buildHarness({ retrySucceeds: false });

    const result = await executeToolViaHttp(ctx, buildManaged(), 'list-catalog', {}, staleClient);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('fetch failed');
    expect(getOrSpawn).toHaveBeenCalledTimes(1); // one respawn attempt, no loop
  });

  it('surfaces the error when the respawn does not reach ready', async () => {
    const { ctx, staleClient, freshClient } = buildHarness({ respawnStatus: 'error' });

    const result = await executeToolViaHttp(ctx, buildManaged(), 'list-catalog', {}, staleClient);

    expect(result.isError).toBe(true);
    expect(freshClient.callTool).not.toHaveBeenCalled();
  });

  it('does not attempt healing for non-connection errors', async () => {
    const { ctx, getOrSpawn } = buildHarness();
    const plainClient = {
      callTool: async () => {
        throw new Error('tool exploded');
      },
    } as any;

    const result = await executeToolViaHttp(ctx, buildManaged(), 'list-catalog', {}, plainClient);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('tool exploded');
    expect(getOrSpawn).not.toHaveBeenCalled();
  });
});
