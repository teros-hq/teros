/**
 * WS provider handlers — contract-boundary (TER-468, grupo config/acceso).
 *
 * Lo CRÍTICO de provider: nunca filtra secrets al cliente, y las mutaciones
 * verifican ownership (user-sovereign). Cubre list (sanitize), add (validación
 * + no devuelve apiKey), update/delete/test (ownership PROVIDER_NOT_FOUND),
 * complete-oauth (binding de sesión al userId). Handlers mockeados (no Mongo).
 */

import { describe, expect, it, mock } from 'bun:test';
import type { WsHandlerContext } from '@teros/shared';
import { createListProvidersHandler } from '../../src/handlers/domains/provider/list';
import { createAddProviderHandler } from '../../src/handlers/domains/provider/add';
import { createUpdateProviderHandler } from '../../src/handlers/domains/provider/update';
import { createDeleteProviderHandler } from '../../src/handlers/domains/provider/delete';
import { createTestProviderHandler } from '../../src/handlers/domains/provider/test';
import { createCompleteOAuthHandler } from '../../src/handlers/domains/provider/complete-oauth';
import { createStartOAuthHandler } from '../../src/handlers/domains/provider/start-oauth';
import { createListModelsHandler } from '../../src/handlers/domains/provider/list-models';
import { oauthSessions } from '../../src/handlers/domains/provider/oauth-sessions';
import { MODEL_DEFINITIONS } from '../../src/models/definitions';
import { PROVIDER_RETENTION } from '@teros/shared';

const ctx = (userId: string): WsHandlerContext => ({ userId, sessionId: 's', connectionId: 'c' }) as any;

function makeProviderService(over: any = {}) {
  return {
    listUserProviders: mock(async () => over.providers ?? []),
    addProvider: mock(async (_u: string, d: any) => ({
      providerId: 'prov_new',
      providerType: d.providerType,
      displayName: d.displayName,
      status: 'active',
      priority: 100,
    })),
    setProviderSecrets: mock(async () => {}),
    testProvider: mock(async () => ({ ok: true, models: [] })),
    ...over.svc,
  } as any;
}

function makeDb(captured: any[] = []) {
  return {
    collection: () => ({
      updateOne: mock(async (f: any, u: any) => captured.push({ op: 'updateOne', f, u })),
      updateMany: mock(async (f: any, u: any) => captured.push({ op: 'updateMany', f, u })),
      deleteOne: mock(async (f: any) => captured.push({ op: 'deleteOne', f })),
    }),
  } as any;
}

const OWNED = {
  providerId: 'prov_1',
  providerType: 'anthropic',
  displayName: 'Claude',
  config: {},
  models: [],
  priority: 100,
  status: 'active',
  createdAt: 't',
  updatedAt: 't',
  // estos NO deben salir al cliente:
  encryptedData: 'SECRET_BLOB',
  encryptionIv: 'IV',
  encryptionTag: 'TAG',
};

describe('provider.list — NUNCA filtra secrets', () => {
  it('omite encryptedData/encryptionIv/encryptionTag del payload', async () => {
    const handler = createListProvidersHandler(makeProviderService({ providers: [OWNED] }));
    const res: any = await handler(ctx('u1'));

    expect(res.providers.length).toBe(1);
    const p = res.providers[0];
    expect(p.encryptedData).toBeUndefined();
    expect(p.encryptionIv).toBeUndefined();
    expect(p.encryptionTag).toBeUndefined();
    // y sí expone los campos públicos esperados
    expect(p).toEqual({
      providerId: 'prov_1',
      providerType: 'anthropic',
      displayName: 'Claude',
      config: {},
      models: [],
      defaultModelId: undefined,
      isDefault: false,
      priority: 100,
      status: 'active',
      lastTestedAt: undefined,
      errorMessage: undefined,
      createdAt: 't',
      updatedAt: 't',
    });
  });

  it('serializa el JSON sin que aparezca el secret', async () => {
    const handler = createListProvidersHandler(makeProviderService({ providers: [OWNED] }));
    const res = await handler(ctx('u1'));
    expect(JSON.stringify(res)).not.toContain('SECRET_BLOB');
  });
});

