import { Check, Clock, Inbox, RefreshCw } from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect } from 'react';
import { ScrollView, Text, View, XStack, YStack } from 'tamagui';
import { useInvitations } from '../hooks/useInvitations';
import type { TerosClient } from '../services/TerosClient';

interface SentInvitationsProps {
  client: TerosClient | null;
}

export const SentInvitations: React.FC<SentInvitationsProps> = ({ client }) => {
  const { sentInvitations, loadSentInvitations, loading } = useInvitations(client);

  useEffect(() => {
    if (client && client.isConnected()) {
      loadSentInvitations();
    }
  }, [client]);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('es-ES', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <YStack padding="$4" gap="$4">
      {/* Header */}
      <XStack alignItems="center" justifyContent="space-between">
        <XStack alignItems="center" gap="$3">
          <Inbox size={20} color="#71717A" />
          <Text fontSize="$4" fontWeight="600" color="$color">
            Invitaciones Enviadas
          </Text>
        </XStack>
        <XStack
          paddingVertical="$2"
          paddingHorizontal="$3"
          borderRadius="$2"
          backgroundColor="rgba(39, 39, 42, 0.3)"
          borderWidth={1}
          borderColor="rgba(39, 39, 42, 0.5)"
          alignItems="center"
          gap="$2"
          cursor="pointer"
          opacity={loading ? 0.5 : 1}
          hoverStyle={{ backgroundColor: 'rgba(39, 39, 42, 0.5)' }}
          pressStyle={{ opacity: 0.8 }}
          onPress={loadSentInvitations}
        >
          <RefreshCw size={14} color="#71717A" />
        </XStack>
      </XStack>

      {sentInvitations.length === 0 && (
        <YStack
          backgroundColor="rgba(39, 39, 42, 0.2)"
          borderRadius="$3"
          padding="$4"
          alignItems="center"
          gap="$2"
        >
          <Inbox size={24} color="#71717A" />
          <Text fontSize="$3" color="$gray11" textAlign="center">
            You haven't sent any invitations yet
          </Text>
          <Text fontSize="$2" color="$gray11" textAlign="center" opacity={0.7}>
            Invita a otros usuarios para que puedan unirse a Teros
          </Text>
        </YStack>
      )}

      {sentInvitations.length > 0 && (
        <YStack gap="$2">
          {sentInvitations.map((invitation, index) => {
            // Support both old format (toUser.displayName) and new format (toDisplayName)
            const displayName =
              invitation.toDisplayName || invitation.toUser?.displayName || 'Usuario';
            const email = invitation.toEmail || invitation.toUser?.email || '';
            const accepted = invitation.recipientAccessGranted || invitation.accepted;
            const sentAt = invitation.createdAt || invitation.sentAt;

            return (
              <YStack
                key={invitation.invitationId || invitation.toUserId || index}
                backgroundColor="rgba(20, 20, 22, 0.9)"
                borderRadius="$3"
                padding="$3"
                borderWidth={1}
                borderColor={accepted ? 'rgba(34, 197, 94, 0.3)' : 'rgba(39, 39, 42, 0.5)'}
                gap="$3"
              >
                {/* User Info */}
                <XStack justifyContent="space-between" alignItems="flex-start">
                  <YStack flex={1}>
                    <Text fontSize="$3" fontWeight="600" color="$color">
                      {displayName}
                    </Text>
                    <Text fontSize="$2" color="$gray11">
                      {email}
                    </Text>
                  </YStack>

                  {/* Status Badge */}
                  <XStack
                    alignItems="center"
                    gap="$1"
                    paddingHorizontal="$2"
                    paddingVertical="$1"
                    backgroundColor={
                      accepted ? 'rgba(34, 197, 94, 0.15)' : 'rgba(245, 158, 11, 0.15)'
                    }
                    borderRadius="$2"
                    borderWidth={1}
                    borderColor={accepted ? 'rgba(34, 197, 94, 0.3)' : 'rgba(245, 158, 11, 0.3)'}
                  >
                    {accepted ? (
                      <Check size={12} color="#22C55E" />
                    ) : (
                      <Clock size={12} color="#F59E0B" />
                    )}
                    <Text fontSize="$1" color={accepted ? '#22C55E' : '#F59E0B'} fontWeight="600">
                      {accepted ? 'ACEPTADA' : 'PENDIENTE'}
                    </Text>
                  </XStack>
                </XStack>

                {/* Date */}
                <XStack alignItems="center" gap="$1">
                  <Clock size={12} color="#71717A" />
                  <Text fontSize="$2" color="$gray11">
                    Enviada el {formatDate(sentAt)}
                  </Text>
                </XStack>
              </YStack>
            );
          })}
        </YStack>
      )}
    </YStack>
  );
};
