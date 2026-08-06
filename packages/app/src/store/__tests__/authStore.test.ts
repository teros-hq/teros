/**
 * authStore — auth/session single source of truth.
 *
 * Two risk areas the bugs live in:
 *  - normalizeAuthUser: precedence of nested vs flat/legacy fields, and the
 *    `??` on accessGranted (a `||` would wrongly drop a real `false`).
 *  - updateProfile anti-downgrade: a backend profile sync arriving after a local
 *    complete-onboarding must NOT clear onboardingCompletedAt/termsAcceptedAt, or
 *    the onboarding guard redirect-loops the user (global breakage).
 *  - impersonation: start/stop/meta + hydrate restoring it from storage.
 *
 * authStore imports `services/storage`, which imports react-native (Flow source
 * bun can't parse). We stub storage with an in-memory Map BEFORE importing the
 * store (mock.module + dynamic import — a static import would hoist above the
 * mock and pull in react-native). The Map doubles as a spy on what gets persisted.
 *
 * Runner: bun:test (pure store logic, node-env).
 */
import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'

const mem = new Map<string, unknown>()
const fakeStorage = {
  set: (k: string, v: unknown) => {
    mem.set(k, v)
  },
  get: async (k: string) => mem.get(k) ?? null,
  remove: async (k: string) => {
    mem.delete(k)
  },
}
const AUTH_KEY = 'teros-auth'
mock.module('../../services/storage', () => ({ storage: fakeStorage, STORAGE_KEYS: { AUTH: AUTH_KEY } }))

let mod: typeof import('../authStore')
type User = import('../authStore').User

beforeAll(async () => {
  mod = await import('../authStore')
})

beforeEach(() => {
  mem.clear()
  mod.useAuthStore.setState({
    user: null,
    sessionToken: null,
    isAuthenticated: false,
    isHydrated: false,
    isProfileSynced: false,
    impersonation: null,
  })
})

const auth = () => mod.useAuthStore.getState()

// ============================================================================
// normalizeAuthUser — pure mapping
// ============================================================================

describe('normalizeAuthUser', () => {
  it('prefers token over sessionToken, falling back to empty string', () => {
    expect(mod.normalizeAuthUser({ token: 'A', sessionToken: 'B' }).sessionToken).toBe('A')
    expect(mod.normalizeAuthUser({ sessionToken: 'B' }).sessionToken).toBe('B')
    expect(mod.normalizeAuthUser({}).sessionToken).toBe('')
  })

  it('prefers nested profile fields over the provided fallbacks', () => {
    const withProfile = mod.normalizeAuthUser(
      { user: { profile: { email: 'real@x.com', displayName: 'Real' } } },
      { email: 'fb@x.com', name: 'Fallback' },
    )
    expect(withProfile.user.email).toBe('real@x.com')
    expect(withProfile.user.name).toBe('Real')

    const withFallback = mod.normalizeAuthUser({ user: { profile: {} } }, { email: 'fb@x.com', name: 'Fallback' })
    expect(withFallback.user.email).toBe('fb@x.com')
    expect(withFallback.user.name).toBe('Fallback')

    const empty = mod.normalizeAuthUser({})
    expect(empty.user.email).toBe('')
    expect(empty.user.name).toBe('')
  })

  it('prefers nested role over the legacy flat role', () => {
    expect(mod.normalizeAuthUser({ user: { role: 'admin' }, role: 'user' }).user.role).toBe('admin')
    expect(mod.normalizeAuthUser({ role: 'user' }).user.role).toBe('user')
    expect(mod.normalizeAuthUser({}).user.role).toBeUndefined()
  })

  it('keeps a nested accessGranted:false instead of falling through to the flat field (?? not ||)', () => {
    // The bite: `??` only falls through on null/undefined. A `||` would drop false.
    expect(mod.normalizeAuthUser({ user: { accessGranted: false }, accessGranted: true }).user.accessGranted).toBe(false)
    // undefined nested → falls through to flat.
    expect(mod.normalizeAuthUser({ user: {}, accessGranted: true }).user.accessGranted).toBe(true)
  })

  it('maps a full response to the exact User shape', () => {
    const r = mod.normalizeAuthUser({
      userId: 'user_1',
      token: 'tok',
      user: {
        profile: { email: 'a@x.com', displayName: 'Ana', avatarUrl: 'http://a/x.png' },
        role: 'admin',
        termsAcceptedAt: '2026-01-01T00:00:00Z',
        onboardingCompletedAt: '2026-01-02T00:00:00Z',
        accessGranted: true,
      },
    })
    expect(r).toEqual({
      sessionToken: 'tok',
      user: {
        userId: 'user_1',
        email: 'a@x.com',
        name: 'Ana',
        avatarUrl: 'http://a/x.png',
        role: 'admin',
        termsAcceptedAt: '2026-01-01T00:00:00Z',
        onboardingCompletedAt: '2026-01-02T00:00:00Z',
        accessGranted: true,
      },
    })
  })
})

