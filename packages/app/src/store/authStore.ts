/**
 * Auth Store - User authentication and session management
 *
 * Handles:
 * - User login/logout
 * - Session token persistence
 * - Cross-platform storage (localStorage on web, SecureStore on native)
 */

import { create } from 'zustand';
import { STORAGE_KEYS, storage } from '../services/storage';

const AUTH_STORAGE_KEY = 'teros-auth';
// Legacy key - will be migrated to AUTH_STORAGE_KEY
const LEGACY_USER_KEY = STORAGE_KEYS.USER;

export interface User {
  userId: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  description?: string;
  locale?: string;
  timezone?: string;
  createdAt?: string;
}

interface AuthState {
  // State
  user: User | null;
  sessionToken: string | null;
  isAuthenticated: boolean;
  isHydrated: boolean;

  // Actions
  setUser: (user: User | null) => void;
  setSessionToken: (token: string | null) => void;
  login: (user: User, sessionToken: string) => void;
  logout: () => void;
  hydrate: () => Promise<void>;
  updateProfile: (updates: Partial<Omit<User, 'userId' | 'email'>>) => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  // Initial state
  user: null,
  sessionToken: null,
  isAuthenticated: false,
  isHydrated: false,

  // Actions
  setUser: (user) => {
    set({ user, isAuthenticated: !!user });
    const { sessionToken } = get();
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ user, sessionToken }));
  },

  setSessionToken: (sessionToken) => {
    set({ sessionToken });
    const { user } = get();
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ user, sessionToken }));
  },

  login: (user, sessionToken) => {
    set({
      user,
      sessionToken,
      isAuthenticated: true,
    });
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ user, sessionToken }));
  },

  logout: async () => {
    set({
      user: null,
      sessionToken: null,
      isAuthenticated: false,
    });
    await storage.removeItem(AUTH_STORAGE_KEY);
  },

  updateProfile: (updates) => {
    const { user, sessionToken } = get();
    if (!user) return;

    const updatedUser = { ...user, ...updates };
    set({ user: updatedUser });
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ user: updatedUser, sessionToken }));
  },

  hydrate: async () => {
    try {
      const stored = await storage.getItem(AUTH_STORAGE_KEY);
      let user: User | null = null;
      let sessionToken: string | null = null;

      if (stored) {
        const parsed = JSON.parse(stored);
        user = parsed.user;
        sessionToken = parsed.sessionToken;
      }

      // Also check legacy storage (teros_user) for migration
      // This handles cases where userId is missing from teros-auth
      const legacyStored = await storage.getItem(LEGACY_USER_KEY);
      if (legacyStored) {
        const legacyData = JSON.parse(legacyStored);

        // If we have legacy data with id but current user is missing userId, merge it
        if (legacyData.id) {
          if (!user) {
            // No user in teros-auth, use legacy data
            user = {
              userId: legacyData.id,
              email: legacyData.email || '',
              name: legacyData.displayName || legacyData.name,
              avatarUrl: legacyData.avatarUrl,
            };
            sessionToken = legacyData.sessionToken || sessionToken;
          } else if (!user.userId) {
            // User exists but missing userId, merge from legacy
            user = {
              ...user,
              userId: legacyData.id,
              name: user.name || legacyData.displayName || legacyData.name,
              avatarUrl: user.avatarUrl || legacyData.avatarUrl,
            };
          }

          // Migrate: save unified data to teros-auth
          if (user && sessionToken) {
            storage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ user, sessionToken }));
          }
        }
      }

      set({
        user,
        sessionToken,
        isAuthenticated: !!user,
        isHydrated: true,
      });
    } catch (error) {
      console.error('Failed to hydrate auth from storage:', error);
      set({ isHydrated: true });
    }
  },
}));
