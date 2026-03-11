/**
 * Workspace Layout - Tiling Window Manager
 *
 * Este layout envuelve todas las rutas del workspace.
 * Renderiza el TilingLayout y maneja:
 * - Autenticación
 * - Auto-guardado del estado
 * - Listeners globales (channel status, typing)
 * - Sincronización de URL con ventana activa
 *
 * Las rutas hijas (chat/[channelId], apps, etc.) solo disparan
 * la apertura/enfoque de ventanas, no renderizan nada.
 */

import { Slot, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { YStack } from 'tamagui';
import { AccessGate } from '../../src/components/AccessGate';
import { Navbar } from '../../src/components/Navbar';
import { TilingLayout } from '../../src/components/workspace/TilingLayout';
import { useUrlSync } from '../../src/hooks';
import { STORAGE_KEYS, storage } from '../../src/services/storage';
import { useChatStore } from '../../src/store/chatStore';
import { useNavbarStore } from '../../src/store/navbarStore';
import { useTilingStore } from '../../src/store/tilingStore';
import { VoiceSessionProvider } from '../../src/contexts/VoiceSessionContext';
import { getTerosClient } from '../_layout';
import { useWorkspaceReady as useWorkspaceReadyHook, WorkspaceContext } from './workspaceContext';

// Re-export for backward compatibility
export { useWorkspaceReadyHook as useWorkspaceReady };

/** Debounce delay for auto-save (ms) */
const AUTO_SAVE_DELAY = 1000;

export default function WorkspaceLayout() {
  const [user, setUser] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);

  const router = useRouter();
  const client = getTerosClient();
  const insets = useSafeAreaInsets();

  // Workspace state for auto-save
  const desktops = useTilingStore((state) => state.desktops);
  const windows = useTilingStore((state) => state.windows);
  const loadState = useTilingStore((state) => state.loadState);
  const saveState = useTilingStore((state) => state.saveState);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isFirstRender = useRef(true);

  // Sync URL with active window
  useUrlSync(workspaceLoaded);

  // Load user
  useEffect(() => {
    const loadUser = async () => {
      try {
        const savedUser = await storage.getItem(STORAGE_KEYS.USER);
        if (savedUser) {
          setUser(JSON.parse(savedUser));
        } else {
          router.replace('/(auth)/login');
        }
      } catch (e) {
        console.error('Failed to load user:', e);
        router.replace('/(auth)/login');
      } finally {
        setIsLoading(false);
      }
    };
    loadUser();
  }, []);

  // TODO: Implement /api/users/me endpoint to refresh user role from backend
  // For now, user role is set during login and persisted in storage

  // Load workspace state on mount
  useEffect(() => {
    const loadWorkspace = async () => {
      await loadState();
      setWorkspaceLoaded(true);
    };
    loadWorkspace();
  }, []);

  // Auto-save workspace state when it changes (debounced)
  useEffect(() => {
    // Skip first render and wait until workspace is loaded
    if (isFirstRender.current || !workspaceLoaded) {
      isFirstRender.current = false;
      return;
    }

    // Clear previous timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Schedule save
    saveTimeoutRef.current = setTimeout(() => {
      saveState();
    }, AUTO_SAVE_DELAY);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [desktops, windows, workspaceLoaded]);

  // Global listener for channel_list_status to update chatStore
  // This ensures all tabs (even inactive ones) get updated states
  useEffect(() => {
    const handleChannelListStatus = (data: any) => {
      const { channelId, action, channel } = data;

      if (!channelId) return;

      // Update chatStore with channel status changes
      if (action === 'updated' && channel) {
        const updates: any = {};
        if (channel.title !== undefined) updates.title = channel.title;
        if (channel.isTyping !== undefined) updates.isTyping = channel.isTyping;
        if (channel.externalActionRequested !== undefined)
          updates.externalActionRequested = channel.externalActionRequested;

        if (Object.keys(updates).length > 0) {
          useChatStore.getState().updateChannel(channelId, updates);
        }
      } else if (action === 'created' && channel) {
        // New channel - add to store
        useChatStore.getState().setChannel({
          channelId,
          title: channel.title || 'Nuevo chat',
          agentId: channel.agentId || '',
          agentName: '',
          agentAvatarUrl: null,
          isTyping: false,
          isRenaming: false,
          isAutonaming: false,
          lastMessageAt: channel.createdAt || null,
          createdAt: channel.createdAt || new Date().toISOString(),
          updatedAt: channel.updatedAt || new Date().toISOString(),
          externalActionRequested: false,
        });
      }
    };

    // Also listen for typing events globally
    const handleTyping = (data: any) => {
      if (data.channelId) {
        useChatStore.getState().setTyping(data.channelId, data.isTyping ?? false);
      }
    };

    client.on('channel_list_status', handleChannelListStatus);
    client.on('typing', handleTyping);

    return () => {
      client.off('channel_list_status', handleChannelListStatus);
      client.off('typing', handleTyping);
    };
  }, [client]);

  const handleLogout = async () => {
    await storage.removeItem(STORAGE_KEYS.USER);
    client.setSessionToken('');
    useNavbarStore.getState().reset();
    router.replace('/(auth)/login');
  };

  if (isLoading) {
    return (
      <YStack flex={1} justifyContent="center" alignItems="center" backgroundColor="#000">
        <ActivityIndicator size="large" color="#06B6D4" />
      </YStack>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <AccessGate client={client}>
      <WorkspaceContext.Provider value={{ isReady: workspaceLoaded }}>
        <VoiceSessionProvider>
          <Navbar userName={user.displayName} userRole={user.role} onLogout={handleLogout}>
            <YStack flex={1} backgroundColor="#000" paddingBottom={insets.bottom}>
              <TilingLayout />
              {/* Slot renderiza la ruta hija, que solo dispara openWindow */}
              <Slot />
            </YStack>
          </Navbar>
        </VoiceSessionProvider>
      </WorkspaceContext.Provider>
    </AccessGate>
  );
}
