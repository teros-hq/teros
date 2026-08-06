/**
 * WS user-api handlers — contract-boundary (TER-481, grupo admin/resto).
 *
 * Lo CRÍTICO de user-api: NO hay check de rol; la seguridad descansa en que el
 * handler FUERZA userId = ctx.userId en la query, así un usuario nunca ve datos
 * de otro aunque mande userId en el payload. Este es el invariante que se afirma
 * (pass {userId:'victim'} → se consulta el propio). db mockeado captura el
 * filtro/collection real.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { WsHandlerContext } from '@teros/shared';
import {
  createMyUsageTokensPerHourHandler,
  createMyUsageListSessionsHandler,
} from '../../src/handlers/domains/user-api/my-usage';

const ctx = (userId: string): WsHandlerContext => ({ userId, sessionId: 's', connectionId: 'c' }) as any;
const RANGE = { from: '2026-01-01T00:00:00Z', to: '2026-01-08T00:00:00Z' };

/** db que captura la collection consultada y el filtro de find. */
function makeDb() {
  const calls: { aggregateColl?: string; findFilter?: any } = {};
  const db = {
    collection: (name: string) => ({
      aggregate: (_p: any) => { calls.aggregateColl = name; return { toArray: async () => [{ bucket: 1 }] }; },
      find: (filter: any) => {
        calls.findFilter = filter;
        return { sort: () => ({ skip: () => ({ limit: () => ({ toArray: async () => [{ id: 'sess_1' }] }) }) }) };
      },
    }),
  } as any;
  return { db, calls };
}

describe('user-api.my-usage-tokens-per-hour', () => {
  it('INVALID_INPUT sin from/to (parseQuery valida el rango)', async () => {
    const { db } = makeDb();
    await expect(createMyUsageTokensPerHourHandler(db)(ctx('u1'), {})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('FUERZA userId=ctx.userId aunque el payload mande otro (anti cross-user)', async () => {
    const { db } = makeDb();
    const res: any = await createMyUsageTokensPerHourHandler(db)(ctx('u1'), { ...RANGE, userId: 'victim' });
    expect(res.filters.userId).toBe('u1');
  });

  it('default triggerKind=user_message + source=rollup + timeZone propagada', async () => {
    const { db } = makeDb();
    const res: any = await createMyUsageTokensPerHourHandler(db)(ctx('u1'), RANGE);
    expect(res.filters.triggerKind).toBe('user_message');
    expect(res.source).toBe('rollup');
    expect(res.bucketTimeZone).toBe('UTC');
    expect(res.buckets).toEqual([{ bucket: 1 }]);
  });

  it('timeMetric=userActive consulta la collection de rollups por usuario', async () => {
    const { db, calls } = makeDb();
    await createMyUsageTokensPerHourHandler(db)(ctx('u1'), { ...RANGE, timeMetric: 'userActive' });
    expect(calls.aggregateColl).toBe('agent_usage_rollups_user_hourly');
  });

  it('timeMetric por defecto consulta la collection horaria estándar', async () => {
    const { db, calls } = makeDb();
    await createMyUsageTokensPerHourHandler(db)(ctx('u1'), RANGE);
    expect(calls.aggregateColl).toBe('agent_usage_rollups_hourly');
  });
});

describe('user-api.my-usage-list-sessions', () => {
  it('FUERZA userId=ctx.userId en el filtro de la query (anti cross-user)', async () => {
    const { db, calls } = makeDb();
    await createMyUsageListSessionsHandler(db)(ctx('u1'), { ...RANGE, userId: 'victim' });
    expect(calls.findFilter.userId).toBe('u1');
  });

  it('devuelve items + limit + skip', async () => {
    const { db } = makeDb();
    const res: any = await createMyUsageListSessionsHandler(db)(ctx('u1'), RANGE);
    expect(res.items).toEqual([{ id: 'sess_1' }]);
    expect(typeof res.limit).toBe('number');
    expect(typeof res.skip).toBe('number');
  });
});