describe('provider.add — validación + no devuelve la apiKey', () => {
  it('rechaza sin providerType/displayName', async () => {
    const handler = createAddProviderHandler(makeProviderService());
    await expect(handler(ctx('u1'), { displayName: 'X' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(handler(ctx('u1'), { providerType: 'anthropic' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rechaza un providerType fuera de la whitelist', async () => {
    const handler = createAddProviderHandler(makeProviderService());
    await expect(
      handler(ctx('u1'), { providerType: 'evil-provider', displayName: 'X' }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_TYPE' });
  });

  it('con apiKey: la guarda vía setProviderSecrets y NO la devuelve', async () => {
    const svc = makeProviderService();
    const handler = createAddProviderHandler(svc);
    const res: any = await handler(ctx('u1'), {
      providerType: 'anthropic',
      displayName: 'Claude',
      auth: { apiKey: 'sk-ant-SECRET' },
    });
    expect(svc.setProviderSecrets).toHaveBeenCalledWith('u1', 'prov_new', { apiKey: 'sk-ant-SECRET' });
    expect(JSON.stringify(res)).not.toContain('sk-ant-SECRET');
  });
});

describe('provider ownership — update/delete/test', () => {
  it('update: PROVIDER_NOT_FOUND si el provider no pertenece al usuario', async () => {
    const handler = createUpdateProviderHandler(makeDb(), makeProviderService({ providers: [] }));
    await expect(handler(ctx('u1'), { providerId: 'prov_ajeno', displayName: 'x' })).rejects.toMatchObject({
      code: 'PROVIDER_NOT_FOUND',
    });
  });

  it('delete: PROVIDER_NOT_FOUND si no es del usuario (no borra)', async () => {
    const captured: any[] = [];
    const handler = createDeleteProviderHandler(makeDb(captured), makeProviderService({ providers: [] }));
    await expect(handler(ctx('u1'), { providerId: 'prov_ajeno' })).rejects.toMatchObject({
      code: 'PROVIDER_NOT_FOUND',
    });
    expect(captured.filter((c) => c.op === 'deleteOne')).toEqual([]);
  });

  it('test: PROVIDER_NOT_FOUND si no es del usuario', async () => {
    const handler = createTestProviderHandler(makeProviderService({ providers: [] }));
    await expect(handler(ctx('u1'), { providerId: 'prov_ajeno' })).rejects.toMatchObject({
      code: 'PROVIDER_NOT_FOUND',
    });
  });

  it('update/delete/test: MISSING_PROVIDER_ID sin providerId', async () => {
    const upd = createUpdateProviderHandler(makeDb(), makeProviderService());
    const del = createDeleteProviderHandler(makeDb(), makeProviderService());
    const tst = createTestProviderHandler(makeProviderService());
    await expect(upd(ctx('u1'), {})).rejects.toMatchObject({ code: 'MISSING_PROVIDER_ID' });
    await expect(del(ctx('u1'), {})).rejects.toMatchObject({ code: 'MISSING_PROVIDER_ID' });
    await expect(tst(ctx('u1'), {})).rejects.toMatchObject({ code: 'MISSING_PROVIDER_ID' });
  });

  it('update con provider propio: ejecuta el updateOne (ownership OK)', async () => {
    const captured: any[] = [];
    const handler = createUpdateProviderHandler(makeDb(captured), makeProviderService({ providers: [OWNED] }));
    await handler(ctx('u1'), { providerId: 'prov_1', displayName: 'Nuevo' });
    expect(captured.some((c) => c.op === 'updateOne')).toBe(true);
  });

  it('update isDefault=true: limpia isDefault del resto vía updateMany scopeado al userId', async () => {
    const captured: any[] = [];
    const handler = createUpdateProviderHandler(makeDb(captured), makeProviderService({ providers: [OWNED] }));
    await handler(ctx('u1'), { providerId: 'prov_1', isDefault: true });
    const many = captured.find((c) => c.op === 'updateMany');
    expect(many.f).toEqual({ userId: 'u1', providerId: { $ne: 'prov_1' } });
    expect(many.u.$set.isDefault).toBe(false);
  });
});

describe('provider.complete-oauth — binding de sesión al userId', () => {
  it('INVALID_INPUT sin verifier', async () => {
    const handler = createCompleteOAuthHandler(makeProviderService());
    await expect(handler(ctx('u1'), {})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('INVALID_VERIFIER si la sesión no existe', async () => {
    const handler = createCompleteOAuthHandler(makeProviderService());
    await expect(handler(ctx('u1'), { verifier: 'nope' })).rejects.toMatchObject({ code: 'INVALID_VERIFIER' });
  });

  it('UNAUTHORIZED si la sesión pertenece a OTRO usuario', async () => {
    const verifier = 'v_other_user';
    oauthSessions.set(verifier, {
      verifier,
      userId: 'u_owner',
      providerType: 'anthropic-oauth',
      createdAt: Date.now(),
    } as any);
    try {
      const handler = createCompleteOAuthHandler(makeProviderService());
      await expect(handler(ctx('u_intruso'), { verifier, callbackUrl: 'x' })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    } finally {
      oauthSessions.delete(verifier);
    }
  });
});

// La mitad ESCRITORA del binding sesión→userId. complete-oauth (arriba) LEE
// session.userId para rechazar a otro usuario; si start-oauth NO grabase
// ctx.userId, ese gate quedaría sin nada que comparar. El loop testeó el read,
// no el write (TER-468 #171). anthropic-oauth usa PKCE local (sin red), así que
// el binding se verifica sin mockear @teros/core.
describe('provider.start-oauth — graba el binding sesión→userId', () => {
  it('INVALID_PROVIDER si el providerType no está soportado', async () => {
    const handler = createStartOAuthHandler();
    await expect(handler(ctx('u1'), { providerType: 'evil-oauth' })).rejects.toMatchObject({
      code: 'INVALID_PROVIDER',
    });
  });

  it('anthropic-oauth: persiste userId=ctx.userId bajo el verifier devuelto', async () => {
    const handler = createStartOAuthHandler();
    const res: any = await handler(ctx('u_owner'), { providerType: 'anthropic-oauth' });
    expect(res.verifier).toBeTruthy();
    try {
      const session = oauthSessions.get(res.verifier);
      expect(session?.userId).toBe('u_owner');
      expect(session?.providerType).toBe('anthropic-oauth');
    } finally {
      oauthSessions.delete(res.verifier);
    }
  });

  it('el verifier devuelto al cliente ES la clave de la sesión (no se desincronizan)', async () => {
    const handler = createStartOAuthHandler();
    const res: any = await handler(ctx('u1'), { providerType: 'anthropic-oauth' });
    try {
      expect(oauthSessions.has(res.verifier)).toBe(true);
    } finally {
      oauthSessions.delete(res.verifier);
    }
  });
});

// ── provider.list-models — el campo `retention` (privacidad) ──────────────────
// Sin esto, quitar `retention: resolveRetention(...)` del handler no rompería
// ningún test, y el fallback del frontend degradaría zhipu-China 🔴→🟡 en silencio.

const fakeModelService = (models: any[]) => ({ listModels: async () => models }) as any;
const model = (over: any) => ({
  modelId: 'm', name: 'M', modelString: 's', description: '', status: 'active',
  context: { maxTokens: 1, maxOutputTokens: 1 }, defaults: { temperature: 0, maxTokens: 1 },
  capabilities: { streaming: true, tools: true, vision: false }, ...over,
});

describe('provider.list-models — incluye el tier de retención resuelto', () => {
  it('añade retention { tier, noticeSlug } a cada modelo', async () => {
    const handler = createListModelsHandler({} as any, fakeModelService([model({ provider: 'anthropic' })]));
    const res: any = await handler(ctx('u1'));
    expect(res.models[0].retention).toEqual({ tier: 'retains', noticeSlug: 'api30d' });
  });

  it('resuelve zhipu + useChina a `trains` (NO degrada a retains)', async () => {
    const handler = createListModelsHandler(
      {} as any,
      fakeModelService([model({ provider: 'zhipu', providerConfig: { useChina: true } })]),
    );
    const res: any = await handler(ctx('u1'));
    expect(res.models[0].retention.tier).toBe('trains');
    expect(res.models[0].retention.noticeSlug).toBe('zhipuChina');
  });

  it('zhipu sin providerConfig → retains (z.ai por defecto)', async () => {
    const handler = createListModelsHandler({} as any, fakeModelService([model({ provider: 'zhipu' })]));
    const res: any = await handler(ctx('u1'));
    expect(res.models[0].retention.tier).toBe('retains');
  });

  it('provider de inferencia ZDR (teros) → zdr', async () => {
    const handler = createListModelsHandler({} as any, fakeModelService([model({ provider: 'teros' })]));
    const res: any = await handler(ctx('u1'));
    expect(res.models[0].retention.tier).toBe('zdr');
  });
});

// ── Guard estructural: el mapa cubre el catálogo RUNTIME ──────────────────────
// Liga PROVIDER_RETENTION a los providers reales de MODEL_DEFINITIONS, no a un
// mirror a mano. Un provider nuevo sin clasificar hace fallar esto (cae a
// UNKNOWN/retains en producción, invisible de otro modo).

describe('PROVIDER_RETENTION cubre el catálogo de modelos en runtime', () => {
  it('cada provider de MODEL_DEFINITIONS está clasificado (salvo openai-compatible)', () => {
    const providers = [...new Set(MODEL_DEFINITIONS.map((m) => m.provider))];
    const missing = providers.filter((p) => p !== 'openai-compatible' && !(p in PROVIDER_RETENTION));
    expect(missing).toEqual([]);
  });
});
