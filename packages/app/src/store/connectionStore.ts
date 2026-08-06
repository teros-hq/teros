/**
 * Connection Store - WebSocket connection state management
 *
 * Handles:
 * - Connection status
 * - Reconnection attempts
 * - Connection errors
 */

import { createSessionStore } from './session/createSessionStore';

interface ConnectionState {
  // State
  isConnected: boolean;
  isConnecting: boolean;
  reconnectAttempts: number;
  error: string | null;

  // Actions
  setConnected: (connected: boolean) => void;
  setConnecting: (connecting: boolean) => void;
  setError: (error: string | null) => void;
  incrementReconnectAttempts: () => void;
  resetReconnectAttempts: () => void;

  /** Reset session — clears all connection state */
  resetSession: () => void;

  // @deprecated Use resetSession() instead — kept for backward compatibility during transition
  reset: () => void;
}

export const useConnectionStore = createSessionStore<ConnectionState>('connection', (set) => ({
  // Initial state
  isConnected: false,
  isConnecting: false,
  reconnectAttempts: 0,
  error: null,

  // Actions
  setConnected: (connected) =>
    set({
      isConnected: connected,
      isConnecting: false,
      error: connected ? null : undefined, // Clear error on successful connection
    }),

  setConnecting: (connecting) =>
    set({
      isConnecting: connecting,
    }),

  setError: (error) =>
    set({
      error,
      isConnecting: false,
    }),

  incrementReconnectAttempts: () =>
    set((state) => ({
      reconnectAttempts: state.reconnectAttempts + 1,
    })),

  resetReconnectAttempts: () =>
    set({
      reconnectAttempts: 0,
    }),

  resetSession: () =>
    set({
      isConnected: false,
      isConnecting: false,
      reconnectAttempts: 0,
      error: null,
    }),

  // Legacy alias — @todo nira - 2026-05-20: remove after all callers migrated
  reset: () => useConnectionStore.getState().resetSession(),
}));
