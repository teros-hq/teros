import AsyncStorage from '@react-native-async-storage/async-storage'
import { Platform } from 'react-native'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { storeRegistry } from './session/StoreRegistry'

export interface PendingAudio {
  base64Data: string
  mimeType: string
  duration: number
  timestamp: number
}

interface AudioStoreState {
  pendingAudio: Record<string, PendingAudio>
  savePendingAudio: (channelId: string, audio: PendingAudio) => void
  clearPendingAudio: (channelId: string) => void
  resetSession: () => void
}

const MAX_BASE64_SIZE = 4 * 1024 * 1024
const EXPIRY_MS = 5 * 60 * 1000

const platformStorage = () => {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return window.localStorage
  }
  return AsyncStorage
}

export const useAudioStore = create<AudioStoreState>()(
  persist(
    (set) => ({
      pendingAudio: {},

      savePendingAudio: (channelId, audio) => {
        if (audio.base64Data.length > MAX_BASE64_SIZE) {
          console.warn('[audioStore] Audio too large to persist:', audio.base64Data.length)
          return
        }
        set((state) => ({
          pendingAudio: { ...state.pendingAudio, [channelId]: audio },
        }))
      },

      clearPendingAudio: (channelId) =>
        set((state) => {
          const { [channelId]: _, ...rest } = state.pendingAudio
          return { pendingAudio: rest }
        }),

      resetSession: () => set({ pendingAudio: {} }),
    }),
    {
      name: 'teros-pending-audio',
      storage: createJSONStorage(platformStorage),
      version: 1,
      partialize: (state) => ({ pendingAudio: state.pendingAudio }),
      migrate: (persistedState) => persistedState as AudioStoreState,
    },
  ),
)

export function getPendingAudio(channelId: string): PendingAudio | null {
  const entry = useAudioStore.getState().pendingAudio[channelId]
  if (!entry) return null
  if (Date.now() - entry.timestamp > EXPIRY_MS) {
    useAudioStore.getState().clearPendingAudio(channelId)
    return null
  }
  return entry
}

storeRegistry.register('audio', {
  resetSession: () => {
    useAudioStore.getState().resetSession()
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('teros-pending-audio')
    }
  },
})
