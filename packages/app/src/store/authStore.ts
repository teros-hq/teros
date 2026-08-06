/**
 * Auth Store - Single source of truth for user authentication and session.
 *
 * Rules:
 * - This is the ONLY place that reads/writes auth storage.
 * - All components read from useAuthStore(), never from storage directly.
 * - Storage key: 'teros-auth'
 */

import { createSessionStore } from './session/createSessionStore'
import { destroySession } from './session/SessionManager'
import { storage, STORAGE_KEYS } from "../services/storage"

/**
 * Normalize any auth response (email login, signup, OAuth popup) into a User object.
 * Single source of truth for how we extract user data from backend responses.
 */
export function normalizeAuthUser(
  data: {
    userId?: string
    user?: {
      profile?: { displayName?: string; email?: string; avatarUrl?: string; locale?: string; timezone?: string }
      role?: string
      termsAcceptedAt?: string
      onboardingCompletedAt?: string
      accessGranted?: boolean
      lastChangelogSeen?: string
    }
    // Legacy / flat fields some flows still return
    role?: string
    token?: string
    sessionToken?: string
    accessGranted?: boolean
  },
  fallbacks?: { email?: string; name?: string },
): { user: User; sessionToken: string } {
  return {
    sessionToken: data.token || data.sessionToken || "",
    user: {
      userId: data.userId || "",
      email: data.user?.profile?.email || fallbacks?.email || "",
      name: data.user?.profile?.displayName || fallbacks?.name || "",
      avatarUrl: data.user?.profile?.avatarUrl,
      role: data.user?.role || data.role,
      termsAcceptedAt: data.user?.termsAcceptedAt,
      onboardingCompletedAt: data.user?.onboardingCompletedAt,
      accessGranted: data.user?.accessGranted ?? data.accessGranted,
      lastChangelogSeen: data.user?.lastChangelogSeen,
      locale: data.user?.profile?.locale,
    },
  }
}



export interface User {
  userId: string
  email: string
  name?: string
  avatarUrl?: string
  description?: string
  locale?: string
  timezone?: string
  createdAt?: string
  termsAcceptedAt?: string
  /** ISO string set when the user completes the onboarding wizard */
  onboardingCompletedAt?: string
  role?: string
  accessGranted?: boolean
  /** ID of the last changelog entry the user has seen (for "What's New" modal) */
  lastChangelogSeen?: string
}

export interface ImpersonationMeta {
  isImpersonating: boolean
  impersonatedBy: string
  impersonatedByName: string
}

interface AuthState {
  user: User | null
  sessionToken: string | null
  isAuthenticated: boolean
  /** True once hydrate() has finished — gate renders that need auth state on this */
  isHydrated: boolean
  /**
   * True once the profile has been synced from the backend (profile.get on WS connect).
   * The onboarding guard must wait for this before redirecting, to avoid false redirects
   * when onboardingCompletedAt is missing from localStorage but present on the server.
   */
  isProfileSynced: boolean
  setProfileSynced: () => void

  /**
   * Impersonation state — only stored in memory, never persisted.
   * Set when an admin is impersonating another user.
   */
  impersonation: ImpersonationMeta | null

  login: (user: User, sessionToken: string) => void
  logout: () => Promise<void>
  hydrate: () => Promise<void>

  /** Reset session — clears auth state and storage */
  resetSession: () => Promise<void>

  updateProfile: (updates: Partial<Omit<User, "userId" | "email">>) => void
  /** Called after profile.complete-onboarding succeeds. Persists to storage. */
  completeOnboarding: () => void

  /**
   * Called after a successful admin.impersonate response.
   * Swaps the session to the impersonated user — does NOT persist.
   */
  startImpersonation: (
    targetUser: User,
    impersonationToken: string,
    meta: { impersonatedBy: string; impersonatedByName: string },
  ) => void

  /**
   * Called after a successful admin.stop-impersonation response.
   * Clears impersonation state — the caller is responsible for swapping the token.
   */
  stopImpersonation: () => void

  /**
   * Called when auth_success arrives with an `impersonation` field.
   * Updates the impersonation meta without touching the user/token.
   */
  setImpersonationMeta: (meta: ImpersonationMeta) => void
}

