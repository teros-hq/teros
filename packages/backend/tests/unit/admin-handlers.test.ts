/**
 * WS admin handlers — contract-boundary (TER-481, grupo admin/resto).
 *
 * Lo CRÍTICO de admin: el gate de privilegios. Cada handler resuelve el rol del
 * caller con userService.getByUserId(ctx.userId) y rechaza con FORBIDDEN si no
 * es admin/super (o super para los super-only). Cubre el gate de cada handler,
 * las protecciones de auto-daño (self-demotion / self-suspension), y el flujo
 * de impersonación (super-only, no anidada, no a uno mismo, no a otro super, no
 * a suspendido) + stop-impersonation. Handlers mockeados (no Mongo).
 */

import { describe, expect, it, mock } from 'bun:test';
import type { WsHandlerContext } from '@teros/shared';
import { createListUsersHandler } from '../../src/handlers/domains/admin/list-users';
import { createGetUserHandler } from '../../src/handlers/domains/admin/get-user';
import { createGetUserDetailHandler } from '../../src/handlers/domains/admin/get-user-detail';
import { createUpdateUserRoleHandler } from '../../src/handlers/domains/admin/update-user-role';
import { createUpdateUserStatusHandler } from '../../src/handlers/domains/admin/update-user-status';
import { createGrantAccessHandler } from '../../src/handlers/domains/admin/grant-access';
import {
  createImpersonateHandler,
  createStopImpersonationHandler,
} from '../../src/handlers/domains/admin/impersonate';

const ctx = (userId: string, extra: Partial<WsHandlerContext> = {}): WsHandlerContext =>
  ({ userId, sessionId: 'sess', connectionId: 'conn', ...extra }) as any;

