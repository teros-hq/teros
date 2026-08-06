/**
 * Unit — /secrets/* MCA callback auth boundary (TER-450)
 *
 * The secret endpoints hand an MCA container its system/user credentials, so
 * the auth gate is fail-closed by design (C-1/C-2 fix): without a wired
 * containerManager → 503; without a Bearer token → 401; with a token that does
 * not verify against any candidate container key → 401. Critically, the X-Mca-Id
 * header is NEVER trusted on its own — the effective mcaId is derived from the
 * verified container key, so a forged header cannot redirect the secret lookup.
 */

import { describe, expect, it, mock } from 'bun:test';
import { createMcaCallbackRoutes } from '../../../packages/backend/src/routes/mca-callback-routes';

const SECRET_URL = '/mca/callback/ch_test/secrets/system';

function makeRes() {
  const captured: { status?: number; body?: unknown } = {};
  const res: any = {
    writeHead: (status: number) => {
      captured.status = status;
      return res;
    },
    end: (payload?: string) => {
      if (payload) captured.body = JSON.parse(payload);
    },
  };
  return { res, captured };
}

function makeReq(headers: Record<string, string> = {}, method = 'GET') {
  // Minimal IncomingMessage: `on` resolves parseBody with an empty body so the
  // downstream handler doesn't blow up on a non-stream req during gate tests.
  const req: any = {
    method,
    headers,
    url: SECRET_URL,
    on: (event: string, cb: (arg?: unknown) => void) => {
      if (event === 'end') cb();
      return req;
    },
  };
  return req;
}

/** cfg with only what the gate touches; downstream deps are inert stubs. */
function makeCfg(over: Record<string, unknown> = {}) {
  const dbStub = { collection: () => ({ findOne: async () => null }) };
  return {
    db: dbStub,
    secretsManager: { mca: () => ({}), system: () => ({}) },
    authManager: {},
    workspaceService: {},
    volumeService: {},
    mcaEventSubscriptionService: {},
    mcaOAuth: {},
    invalidateToolCache: () => undefined,
    getChannelOwnerUserIdFn: async () => null,
    ...over,
  } as any;
}

describe('/secrets/* — fail-closed auth gate', () => {
  it('returns 503 when the container manager is not wired up', async () => {
    const handle = createMcaCallbackRoutes(makeCfg({ containerManager: undefined }));
    const { res, captured } = makeRes();
    const handled = await handle(makeReq({ authorization: 'Bearer x' }), res, SECRET_URL);
    expect(handled).toBe(true);
    expect(captured.status).toBe(503);
  });

  it('returns 401 when no Bearer token is present', async () => {
    const containerManager = { verifyCallbackToken: mock(() => true), touch: mock(() => {}), getInfo: mock(() => null) };
    const handle = createMcaCallbackRoutes(makeCfg({ containerManager }));
    const { res, captured } = makeRes();
    await handle(makeReq({ 'x-mca-id': 'mca.test' }), res, SECRET_URL);
    expect(captured.status).toBe(401);
    expect(containerManager.verifyCallbackToken).not.toHaveBeenCalled();
  });

  it('returns 401 when the Bearer token verifies against no candidate key', async () => {
    const containerManager = { verifyCallbackToken: mock(() => false), touch: mock(() => {}), getInfo: mock(() => null) };
    const handle = createMcaCallbackRoutes(makeCfg({ containerManager }));
    const { res, captured } = makeRes();
    await handle(makeReq({ authorization: 'Bearer forged', 'x-mca-id': 'mca.test' }), res, SECRET_URL);
    expect(captured.status).toBe(401);
  });

  it('rejects a forged X-Mca-Id that has no valid token (header alone never authenticates)', async () => {
    const containerManager = { verifyCallbackToken: mock(() => false), touch: mock(() => {}), getInfo: mock(() => null) };
    const handle = createMcaCallbackRoutes(makeCfg({ containerManager }));
    const { res, captured } = makeRes();
    await handle(makeReq({ authorization: 'Bearer x', 'x-mca-id': 'mca.victim' }), res, SECRET_URL);
    expect(captured.status).toBe(401);
    // Both candidate keys were probed against the token — the header is only ever a candidate.
    expect(containerManager.verifyCallbackToken).toHaveBeenCalledWith('mca.victim', 'x');
  });

  it('derives mcaId from the verified container key, not the forged X-Mca-Id header', async () => {
    // Token verifies for the legit appId only; X-Mca-Id is a forged different id.
    const containerManager = {
      verifyCallbackToken: mock((key: string) => key === 'app_legit'),
      touch: mock(() => {}),
      getInfo: mock(() => ({ mcaId: 'mca.real' })),
    };
    const handle = createMcaCallbackRoutes(makeCfg({ containerManager }));
    const { res } = makeRes();
    const req = makeReq({ authorization: 'Bearer good', 'x-app-id': 'app_legit', 'x-mca-id': 'mca.victim' });
    // Downstream may throw on inert stubs — we only assert the gate's derivation.
    await handle(req, res, SECRET_URL).catch(() => undefined);
    // getInfo resolves the real mcaId from the VERIFIED key (appId), never the header.
    expect(containerManager.getInfo).toHaveBeenCalledWith('app_legit');
    expect(containerManager.getInfo).not.toHaveBeenCalledWith('mca.victim');
  });
});
