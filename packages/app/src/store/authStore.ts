/**
 * Auth Store - Single source of truth for user authentication and session.
 *
 * Rules:
 * - This is the ONLY place that reads/writes auth storage.
 * - All components read from useAuthStore(), never from storage directly.
 * - Storage key: 'teros-auth'
 *
 * Security: The sessionToken is kept ONLY in Zustand in-memory state.
 * It is never persisted to localStorage, sessionStorage, or any other
 * persistent storage on web. This prevents XSS exfiltration of the token
 * via localStorage access. Only the non-sensitive user profile (name,
 * email, avatar, role, onboarding state) is persisted for hydration.
 * On page reload, the user must re-authenticate to obtain a new token.
 */

import { createSessionStore } from './session/createSessionStore'
import { destroySession } from './session/SessionManager'
import { suppressAutologinAfterSignOut } from "../lib/dev-autologin"
import { storage, STORAGE_KEYS, shouldPersistSessionToken } from "../services/storage"

/**
 * Broadcast the session token to other tabs via BroadcastChannel.
 * On web, the token is in-memory only, so we need this channel to notify
 * other open tabs when a login occurs (e.g. OAuth popup completes).
 * On native this is a no-op (BroadcastChannel doesn't exist).
 */
let _authChannel: BroadcastChannel | null = null
function getAuthChannel(): BroadcastChannel | null {
  if (_authChannel) return _authChannel
  if (typeof BroadcastChannel !== "undefined") {
    _authChannel = new BroadcastChannel("teros-auth")
  }
  return _authChannel
}

function broadcastAuthLogin(sessionToken: string) {
  const channel = getAuthChannel()
  if (channel) {
    channel.postMessage({ type: "auth_login", sessionToken })
  }
}

/**
 * Lazy access to the session-cookie service (web session persistence,
 * Req 6.6.1). Lazy require so this store stays importable in Bun tests,
 * where the service's react-native import can't be parsed.
 */
function sessionCookieService(): typeof import("../services/sessionCookie") | null {
  try {
    return require("../services/sessionCookie")
  } catch {
    return null
  }
}

/**
 * Build the persisted auth payload.
 *
 * On native (SecureStorage) the sessionToken is included so the session
 * survives app restarts. On web the token is omitted — it lives only in
 * Zustand in-memory state to prevent XSS exfiltration via localStorage.
 */
function buildPersistedAuth(user: User, sessionToken: string | null, impersonation?: ImpersonationMeta | null) {
  return shouldPersistSessionToken
    ? { user, sessionToken, ...(impersonation ? { impersonation } : {}) }
    : { user, ...(impersonation ? { impersonation } : {}) }
}

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
      edition?: "self-hosted" | "cloud"
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
      // ONB-REQ-1: edition arrives with every auth result (login, signup, OAuth, cookie restore).
      ...(data.user?.edition ? { edition: data.user.edition } : {}),
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
  /** Deployment edition from profile.get (ONB-REQ-1); unset until the profile syncs. */
  edition?: "self-hosted" | "cloud"
  /** ID of the last changelog entry the user has seen (for "What's New" modal) */
  lastChangelogSeen?: string
  /** Show the agent's summary on a new conversation (CSUM-REQ-3); unset until the profile syncs. */
  conversationSummary?: boolean
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
  /**
   * F2: true when the session was restored from the httpOnly cookie after a
   * reload — there is no in-memory token, the WS authenticates with auth
   * method "cookie" and HTTP calls send the cookie (credentials: 'include').
   */
  cookieAuth: boolean
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
  cookieAuth: false,
  isHydrated: false,
  isProfileSynced: false,
  impersonation: null,

  login: (user, sessionToken) => {
    set({ user, sessionToken, isAuthenticated: true, cookieAuth: false })
    storage.set(STORAGE_KEYS.AUTH, buildPersistedAuth(user, sessionToken))
    broadcastAuthLogin(sessionToken)
    // Web: persist the token in the backend's httpOnly cookie so the session
    // survives page reloads (the token itself is never written to storage).
    if (!shouldPersistSessionToken) {
      sessionCookieService()?.installSessionCookie(sessionToken)
    }
  },

  resetSession: async () => {
    set({ user: null, sessionToken: null, isAuthenticated: false, cookieAuth: false, isProfileSynced: false, impersonation: null })
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
  // and clears Sentry.
  logout: async () => {
    // Signing out against an auto-login backend must not sign straight back in (ALOGIN-REQ-7)
    suppressAutologinAfterSignOut()
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
    storage.set(STORAGE_KEYS.AUTH, buildPersistedAuth(updatedUser, sessionToken))
  },

  setProfileSynced: () => set({ isProfileSynced: true }),

  completeOnboarding: () => {
    const { user, sessionToken } = get()
    if (!user) return
    const updatedUser = { ...user, onboardingCompletedAt: new Date().toISOString() }
    set({ user: updatedUser })
    storage.set(STORAGE_KEYS.AUTH, buildPersistedAuth(updatedUser, sessionToken))
  },

  hydrate: async () => {
    try {
      const stored = await storage.get<{ user: User; sessionToken?: string; impersonation?: ImpersonationMeta }>(STORAGE_KEYS.AUTH)
      if (stored?.user?.userId && stored.sessionToken) {
        // Native path: token was persisted in SecureStorage — full session restore
        const { user, sessionToken, impersonation } = stored
        set({ user, sessionToken, isAuthenticated: true, isHydrated: true, impersonation: impersonation ?? null })
        return
      }

      // Web path: the token is in-memory only, so after a reload it's gone.
      // Try to restore the session STATE from the backend's httpOnly cookie
      // before giving up (Req 6.6.1). This runs even with empty storage: the
      // cookie is the source of truth for "am I still logged in" on web.
      // F2: the restore carries NO token — the session is marked cookieAuth
      // and the WS authenticates with auth method "cookie" instead.
      if (!shouldPersistSessionToken) {
        const restored = await sessionCookieService()?.restoreSessionFromCookie()
        if (restored) {
          const { user } = normalizeAuthUser(restored, {
            email: stored?.user?.email,
            name: stored?.user?.name,
          })
          const impersonation = restored.impersonation ?? null
          set({ user, sessionToken: null, isAuthenticated: true, cookieAuth: true, isHydrated: true, impersonation })
          storage.set(STORAGE_KEYS.AUTH, buildPersistedAuth(user, null, impersonation))
          return
        }
      }

      if (stored?.user?.userId) {
        // No token anywhere: restore the user object so the UI can show profile
        // data on the login screen, but the user must re-authenticate.
        set({ user: stored.user, sessionToken: null, isAuthenticated: false, isHydrated: true, impersonation: null })
        return
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
    // Persist user + impersonation meta (token only on native via buildPersistedAuth)
    storage.set(STORAGE_KEYS.AUTH, buildPersistedAuth(targetUser, impersonationToken, impersonation))
    broadcastAuthLogin(impersonationToken)
    // Web: the cookie must follow the active token so a reload restores the
    // impersonated session, not the admin's.
    if (!shouldPersistSessionToken) {
      sessionCookieService()?.installSessionCookie(impersonationToken)
    }
  },

  stopImpersonation: () => {
    // Token has already been swapped by the caller via login()
    set({ impersonation: null })
  },

  setImpersonationMeta: (meta) => {
    // Called when auth_success arrives with impersonation field (e.g. after reconnect)
    const { user, sessionToken } = get()
    set({ impersonation: meta })
    if (user) {
      storage.set(STORAGE_KEYS.AUTH, buildPersistedAuth(user, sessionToken, meta))
    }
  },
}))
