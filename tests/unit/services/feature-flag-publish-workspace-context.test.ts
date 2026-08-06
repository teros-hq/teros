/**
 * FeatureFlagService.publishChanges — re-resuelve con workspace context (TER-460).
 *
 * El push `featureFlags.changed` re-resolvía los flags con `{ userId }` pelado:
 * un override a nivel workspace salía INVISIBLE en el push — el cliente recibía
 * el default stale justo cuando un admin activaba el flag para su workspace. El
 * fix resuelve el primer workspace del usuario (mismo criterio que el handler
 * `featureFlags.get`) e incluye `workspaceId` en el context de resolución.
 *
 * Estos tests MUERDEN el fix: espían `resolveWithSource` y afirman el context
 * EXACTO con el que se re-resuelve cada flag. Sin el fix, el context llega sin
 * `workspaceId` y el `toEqual` se pone rojo.
 */

import { describe, expect, it, spyOn } from 'bun:test';
import { FeatureFlagService } from '../../../packages/backend/src/services/feature-flag-service';

/** db mock mínimo: el constructor solo asigna colecciones; las queries devuelven vacío. */
function fakeDb(): any {
  const col = {
    find: () => ({ toArray: async () => [], sort: () => ({ toArray: async () => [] }) }),
    findOne: async () => null,
    createIndex: async () => {},
    updateOne: async () => ({}),
  };
  return { collection: () => col };
}

function sessionFor(userId: string): any {
  return { userId, ws: { readyState: 1, send: () => {} } };
}

describe('publishChanges re-resuelve con workspace context (TER-460)', () => {
  it('incluye el workspaceId del primer workspace del usuario en el context de resolución', async () => {
    const svc = new FeatureFlagService(fakeDb());
    svc.setSessionManager({ getAllActiveSessions: () => [sessionFor('u1')] } as any);
    svc.setWorkspaceService({
      listUserWorkspaces: async (userId: string) => {
        expect(userId).toBe('u1');
        return [{ workspaceId: 'ws1' }, { workspaceId: 'ws2' }];
      },
    } as any);

    const resolveSpy = spyOn(svc as any, 'resolveWithSource').mockResolvedValue({
      value: true,
      source: 'workspace',
      type: 'boolean',
    });

    await svc.publishChanges(['voice.enabled']);

    expect(resolveSpy).toHaveBeenCalledTimes(1);
    const [key, context] = resolveSpy.mock.calls[0];
    expect(key).toBe('voice.enabled');
    // Payload EXACTO: sin el fix el context es { userId: 'u1' } y este toEqual
    // falla (workspaceId esperado 'ws1' vs ausente). Toma el PRIMER workspace.
    expect(context).toEqual({ userId: 'u1', workspaceId: 'ws1' });
  });

  it('resuelve un context por sesión activa, cada una con su propio workspace', async () => {
    const svc = new FeatureFlagService(fakeDb());
    svc.setSessionManager({
      getAllActiveSessions: () => [sessionFor('u1'), sessionFor('u2')],
    } as any);
    svc.setWorkspaceService({
      listUserWorkspaces: async (userId: string) =>
        userId === 'u1' ? [{ workspaceId: 'wsA' }] : [{ workspaceId: 'wsB' }],
    } as any);

    const resolveSpy = spyOn(svc as any, 'resolveWithSource').mockResolvedValue({
      value: true,
      source: 'workspace',
      type: 'boolean',
    });

    await svc.publishChanges(['voice.enabled']);

    const contexts = resolveSpy.mock.calls.map((c) => c[1]);
    // Sin el fix, ambos contexts serían { userId } sin workspaceId → rojo.
    expect(contexts).toEqual([
      { userId: 'u1', workspaceId: 'wsA' },
      { userId: 'u2', workspaceId: 'wsB' },
    ]);
  });
});
