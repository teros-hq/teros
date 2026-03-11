/**
 * Connection Store - WebSocket connection state management
 *
 * Handles:
 * - Connection status
 * - Reconnection attempts
 * - Connection errors
 */

import { create } from 'zustand';

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
  reset: () => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
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

  reset: () =>
    set({
      isConnected: false,
      isConnecting: false,
      reconnectAttempts: 0,
      error: null,
    }),
}));
