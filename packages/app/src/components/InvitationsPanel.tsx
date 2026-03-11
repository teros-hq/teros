import { Inbox, Send, Users } from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useState } from 'react';
import { Button, ScrollView, Text, View, XStack, YStack } from 'tamagui';
import type { TerosClient } from '../services/TerosClient';
import { InvitationStatus } from './InvitationStatus';
import { SendInvitation } from './SendInvitation';
import { SentInvitations } from './SentInvitations';

export type TabType = 'status' | 'send' | 'sent';

interface InvitationsPanelProps {
  client: TerosClient | null;
  onClose?: () => void;
  initialTab?: TabType;
  onTabChange?: (tab: TabType) => void;
}

export const InvitationsPanel: React.FC<InvitationsPanelProps> = ({
  client,
  onClose,
  initialTab = 'status',
  onTabChange,
}) => {
  const [activeTab, setActiveTab] = useState<TabType>(initialTab);

  // Sync with initialTab prop when it changes
  useEffect(() => {
    if (initialTab && initialTab !== activeTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  const handleTabChange = (tab: TabType) => {
    setActiveTab(tab);
    onTabChange?.(tab);
  };

  const tabs = [
    { id: 'status', label: 'Estado', icon: Users },
    { id: 'send', label: 'Invitar', icon: Send },
    { id: 'sent', label: 'Enviadas', icon: Inbox },
  ] as const;

  const renderTabContent = () => {
    switch (activeTab) {
      case 'status':
        return <InvitationStatus client={client} />;
      case 'send':
        return <SendInvitation client={client} />;
      case 'sent':
        return <SentInvitations client={client} />;
      default:
        return <InvitationStatus client={client} />;
    }
  };

  return (
    <YStack flex={1} backgroundColor="$background">
      <ScrollView flex={1}>
        <YStack padding="$4" gap="$4">
          {/* Header */}
          <YStack gap="$2">
            <Text fontSize="$6" fontWeight="700" color="$color">
              Sistema de Invitaciones
            </Text>
            <Text fontSize="$2" color="$gray11">
              Invita a otros usuarios a Teros. Los usuarios necesitan 3 invitaciones de diferentes
              usuarios para obtener acceso completo.
            </Text>
          </YStack>

          {/* Tabs */}
          <XStack
            backgroundColor="rgba(20, 20, 22, 0.9)"
            borderRadius="$3"
            padding="$1"
            borderWidth={1}
            borderColor="rgba(39, 39, 42, 0.5)"
          >
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <XStack
                  key={tab.id}
                  flex={1}
                  paddingVertical="$2"
                  paddingHorizontal="$3"
                  borderRadius="$2"
                  backgroundColor={isActive ? 'rgba(6, 78, 97, 0.3)' : 'transparent'}
                  justifyContent="center"
                  alignItems="center"
                  gap="$2"
                  cursor="pointer"
                  hoverStyle={{
                    backgroundColor: isActive ? 'rgba(6, 78, 97, 0.3)' : 'rgba(39, 39, 42, 0.3)',
                  }}
                  pressStyle={{ opacity: 0.8 }}
                  onPress={() => handleTabChange(tab.id as TabType)}
                >
                  <Icon size={16} color={isActive ? '#22D3EE' : '#71717A'} />
                  <Text
                    fontSize="$2"
                    fontWeight={isActive ? '600' : '400'}
                    color={isActive ? '#22D3EE' : '$gray11'}
                  >
                    {tab.label}
                  </Text>
                </XStack>
              );
            })}
          </XStack>

          {/* Tab Content */}
          <YStack
            backgroundColor="rgba(20, 20, 22, 0.9)"
            borderRadius="$4"
            borderWidth={1}
            borderColor="rgba(39, 39, 42, 0.5)"
            overflow="hidden"
          >
            {renderTabContent()}
          </YStack>

          {/* Footer Info */}
          <YStack
            gap="$2"
            backgroundColor="rgba(20, 20, 22, 0.9)"
            borderRadius="$3"
            padding="$3"
            borderWidth={1}
            borderColor="rgba(39, 39, 42, 0.5)"
          >
            <Text fontSize="$2" color="$color" fontWeight="600">
              How does the system work?
            </Text>
            <Text fontSize="$2" color="$gray11">
              1. Solo usuarios con acceso pueden enviar invitaciones
            </Text>
            <Text fontSize="$2" color="$gray11">
              2. Cada usuario necesita 3 invitaciones de usuarios diferentes
            </Text>
            <Text fontSize="$2" color="$gray11">
              3. Access is granted automatically once the threshold is reached
            </Text>
          </YStack>
        </YStack>
      </ScrollView>
    </YStack>
  );
};
