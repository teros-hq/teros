/**
 * NewConversationModal - Sheet para crear nuevas conversaciones
 *
 * Allows selecting an agent and creating a new conversation directly.
 * Used from the Navbar to quickly create chats.
 */

import { User, X } from '@tamagui/lucide-icons';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';
import { Avatar, Button, Sheet, Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../services/terosClientSingleton';
import { useWorkspaceStore } from '../store/workspaceStore';
import { AppSpinner } from '../components/ui';
import { useColors } from './mca/primitives/useColors';
import { colors as semanticColors } from './mca/primitives/colors';

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
  const { t } = useTranslation();
  const c = useColors();
  const client = getTerosClient();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId) ?? undefined;

  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load agents when modal opens
  useEffect(() => {
    if (visible && client) {
      loadAgents();
    }
  }, [visible, client, workspaceId]);

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
      // listAgents(workspaceId) now returns workspace agents + superagents from backend
      const agentList = await client.agent.listAgents(workspaceId).then((r) => r.agents);
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
        setLoading(false);
        handleSelectAgent(mappedAgents[0]);
        return;
      }

      setAgents(mappedAgents);
    } catch (err) {
      console.error('Failed to load agents:', err);
      setError(t("conversation.failedToLoadAgents"));
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
      onOpenChange={(open: boolean) => !open && onClose()}
      snapPoints={[60]}
      dismissOnSnapToBottom
      zIndex={100000}
    >
      <Sheet.Overlay
        animation="medium"
        enterStyle={{ opacity: 0 }}
        exitStyle={{ opacity: 0 }}
        backgroundColor={c.bgInner}
      />
      <Sheet.Frame
        animation="medium"
        backgroundColor={c.bgCard}
        borderTopLeftRadius={12}
        borderTopRightRadius={12}
        padding={16}
      >
        <Sheet.Handle backgroundColor={c.borderStrong} />

        <XStack justifyContent="space-between" alignItems="center" marginBottom={16}>
          <Text fontSize={16} fontWeight="600" color={c.text}>
            {t("conversation.newChat")}
          </Text>
          <Button
            circular
            size="$2"
            backgroundColor="transparent"
            icon={<X size={16} color={c.text3} />}
            onPress={onClose}
          />
        </XStack>

        <ScrollView style={{ maxHeight: 400 }}>
          {loading ? (
            <YStack padding={32} alignItems="center">
              <AppSpinner size="lg" variant="brand" />
              <Text fontSize={13} color={c.text2} marginTop={12}>
                {t("conversation.loadingAgents")}
              </Text>
            </YStack>
          ) : error ? (
            <YStack padding={24} alignItems="center">
              <Text fontSize={13} color={semanticColors.red} marginBottom={12}>
                {error}
              </Text>
              <Button
                size="$2"
                backgroundColor={semanticColors.indigoGlow}
                color={semanticColors.indigo}
                onPress={loadAgents}
              >
                {t("common.retry")}
              </Button>
            </YStack>
          ) : agents.length === 0 ? (
            <YStack padding={24} alignItems="center">
              <Text fontSize={14} color={c.text2} fontWeight="500">
                {t("conversation.noAgentsAvailable")}
              </Text>
              <Text fontSize={12} color={c.text3} marginTop={4} textAlign="center">
                {t("conversation.createAgentFirst")}
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
                  backgroundColor={c.bgCardHover}
                  borderRadius={8}
                  cursor="pointer"
                  hoverStyle={{ backgroundColor: c.bgCardHover }}
                  pressStyle={{ backgroundColor: c.bgInner }}
                  onPress={() => handleSelectAgent(agent)}
                >
                  <Avatar circular size={44}>
                    {agent.avatarUrl ? (
                      <Avatar.Image src={agent.avatarUrl} />
                    ) : (
                      <Avatar.Fallback backgroundColor={c.borderStrong}>
                        <User size={22} color={c.text3} />
                      </Avatar.Fallback>
                    )}
                  </Avatar>
                  <YStack flex={1}>
                    <Text fontSize={14} fontWeight="600" color={c.text}>
                      {agent.fullName}
                    </Text>
                    <Text fontSize={11} color={semanticColors.indigo}>
                      {agent.role}
                    </Text>
                    {agent.intro && (
                      <Text fontSize={11} color={c.text3} numberOfLines={2}>
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
