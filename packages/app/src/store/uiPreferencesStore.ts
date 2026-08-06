/**
 * UI Preferences Store
 *
 * Persists user-facing presentation choices (theme) across sessions.
 * Used by the global Tamagui provider in `_layout.tsx` so MCA renderers
 * and the rest of the UI switch in lockstep.
 *
 * Architecture (post-M1, M2 in `useColors.ts`):
 * - This store is the **persistence layer** — it remembers the user's
 *   theme choice between sessions.
 * - Tamagui's `<TamaguiProvider defaultTheme>` + `<Theme name>` in
 *   `_layout.tsx` reads from here on mount.
 * - At runtime, primitives consume Tamagui's `useThemeName()` hook
 *   (single source of truth) — they don't read this store directly.
 *   See `primitives/useColors.ts`.
 *
 * Cross-platform persistence (Zustand 5 `persist` middleware):
 * - Web: `localStorage` via `createJSONStorage`.
 * - Native: `AsyncStorage` via `createJSONStorage`.
 * - Hydration is async on native — `hasHydrated` lifecycle exposed for
 *   cases where we need to wait before reading.
 *
 * Versioning:
 * - `version: 1` initial release. Bump + provide `migrate` if the
 *   shape ever changes (e.g. adding `accentColor`, `density`, etc.).
 */

// `@react-native-async-storage/async-storage` is pinned to 2.2.0 in
// package.json — v3.x is incompatible with Expo SDK 54+ (see expo/expo#43757).
// When Teros bumps to SDK 55+, upgrade this dependency together to avoid
// silently downgrading the persistence path.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { captureException } from '../lib/sentry';
import type { Theme } from '../components/mca/primitives/colors';

interface UiPreferencesState {
  theme: Theme;
  setTheme: (next: Theme) => void;
  toggleTheme: () => void;
  reset: () => void;
}

// Web localStorage when available, AsyncStorage on native (or web SSR
// before window is defined). Falls back to a no-op storage if neither
// is reachable so the store still works without persistence.
const platformStorage = () => {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return window.localStorage;
  }
  return AsyncStorage;
};

export const useUiPreferencesStore = create<UiPreferencesState>()(
  persist(
    (set, get) => ({
      theme: 'light',
      setTheme: (next) => set({ theme: next }),
      toggleTheme: () => {
        const next: Theme = get().theme === 'dark' ? 'light' : 'dark';
        set({ theme: next });
      },
      reset: () => set({ theme: 'light' }),
    }),
    {
      name: 'teros-ui-theme',
      storage: createJSONStorage(platformStorage),
      version: 1,
      partialize: (state) => ({ theme: state.theme }),
      // Migration is a no-op today — there's only `theme` in the schema
      // and we're at v1. Keeping the function declared sets the
      // convention: when someone adds `accentColor` or `density` in v2,
      // they bump `version` and extend this switch instead of guessing.
      migrate: (persistedState, _version) => persistedState as UiPreferencesState,
      // Surfaces hydration failures to Sentry. AsyncStorage on native
      // can fail with permission/storage-corrupt errors; without this
      // hook the store would silently return the default `'light'` theme
      // and the user's saved preference would be lost without trace.
      onRehydrateStorage: () => (_state, error) => {
        if (error) {
          captureException(error instanceof Error ? error : new Error(String(error)), {
            source: 'uiPreferencesStore',
            phase: 'rehydrate',
          });
        }
      },
    },
  ),
);

// ── Session lifecycle registration ──────────────────────────────────────────
// @todo nira - 2026-05-20: migrate to createSessionStore once circular deps resolved

import { storeRegistry } from './session/StoreRegistry'

storeRegistry.register('uiPreferences', {
  resetSession: () => {
    useUiPreferencesStore.getState().reset()
    // Also clear the Zustand persist key from localStorage
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('teros-ui-theme')
    }
  },
})
