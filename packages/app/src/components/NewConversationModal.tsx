/**
 * NewConversationModal - Sheet para crear nuevas conversaciones
 *
 * Allows selecting an agent and creating a new conversation directly.
 * Used from the Navbar to quickly create chats.
 */

import { User, X } from '@tamagui/lucide-icons';
import React, { useEffect, useState } from 'react';
import { ScrollView } from 'react-native';
import { Avatar, Button, Sheet, Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../app/_layout';
import { AppSpinner } from '../components/ui';

interface Agent {
  agentId: string;
  name: string;
  fullName: string;
  role: string;
  intro: string;
  avatarUrl?: string;
}

interface NewConversationModalProps {
  visible: boolean;
  onClose: () => void;
  onSelectAgent: (agent: Agent) => void;
}

export function NewConversationModal({
  visible,
  onClose,
  onSelectAgent,
}: NewConversationModalProps) {
  const client = getTerosClient();

  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load agents when modal opens
  useEffect(() => {
    if (visible && client) {
      loadAgents();
    }
  }, [visible, client]);

  // Reset state when modal closes
  useEffect(() => {
    if (!visible) {
      setError(null);
    }
  }, [visible]);

  const loadAgents = async () => {
    if (!client) return;

    setLoading(true);
    setError(null);

    try {
      const agentList = await client.agent.listAgents().then((r) => r.agents);
      const mappedAgents = agentList.map((a: any) => ({
        agentId: a.agentId,
        name: a.name,
        fullName: a.fullName,
        role: a.role,
        intro: a.intro,
        avatarUrl: a.avatarUrl,
      }));

      // If there's only one agent, select it automatically
      if (mappedAgents.length === 1) {
        handleSelectAgent(mappedAgents[0]);
        return;
      }

      setAgents(mappedAgents);
    } catch (err) {
      console.error('Failed to load agents:', err);
      setError('Failed to load agents');
    } finally {
      setLoading(false);
    }
  };

  const handleSelectAgent = (agent: Agent) => {
    onSelectAgent(agent);
    onClose();
  };

  return (
    <Sheet
      modal
      open={visible}
      onOpenChange={(open) => !open && onClose()}
      snapPoints={[60]}
      dismissOnSnapToBottom
      zIndex={100000}
    >
      <Sheet.Overlay
        animation="lazy"
        enterStyle={{ opacity: 0 }}
        exitStyle={{ opacity: 0 }}
        backgroundColor="rgba(0, 0, 0, 0.7)"
      />
      <Sheet.Frame
        backgroundColor="#111"
        borderTopLeftRadius={12}
        borderTopRightRadius={12}
        padding={16}
      >
        <Sheet.Handle backgroundColor="#333" />

        <XStack justifyContent="space-between" alignItems="center" marginBottom={16}>
          <Text fontSize={16} fontWeight="600" color="#e4e4e7">
            Nuevo chat
          </Text>
          <Button
            circular
            size="$2"
            backgroundColor="transparent"
            icon={<X size={16} color="#666" />}
            onPress={onClose}
          />
        </XStack>

        <ScrollView style={{ maxHeight: 400 }}>
          {loading ? (
            <YStack padding={32} alignItems="center">
              <AppSpinner size="lg" variant="brand" />
              <Text fontSize={13} color="#71717A" marginTop={12}>
                Cargando agentes...
              </Text>
            </YStack>
          ) : error ? (
            <YStack padding={24} alignItems="center">
              <Text fontSize={13} color="#EF4444" marginBottom={12}>
                {error}
              </Text>
              <Button
                size="$2"
                backgroundColor="rgba(6, 182, 212, 0.15)"
                color="#06B6D4"
                onPress={loadAgents}
              >
                Reintentar
              </Button>
            </YStack>
          ) : agents.length === 0 ? (
            <YStack padding={24} alignItems="center">
              <Text fontSize={14} color="#71717A" fontWeight="500">
                No hay agentes disponibles
              </Text>
              <Text fontSize={12} color="#52525B" marginTop={4} textAlign="center">
                Crea un agente primero para poder iniciar conversaciones
              </Text>
            </YStack>
          ) : (
            <YStack gap={8}>
              {agents.map((agent) => (
                <XStack
                  key={agent.agentId}
                  padding={12}
                  gap={12}
                  alignItems="center"
                  backgroundColor="#1a1a1a"
                  borderRadius={8}
                  cursor="pointer"
                  hoverStyle={{ backgroundColor: '#222' }}
                  pressStyle={{ backgroundColor: '#252525' }}
                  onPress={() => handleSelectAgent(agent)}
                >
                  <Avatar circular size={44}>
                    {agent.avatarUrl ? (
                      <Avatar.Image src={agent.avatarUrl} />
                    ) : (
                      <Avatar.Fallback backgroundColor="#333">
                        <User size={22} color="#666" />
                      </Avatar.Fallback>
                    )}
                  </Avatar>
                  <YStack flex={1}>
                    <Text fontSize={14} fontWeight="600" color="#e4e4e7">
                      {agent.fullName}
                    </Text>
                    <Text fontSize={11} color="#06B6D4">
                      {agent.role}
                    </Text>
                    {agent.intro && (
                      <Text fontSize={11} color="#666" numberOfLines={2}>
                        {agent.intro.split('\n')[0]}
                      </Text>
                    )}
                  </YStack>
                </XStack>
              ))}
            </YStack>
          )}
        </ScrollView>
      </Sheet.Frame>
    </Sheet>
  );
}
