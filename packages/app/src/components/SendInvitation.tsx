import { AlertCircle, CheckCircle, Gift, Mail, Send, X } from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useState } from 'react';
import { Modal, Pressable } from 'react-native';
import { Input, Text, View, XStack, YStack } from 'tamagui';
import { useInvitations } from '../hooks/useInvitations';
import type { TerosClient } from '../services/TerosClient';

interface SendInvitationProps {
  client: TerosClient | null;
}

export const SendInvitation: React.FC<SendInvitationProps> = ({ client }) => {
  const [email, setEmail] = useState('');
  const [isValidEmail, setIsValidEmail] = useState(true);
  const [showAlreadyAccessModal, setShowAlreadyAccessModal] = useState(false);
  const [attemptedEmail, setAttemptedEmail] = useState('');
  const { status, sendInvitation, loading, loadStatus, error } = useInvitations(client);

  useEffect(() => {
    if (client && client.isConnected()) {
      loadStatus();
    }
  }, [client]);

  const availableInvitations = status?.availableInvitations ?? 0;
  const canInvite = availableInvitations > 0;

  const validateEmail = (email: string) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const handleSendInvitation = async () => {
    if (!canInvite) return;

    if (!email.trim()) {
      setIsValidEmail(false);
      return;
    }

    if (!validateEmail(email)) {
      setIsValidEmail(false);
      return;
    }

    setAttemptedEmail(email.trim());
    const success = await sendInvitation(email.trim());
    if (success) {
      setEmail('');
      // Refresh status to update available count
      loadStatus();
    }
  };

  // Check for "already has access" error
  useEffect(() => {
    if (error && error.includes('already has platform access')) {
      setShowAlreadyAccessModal(true);
    }
  }, [error]);

  const handleEmailChange = (text: string) => {
    setEmail(text);
    setIsValidEmail(true);
  };

  const handleKeyPress = (e: any) => {
    if (e.nativeEvent.key === 'Enter') {
      handleSendInvitation();
    }
  };

  const isButtonEnabled = canInvite && email.trim() && !loading;

  return (
    <YStack padding="$4" gap="$4">
      {/* Header with available count */}
      <XStack alignItems="center" justifyContent="space-between">
        <XStack alignItems="center" gap="$3">
          <Mail size={20} color="#71717A" />
          <Text fontSize="$4" fontWeight="600" color="$color">
            Send Invitation
          </Text>
        </XStack>

        <XStack
          alignItems="center"
          gap="$2"
          paddingHorizontal="$3"
          paddingVertical="$1"
          backgroundColor={canInvite ? 'rgba(6, 78, 97, 0.2)' : 'rgba(239, 68, 68, 0.15)'}
          borderRadius="$2"
          borderWidth={1}
          borderColor={canInvite ? 'rgba(6, 182, 212, 0.3)' : 'rgba(239, 68, 68, 0.3)'}
        >
          <Gift size={14} color={canInvite ? '#22D3EE' : '#EF4444'} />
          <Text fontSize="$2" color={canInvite ? '#22D3EE' : '#EF4444'} fontWeight="600">
            {availableInvitations} disponible{availableInvitations !== 1 ? 's' : ''}
          </Text>
        </XStack>
      </XStack>

      {canInvite ? (
        <>
          <Text fontSize="$2" color="$gray11">
            Invita a otros usuarios a Teros. Necesitan 3 invitaciones de diferentes usuarios para
            obtener acceso.
          </Text>

          {/* Email Input */}
          <YStack gap="$3">
            <XStack gap="$3" alignItems="flex-end">
              <YStack flex={1}>
                <Input
                  placeholder="correo@ejemplo.com"
                  value={email}
                  onChangeText={handleEmailChange}
                  onKeyPress={handleKeyPress}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                  backgroundColor="rgba(20, 20, 22, 0.9)"
                  borderColor={isValidEmail ? 'rgba(39, 39, 42, 0.5)' : '#EF4444'}
                  borderWidth={1}
                  color="$color"
                  fontSize="$3"
                  padding="$3"
                  borderRadius="$3"
                  disabled={loading}
                  placeholderTextColor="#71717A"
                />
              </YStack>

              <XStack
                paddingVertical="$3"
                paddingHorizontal="$4"
                borderRadius="$3"
                backgroundColor={isButtonEnabled ? 'rgba(6, 78, 97, 0.3)' : 'rgba(39, 39, 42, 0.3)'}
                borderWidth={1}
                borderColor={isButtonEnabled ? 'rgba(6, 182, 212, 0.3)' : 'rgba(39, 39, 42, 0.5)'}
                alignItems="center"
                gap="$2"
                cursor={isButtonEnabled ? 'pointer' : 'not-allowed'}
                opacity={isButtonEnabled ? 1 : 0.5}
                hoverStyle={isButtonEnabled ? { backgroundColor: 'rgba(6, 78, 97, 0.5)' } : {}}
                pressStyle={isButtonEnabled ? { opacity: 0.8 } : {}}
                onPress={isButtonEnabled ? handleSendInvitation : undefined}
              >
                <Send size={16} color={isButtonEnabled ? '#22D3EE' : '#71717A'} />
                <Text
                  fontSize="$3"
                  fontWeight="600"
                  color={isButtonEnabled ? '#22D3EE' : '#71717A'}
                >
                  {loading ? 'Enviando...' : 'Invitar'}
                </Text>
              </XStack>
            </XStack>

            {!isValidEmail && (
              <XStack alignItems="center" gap="$2">
                <AlertCircle size={14} color="#EF4444" />
                <Text fontSize="$2" color="#EF4444">
                  Please enter a valid email address
                </Text>
              </XStack>
            )}
          </YStack>
        </>
      ) : (
        <YStack
          backgroundColor="rgba(239, 68, 68, 0.1)"
          borderRadius="$3"
          padding="$4"
          alignItems="center"
          gap="$3"
          borderWidth={1}
          borderColor="rgba(239, 68, 68, 0.2)"
        >
          <AlertCircle size={32} color="#EF4444" />
          <Text fontSize="$3" color="#EF4444" fontWeight="600" textAlign="center">
            No tienes invitaciones disponibles
          </Text>
          <Text fontSize="$2" color="$gray11" textAlign="center">
            Las invitaciones son asignadas por los administradores de la plataforma.
          </Text>
        </YStack>
      )}

      {/* Modal: User already has access */}
      <Modal
        visible={showAlreadyAccessModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAlreadyAccessModal(false)}
      >
        <Pressable
          style={{
            flex: 1,
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 20,
          }}
          onPress={() => setShowAlreadyAccessModal(false)}
        >
          <Pressable onPress={(e) => e.stopPropagation()}>
            <YStack
              backgroundColor="#18181B"
              borderRadius="$4"
              padding="$5"
              width={340}
              maxWidth="100%"
              borderWidth={1}
              borderColor="rgba(16, 185, 129, 0.3)"
              gap="$4"
              alignItems="center"
            >
              {/* Close button */}
              <XStack position="absolute" top="$3" right="$3">
                <Pressable onPress={() => setShowAlreadyAccessModal(false)}>
                  <X size={20} color="#71717A" />
                </Pressable>
              </XStack>

              {/* Icon */}
              <View
                width={64}
                height={64}
                borderRadius={32}
                backgroundColor="rgba(16, 185, 129, 0.15)"
                alignItems="center"
                justifyContent="center"
              >
                <CheckCircle size={32} color="#10B981" />
              </View>

              {/* Title */}
              <Text fontSize={18} fontWeight="700" color="$color" textAlign="center">
                This user already has access!
              </Text>

              {/* Description */}
              <YStack gap="$2" alignItems="center">
                <Text fontSize={14} color="#A1A1AA" textAlign="center">
                  El usuario con email
                </Text>
                <Text fontSize={14} color="#10B981" fontWeight="600" textAlign="center">
                  {attemptedEmail}
                </Text>
                <Text fontSize={14} color="#A1A1AA" textAlign="center">
                  already has access to TEROS and does not need more invitations.
                </Text>
              </YStack>

              {/* Close button */}
              <XStack
                marginTop="$2"
                paddingVertical="$3"
                paddingHorizontal="$5"
                backgroundColor="rgba(16, 185, 129, 0.15)"
                borderWidth={1}
                borderColor="rgba(16, 185, 129, 0.3)"
                borderRadius="$3"
                cursor="pointer"
                hoverStyle={{ backgroundColor: 'rgba(16, 185, 129, 0.25)' }}
                pressStyle={{ opacity: 0.8 }}
                onPress={() => {
                  setShowAlreadyAccessModal(false);
                  setEmail('');
                }}
              >
                <Text fontSize={14} fontWeight="600" color="#10B981">
                  Entendido
                </Text>
              </XStack>
            </YStack>
          </Pressable>
        </Pressable>
      </Modal>
    </YStack>
  );
};