export const useAuthStore = createSessionStore<AuthState>('auth', (set, get) => ({
  user: null,
  sessionToken: null,
  isAuthenticated: false,
  isHydrated: false,
  isProfileSynced: false,
  impersonation: null,

  login: (user, sessionToken) => {
    set({ user, sessionToken, isAuthenticated: true })
    storage.set(STORAGE_KEYS.AUTH, { user, sessionToken })
  },

  resetSession: async () => {
    set({ user: null, sessionToken: null, isAuthenticated: false, isProfileSynced: false, impersonation: null })
    await storage.remove(STORAGE_KEYS.AUTH)
  },

  // Logout tears down the ENTIRE session, not just auth state.
  // Delegates to destroySession() so the whole store registry is reset —
  // critically the workspace store, whose ACTIVE_WORKSPACE / LAST_ACTIVE_WORKSPACE
  // storage keys would otherwise survive logout and leak into the next account's
  // session (re-hydrated by hydrateActiveWorkspace), scoping API calls to a
  // workspace the new account is not authorized for.
  // destroySession() resets all registered stores (including this auth store,
  // registered as 'auth'), calls storage.clearAll(), tears down the transport,
  // and clears Sentry/analytics.
  logout: async () => {
    await destroySession()
  },

  updateProfile: (updates) => {
    const { user, sessionToken } = get()
    if (!user) return
    // Never downgrade onboardingCompletedAt — if it's already set locally, keep it.
    // This prevents a race where the backend profile sync arrives before the
    // complete-onboarding call has been processed, clearing the local value and
    // causing the onboarding guard to redirect the user back to onboarding.
    // NEVER clear these critical fields once set locally.
    // This prevents race conditions where a backend profile sync arrives before
    // a recent mutation (complete-onboarding / accept-terms) has been processed,
    // which would clear the local value and cause redirect loops.
    const safeUpdates = { ...updates }
    if (user.onboardingCompletedAt && !safeUpdates.onboardingCompletedAt) {
      delete safeUpdates.onboardingCompletedAt
    }
    if (user.termsAcceptedAt && !safeUpdates.termsAcceptedAt) {
      delete safeUpdates.termsAcceptedAt
    }
    const updatedUser = { ...user, ...safeUpdates }
    set({ user: updatedUser })
    storage.set(STORAGE_KEYS.AUTH, { user: updatedUser, sessionToken })
  },

  setProfileSynced: () => set({ isProfileSynced: true }),

  completeOnboarding: () => {
    const { user, sessionToken } = get()
    if (!user) return
    const updatedUser = { ...user, onboardingCompletedAt: new Date().toISOString() }
    set({ user: updatedUser })
    storage.set(STORAGE_KEYS.AUTH, { user: updatedUser, sessionToken })
  },

  hydrate: async () => {
    try {
      const stored = await storage.get<{ user: User; sessionToken: string; impersonation?: ImpersonationMeta }>(STORAGE_KEYS.AUTH)
      if (stored) {
        const { user, sessionToken, impersonation } = stored
        if (user?.userId && sessionToken) {
          set({ user, sessionToken, isAuthenticated: true, isHydrated: true, impersonation: impersonation ?? null })
          return
        }
      }
    } catch (error) {
      console.error("[AuthStore] Failed to hydrate:", error)
    }
    set({ isHydrated: true })
  },

  startImpersonation: (targetUser, impersonationToken, meta) => {
    const impersonation: ImpersonationMeta = {
      isImpersonating: true,
      impersonatedBy: meta.impersonatedBy,
      impersonatedByName: meta.impersonatedByName,
    }
    set({ user: targetUser, sessionToken: impersonationToken, isAuthenticated: true, impersonation })
    // Persist exactly like login — on reload the token is still valid and the banner reappears
    storage.set(STORAGE_KEYS.AUTH, { user: targetUser, sessionToken: impersonationToken, impersonation })
  },

  stopImpersonation: () => {
    // Token has already been swapped by the caller via login()
    set({ impersonation: null })
  },

  setImpersonationMeta: (meta) => {
    // Called when auth_success arrives with impersonation field (e.g. after reconnect)
    const { user, sessionToken } = get()
    set({ impersonation: meta })
    if (user && sessionToken) {
      storage.set(STORAGE_KEYS.AUTH, { user, sessionToken, impersonation: meta })
    }
  },
}))