// ============================================================================
// login / resetSession
// ============================================================================

describe('login / resetSession', () => {
  it('login authenticates and persists user+token', () => {
    auth().login({ userId: 'user_1', email: 'a@x.com' }, 'tok')
    expect(auth().isAuthenticated).toBe(true)
    expect(auth().user).toEqual({ userId: 'user_1', email: 'a@x.com' })
    expect(mem.get(AUTH_KEY)).toEqual({ user: { userId: 'user_1', email: 'a@x.com' }, sessionToken: 'tok' })
  })

  it('resetSession clears state, impersonation and removes storage', async () => {
    auth().login({ userId: 'user_1', email: 'a@x.com' }, 'tok')
    await auth().resetSession()
    expect(auth().user).toBeNull()
    expect(auth().sessionToken).toBeNull()
    expect(auth().isAuthenticated).toBe(false)
    expect(auth().impersonation).toBeNull()
    expect(mem.has(AUTH_KEY)).toBe(false)
  })
})

// ============================================================================
// updateProfile — anti-downgrade (the redirect-loop guard)
// ============================================================================

describe('updateProfile anti-downgrade', () => {
  const baseUser: User = {
    userId: 'user_1',
    email: 'a@x.com',
    onboardingCompletedAt: '2026-01-02T00:00:00Z',
    termsAcceptedAt: '2026-01-01T00:00:00Z',
  }

  it('does NOT clear onboardingCompletedAt when an update omits it as undefined', () => {
    auth().login(baseUser, 'tok')
    // A backend profile sync clearing the field would redirect-loop the user.
    auth().updateProfile({ onboardingCompletedAt: undefined, name: 'Nueva' })
    expect(auth().user?.onboardingCompletedAt).toBe('2026-01-02T00:00:00Z')
    expect(auth().user?.name).toBe('Nueva')
  })

  it('does NOT clear termsAcceptedAt when an update omits it as undefined', () => {
    auth().login(baseUser, 'tok')
    auth().updateProfile({ termsAcceptedAt: undefined })
    expect(auth().user?.termsAcceptedAt).toBe('2026-01-01T00:00:00Z')
  })

  it('DOES apply a newer onboardingCompletedAt (upgrades are not blocked)', () => {
    auth().login({ userId: 'user_1', email: 'a@x.com' }, 'tok')
    auth().updateProfile({ onboardingCompletedAt: '2026-03-03T00:00:00Z' })
    expect(auth().user?.onboardingCompletedAt).toBe('2026-03-03T00:00:00Z')
  })

  it('persists the merged user and is a no-op with no user', () => {
    auth().login(baseUser, 'tok')
    auth().updateProfile({ name: 'Persistida' })
    expect((mem.get(AUTH_KEY) as { user: User }).user.name).toBe('Persistida')

    mod.useAuthStore.setState({ user: null })
    expect(() => auth().updateProfile({ name: 'x' })).not.toThrow()
    expect(auth().user).toBeNull()
  })
})

// ============================================================================
// completeOnboarding
// ============================================================================

