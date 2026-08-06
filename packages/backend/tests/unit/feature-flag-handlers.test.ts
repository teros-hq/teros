/**
 * WS feature-flag handlers — contract-boundary (TER-468, grupo config/acceso).
 *
 * Lo CRÍTICO: el gating admin. list/update/setOverride/deleteOverride/
 * getOverrides/resetDefault son super-only (FORBIDDEN si role !== 'super');
 * get/getAll abiertos a cualquier autenticado. El guard `role !== 'super'` está
 * DUPLICADO inline en cada handler (no hay middleware compartido) → cada uno es
 * un punto de regresión independiente y se testea por separado. Cubre los 6
 * guards, la validación de cada uno y los shapes exactos. Handlers mockeados.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { WsHandlerContext } from '@teros/shared';
import { createListFlagsHandler } from '../../src/handlers/domains/feature-flag/list';
import { createSetOverrideHandler } from '../../src/handlers/domains/feature-flag/set-override';
import { createUpdateFlagHandler } from '../../src/handlers/domains/feature-flag/update';
import { createGetOverridesHandler } from '../../src/handlers/domains/feature-flag/get-overrides';
import { createDeleteOverrideHandler } from '../../src/handlers/domains/feature-flag/delete-override';
import { createResetDefaultHandler } from '../../src/handlers/domains/feature-flag/reset-default';

const ctx = (userId: string): WsHandlerContext => ({ userId, sessionId: 's', connectionId: 'c' }) as any;

const userService = (role: string | null) =>
  ({ getByUserId: mock(async () => (role ? { userId: 'u', role } : null)) }) as any;

function flagService(over: any = {}) {
  return {
    listFlags: mock(async () => over.flags ?? []),
    // getOverridesForAllFlags devuelve un ARRAY de overrides (cada uno con .key);
    // el handler los agrupa y cuenta por key.
    getOverridesForAllFlags: mock(async () => over.overrides ?? []),
    setOverride: mock(async () => {}),
    setDefault: mock(async () => {}),
    listOverrides: mock(async () => over.overrideList ?? []),
    deleteOverride: mock(async () => {}),
    resetToRegistryDefault: mock(async () => {}),
    ...over,
  } as any;
}

describe('feature-flag super-only gating', () => {
  it('list: FORBIDDEN si el usuario NO es super', async () => {
    const handler = createListFlagsHandler(flagService(), userService('user'));
    await expect(handler(ctx('u1'), {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('list: FORBIDDEN si el usuario no existe (role null)', async () => {
    const handler = createListFlagsHandler(flagService(), userService(null));
    await expect(handler(ctx('u1'), {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('list: un super SÍ pasa y recibe el shape de flags', async () => {
    const flags = [
      { key: 'voice.enabled', type: 'boolean', description: 'd', defaultValue: false, category: 'voice' },
    ];
    const handler = createListFlagsHandler(
      flagService({
        flags,
        // 3 overrides de la misma key → overrideCount: 3
        overrides: [{ key: 'voice.enabled' }, { key: 'voice.enabled' }, { key: 'voice.enabled' }],
      }),
      userService('super'),
    );
    const res: any = await handler(ctx('admin'), {});
    expect(res.flags).toEqual([
      {
        key: 'voice.enabled',
        type: 'boolean',
        description: 'd',
        defaultValue: false,
        category: 'voice',
        overrideCount: 3,
      },
    ]);
  });

  it('setOverride: FORBIDDEN si NO es super', async () => {
    const handler = createSetOverrideHandler(flagService(), userService('user'));
    await expect(
      handler(ctx('u1'), { key: 'voice.enabled', targetType: 'user', targetId: 'u2', value: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('feature-flag setOverride — validación (como super)', () => {
  const su = () => userService('super');

  it('MISSING_FIELDS si falta key/targetType/targetId/value', async () => {
    const h = createSetOverrideHandler(flagService(), su());
    await expect(h(ctx('a'), { targetType: 'user', targetId: 'u', value: true })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
    await expect(h(ctx('a'), { key: 'k', targetId: 'u', value: true })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
    await expect(h(ctx('a'), { key: 'k', targetType: 'user', targetId: 'u' })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('INVALID_TARGET_TYPE si targetType no es user/workspace/company', async () => {
    const h = createSetOverrideHandler(flagService(), su());
    await expect(
      h(ctx('a'), { key: 'k', targetType: 'galaxy', targetId: 'u', value: true }),
    ).rejects.toMatchObject({ code: 'INVALID_TARGET_TYPE' });
  });

  it('happy path: llama setOverride con el actor (ctx.userId) y devuelve el shape', async () => {
    const svc = flagService();
    const h = createSetOverrideHandler(svc, su());
    const res: any = await h(ctx('admin'), {
      key: 'voice.enabled',
      targetType: 'user',
      targetId: 'u2',
      value: true,
      note: 'beta',
    });
    expect(svc.setOverride).toHaveBeenCalledWith('voice.enabled', 'user', 'u2', true, 'admin', 'beta');
    expect(res).toEqual({ success: true, key: 'voice.enabled', targetType: 'user', targetId: 'u2' });
  });

  it('acepta value falsy (false / 0) — usa value === undefined, no truthiness', async () => {
    const svc = flagService();
    const h = createSetOverrideHandler(svc, su());
    await expect(
      h(ctx('admin'), { key: 'k', targetType: 'workspace', targetId: 'w1', value: false }),
    ).resolves.toMatchObject({ success: true });
    expect(svc.setOverride).toHaveBeenCalledWith('k', 'workspace', 'w1', false, 'admin', undefined);
  });
});

// Los 4 hermanos del MISMO guard inline que list/setOverride: el loop solo
// testeó esos 2 (TER-468 #171). Cada handler repite `role !== 'super'` sin
// middleware, así que cada uno es punto de regresión propio. deleteOverride es
// DESTRUCTIVO — su gate sin test era el hueco de más riesgo.
describe('feature-flag update/getOverrides/deleteOverride/resetDefault — super-only inline', () => {
  const su = () => userService('super');

  it('update: FORBIDDEN si NO es super', async () => {
    const h = createUpdateFlagHandler(flagService(), userService('user'));
    await expect(h(ctx('u1'), { key: 'k', defaultValue: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('getOverrides: FORBIDDEN si NO es super', async () => {
    const h = createGetOverridesHandler(flagService(), userService('user'));
    await expect(h(ctx('u1'), { key: 'k' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('deleteOverride: FORBIDDEN si NO es super (DESTRUCTIVO — NO debe borrar)', async () => {
    const svc = flagService();
    const h = createDeleteOverrideHandler(svc, userService('user'));
    await expect(
      h(ctx('u1'), { key: 'k', targetType: 'user', targetId: 'u2' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(svc.deleteOverride).not.toHaveBeenCalled();
  });

  it('deleteOverride: FORBIDDEN también si el usuario no existe (role null) — no borra', async () => {
    const svc = flagService();
    const h = createDeleteOverrideHandler(svc, userService(null));
    await expect(
      h(ctx('u1'), { key: 'k', targetType: 'user', targetId: 'u2' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(svc.deleteOverride).not.toHaveBeenCalled();
  });

  it('resetDefault: FORBIDDEN si NO es super', async () => {
    const h = createResetDefaultHandler(flagService(), userService('user'));
    await expect(h(ctx('u1'), { key: 'k' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('update: MISSING_FIELDS si falta key o defaultValue (como super)', async () => {
    const h = createUpdateFlagHandler(flagService(), su());
    await expect(h(ctx('a'), { defaultValue: true })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
    await expect(h(ctx('a'), { key: 'k' })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('update: defaultValue falsy (false) SÍ pasa — usa === undefined, no truthiness', async () => {
    const svc = flagService();
    const h = createUpdateFlagHandler(svc, su());
    const res: any = await h(ctx('admin'), { key: 'voice.enabled', defaultValue: false });
    expect(svc.setDefault).toHaveBeenCalledWith('voice.enabled', false, 'admin');
    expect(res).toEqual({ success: true, key: 'voice.enabled' });
  });

  it('getOverrides: MISSING_FIELDS sin key (como super)', async () => {
    const h = createGetOverridesHandler(flagService(), su());
    await expect(h(ctx('a'), {})).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('deleteOverride: MISSING_FIELDS si falta key/targetType/targetId (como super)', async () => {
    const h = createDeleteOverrideHandler(flagService(), su());
    await expect(h(ctx('a'), { targetType: 'user', targetId: 'u' })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
    await expect(h(ctx('a'), { key: 'k', targetId: 'u' })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
    await expect(h(ctx('a'), { key: 'k', targetType: 'user' })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('resetDefault: MISSING_FIELDS sin key (como super)', async () => {
    const h = createResetDefaultHandler(flagService(), su());
    await expect(h(ctx('a'), {})).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('update happy: setDefault(key, value, actor=ctx.userId) + shape exacto', async () => {
    const svc = flagService();
    const h = createUpdateFlagHandler(svc, su());
    const res: any = await h(ctx('admin'), { key: 'voice.enabled', defaultValue: true });
    expect(svc.setDefault).toHaveBeenCalledWith('voice.enabled', true, 'admin');
    expect(res).toEqual({ success: true, key: 'voice.enabled' });
  });

  it('getOverrides happy: listOverrides(key) + whitelist de campos EXACTA (sin _id interno)', async () => {
    const svc = flagService({
      listOverrides: mock(async () => [
        {
          key: 'voice.enabled', targetType: 'user', targetId: 'u2', value: true,
          note: 'n', createdBy: 'admin', createdAt: 't1', updatedAt: 't2',
          _id: 'INTERNAL_MONGO_ID',
        },
      ]),
    });
    const h = createGetOverridesHandler(svc, su());
    const res: any = await h(ctx('admin'), { key: 'voice.enabled' });
    expect(svc.listOverrides).toHaveBeenCalledWith('voice.enabled');
    expect(res).toEqual({
      overrides: [
        {
          key: 'voice.enabled', targetType: 'user', targetId: 'u2', value: true,
          note: 'n', createdBy: 'admin', createdAt: 't1', updatedAt: 't2',
        },
      ],
    });
    expect(JSON.stringify(res)).not.toContain('INTERNAL_MONGO_ID');
  });

  it('deleteOverride happy: deleteOverride(key, type, id, actor) + shape exacto', async () => {
    const svc = flagService();
    const h = createDeleteOverrideHandler(svc, su());
    const res: any = await h(ctx('admin'), { key: 'voice.enabled', targetType: 'user', targetId: 'u2' });
    expect(svc.deleteOverride).toHaveBeenCalledWith('voice.enabled', 'user', 'u2', 'admin');
    expect(res).toEqual({ success: true, key: 'voice.enabled', targetType: 'user', targetId: 'u2' });
  });

  it('resetDefault happy: resetToRegistryDefault(key, actor) + shape exacto', async () => {
    const svc = flagService();
    const h = createResetDefaultHandler(svc, su());
    const res: any = await h(ctx('admin'), { key: 'voice.enabled' });
    expect(svc.resetToRegistryDefault).toHaveBeenCalledWith('voice.enabled', 'admin');
    expect(res).toEqual({ success: true, key: 'voice.enabled' });
  });
});
