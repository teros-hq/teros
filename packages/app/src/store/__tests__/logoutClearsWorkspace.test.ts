/**
 * Regression test — logout must tear down the ENTIRE session, not just auth.
 *
 * Bug (workspace-persists-after-logout): authStore.logout() was a legacy alias
 * that called only the auth store's own resetSession(), clearing the AUTH key
 * but leaving every other registered store's storage intact. In particular the
 * workspace store's ACTIVE_WORKSPACE / LAST_ACTIVE_WORKSPACE keys survived
 * logout, so when a different account logged in, hydrateActiveWorkspace()
 * restored the previous account's workspace and scoped its API calls to a
 * workspace it was not authorized for — every action then failed.
 *
 * Fix: logout() now delegates to destroySession(), which runs
 * storeRegistry.resetAll() (resetting the workspace store) plus storage.clearAll().
 *
 * This test asserts that calling logout() invokes the reset path for a
 * registered non-auth store (mimicking the workspace store), which the old
 * auth-only logout never did.
 *
 * Runner: bun:test. Storage + transport + sentry are lazily required by
 * SessionManager and stubbed here so no react-native is pulled in.
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
  clearAll: async () => {
    mem.clear()
  },
}
const AUTH_KEY = 'teros-auth'
const ACTIVE_WORKSPACE_KEY = 'teros_active_workspace_id'
const LAST_ACTIVE_WORKSPACE_KEY = 'teros_last_active_workspace_id'

mock.module('../../services/storage', () => ({
  storage: fakeStorage,
  STORAGE_KEYS: {
    AUTH: AUTH_KEY,
    ACTIVE_WORKSPACE: ACTIVE_WORKSPACE_KEY,
    LAST_ACTIVE_WORKSPACE: LAST_ACTIVE_WORKSPACE_KEY,
  },
}))

let authMod: typeof import('../authStore')
let registryMod: typeof import('../session/StoreRegistry')

beforeAll(async () => {
  registryMod = await import('../session/StoreRegistry')
  authMod = await import('../authStore')
})

beforeEach(() => {
  mem.clear()
  authMod.useAuthStore.setState({
    user: null,
    sessionToken: null,
    isAuthenticated: false,
    isHydrated: false,
    isProfileSynced: false,
    impersonation: null,
  })
})

describe('logout clears the full session (workspace contamination guard)', () => {
  it('logout() resets a registered non-auth store, not just auth', async () => {
    let workspaceReset = false
    // Mimic the workspace store's registry entry: clears its persisted keys.
    registryMod.storeRegistry.register('workspace', {
      resetSession: async () => {
        workspaceReset = true
        await fakeStorage.remove(ACTIVE_WORKSPACE_KEY)
        await fakeStorage.remove(LAST_ACTIVE_WORKSPACE_KEY)
      },
    })

    // Simulate account A: authenticated + an active workspace persisted.
    authMod.useAuthStore.getState().login({ userId: 'user_A', email: 'a@x.com' }, 'tok_A')
    mem.set(ACTIVE_WORKSPACE_KEY, 'ws_SIG_2')
    mem.set(LAST_ACTIVE_WORKSPACE_KEY, 'ws_SIG_2')

    // Logout.
    await authMod.useAuthStore.getState().logout()

    // The workspace store's reset ran (the bug: it never did) ...
    expect(workspaceReset).toBe(true)
    // ... and the leaked workspace keys are gone, so account B starts clean.
    expect(mem.has(ACTIVE_WORKSPACE_KEY)).toBe(false)
    expect(mem.has(LAST_ACTIVE_WORKSPACE_KEY)).toBe(false)
    // Auth is cleared too.
    expect(authMod.useAuthStore.getState().isAuthenticated).toBe(false)
  })
})
