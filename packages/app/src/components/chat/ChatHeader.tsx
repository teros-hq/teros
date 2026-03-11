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

import { Activity, Archive, Check, Lock, MoreVertical, Pencil, X } from '@tamagui/lucide-icons';
import type { TokenBudget } from '@teros/shared';
import { LinearGradient } from 'expo-linear-gradient';
import type React from 'react';
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { Sheet, Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../../app/_layout';
import { Avatar } from '../Avatar';
import { TerosLoading } from '../TerosLoading';
import { TokenBudgetDetails } from '../TokenBudgetDetails';
import { WorkspaceIcon } from '../WorkspaceIcon';

interface ChatHeaderProps {
  /** Conversation title/purpose */
  title: string;
  /** Agent name */
  agentName: string;
  /** Agent avatar URL */
  agentAvatarUrl?: string | null;
  /** Model string (e.g., 'anthropic/claude-opus-4.5') */
  modelString?: string;
  /** Model display name (e.g., 'Claude Sonnet 4.5 (OpenRouter)') */
  modelName?: string;
  /** Provider display name (e.g., 'OpenRouter', 'Claude Max') */
  providerName?: string;
  /** Agent ID (needed to change model) */
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
}

export function ChatHeader({
  title,
  agentName,
  agentAvatarUrl,
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
}: ChatHeaderProps) {
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
          backgroundColor="rgba(10, 10, 10, 0.95)"
          borderBottomWidth={1}
          borderBottomColor="rgba(255, 255, 255, 0.05)"
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
                      style={styles.titleInput}
                      value={editedTitle}
                      onChangeText={setEditedTitle}
                      autoFocus
                      selectTextOnFocus
                      onSubmitEditing={handleSaveEdit}
                      onBlur={handleSaveEdit}
                    />
                    <TouchableOpacity onPress={handleSaveEdit} style={styles.editButton}>
                      <Check size={14} color="#06B6D4" />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={handleCancelEdit} style={styles.editButton}>
                      <X size={14} color="#666" />
                    </TouchableOpacity>
                  </XStack>
                ) : (
                  <>
                    <TouchableOpacity
                      onPress={handleStartEdit}
                      disabled={isTitleLocked}
                      style={{ flex: 1 }}
                    >
                      <XStack alignItems="center" gap="$1.5">
                        {isPrivate && <Lock size={12} color="#06B6D4" />}
                        <Text
                          color="#e4e4e7"
                          fontSize={14}
                          fontWeight="500"
                          numberOfLines={1}
                          opacity={isTitleLocked ? 1 : 0.9}
                        >
                          {title}
                        </Text>
                      </XStack>
                    </TouchableOpacity>
                    {workspace && (
                      <XStack
                        alignItems="center"
                        gap="$1.5"
                        backgroundColor="rgba(255, 255, 255, 0.08)"
                        paddingHorizontal="$2"
                        paddingVertical={4}
                        borderRadius={6}
                      >
                        <WorkspaceIcon
                          icon={workspace.icon}
                          color={workspace.color}
                          size={14}
                          showBackground={false}
                        />
                        <Text color="#999" fontSize={12} fontWeight="500">
                          {workspace.name}
                        </Text>
                      </XStack>
                    )}
                  </>
                )}
              </XStack>

              {/* Line 2: Agent + model + indicator */}
              <XStack alignItems="center" gap="$1.5">
                <Text color="#999" fontSize={13} fontWeight="500">
                  {agentName}
                </Text>
                {(providerName || modelName || modelString) && (
                  <>
                    <Text color="#444" fontSize={11}>
                      ·
                    </Text>
                    <XStack alignItems="center" gap="$1.5">
                      {providerName && (
                        <Text color="#888" fontSize={11} fontWeight="500">
                          {providerName}
                        </Text>
                      )}
                      {providerName && (modelName || modelString) && (
                        <Text color="#444" fontSize={11}>
                          ·
                        </Text>
                      )}
                      <Text color="#666" fontSize={11}>
                        {modelName || modelString}
                      </Text>
                    </XStack>
                  </>
                )}
                {isWorking && <TerosLoading size={14} color="#06B6D4" />}
              </XStack>
            </YStack>

            {/* Menu ⋮ */}
            <TouchableOpacity onPress={() => setShowMenu(true)} style={styles.menuButton}>
              <MoreVertical size={18} color="#666" />
            </TouchableOpacity>
          </XStack>
        </YStack>

        {/* Gradient shadow below header */}
        <LinearGradient
          colors={['rgba(10, 10, 10, 1)', 'rgba(10, 10, 10, 0)']}
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
          animation="lazy"
          enterStyle={{ opacity: 0 }}
          exitStyle={{ opacity: 0 }}
          backgroundColor="rgba(0, 0, 0, 0.5)"
        />
        <Sheet.Frame
          backgroundColor="#111"
          borderTopLeftRadius={12}
          borderTopRightRadius={12}
          padding={8}
        >
          <Sheet.Handle backgroundColor="#333" />

          <YStack gap={2} paddingTop={8}>
            {!isTitleLocked && (
              <MenuItem
                icon={<Pencil size={18} color="#888" />}
                label="Rename"
                onPress={handleRename}
              />
            )}

            {tokenBudget && (
              <MenuItem
                icon={<Activity size={18} color="#888" />}
                label="View token usage"
                onPress={handleShowTokens}
              />
            )}

            {onArchive && (
              <MenuItem
                icon={<Archive size={18} color="#888" />}
                label="Archive conversation"
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
        <Pressable style={styles.modalOverlay} onPress={() => setShowTokens(false)}>
          <Pressable style={styles.modalContent} onPress={(e) => e.stopPropagation()}>
            <XStack justifyContent="space-between" alignItems="center" marginBottom="$3">
              <Text color="#e4e4e7" fontSize={16} fontWeight="600">
                Token usage
              </Text>
              <TouchableOpacity onPress={() => setShowTokens(false)}>
                <X size={20} color="#666" />
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
  return (
    <XStack
      padding={12}
      gap={12}
      alignItems="center"
      borderRadius={8}
      cursor="pointer"
      hoverStyle={{ backgroundColor: '#1a1a1a' }}
      pressStyle={{ backgroundColor: '#222' }}
      onPress={onPress}
    >
      {icon}
      <Text fontSize={14} color="#e4e4e7">
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
    backgroundColor: 'rgba(6, 182, 212, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.3)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    color: '#e4e4e7',
    fontSize: 14,
    fontWeight: '500',
  },
  editButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
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
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: '#111',
    borderRadius: 12,
    padding: 16,
    width: '100%',
    maxWidth: 400,
    maxHeight: '80%',
  },
});
