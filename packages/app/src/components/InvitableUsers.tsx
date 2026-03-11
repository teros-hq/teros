import { RefreshCw, Search, UserPlus, Users } from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useState } from 'react';
import { Input, ScrollView, Text, View, XStack, YStack } from 'tamagui';
import { useInvitations } from '../hooks/useInvitations';
import type { TerosClient } from '../services/TerosClient';

interface InvitableUsersProps {
  client: TerosClient | null;
}

export const InvitableUsers: React.FC<InvitableUsersProps> = ({ client }) => {
  const { invitableUsers, loadInvitableUsers, sendInvitation, loading } = useInvitations(client);
  const [searchTerm, setSearchTerm] = useState('');
  const [filteredUsers, setFilteredUsers] = useState<any[]>([]);

  useEffect(() => {
    if (client && client.isConnected()) {
      loadInvitableUsers(50);
    }
  }, [client]);

  useEffect(() => {
    const filtered = invitableUsers.filter(
      (user) =>
        user.displayName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        user.email.toLowerCase().includes(searchTerm.toLowerCase()),
    );
    setFilteredUsers(filtered);
  }, [invitableUsers, searchTerm]);

  const handleInviteUser = async (user: any) => {
    const confirmed = window.confirm(
      `Are you sure you want to invite ${user.displayName} (${user.email})?`,
    );

    if (confirmed) {
      const success = await sendInvitation(user.email);
      if (success) {
        loadInvitableUsers(50);
        setSearchTerm('');
      }
    }
  };

  const handleRefresh = () => {
    setSearchTerm('');
    loadInvitableUsers(50);
  };

  return (
    <YStack padding="$4" gap="$4">
      {/* Header */}
      <XStack alignItems="center" justifyContent="space-between">
        <XStack alignItems="center" gap="$3">
          <Users size={20} color="#71717A" />
          <Text fontSize="$4" fontWeight="600" color="$color">
            Usuarios Invitables
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
          onPress={handleRefresh}
        >
          <RefreshCw size={14} color="#71717A" />
        </XStack>
      </XStack>

      <Text fontSize="$2" color="$gray11">
        Users without access that you can invite. Search by name or email.
      </Text>

      {/* Search Input */}
      <XStack
        backgroundColor="rgba(20, 20, 22, 0.9)"
        borderRadius="$3"
        padding="$3"
        alignItems="center"
        gap="$3"
        borderWidth={1}
        borderColor="rgba(39, 39, 42, 0.5)"
      >
        <Search size={18} color="#71717A" />
        <Input
          flex={1}
          placeholder="Buscar usuarios..."
          value={searchTerm}
          onChangeText={setSearchTerm}
          backgroundColor="transparent"
          borderWidth={0}
          color="$color"
          fontSize="$3"
          padding={0}
          disabled={loading}
          placeholderTextColor="#71717A"
        />
      </XStack>

      {filteredUsers.length === 0 && !loading && (
        <YStack
          backgroundColor="rgba(39, 39, 42, 0.2)"
          borderRadius="$3"
          padding="$4"
          alignItems="center"
          gap="$2"
        >
          <Users size={24} color="#71717A" />
          <Text fontSize="$3" color="$gray11" textAlign="center">
            {searchTerm ? 'No se encontraron usuarios' : 'No hay usuarios disponibles'}
          </Text>
          <Text fontSize="$2" color="$gray11" textAlign="center" opacity={0.7}>
            {searchTerm
              ? 'Try different search terms'
              : 'Todos ya fueron invitados o tienen acceso'}
          </Text>
        </YStack>
      )}

      {filteredUsers.length > 0 && (
        <YStack gap="$2">
          {filteredUsers.map((user) => (
            <XStack
              key={user.userId}
              backgroundColor="rgba(20, 20, 22, 0.9)"
              borderRadius="$3"
              padding="$3"
              borderWidth={1}
              borderColor="rgba(39, 39, 42, 0.5)"
              justifyContent="space-between"
              alignItems="center"
            >
              <YStack flex={1}>
                <Text fontSize="$3" fontWeight="600" color="$color">
                  {user.displayName}
                </Text>
                <Text fontSize="$2" color="$gray11">
                  {user.email}
                </Text>
              </YStack>

              <XStack
                paddingVertical="$2"
                paddingHorizontal="$3"
                borderRadius="$2"
                backgroundColor={loading ? 'rgba(39, 39, 42, 0.3)' : 'rgba(6, 78, 97, 0.3)'}
                borderWidth={1}
                borderColor={loading ? 'rgba(39, 39, 42, 0.5)' : 'rgba(6, 182, 212, 0.3)'}
                alignItems="center"
                gap="$2"
                cursor={loading ? 'not-allowed' : 'pointer'}
                opacity={loading ? 0.5 : 1}
                hoverStyle={loading ? {} : { backgroundColor: 'rgba(6, 78, 97, 0.5)' }}
                pressStyle={loading ? {} : { opacity: 0.8 }}
                onPress={() => !loading && handleInviteUser(user)}
              >
                <UserPlus size={14} color={loading ? '#71717A' : '#22D3EE'} />
                <Text fontSize="$2" fontWeight="500" color={loading ? '#71717A' : '#22D3EE'}>
                  Invitar
                </Text>
              </XStack>
            </XStack>
          ))}
        </YStack>
      )}

      {invitableUsers.length > 0 && (
        <XStack
          backgroundColor="rgba(6, 78, 97, 0.1)"
          borderRadius="$3"
          padding="$3"
          alignItems="center"
          gap="$2"
          borderWidth={1}
          borderColor="rgba(6, 182, 212, 0.15)"
        >
          <UserPlus size={16} color="#22D3EE" />
          <Text fontSize="$2" color="$gray11">
            {invitableUsers.length} usuarios disponibles para invitar
          </Text>
        </XStack>
      )}
    </YStack>
  );
};
