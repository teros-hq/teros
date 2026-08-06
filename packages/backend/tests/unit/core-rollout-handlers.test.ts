/**
 * Contract-boundary — handlers nuevos del rollout de cores (TER-412):
 * agent.create-core, admin-api.feature-flags-set-rollout / -clear-rollout y
 * admin-api.core-rollout-apply.
 *
 * Lo CRÍTICO: el gating por rol (create-core = admin|super; rollout/apply =
 * super-only) y la validación E10 de set-rollout para flags core.* (el value es
 * un coreId que debe existir, estar activo y casar con el coreType del flag).
 * El camino feliz de applyCoreRollout vive en core-rollout-apply.test.ts
 * (integration con Mongo) — aquí solo gates y validación, con db mockeada.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { WsHandlerContext } from '@teros/shared';
import { createCreateCoreHandler } from '../../src/handlers/domains/agent/create-core';
import {
  createFeatureFlagsClearRolloutHandler,
  createFeatureFlagsSetRolloutHandler,
} from '../../src/handlers/domains/admin-api/feature-flags';
import { createCoreRolloutApplyHandler } from '../../src/handlers/domains/admin-api/agents';

const ctx = (userId: string): WsHandlerContext => ({ userId, sessionId: 's', connectionId: 'c' }) as any;

/** db mock: role del caller + doc de agent_cores que devuelve findOne. */
function makeDb(opts: { role?: string | null; core?: any } = {}) {
  return {
    collection: (name: string) => {
      if (name === 'users') {
        return { findOne: async () => (opts.role ? { userId: 'u', role: opts.role } : null) };
      }
      if (name === 'agent_cores') {
        return { findOne: async () => opts.core ?? null };
      }
      return {};
    },
  } as any;
}

const VALID_CORE_INPUT = {
  coreId: 'agent-exp',
  coreType: 'agent' as const,
  name: 'Exp',
  fullName: 'Agent Exp',
  systemPrompt: 'You are…',
  modelId: 'm1',
};

