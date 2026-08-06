/**
 * WS profile handlers — contract-boundary (TER-468, grupo config/acceso).
 *
 * profile es user-sovereign: TODO opera sobre ctx.userId, nunca acepta un
 * userId de params (no se puede leer/editar el perfil de otro). Cubre get
 * (shape + USER_NOT_FOUND), update (INVALID_UPDATE + usa ctx.userId) y stats
 * (cuenta scopeado a ctx.userId). Handlers mockeados.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { WsHandlerContext } from '@teros/shared';
import { createGetProfileHandler } from '../../src/handlers/domains/profile/get';
import { createUpdateProfileHandler } from '../../src/handlers/domains/profile/update';
import { createGetProfileStatsHandler } from '../../src/handlers/domains/profile/stats';
import { createAcceptTermsHandler } from '../../src/handlers/domains/profile/accept-terms';
import { createCompleteOnboardingHandler } from '../../src/handlers/domains/profile/complete-onboarding';
import { createOnboardingStatusHandler } from '../../src/handlers/domains/profile/onboarding-status';

const ctx = (userId: string): WsHandlerContext => ({ userId, sessionId: 's', connectionId: 'c' }) as any;

const USER = {
  userId: 'u1',
  profile: { displayName: 'Ada', email: 'ada@x.com', avatarUrl: 'a.png', description: 'd', locale: 'es', timezone: 'Europe/Madrid' },
  createdAt: new Date('2026-01-01T00:00:00Z'),
  termsAcceptedAt: new Date('2026-02-01T00:00:00Z'),
  onboardingCompletedAt: undefined,
  accessGranted: true,
  badges: ['founding_partner'],
};

describe('profile.get', () => {
  it('devuelve el perfil del ctx.userId con shape exacto', async () => {
    const userService = { getByUserId: mock(async (id: string) => (id === 'u1' ? USER : null)) } as any;
    const handler = createGetProfileHandler(userService);
    const res: any = await handler(ctx('u1'));

    expect(userService.getByUserId).toHaveBeenCalledWith('u1');
    expect(res).toEqual({
      userId: 'u1',
      displayName: 'Ada',
      email: 'ada@x.com',
      avatarUrl: 'a.png',
      description: 'd',
      locale: 'es',
      timezone: 'Europe/Madrid',
      createdAt: '2026-01-01T00:00:00.000Z',
      termsAcceptedAt: '2026-02-01T00:00:00.000Z',
      onboardingCompletedAt: undefined,
      accessGranted: true,
      badges: ['founding_partner'],
    });
  });

  it('USER_NOT_FOUND si el usuario no existe', async () => {
    const handler = createGetProfileHandler({ getByUserId: mock(async () => null) } as any);
    await expect(handler(ctx('ghost'))).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('siempre consulta por ctx.userId (user-sovereign — no hay forma de pedir otro perfil)', async () => {
    const userService = { getByUserId: mock(async () => USER) } as any;
    const handler = createGetProfileHandler(userService);
    // Aunque un cliente malicioso mande userId en el payload, get() no recibe params.
    await handler(ctx('u_caller'));
    expect(userService.getByUserId).toHaveBeenCalledWith('u_caller');
  });
});

describe('profile.update', () => {
  it('INVALID_UPDATE si no hay campos', async () => {
    const handler = createUpdateProfileHandler({ updateProfile: mock(async () => USER) } as any);
    await expect(handler(ctx('u1'), {})).rejects.toMatchObject({ code: 'INVALID_UPDATE' });
  });

  it('actualiza SOLO el perfil del ctx.userId con los campos permitidos', async () => {
    const userService = {
      updateProfile: mock(async (id: string, updates: any) => ({
        userId: id,
        profile: { displayName: updates.displayName ?? 'Ada', email: 'ada@x.com', ...updates },
        createdAt: new Date('2026-01-01T00:00:00Z'),
      })),
    } as any;
    const handler = createUpdateProfileHandler(userService);
    await handler(ctx('u1'), { displayName: 'Ada Lovelace', timezone: 'UTC' });

    expect(userService.updateProfile).toHaveBeenCalledWith('u1', {
      displayName: 'Ada Lovelace',
      avatarUrl: undefined,
      description: undefined,
      locale: undefined,
      timezone: 'UTC',
    });
  });
});

describe('profile.stats', () => {
  it('cuenta channels (userId) y agents (ownerId) scopeado al ctx.userId', async () => {
    const counts: Record<string, any> = {};
    const db = {
      collection: (name: string) => ({
        countDocuments: mock(async (filter: any) => {
          counts[name] = filter;
          return name === 'channels' ? 5 : 2;
        }),
      }),
    } as any;
    const handler = createGetProfileStatsHandler(db);
    const res: any = await handler(ctx('u1'));

    expect(res).toEqual({ channelCount: 5, agentCount: 2 });
    expect(counts.channels).toEqual({ userId: 'u1' });
    expect(counts.agents).toEqual({ ownerId: 'u1' });
  });
});

describe('profile.accept-terms — user-sovereign', () => {
  it('llama acceptTerms(ctx.userId) y devuelve termsAcceptedAt en ISO', async () => {
    const userService = {
      acceptTerms: mock(async (id: string) =>
        id === 'u1' ? { termsAcceptedAt: new Date('2026-03-01T00:00:00Z') } : null,
      ),
    } as any;
    const handler = createAcceptTermsHandler(userService);
    const res = await handler(ctx('u1'));
    expect(userService.acceptTerms).toHaveBeenCalledWith('u1');
    expect(res).toEqual({ termsAcceptedAt: '2026-03-01T00:00:00.000Z' });
  });

  it('USER_NOT_FOUND si el usuario no existe', async () => {
    const handler = createAcceptTermsHandler({ acceptTerms: mock(async () => null) } as any);
    await expect(handler(ctx('ghost'))).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });
});

describe('profile.complete-onboarding — user-sovereign', () => {
  it('llama completeOnboarding(ctx.userId) y devuelve onboardingCompletedAt en ISO', async () => {
    const userService = {
      completeOnboarding: mock(async (id: string) =>
        id === 'u1' ? { onboardingCompletedAt: new Date('2026-03-02T00:00:00Z') } : null,
      ),
    } as any;
    const handler = createCompleteOnboardingHandler(userService);
    const res = await handler(ctx('u1'));
    expect(userService.completeOnboarding).toHaveBeenCalledWith('u1');
    expect(res).toEqual({ onboardingCompletedAt: '2026-03-02T00:00:00.000Z' });
  });

  it('USER_NOT_FOUND si el usuario no existe', async () => {
    const handler = createCompleteOnboardingHandler({ completeOnboarding: mock(async () => null) } as any);
    await expect(handler(ctx('ghost'))).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });
});

describe('profile.onboarding-status — todos los counts scopeados a ctx.userId', () => {
  it('cada colección se filtra por el userId del ctx (nunca por otro) + shape de booleans', async () => {
    const filters: Record<string, any> = {};
    const countByCollection: Record<string, number> = {
      user_providers: 1,
      user_credentials: 0,
      agent_app_access: 2,
      messages: 0,
    };
    const db = {
      collection: (name: string) => ({
        countDocuments: mock(async (filter: any) => {
          filters[name] = filter;
          return countByCollection[name] ?? 0;
        }),
      }),
    } as any;
    const userService = {
      getByUserId: mock(async () => ({ userId: 'u1', onboardingCompletedAt: new Date('2026-01-01') })),
    } as any;
    const handler = createOnboardingStatusHandler(db, userService);
    const res: any = await handler(ctx('u1'));

    expect(userService.getByUserId).toHaveBeenCalledWith('u1');
    // El scoping: si alguno dejara de filtrar por el ctx.userId, este toEqual cae.
    expect(filters.user_providers).toEqual({ userId: 'u1', status: 'active' });
    expect(filters.user_credentials).toEqual({ userId: 'u1' });
    expect(filters.agent_app_access).toEqual({ ownerId: 'u1' });
    expect(filters.messages).toEqual({ userId: 'u1', role: 'user' });
    // El shape: cada flag es count > 0 (no >= 0), onboarding sale del user doc.
    expect(res).toEqual({
      hasProvider: true,
      hasOnboardingCompleted: true,
      hasAppWithCredentials: false,
      hasAppAssigned: true,
      hasFirstMessage: false,
    });
  });

  it('hasOnboardingCompleted=false si el user no tiene onboardingCompletedAt', async () => {
    const db = { collection: () => ({ countDocuments: mock(async () => 0) }) } as any;
    const userService = { getByUserId: mock(async () => ({ userId: 'u1' })) } as any;
    const handler = createOnboardingStatusHandler(db, userService);
    const res: any = await handler(ctx('u1'));
    expect(res.hasOnboardingCompleted).toBe(false);
  });
});
