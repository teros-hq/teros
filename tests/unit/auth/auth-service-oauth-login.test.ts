/**
 * Unit — OAuth login routing & account-linking boundary (TER-450)
 *
 * `AuthService.loginWithOAuth` is a 3-way router that decides, from a
 * provider-verified email, whether to (1) log into an existing OAuth identity,
 * (2) auto-link the OAuth identity to a pre-existing user with the same email,
 * or (3) create a brand-new user. The security-critical invariants:
 *   - auto-link attaches to the EXISTING userId (no duplicate account),
 *   - a `suspended` user can never log in via OAuth (anti account-takeover),
 *   - a new email creates exactly one user + identity.
 *
 * Services are constructed internally from `db`, so we build with a stub db and
 * overwrite the service fields with mocks to exercise the router in isolation.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { ObjectId } from 'mongodb';
import { AuthService } from '../../../packages/backend/src/auth/auth-service';

const PARAMS = {
  provider: 'google' as const,
  providerUserId: 'g-123',
  email: 'User@Test.Local',
  displayName: 'Test User',
};

function makeUser(over: Record<string, unknown> = {}) {
  return {
    userId: 'user_existing',
    status: 'active',
    profile: { email: 'user@test.local', displayName: 'Test User', avatarUrl: undefined },
    ...over,
  };
}

function buildService() {
  const dbStub = { collection: () => ({ createIndex: async () => undefined }) } as any;
  const svc = new AuthService(dbStub);

  const identityService = {
    getByProvider: mock(async () => null as any),
    getAnyByEmail: mock(async () => null as any),
    upsertOAuthIdentity: mock(async () => ({ _id: new ObjectId() })),
  };
  const userService = {
    getByUserId: mock(async () => makeUser()),
    createUser: mock(async () => makeUser({ userId: 'user_new' })),
    updateLastLogin: mock(async () => undefined),
    updateProfile: mock(async () => undefined),
  };
  const sessionService = { createSession: mock(async () => ({ token: 'sess_1' })) };
  const defaultAgentService = { createDefaultAgentIfNeeded: mock(async () => undefined) };

  (svc as any).identityService = identityService;
  (svc as any).userService = userService;
  (svc as any).sessionService = sessionService;
  (svc as any).defaultAgentService = defaultAgentService;

  return { svc, identityService, userService, sessionService, defaultAgentService };
}

describe('loginWithOAuth — routing & linking', () => {
  let h: ReturnType<typeof buildService>;
  beforeEach(() => {
    h = buildService();
  });

  it('logs into an existing OAuth identity (no new user created)', async () => {
    h.identityService.getByProvider = mock(async () => ({ _id: new ObjectId(), userId: 'user_existing' }) as any);
    const res = await h.svc.loginWithOAuth({ ...PARAMS });
    expect(res.success).toBe(true);
    expect(res.session).toBeDefined();
    expect(h.userService.createUser).not.toHaveBeenCalled();
    expect(h.identityService.getAnyByEmail).not.toHaveBeenCalled();
  });

  it('blocks an existing-identity login when the user is suspended', async () => {
    h.identityService.getByProvider = mock(async () => ({ _id: new ObjectId(), userId: 'user_existing' }) as any);
    h.userService.getByUserId = mock(async () => makeUser({ status: 'suspended' }));
    const res = await h.svc.loginWithOAuth({ ...PARAMS });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('account_suspended');
    expect(h.sessionService.createSession).not.toHaveBeenCalled();
  });

  it('returns identity_not_found when the linked user is missing', async () => {
    h.identityService.getByProvider = mock(async () => ({ _id: new ObjectId(), userId: 'user_ghost' }) as any);
    h.userService.getByUserId = mock(async () => null as any);
    const res = await h.svc.loginWithOAuth({ ...PARAMS });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('identity_not_found');
  });

  it('auto-links to the EXISTING user when the email already has an identity (no duplicate user)', async () => {
    h.identityService.getByProvider = mock(async () => null as any);
    h.identityService.getAnyByEmail = mock(async () => ({ userId: 'user_existing' }) as any);
    const res = await h.svc.loginWithOAuth({ ...PARAMS });
    expect(res.success).toBe(true);
    expect(res.user?.userId).toBe('user_existing');
    expect(h.userService.createUser).not.toHaveBeenCalled();
    // The new identity is attached to the existing user id.
    const call = h.identityService.upsertOAuthIdentity.mock.calls[0]?.[0] as any;
    expect(call.userId).toBe('user_existing');
  });

  it('blocks auto-link when the matched user is suspended (anti account-takeover)', async () => {
    h.identityService.getByProvider = mock(async () => null as any);
    h.identityService.getAnyByEmail = mock(async () => ({ userId: 'user_existing' }) as any);
    h.userService.getByUserId = mock(async () => makeUser({ status: 'suspended' }));
    const res = await h.svc.loginWithOAuth({ ...PARAMS });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('account_suspended');
    expect(h.sessionService.createSession).not.toHaveBeenCalled();
  });

  it('creates a new user + identity + default agent for an unseen email', async () => {
    h.identityService.getByProvider = mock(async () => null as any);
    h.identityService.getAnyByEmail = mock(async () => null as any);
    const res = await h.svc.loginWithOAuth({ ...PARAMS });
    expect(res.success).toBe(true);
    expect(h.userService.createUser).toHaveBeenCalledTimes(1);
    expect(h.defaultAgentService.createDefaultAgentIfNeeded).toHaveBeenCalledTimes(1);
    // createUser receives the provider-verified email flag.
    const call = h.userService.createUser.mock.calls[0]?.[0] as any;
    expect(call.emailVerified).toBe(true);
  });

  // --- branches found as surviving mutants in the gap audit ---

  it('returns identity_not_found when the auto-link user disappears mid-flow', async () => {
    // getAnyByEmail matches a userId, but getByUserId then returns null (race/cleanup).
    h.identityService.getByProvider = mock(async () => null as any);
    h.identityService.getAnyByEmail = mock(async () => ({ userId: 'user_existing' }) as any);
    h.userService.getByUserId = mock(async () => null as any);
    const res = await h.svc.loginWithOAuth({ ...PARAMS });
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('identity_not_found');
    expect(h.sessionService.createSession).not.toHaveBeenCalled();
  });

  it('backfills the avatar on existing login when the user has none and the provider sends one', async () => {
    h.identityService.getByProvider = mock(async () => ({ _id: new ObjectId(), userId: 'user_existing' }) as any);
    h.userService.getByUserId = mock(async () => makeUser({ profile: { email: 'user@test.local', displayName: 'Test User', avatarUrl: undefined } }));
    await h.svc.loginWithOAuth({ ...PARAMS, avatarUrl: 'https://provider/pic.png' });
    expect(h.userService.updateProfile).toHaveBeenCalledWith('user_existing', { avatarUrl: 'https://provider/pic.png' });
  });

  it('does NOT overwrite an existing avatar', async () => {
    h.identityService.getByProvider = mock(async () => ({ _id: new ObjectId(), userId: 'user_existing' }) as any);
    h.userService.getByUserId = mock(async () => makeUser({ profile: { email: 'user@test.local', displayName: 'Test User', avatarUrl: 'https://existing/pic.png' } }));
    await h.svc.loginWithOAuth({ ...PARAMS, avatarUrl: 'https://provider/pic.png' });
    expect(h.userService.updateProfile).not.toHaveBeenCalled();
  });
});