describe('completeOnboarding', () => {
  it('stamps onboardingCompletedAt with an ISO string and persists it', () => {
    auth().login({ userId: 'user_1', email: 'a@x.com' }, 'tok')
    auth().completeOnboarding()
    const stamp = auth().user?.onboardingCompletedAt
    expect(typeof stamp).toBe('string')
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect((mem.get(AUTH_KEY) as { user: User }).user.onboardingCompletedAt).toBe(stamp)
  })
})

// ============================================================================
// hydrate
// ============================================================================

describe('hydrate', () => {
  it('restores an authenticated session (with impersonation) from storage', async () => {
    mem.set(AUTH_KEY, {
      user: { userId: 'user_1', email: 'a@x.com' },
      sessionToken: 'tok',
      impersonation: { isImpersonating: true, impersonatedBy: 'user_admin', impersonatedByName: 'Admin' },
    })
    await auth().hydrate()
    expect(auth().isAuthenticated).toBe(true)
    expect(auth().isHydrated).toBe(true)
    expect(auth().user?.userId).toBe('user_1')
    expect(auth().impersonation).toEqual({
      isImpersonating: true,
      impersonatedBy: 'user_admin',
      impersonatedByName: 'Admin',
    })
  })

  it('marks hydrated but unauthenticated when the stored token is missing', async () => {
    mem.set(AUTH_KEY, { user: { userId: 'user_1' }, sessionToken: '' })
    await auth().hydrate()
    expect(auth().isAuthenticated).toBe(false)
    expect(auth().isHydrated).toBe(true)
  })

  it('marks hydrated when there is nothing stored', async () => {
    await auth().hydrate()
    expect(auth().isAuthenticated).toBe(false)
    expect(auth().isHydrated).toBe(true)
  })
})

// ============================================================================
// impersonation
// ============================================================================

describe('impersonation', () => {
  it('startImpersonation swaps user+token and persists the impersonation meta', () => {
    auth().login({ userId: 'user_admin', email: 'admin@x.com', role: 'admin' }, 'admin_tok')
    auth().startImpersonation({ userId: 'user_2', email: 'b@x.com' }, 'imp_tok', {
      impersonatedBy: 'user_admin',
      impersonatedByName: 'Admin',
    })
    expect(auth().user?.userId).toBe('user_2')
    expect(auth().sessionToken).toBe('imp_tok')
    expect(auth().impersonation).toEqual({
      isImpersonating: true,
      impersonatedBy: 'user_admin',
      impersonatedByName: 'Admin',
    })
    // Persisted so the banner reappears on reload (and the impersonated session survives).
    expect(mem.get(AUTH_KEY)).toEqual({
      user: { userId: 'user_2', email: 'b@x.com' },
      sessionToken: 'imp_tok',
      impersonation: { isImpersonating: true, impersonatedBy: 'user_admin', impersonatedByName: 'Admin' },
    })
  })

  it('stopImpersonation clears the meta without touching user or token', () => {
    auth().startImpersonation({ userId: 'user_2', email: 'b@x.com' }, 'imp_tok', {
      impersonatedBy: 'user_admin',
      impersonatedByName: 'Admin',
    })
    auth().stopImpersonation()
    expect(auth().impersonation).toBeNull()
    expect(auth().user?.userId).toBe('user_2') // caller swaps the token via login()
    expect(auth().sessionToken).toBe('imp_tok')
  })

  it('setImpersonationMeta updates the meta and re-persists with the current user', () => {
    auth().login({ userId: 'user_2', email: 'b@x.com' }, 'imp_tok')
    const meta = { isImpersonating: true, impersonatedBy: 'user_admin', impersonatedByName: 'Admin' }
    auth().setImpersonationMeta(meta)
    expect(auth().impersonation).toEqual(meta)
    expect(mem.get(AUTH_KEY)).toEqual({
      user: { userId: 'user_2', email: 'b@x.com' },
      sessionToken: 'imp_tok',
      impersonation: meta,
    })
  })
})
