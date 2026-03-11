import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Cross-platform storage service
 * Uses localStorage on web, SecureStore on native (iOS/Android)
 */
export const storage = {
  async getItem(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.localStorage) {
        return localStorage.getItem(key);
      }
      return null;
    }
    // Native: use SecureStore
    try {
      return await SecureStore.getItemAsync(key);
    } catch (error) {
      console.error('SecureStore getItem error:', error);
      return null;
    }
  },

  async setItem(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem(key, value);
      }
      return;
    }
    // Native: use SecureStore
    try {
      await SecureStore.setItemAsync(key, value);
    } catch (error) {
      console.error('SecureStore setItem error:', error);
    }
  },

  async removeItem(key: string): Promise<void> {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.removeItem(key);
      }
      return;
    }
    // Native: use SecureStore
    try {
      await SecureStore.deleteItemAsync(key);
    } catch (error) {
      console.error('SecureStore removeItem error:', error);
    }
  },
};

// Storage keys constants
export const STORAGE_KEYS = {
  USER: 'teros_user',
  SESSION_TOKEN: 'teros_session_token',
  MESSAGE_DRAFTS: 'teros_message_drafts', // Stores drafts per channel
  WORKSPACE_STATE: 'teros_workspace_state', // Stores workspace layout and windows
  NAVBAR_EXPANDED: 'teros_navbar_expanded', // Stores navbar expanded/collapsed state
} as const;
