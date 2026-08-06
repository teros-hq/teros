/**
 * Retention Acknowledgement Store
 *
 * Remembers which 🔴 (trains-on-your-data) models/providers the user has
 * already confirmed via the RetentionConfirmModal, so the blocking dialog
 * fires once per model/provider, not on every re-selection.
 *
 * Keyed by an opaque string: modelId in the model pickers, provider type in
 * onboarding. Persisted across sessions (Zustand `persist`): a choice the user
 * already made consciously shouldn't be re-prompted next launch.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { captureException } from '../lib/sentry';

interface RetentionAckState {
  /** Keys (modelId / provider type) the user has acknowledged. */
  acked: string[];
  isAcked: (key: string) => boolean;
  ack: (key: string) => void;
  reset: () => void;
}

// No-op storage so the store still works (without persistence) when neither
// localStorage nor AsyncStorage is reachable — SSR, tests, opaque-origin jsdom.
const noopStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const platformStorage = () => {
  try {
    if (Platform.OS === 'web') {
      return typeof window !== 'undefined' && window.localStorage ? window.localStorage : noopStorage;
    }
    return AsyncStorage ?? noopStorage;
  } catch {
    return noopStorage;
  }
};

export const useRetentionAckStore = create<RetentionAckState>()(
  persist(
    (set, get) => ({
      acked: [],
      isAcked: (key) => get().acked.includes(key),
      ack: (key) =>
        set((state) => (state.acked.includes(key) ? state : { acked: [...state.acked, key] })),
      reset: () => set({ acked: [] }),
    }),
    {
      name: 'teros-retention-ack',
      storage: createJSONStorage(platformStorage),
      version: 1,
      partialize: (state) => ({ acked: state.acked }),
      onRehydrateStorage: () => (_state, error) => {
        if (error) {
          captureException(error instanceof Error ? error : new Error(String(error)), {
            source: 'retentionAckStore',
            phase: 'rehydrate',
          });
        }
      },
    },
  ),
);

// ── Session lifecycle registration ──────────────────────────────────────────
import { storeRegistry } from './session/StoreRegistry';

storeRegistry.register('retentionAck', {
  resetSession: () => {
    useRetentionAckStore.getState().reset();
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('teros-retention-ack');
    }
  },
});