describe('agent.create-core — gating y validación', () => {
  it('FORBIDDEN si el caller es user normal (o no existe)', async () => {
    for (const role of ['user', null]) {
      const h = createCreateCoreHandler(makeDb({ role }), {} as any);
      await expect(h(ctx('u1'), VALID_CORE_INPUT)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('INVALID_INPUT si falta cualquier campo requerido', async () => {
    const h = createCreateCoreHandler(makeDb({ role: 'admin' }), {} as any);
    for (const missing of ['coreId', 'coreType', 'name', 'fullName', 'systemPrompt', 'modelId']) {
      const data: any = { ...VALID_CORE_INPUT };
      delete data[missing];
      await expect(h(ctx('a'), data)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
  });

  it('CREATE_CORE_FAILED si el service rechaza (p.ej. coreId duplicado)', async () => {
    const modelService: any = {
      createAgentCore: mock(async () => {
        throw new Error("Agent core 'agent-exp' already exists");
      }),
    };
    const h = createCreateCoreHandler(makeDb({ role: 'admin' }), modelService);
    await expect(h(ctx('a'), VALID_CORE_INPUT)).rejects.toMatchObject({ code: 'CREATE_CORE_FAILED' });
  });

  it('un admin SÍ pasa: delega en modelService.createAgentCore y devuelve el shape del core', async () => {
    const created = {
      ...VALID_CORE_INPUT,
      version: 'v1.0',
      personality: [],
      capabilities: [],
      defaultApps: [],
      avatarUrl: 'icon.png',
      status: 'active',
      createdAt: 'x',
      updatedAt: 'x',
    };
    const modelService: any = { createAgentCore: mock(async () => created) };
    const h = createCreateCoreHandler(makeDb({ role: 'admin' }), modelService);
    const res: any = await h(ctx('a'), VALID_CORE_INPUT);
    expect(modelService.createAgentCore).toHaveBeenCalledWith(VALID_CORE_INPUT);
    expect(res.core.coreId).toBe('agent-exp');
    expect(res.core.coreType).toBe('agent');
    expect(res.core.status).toBe('active');
    expect(res.core.defaultApps).toEqual([]);
  });
});

describe('admin-api.feature-flags-set-rollout — gating y validación E10', () => {
  const ffService = () => ({ setRollout: mock(async () => {}) }) as any;
  const PAYLOAD = { key: 'core.agent', value: 'agent-exp', percentage: 25 };

  it('FORBIDDEN si el caller NO es super (admin tampoco basta)', async () => {
    for (const role of ['user', 'admin', null]) {
      const h = createFeatureFlagsSetRolloutHandler(makeDb({ role }), ffService());
      await expect(h(ctx('u1'), PAYLOAD)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('MISSING_FIELDS / INVALID_PERCENTAGE en payloads rotos', async () => {
    const h = createFeatureFlagsSetRolloutHandler(makeDb({ role: 'super' }), ffService());
    await expect(h(ctx('s'), { value: 'x', percentage: 10 })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
    await expect(h(ctx('s'), { key: 'core.agent', percentage: 10 })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
    await expect(h(ctx('s'), { key: 'core.agent', value: 'x' })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
    for (const percentage of [-1, 101, 10.5, Number.NaN]) {
      await expect(h(ctx('s'), { key: 'core.agent', value: 'x', percentage })).rejects.toMatchObject({
        code: 'INVALID_PERCENTAGE',
      });
    }
  });

  it('E10: CORE_NOT_FOUND / CORE_INACTIVE / CORE_TYPE_MISMATCH para flags core.*', async () => {
    // Core inexistente
    let h = createFeatureFlagsSetRolloutHandler(makeDb({ role: 'super', core: null }), ffService());
    await expect(h(ctx('s'), PAYLOAD)).rejects.toMatchObject({ code: 'CORE_NOT_FOUND' });

    // Core inactivo
    h = createFeatureFlagsSetRolloutHandler(
      makeDb({ role: 'super', core: { coreId: 'agent-exp', coreType: 'agent', status: 'inactive' } }),
      ffService(),
    );
    await expect(h(ctx('s'), PAYLOAD)).rejects.toMatchObject({ code: 'CORE_INACTIVE' });

    // coreType incoherente con el flag (core.agent apuntando a un super-agent)
    h = createFeatureFlagsSetRolloutHandler(
      makeDb({ role: 'super', core: { coreId: 'agent-exp', coreType: 'super-agent', status: 'active' } }),
      ffService(),
    );
    await expect(h(ctx('s'), PAYLOAD)).rejects.toMatchObject({ code: 'CORE_TYPE_MISMATCH' });
  });

  it('camino feliz: delega en ffService.setRollout con los args exactos', async () => {
    const svc = ffService();
    const h = createFeatureFlagsSetRolloutHandler(
      makeDb({ role: 'super', core: { coreId: 'agent-exp', coreType: 'agent', status: 'active' } }),
      svc,
    );
    const res: any = await h(ctx('s'), PAYLOAD);
    expect(svc.setRollout).toHaveBeenCalledWith('core.agent', 'agent-exp', 25, 's', undefined);
    expect(res).toEqual({ success: true, key: 'core.agent', value: 'agent-exp', percentage: 25 });
  });
});

describe('admin-api.feature-flags-clear-rollout — gating', () => {
  it('FORBIDDEN si NO es super; MISSING_FIELDS sin key; feliz delega en clearRollout', async () => {
    const svc: any = { clearRollout: mock(async () => {}) };

    let h = createFeatureFlagsClearRolloutHandler(makeDb({ role: 'admin' }), svc);
    await expect(h(ctx('u1'), { key: 'core.agent' })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    h = createFeatureFlagsClearRolloutHandler(makeDb({ role: 'super' }), svc);
    await expect(h(ctx('s'), {})).rejects.toMatchObject({ code: 'MISSING_FIELDS' });

    const res: any = await h(ctx('s'), { key: 'core.agent' });
    expect(svc.clearRollout).toHaveBeenCalledWith('core.agent', 's');
    expect(res).toEqual({ success: true, key: 'core.agent' });
  });
});

describe('admin-api.core-rollout-apply — gating y validación', () => {
  it('FORBIDDEN si el caller NO es super', async () => {
    for (const role of ['user', 'admin', null]) {
      const h = createCoreRolloutApplyHandler(makeDb({ role }), {} as any, {} as any);
      await expect(h(ctx('u1'), { coreType: 'agent' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('VALIDATION_ERROR si coreType no es agent/super-agent', async () => {
    const h = createCoreRolloutApplyHandler(makeDb({ role: 'super' }), {} as any, {} as any);
    for (const coreType of ['core', 'AGENT', '', undefined]) {
      await expect(h(ctx('s'), { coreType })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });
});
