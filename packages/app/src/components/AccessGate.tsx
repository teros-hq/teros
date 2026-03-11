/**
 * AccessGate - Blocks access to the app until user has accessGranted: true
 * Shows the invitation status puzzle when access is not granted
 */

import { LogOut } from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useState } from 'react';
import { ScrollView, Text, View, XStack, YStack } from 'tamagui';
import { useInvitations } from '../hooks/useInvitations';
import { STORAGE_KEYS, storage } from '../services/storage';
import type { TerosClient } from '../services/TerosClient';
import { useAuthStore } from '../store/authStore';
import { InvitationStatus } from './InvitationStatus';

interface AccessGateProps {
  client: TerosClient | null;
  children: React.ReactNode;
}

export const AccessGate: React.FC<AccessGateProps> = ({ client, children }) => {
  const { status, loading, loadStatus } = useInvitations(client);
  const { logout: authLogout } = useAuthStore();
  const [isCheckingAccess, setIsCheckingAccess] = useState(true);
  const [isWaitingForConnection, setIsWaitingForConnection] = useState(true);

  // Wait for WebSocket connection before checking access
  useEffect(() => {
    if (!client) return;

    const checkConnection = () => {
      if (client.isConnected()) {
        setIsWaitingForConnection(false);
        // Trigger status load if not already loaded
        if (status === null && !loading) {
          loadStatus();
        }
      }
    };

    // Check immediately
    checkConnection();

    // Also listen for connection event
    const handleConnected = () => {
      setIsWaitingForConnection(false);
      loadStatus();
    };

    client.on('connected', handleConnected);

    // Fallback: check periodically in case we missed the event
    const interval = setInterval(checkConnection, 500);

    return () => {
      client.off('connected', handleConnected);
      clearInterval(interval);
    };
  }, [client, status, loading, loadStatus]);

  useEffect(() => {
    // Wait for status to be loaded (only after connection is ready)
    if (!isWaitingForConnection && !loading && status !== null) {
      setIsCheckingAccess(false);
    }
  }, [isWaitingForConnection, loading, status]);

  const handleLogout = async () => {
    try {
      await storage.removeItem(STORAGE_KEYS.USER);
      await authLogout();
      client?.disconnect();
      // Force reload to go to login
      if (typeof window !== 'undefined') {
        window.location.href = '/login';
      }
    } catch (error) {
      console.error('Error logging out:', error);
    }
  };

  // Show loading while checking access
  if (isCheckingAccess || loading) {
    return (
      <YStack flex={1} backgroundColor="$background" alignItems="center" justifyContent="center">
        <Text color="$gray11">Verificando acceso...</Text>
      </YStack>
    );
  }

  // If user has access, render children (normal app)
  if (status?.accessGranted) {
    return <>{children}</>;
  }

  // User doesn't have access - show invitation gate
  return (
    <YStack flex={1} backgroundColor="#09090b">
      <ScrollView flex={1}>
        <YStack
          flex={1}
          alignItems="center"
          paddingVertical="$8"
          paddingHorizontal="$4"
          maxWidth={480}
          marginHorizontal="auto"
          width="100%"
        >
          {/* Header */}
          <YStack alignItems="center" gap="$2" marginBottom="$6">
            <Text fontSize={32} fontWeight="700" color="#06B6D4" letterSpacing={2}>
              TEROS
            </Text>
            <Text fontSize={14} color="#71717A" textAlign="center">
              Invitation-based access system
            </Text>
          </YStack>

          {/* Invitation Status Card */}
          <YStack
            width="100%"
            backgroundColor="rgba(20, 20, 22, 0.9)"
            borderRadius="$4"
            borderWidth={1}
            borderColor="rgba(39, 39, 42, 0.5)"
            overflow="hidden"
          >
            <InvitationStatus client={client} />
          </YStack>

          {/* Help text */}
          <YStack
            marginTop="$6"
            gap="$3"
            backgroundColor="rgba(20, 20, 22, 0.9)"
            borderRadius="$3"
            padding="$4"
            borderWidth={1}
            borderColor="rgba(39, 39, 42, 0.5)"
            width="100%"
          >
            <Text fontSize={14} color="$color" fontWeight="600">
              How to get access?
            </Text>
            <Text fontSize={13} color="$gray11" lineHeight={20}>
              Ask users who already have access to TEROS to send you an invitation. You need
              recibir invitaciones de 3 usuarios diferentes para desbloquear el acceso completo a la
              plataforma.
            </Text>
            <Text fontSize={13} color="$gray11" lineHeight={20}>
              Once you complete the 3 invitations, you will have access to all features and
              you will also be able to invite other users.
            </Text>
          </YStack>

          {/* Logout button */}
          <XStack
            marginTop="$6"
            paddingVertical="$3"
            paddingHorizontal="$4"
            backgroundColor="rgba(239, 68, 68, 0.1)"
            borderWidth={1}
            borderColor="rgba(239, 68, 68, 0.2)"
            borderRadius="$3"
            alignItems="center"
            gap="$2"
            cursor="pointer"
            hoverStyle={{ backgroundColor: 'rgba(239, 68, 68, 0.15)' }}
            pressStyle={{ opacity: 0.8 }}
            onPress={handleLogout}
          >
            <LogOut size={16} color="#EF4444" />
            <Text fontSize={14} color="#EF4444" fontWeight="500">
              Sign out
            </Text>
          </XStack>

          {/* Footer */}
          <Text fontSize={12} color="#3F3F46" marginTop="$6">
            Teros
          </Text>
        </YStack>
      </ScrollView>
    </YStack>
  );
};
