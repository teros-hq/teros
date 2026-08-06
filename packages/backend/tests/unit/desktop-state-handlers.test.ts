/**
 * WS desktop-state handlers — contract-boundary (TER-481, grupo admin/resto).
 *
 * get/save persisten el layout del escritorio por (userId, workspaceId). El
 * scoping por ctx.userId lo hace el servicio; el handler valida params y delega.
 * Cubre validación (workspaceId requerido, state debe ser objeto plano) y que
 * el userId que se pasa al servicio es SIEMPRE ctx.userId.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { WsHandlerContext } from '@teros/shared';
import { createGetDesktopStateHandler } from '../../src/handlers/domains/desktop-state/get';
import { createSaveDesktopStateHandler } from '../../src/handlers/domains/desktop-state/save';

const ctx = (userId: string): WsHandlerContext => ({ userId, sessionId: 's', connectionId: 'c' }) as any;

function makeService(doc: any = null) {
  return {
    get: mock(async () => doc),
    save: mock(async () => {}),
  } as any;
}

describe('desktop-state.get', () => {
  it('MISSING_WORKSPACE_ID sin workspaceId', async () => {
    await expect(createGetDesktopStateHandler(makeService())(ctx('u1'), {})).rejects.toMatchObject({
      code: 'MISSING_WORKSPACE_ID',
    });
  });

  it('sin doc → {state:null} y consulta por ctx.userId + workspaceId', async () => {
    const svc = makeService(null);
    const res = await createGetDesktopStateHandler(svc)(ctx('u1'), { workspaceId: 'work_1' });
    expect(res).toEqual({ state: null });
    expect(svc.get).toHaveBeenCalledWith('u1', 'work_1');
  });

  it('con doc → {state}', async () => {
    const svc = makeService({ state: { 'win_1': 'open' } });
    const res = await createGetDesktopStateHandler(svc)(ctx('u1'), { workspaceId: 'work_1' });
    expect(res).toEqual({ state: { 'win_1': 'open' } });
  });
});

describe('desktop-state.save', () => {
  it('MISSING_WORKSPACE_ID sin workspaceId', async () => {
    await expect(
      createSaveDesktopStateHandler(makeService())(ctx('u1'), { state: {} }),
    ).rejects.toMatchObject({ code: 'MISSING_WORKSPACE_ID' });
  });

  it('INVALID_STATE si state no es objeto plano (null / array / primitivo)', async () => {
    const h = createSaveDesktopStateHandler(makeService());
    await expect(h(ctx('u1'), { workspaceId: 'work_1' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(h(ctx('u1'), { workspaceId: 'work_1', state: null })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(h(ctx('u1'), { workspaceId: 'work_1', state: [] })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(h(ctx('u1'), { workspaceId: 'work_1', state: 'x' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('state={} (vacío) es válido (boundary)', async () => {
    const svc = makeService();
    const res = await createSaveDesktopStateHandler(svc)(ctx('u1'), { workspaceId: 'work_1', state: {} });
    expect(res).toEqual({ ok: true });
    expect(svc.save).toHaveBeenCalledWith('u1', 'work_1', {});
  });

  it('happy: guarda con ctx.userId forzado', async () => {
    const svc = makeService();
    const res = await createSaveDesktopStateHandler(svc)(ctx('u1'), { workspaceId: 'work_1', state: { a: 'b' } });
    expect(res).toEqual({ ok: true });
    expect(svc.save).toHaveBeenCalledWith('u1', 'work_1', { a: 'b' });
  });
});