function makeUser(userId: string, role: 'user' | 'admin' | 'super', over: any = {}) {
  return {
    userId,
    role,
    status: 'active',
    emailVerified: true,
    accessGranted: false,
    profile: { displayName: `name-${userId}`, email: `${userId}@x.com`, avatarUrl: null },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

/** UserService fake: getByUserId devuelve según un registro userId→user. */
function makeUserService(users: Record<string, any>, over: any = {}) {
  const all = () => Object.values(users) as any[];
  return {
    getByUserId: mock(async (id: string) => users[id] ?? null),
    listUsers: mock(async () => ({ users: all(), total: all().length })),
    // Summary over the WHOLE filtered set (real handler reads it from here, not
    // from the loaded page) so the counts stay correct once paginated.
    getUserSummary: mock(async () => ({
      total: all().length,
      active: all().filter((u) => u.status === 'active').length,
      admins: all().filter((u) => u.role === 'admin' || u.role === 'super').length,
    })),
    updateRole: mock(async (id: string, role: string) => (users[id] ? { ...users[id], role } : null)),
    updateStatus: mock(async () => {}),
    grantAccess: mock(async (id: string) => (users[id] ? { ...users[id], accessGranted: true } : null)),
    ...over,
  } as any;
}

/** db con counts/aggregate/find/findOne para list-users y get-user. */
function makeDb() {
  // Faithful to a real Mongo cursor: find().sort().limit().toArray() chains.
  const cursor = (rows: any[]) => {
    const c: any = {
      project: () => ({ toArray: async () => rows }),
      sort: () => c,
      limit: () => c,
      toArray: async () => rows,
    };
    return c;
  };
  return {
    collection: () => ({
      countDocuments: async () => 0,
      aggregate: () => ({ toArray: async () => [] }),
      find: () => cursor([]),
      // list-users now enriches each user with billing (getActiveSubscription →
      // billing_subscriptions.findOne, plans.findOne). null = user without a sub.
      findOne: async () => null,
    }),
  } as any;
}

// ===========================================================================
// Gate de privilegios — todos los handlers (RIGHT-BICEP: Error path)
// ===========================================================================

describe('admin — gate de privilegios', () => {
  const cases: Array<[string, (svc: any) => (c: WsHandlerContext, d: unknown) => Promise<any>, any]> = [
    ['list-users', (svc) => createListUsersHandler(svc, makeDb()), {}],
    ['get-user', (svc) => createGetUserHandler(svc, makeDb()), { targetUserId: 'user_x' }],
    ['get-user-detail', (svc) => createGetUserDetailHandler(svc, makeDb()), { targetUserId: 'user_x' }],
    ['update-user-status', (svc) => createUpdateUserStatusHandler(svc), { targetUserId: 'user_x', status: 'active' }],
    ['grant-access', (svc) => createGrantAccessHandler(svc), { targetUserId: 'user_x' }],
  ];

  for (const [name, make, data] of cases) {
    it(`${name}: FORBIDDEN para role 'user'`, async () => {
      const svc = makeUserService({ u: makeUser('u', 'user') });
      await expect(make(svc)(ctx('u'), data)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
    it(`${name}: FORBIDDEN si el caller no existe (rol undefined)`, async () => {
      const svc = makeUserService({});
      await expect(make(svc)(ctx('ghost'), data)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  }

  it('update-user-role: FORBIDDEN para admin (super-only)', async () => {
    const svc = makeUserService({ a: makeUser('a', 'admin') });
    await expect(
      createUpdateUserRoleHandler(svc)(ctx('a'), { targetUserId: 'user_x', role: 'admin' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('impersonate: FORBIDDEN para admin (super-only)', async () => {
    const svc = makeUserService({ a: makeUser('a', 'admin') });
    await expect(
      createImpersonateHandler(svc, {} as any, {} as any)(ctx('a', { sessionToken: 't' }), { targetUserId: 'user_x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

// ===========================================================================
// list-users / get-user — admin permitido
// ===========================================================================

describe('admin.list-users', () => {
  it('admin: devuelve summary con conteos correctos', async () => {
    const users = {
      a: makeUser('a', 'admin'),
      s: makeUser('s', 'super'),
      u1: makeUser('u1', 'user'),
      u2: makeUser('u2', 'user', { status: 'suspended' }),
    };
    const res: any = await createListUsersHandler(makeUserService(users), makeDb())(ctx('a'), {});
    expect(res.total).toBe(4);
    // Summary counts the whole filtered set; nearLimit/exhausted are 0 with no
    // active subs in the fake db (TER-682 added billing-derived KPI counts).
    expect(res.summary).toEqual({ total: 4, active: 3, admins: 2, nearLimit: 0, exhausted: 0 });
    expect(res.users).toHaveLength(4);
    // Default paging echoed back so the client can render numbered pages.
    expect(res.page).toBe(0);
    expect(res.pageSize).toBe(50);
  });

  it('admin: reenvía search/filtros/paginación a userService.listUsers + getUserSummary', async () => {
    const svc = makeUserService({ a: makeUser('a', 'admin') });
    await createListUsersHandler(svc, makeDb())(ctx('a'), {
      search: 'ana',
      status: 'active',
      role: 'user',
      page: 2,
      pageSize: 25,
    });
    // skip = page * pageSize; the same filter feeds the page query and the summary.
    expect(svc.listUsers).toHaveBeenCalledWith({
      search: 'ana',
      status: 'active',
      role: 'user',
      limit: 25,
      skip: 50,
    });
    expect(svc.getUserSummary).toHaveBeenCalledWith({ search: 'ana', status: 'active', role: 'user' });
  });

  it('admin: pageSize se acota a [1, 100]', async () => {
    const svc = makeUserService({ a: makeUser('a', 'admin') });
    await createListUsersHandler(svc, makeDb())(ctx('a'), { pageSize: 5000 });
    expect(svc.listUsers).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
  });

  it('admin: produce filas ligeras (apps/channels/activity + billing del badge), sin stats caros', async () => {
    const svc = makeUserService({ a: makeUser('a', 'admin'), u: makeUser('u', 'user') });
    const res: any = await createListUsersHandler(svc, makeDb())(ctx('a'), {});
    const row = res.users.find((r: any) => r.userId === 'u');
    expect(row.stats).toEqual({ apps: 0, channels: 0 });
    expect(row.stats.agents).toBeUndefined(); // lazy — loaded by get-user-detail
    expect(row.activity).toHaveLength(7);
    expect(row.billing).toBeNull(); // no active sub in the fake db
  });
});

describe('admin.get-user-detail', () => {
  it('MISSING_FIELDS sin targetUserId', async () => {
    const svc = makeUserService({ a: makeUser('a', 'admin') });
    await expect(createGetUserDetailHandler(svc, makeDb())(ctx('a'), {})).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('admin: devuelve stats caros + billing (null sin sub activa)', async () => {
    const svc = makeUserService({ a: makeUser('a', 'admin'), t: makeUser('t', 'user') });
    const res: any = await createGetUserDetailHandler(svc, makeDb())(ctx('a'), { targetUserId: 't' });
    expect(res.userId).toBe('t');
    expect(res.stats).toEqual({ agents: 0, workspaces: 0, totalCost: 0, totalTokens: 0 });
    expect(res.billing).toBeNull();
  });
});

describe('admin.get-user', () => {
  it('MISSING_FIELDS sin targetUserId', async () => {
    const svc = makeUserService({ a: makeUser('a', 'admin') });
    await expect(createGetUserHandler(svc, makeDb())(ctx('a'), {})).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('USER_NOT_FOUND si el target no existe', async () => {
    const svc = makeUserService({ a: makeUser('a', 'admin') });
    await expect(
      createGetUserHandler(svc, makeDb())(ctx('a'), { targetUserId: 'ghost' }),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('admin: devuelve user + stats', async () => {
    const svc = makeUserService({ a: makeUser('a', 'admin'), t: makeUser('t', 'user') });
    const res: any = await createGetUserHandler(svc, makeDb())(ctx('a'), { targetUserId: 't' });
    expect(res.user.userId).toBe('t');
    expect(res.stats).toEqual({ apps: 0, sessions: 0, credentials: 0 });
  });
});

// ===========================================================================
// update-user-role — super only + self-demotion guard
// ===========================================================================

describe('admin.update-user-role', () => {
  const superSvc = () => makeUserService({ s: makeUser('s', 'super'), t: makeUser('t', 'user') });

  it('MISSING_FIELDS sin targetUserId o role', async () => {
    await expect(createUpdateUserRoleHandler(superSvc())(ctx('s'), { targetUserId: 't' })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
    await expect(createUpdateUserRoleHandler(superSvc())(ctx('s'), { role: 'admin' })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('INVALID_ROLE para un role fuera de user|admin|super', async () => {
    await expect(
      createUpdateUserRoleHandler(superSvc())(ctx('s'), { targetUserId: 't', role: 'root' }),
    ).rejects.toMatchObject({ code: 'INVALID_ROLE' });
  });

  it('SELF_DEMOTION si el super se baja a sí mismo', async () => {
    await expect(
      createUpdateUserRoleHandler(superSvc())(ctx('s'), { targetUserId: 's', role: 'admin' }),
    ).rejects.toMatchObject({ code: 'SELF_DEMOTION' });
  });

  it('permite mantenerse super a sí mismo (boundary: self + role super OK)', async () => {
    const res: any = await createUpdateUserRoleHandler(superSvc())(ctx('s'), { targetUserId: 's', role: 'super' });
    expect(res.user).toEqual({ userId: 's', role: 'super' });
  });

  it('USER_NOT_FOUND si updateRole devuelve null', async () => {
    const svc = makeUserService({ s: makeUser('s', 'super') }, { updateRole: mock(async () => null) });
    await expect(
      createUpdateUserRoleHandler(svc)(ctx('s'), { targetUserId: 'ghost', role: 'admin' }),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('happy: devuelve {user:{userId, role}}', async () => {
    const res: any = await createUpdateUserRoleHandler(superSvc())(ctx('s'), { targetUserId: 't', role: 'admin' });
    expect(res.user).toEqual({ userId: 't', role: 'admin' });
  });
});

// ===========================================================================
// update-user-status — self-suspension + can't modify super as non-super
// ===========================================================================

describe('admin.update-user-status', () => {
  it('MISSING_FIELDS sin targetUserId o status', async () => {
    const svc = makeUserService({ a: makeUser('a', 'admin') });
    await expect(createUpdateUserStatusHandler(svc)(ctx('a'), { targetUserId: 't' })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
    await expect(createUpdateUserStatusHandler(svc)(ctx('a'), { status: 'active' })).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('INVALID_STATUS', async () => {
    const svc = makeUserService({ a: makeUser('a', 'admin') });
    await expect(
      createUpdateUserStatusHandler(svc)(ctx('a'), { targetUserId: 't', status: 'banned' }),
    ).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });

  it('SELF_SUSPENSION si un admin se suspende a sí mismo', async () => {
    const svc = makeUserService({ a: makeUser('a', 'admin') });
    await expect(
      createUpdateUserStatusHandler(svc)(ctx('a'), { targetUserId: 'a', status: 'suspended' }),
    ).rejects.toMatchObject({ code: 'SELF_SUSPENSION' });
  });

  it('USER_NOT_FOUND si el target no existe', async () => {
    const svc = makeUserService({ a: makeUser('a', 'admin') });
    await expect(
      createUpdateUserStatusHandler(svc)(ctx('a'), { targetUserId: 'ghost', status: 'active' }),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('FORBIDDEN: un admin no puede modificar a un super', async () => {
    const svc = makeUserService({ a: makeUser('a', 'admin'), s: makeUser('s', 'super') });
    await expect(
      createUpdateUserStatusHandler(svc)(ctx('a'), { targetUserId: 's', status: 'suspended' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('happy: admin suspende a un user → {user:{userId, status}} y llama updateStatus', async () => {
    const svc = makeUserService({ a: makeUser('a', 'admin'), t: makeUser('t', 'user') });
    const res: any = await createUpdateUserStatusHandler(svc)(ctx('a'), { targetUserId: 't', status: 'suspended' });
    expect(res.user).toEqual({ userId: 't', status: 'suspended' });
    expect(svc.updateStatus).toHaveBeenCalledWith('t', 'suspended');
  });

  it('super SÍ puede modificar a otro super', async () => {
    const svc = makeUserService({ s: makeUser('s', 'super'), s2: makeUser('s2', 'super') });
    const res: any = await createUpdateUserStatusHandler(svc)(ctx('s'), { targetUserId: 's2', status: 'suspended' });
    expect(res.user).toEqual({ userId: 's2', status: 'suspended' });
  });
});

// ===========================================================================
// grant-access — ALREADY_GRANTED
// ===========================================================================

describe('admin.grant-access', () => {
  it('MISSING_FIELDS sin targetUserId', async () => {
    const svc = makeUserService({ a: makeUser('a', 'admin') });
    await expect(createGrantAccessHandler(svc)(ctx('a'), {})).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('USER_NOT_FOUND si el target no existe', async () => {
    const svc = makeUserService({ a: makeUser('a', 'admin') });
    await expect(
      createGrantAccessHandler(svc)(ctx('a'), { targetUserId: 'ghost' }),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('ALREADY_GRANTED si ya tiene acceso (no llama grantAccess)', async () => {
    const svc = makeUserService({ a: makeUser('a', 'admin'), t: makeUser('t', 'user', { accessGranted: true }) });
    await expect(
      createGrantAccessHandler(svc)(ctx('a'), { targetUserId: 't' }),
    ).rejects.toMatchObject({ code: 'ALREADY_GRANTED' });
    expect(svc.grantAccess).not.toHaveBeenCalled();
  });

  it('happy: concede acceso → {user:{userId, accessGranted:true}}', async () => {
    const svc = makeUserService({ a: makeUser('a', 'admin'), t: makeUser('t', 'user') });
    const res: any = await createGrantAccessHandler(svc)(ctx('a'), { targetUserId: 't' });
    expect(res.user).toEqual({ userId: 't', accessGranted: true });
  });
});

// ===========================================================================
// impersonate — super only + todas las protecciones
// ===========================================================================

function makeSessionService(over: any = {}) {
  return {
    getByTokenHash: mock(async () => ({
      _id: { toHexString: () => 'sess_hex' },
      userId: 's',
      identityId: 'id_1',
      metadata: {},
      expiresAt: new Date('2026-02-01T00:00:00Z'),
    })),
    createImpersonationSession: mock(async () => ({
      session: { _id: { toHexString: () => 'imp_hex' }, expiresAt: new Date('2026-01-01T02:00:00Z') },
      token: 'imp_token',
    })),
    revokeSession: mock(async () => {}),
    refreshSessionByHash: mock(async () => ({ token: 'restored_token' })),
    ...over,
  } as any;
}

describe('admin.impersonate', () => {
  const superUsers = () => ({ s: makeUser('s', 'super'), t: makeUser('t', 'user') });

  it('MISSING_FIELDS sin targetUserId', async () => {
    const h = createImpersonateHandler(makeUserService(superUsers()), {} as any, makeSessionService());
    await expect(h(ctx('s', { sessionToken: 'tok' }), {})).rejects.toMatchObject({ code: 'MISSING_FIELDS' });
  });

  it('INTERNAL_ERROR si no hay sessionToken en el contexto', async () => {
    const h = createImpersonateHandler(makeUserService(superUsers()), {} as any, makeSessionService());
    await expect(h(ctx('s'), { targetUserId: 't' })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('SESSION_NOT_FOUND si la sesión del caller no existe', async () => {
    const sess = makeSessionService({ getByTokenHash: mock(async () => null) });
    const h = createImpersonateHandler(makeUserService(superUsers()), {} as any, sess);
    await expect(h(ctx('s', { sessionToken: 'tok' }), { targetUserId: 't' })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it('NESTED_IMPERSONATION si la sesión actual ya es de impersonación', async () => {
    const sess = makeSessionService({
      getByTokenHash: mock(async () => ({ _id: { toHexString: () => 'x' }, identityId: 'id', metadata: { isImpersonating: true } })),
    });
    const h = createImpersonateHandler(makeUserService(superUsers()), {} as any, sess);
    await expect(h(ctx('s', { sessionToken: 'tok' }), { targetUserId: 't' })).rejects.toMatchObject({ code: 'NESTED_IMPERSONATION' });
  });

  it('INVALID_TARGET si el super intenta impersonarse a sí mismo', async () => {
    const h = createImpersonateHandler(makeUserService(superUsers()), {} as any, makeSessionService());
    await expect(h(ctx('s', { sessionToken: 'tok' }), { targetUserId: 's' })).rejects.toMatchObject({ code: 'INVALID_TARGET' });
  });

  it('USER_NOT_FOUND si el target no existe', async () => {
    const h = createImpersonateHandler(makeUserService({ s: makeUser('s', 'super') }), {} as any, makeSessionService());
    await expect(h(ctx('s', { sessionToken: 'tok' }), { targetUserId: 'ghost' })).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('FORBIDDEN si el target es otro super', async () => {
    const users = { s: makeUser('s', 'super'), s2: makeUser('s2', 'super') };
    const h = createImpersonateHandler(makeUserService(users), {} as any, makeSessionService());
    await expect(h(ctx('s', { sessionToken: 'tok' }), { targetUserId: 's2' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('USER_SUSPENDED si el target está suspendido', async () => {
    const users = { s: makeUser('s', 'super'), t: makeUser('t', 'user', { status: 'suspended' }) };
    const h = createImpersonateHandler(makeUserService(users), {} as any, makeSessionService());
    await expect(h(ctx('s', { sessionToken: 'tok' }), { targetUserId: 't' })).rejects.toMatchObject({ code: 'USER_SUSPENDED' });
  });

  it('happy: crea sesión de impersonación y devuelve token + targetUser + expiresAt', async () => {
    const sess = makeSessionService();
    const h = createImpersonateHandler(makeUserService(superUsers()), {} as any, sess);
    const res: any = await h(ctx('s', { sessionToken: 'tok', ip: '1.2.3.4' }), { targetUserId: 't' });
    expect(res.impersonationToken).toBe('imp_token');
    expect(res.targetUser.userId).toBe('t');
    expect(res.targetUser.role).toBe('user');
    expect(res.expiresAt).toBe(new Date('2026-01-01T02:00:00Z').toISOString());
    expect(sess.createImpersonationSession).toHaveBeenCalledTimes(1);
  });
});

describe('admin.stop-impersonation', () => {
  function impersonatingSession() {
    return { _id: { toHexString: () => 'x' }, userId: 't', metadata: { isImpersonating: true, originalTokenHash: 'orig_hash' } };
  }

  it('INTERNAL_ERROR sin sessionToken', async () => {
    const h = createStopImpersonationHandler(makeUserService({}), makeSessionService());
    await expect(h(ctx('t'), {})).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('NOT_IMPERSONATING si la sesión actual no es de impersonación', async () => {
    const sess = makeSessionService({ getByTokenHash: mock(async () => ({ _id: { toHexString: () => 'x' }, metadata: {} })) });
    const h = createStopImpersonationHandler(makeUserService({}), sess);
    await expect(h(ctx('t', { sessionToken: 'tok' }), {})).rejects.toMatchObject({ code: 'NOT_IMPERSONATING' });
  });

  it('ORIGINAL_SESSION_EXPIRED si la sesión original ya no existe', async () => {
    let call = 0;
    const sess = makeSessionService({
      getByTokenHash: mock(async () => { call++; return call === 1 ? impersonatingSession() : null; }),
    });
    const h = createStopImpersonationHandler(makeUserService({}), sess);
    await expect(h(ctx('t', { sessionToken: 'tok' }), {})).rejects.toMatchObject({ code: 'ORIGINAL_SESSION_EXPIRED' });
  });

  it('REFRESH_FAILED si refreshSessionByHash devuelve null', async () => {
    const sess = makeSessionService({
      getByTokenHash: mock(async () => impersonatingSession()),
      refreshSessionByHash: mock(async () => null),
    });
    const h = createStopImpersonationHandler(makeUserService({ s: makeUser('s', 'super') }), sess);
    await expect(h(ctx('t', { sessionToken: 'tok' }), {})).rejects.toMatchObject({ code: 'REFRESH_FAILED' });
  });

  it('happy: revoca la impersonación, refresca la original y devuelve restoredToken', async () => {
    const orig = { _id: { toHexString: () => 'o' }, userId: 's', metadata: {} };
    let call = 0;
    const sess = makeSessionService({
      getByTokenHash: mock(async () => { call++; return call === 1 ? impersonatingSession() : orig; }),
    });
    const h = createStopImpersonationHandler(makeUserService({ s: makeUser('s', 'super') }), sess);
    const res: any = await h(ctx('t', { sessionToken: 'tok' }), {});
    expect(res).toEqual({ restoredToken: 'restored_token', adminUserId: 's' });
    expect(sess.revokeSession).toHaveBeenCalledWith('tok', 'admin');
  });
});
