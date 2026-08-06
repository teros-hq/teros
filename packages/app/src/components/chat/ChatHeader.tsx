/**
 * ChatHeader - Minimal chat header
 *
 * Shows:
 * - Agent avatar
 * - Conversation title/purpose (editable on click)
 * - Agent name + working indicator (TerosLoading)
 * - Workspace indicator (if applicable)
 * - Actions menu (⋮) with rename, view tokens, archive options
 */

import { Activity, Archive, Check, Lock, Phone, MoreVertical, Pencil, X } from '@tamagui/lucide-icons';
import { useTranslation } from 'react-i18next';
import { FeatureFlag } from '../FeatureFlag';
import type { TokenBudget } from '@teros/shared';
import { LinearGradient } from 'expo-linear-gradient';
import type React from 'react';
import { useEffect, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { Sheet, Text, XStack, YStack } from 'tamagui';
import { useColors } from '../mca/primitives/useColors';
import { colors as semanticColors, surface } from '../mca/primitives/colors';
import { getTerosClient } from '../../services/terosClientSingleton';
import { Avatar } from '../Avatar';
import { TerosLoading } from '../TerosLoading';
import { TokenBudgetDetails } from '../TokenBudgetDetails';


interface ChatHeaderProps {
  /** Conversation title/purpose */
  title: string;
  /** Agent name */
  agentName: string;
  /** Agent avatar URL */
  agentAvatarUrl?: string | null;
  /** Agent role (e.g., 'Personal Assistant') */
  agentRole?: string;
  /** Model string (e.g., 'anthropic/claude-opus-4.5') */
  modelString?: string;
  /** Model display name (e.g., 'Claude Sonnet 4.5 (OpenRouter)') */
  modelName?: string;
  /** Provider display name (e.g., 'OpenRouter', 'Claude Max') */
  providerName?: string;
  /** Agent ID (needed to change model and start voice) */
  agentId?: string;
  /** Whether the agent is working (streaming, tool calls, etc.) */
  isWorking?: boolean;
  /** Whether the title was locked by the user (not editable) */
  isTitleLocked?: boolean;
  /** Si el canal es privado (se elimina al cerrar) */
  isPrivate?: boolean;
  /** Token budget data */
  tokenBudget?: TokenBudget | null;
  /** Workspace info (if chat belongs to a workspace) */
  workspace?: {
    name: string;
    icon?: string;
    color?: string;
  } | null;
  /** Callback when title changes */
  onTitleChange?: (newTitle: string) => void;
  /** Callback when archiving */
  onArchive?: () => void;
  /** Callback when user clicks the Mic button to start a voice session */
  onStartVoice?: () => void;
  /** Whether there is currently an active voice session for this agent */
  isVoiceActive?: boolean;
}

export function ChatHeader({
  title,
  agentName,
  agentAvatarUrl,
  agentRole,
  modelString,
  modelName,
  providerName,
  agentId,
  isWorking = false,
  isTitleLocked = false,
  isPrivate = false,
  tokenBudget,
  workspace,
  onTitleChange,
  onArchive,
  onStartVoice,
  isVoiceActive = false,
}: ChatHeaderProps) {
  const { t } = useTranslation()
  const c = useColors()
  const isDark = c.bgPage === surface.dark.bgPage
  const [isEditing, setIsEditing] = useState(false);
  const [editedTitle, setEditedTitle] = useState(title);
  const [showMenu, setShowMenu] = useState(false);
  const [showTokens, setShowTokens] = useState(false);

  const handleStartEdit = () => {
    if (isTitleLocked) return;
    setEditedTitle(title);
    setIsEditing(true);
  };

  const handleSaveEdit = () => {
    if (editedTitle.trim() && editedTitle !== title) {
      onTitleChange?.(editedTitle.trim());
    }
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setEditedTitle(title);
    setIsEditing(false);
  };

  const handleArchive = () => {
    setShowMenu(false);
    onArchive?.();
  };

  const handleRename = () => {
    setShowMenu(false);
    handleStartEdit();
  };

  const handleShowTokens = () => {
    setShowMenu(false);
    setShowTokens(true);
  };



  return (
    <>
      <View style={styles.headerContainer}>
        <YStack
          backgroundColor={c.bgCard}
          borderBottomWidth={1}
          borderBottomColor={c.border}
        >
          {/* Main header row */}
          <XStack paddingHorizontal="$3" paddingVertical="$2" alignItems="center" gap="$3">
            {/* Agent Avatar */}
            <Avatar name={agentName} imageUrl={agentAvatarUrl || undefined} size={36} isAgent />

            {/* Content */}
            <YStack flex={1} gap={2}>
              {/* Line 1: Title + Workspace badge */}
              <XStack alignItems="center" gap="$2" flex={1}>
                {isEditing ? (
                  <XStack alignItems="center" gap="$2" flex={1}>
                    <TextInput
                      style={[styles.titleInput, { backgroundColor: semanticColors.indigoGlow, borderWidth: 1, borderColor: semanticColors.indigoGlow, color: c.text }]}
                      value={editedTitle}
                      onChangeText={setEditedTitle}
                      autoFocus
                      selectTextOnFocus
                      onSubmitEditing={handleSaveEdit}
                      onBlur={handleSaveEdit}
                    />
                    <TouchableOpacity onPress={handleSaveEdit} style={[styles.editButton, { backgroundColor: c.border }]}>
                      <Check size={14} color={semanticColors.indigo} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={handleCancelEdit} style={[styles.editButton, { backgroundColor: c.border }]}>
                      <X size={14} color={c.text3} />
                    </TouchableOpacity>
                  </XStack>
                ) : (
                  <TouchableOpacity
                    onPress={handleStartEdit}
                    disabled={isTitleLocked}
                    style={{ flex: 1 }}
                  >
                    <XStack alignItems="center" gap="$1.5">
                      {isPrivate && <Lock size={12} color={semanticColors.indigo} />}
                      <Text
                        color={c.text}
                        fontSize={14}
                        fontWeight="500"
                        fontFamily="$body"
                        numberOfLines={1}
                        opacity={isTitleLocked ? 1 : 0.9}
                      >
                        {title}
                      </Text>
                    </XStack>
                  </TouchableOpacity>
                )}
              </XStack>

              {/* Line 2: Agent name + role (left) | model + provider (right) + indicator */}
              <XStack alignItems="center" justifyContent="space-between">
                {/* Left: agent name · role */}
                <XStack alignItems="center" gap="$1.5" flex={1}>
                  <Text color={c.text2} fontSize={13} fontWeight="500" fontFamily="$body" numberOfLines={1}>
                    {agentName}
                  </Text>
                  {agentRole && (
                    <>
                      <Text color={c.text3} fontSize={11} fontFamily="$body">·</Text>
                      <Text color={c.text3} fontSize={11} fontFamily="$body" numberOfLines={1}>
                        {agentRole}
                      </Text>
                    </>
                  )}
                  {isWorking && <TerosLoading size={14} color={semanticColors.indigo} />}
                </XStack>

                {/* Right: provider · model */}
                {(providerName || modelName || modelString) && (
                  <XStack alignItems="center" gap="$1.5">
                    {providerName && (
                      <Text color={c.text3} fontSize={11} fontWeight="500" fontFamily="$body">
                        {providerName}
                      </Text>
                    )}
                    {providerName && (modelName || modelString) && (
                      <Text color={c.text3} fontSize={11} fontFamily="$body">·</Text>
                    )}
                    <Text color={c.text3} fontSize={11} fontFamily="$body">
                      {modelName || modelString}
                    </Text>
                  </XStack>
                )}
              </XStack>
            </YStack>

            {/* Phone button — start/indicate voice session (feature-flagged) */}
            {onStartVoice && (
              <FeatureFlag flag="voice.enabled">
                <View
                  {...(Platform.OS === 'web'
                    ? { title: isVoiceActive ? 'Voice active — press Esc to stop' : 'Start voice — or press Ctrl+M' } as any
                    : {})}
                >
                  <TouchableOpacity
                    onPress={onStartVoice}
                    style={[
                      styles.micButton,
                      { backgroundColor: isVoiceActive ? semanticColors.violetGlow : c.bgInner },
                    ]}
                  >
                    <Phone size={16} color={isVoiceActive ? semanticColors.green : c.text3} />
                  </TouchableOpacity>
                </View>
              </FeatureFlag>
            )}

            {/* Menu ⋮ */}
            <TouchableOpacity onPress={() => setShowMenu(true)} style={styles.menuButton}>
              <MoreVertical size={18} color={c.text3} />
            </TouchableOpacity>
          </XStack>
        </YStack>

        {/* Gradient shadow below header */}
        <LinearGradient
          colors={isDark ? [c.bgCard, 'transparent'] : [c.shadow, 'transparent']}
          style={styles.headerGradient}
          pointerEvents="none"
        />
      </View>

      {/* Menu Sheet */}
      <Sheet
        modal
        open={showMenu}
        onOpenChange={setShowMenu}
        snapPoints={[40]}
        dismissOnSnapToBottom
        zIndex={100000}
      >
        <Sheet.Overlay
          animation="medium"
          enterStyle={{ opacity: 0 }}
          exitStyle={{ opacity: 0 }}
          backgroundColor={isDark ? 'rgba(0, 0, 0, 0.5)' : 'rgba(10, 10, 15, 0.35)'}
        />
        <Sheet.Frame
          backgroundColor={c.bgCard}
          borderTopLeftRadius={12}
          borderTopRightRadius={12}
          padding={8}
        >
          <Sheet.Handle backgroundColor={c.borderStrong} />

          <YStack gap={2} paddingTop={8}>
            {!isTitleLocked && (
              <MenuItem
                icon={<Pencil size={18} color={c.text3} />}
                label={t('conversation.rename')}
                onPress={handleRename}
              />
            )}

            {tokenBudget && (
              <MenuItem
                icon={<Activity size={18} color={c.text3} />}
                label={t('conversation.viewTokenUsage')}
                onPress={handleShowTokens}
              />
            )}

            {onArchive && (
              <MenuItem
                icon={<Archive size={18} color={c.text3} />}
                label={t('conversation.archiveConversation')}
                onPress={handleArchive}
              />
            )}
          </YStack>
        </Sheet.Frame>
      </Sheet>

      {/* Token Budget Modal */}
      <Modal
        visible={showTokens}
        transparent
        animationType="fade"
        onRequestClose={() => setShowTokens(false)}
      >
        <Pressable style={[styles.modalOverlay, { backgroundColor: isDark ? 'rgba(0, 0, 0, 0.7)' : 'rgba(10, 10, 15, 0.55)' }]} onPress={() => setShowTokens(false)}>
          <Pressable style={[styles.modalContent, { backgroundColor: c.bgCard }]} onPress={(e) => e.stopPropagation()}>
            <XStack justifyContent="space-between" alignItems="center" marginBottom="$3">
              <Text color={c.text} fontSize={16} fontWeight="600" fontFamily="$body">
                {t('conversation.tokenUsage')}
              </Text>
              <TouchableOpacity onPress={() => setShowTokens(false)}>
                <X size={20} color={c.text3} />
              </TouchableOpacity>
            </XStack>

            {tokenBudget && <TokenBudgetDetails budget={tokenBudget} />}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function MenuItem({
  icon,
  label,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
}) {
  const c = useColors()
  return (
    <XStack
      padding={12}
      gap={12}
      alignItems="center"
      borderRadius={8}
      cursor="pointer"
      hoverStyle={{ backgroundColor: c.bgCardHover }}
      pressStyle={{ backgroundColor: c.bgInner }}
      onPress={onPress}
    >
      {icon}
      <Text fontSize={14} color={c.text} fontFamily="$body">
        {label}
      </Text>
    </XStack>
  );
}

const styles = StyleSheet.create({
  headerContainer: {
    position: 'relative',
    zIndex: 10,
  },
  headerGradient: {
    position: 'absolute',
    bottom: -16,
    left: 0,
    right: 0,
    height: 16,
  },
  titleInput: {
    flex: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontFamily: "$body",
    fontSize: 14,
    fontWeight: '500',
  },
  editButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  menuButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  micButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    borderRadius: 12,
    padding: 16,
    width: '100%',
    maxWidth: 400,
    maxHeight: '80%',
  },
});
