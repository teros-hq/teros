// ============================================================================
// TASK CARD
// ============================================================================

import { GripVertical, MessageSquare } from '@tamagui/lucide-icons';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, TouchableOpacity, View } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { type BoardColumn, type Task } from '../../store/boardStore';
import { BLOCK_STATUS_CONFIG, type DependencyHighlight, getBlockStatus, timeAgo } from './board-utils';
import { AppSpinner } from '../../components/ui';

interface TaskCardProps {
  task: Task;
  isSelected: boolean;
  /**
   * Highlight state driven by hovering/selecting another task that this task
   * depends on:
   *   - 'will-unblock'  → completing the hovered task fully unblocks this one (orange)
   *   - 'still-blocked' → this task would still be blocked by other deps (dark red)
   *   - null            → no highlight
   */
  dependencyHighlight?: DependencyHighlight;
  allColumns: BoardColumn[];
  allTasks: Task[];
  currentColumnSlug: string;
  onPress: () => void;
  onMoveTask: (taskId: string, columnId: string, position?: number) => void;
  onDeleteTask: (taskId: string) => void;
  onOpenConversation: (channelId: string) => void;
  agentMap: Record<string, { name: string; avatarUrl?: string }>;
  /** Called when the card is hovered (mouse enter) */
  onHoverIn?: () => void;
  /** Called when the card is no longer hovered (mouse leave) */
  onHoverOut?: () => void;
}

// Dependency highlight style config
const DEPENDENCY_HIGHLIGHT_CONFIG: Record<
  NonNullable<DependencyHighlight>,
  { bg: string; border: string; labelColor: string; label: string }
> = {
  'will-unblock': {
    bg: 'rgba(249,115,22,0.12)',
    border: 'rgba(249,115,22,0.55)',
    labelColor: '#F97316',
    label: 'Would unblock',
  },
  'still-blocked': {
    bg: 'rgba(153,27,27,0.15)',
    border: 'rgba(185,28,28,0.5)',
    labelColor: '#B91C1C',
    label: 'Would remain blocked',
  },
};

export function TaskCard({
  task,
  isSelected,
  dependencyHighlight,
  allColumns,
  allTasks,
  currentColumnSlug,
  onPress,
  onMoveTask,
  onDeleteTask,
  onOpenConversation,
  agentMap,
  onHoverIn,
  onHoverOut,
}: TaskCardProps) {
  const [showActions, setShowActions] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const blockStatus = getBlockStatus(task, allTasks);
  const blockConfig = BLOCK_STATUS_CONFIG[blockStatus];
  const dragHandleRef = useRef<any>(null);
  const cardRef = useRef<any>(null);

  const depConfig = dependencyHighlight ? DEPENDENCY_HIGHLIGHT_CONFIG[dependencyHighlight] : null;

  // Attach native drag events (RNW doesn't forward drag events)
  useEffect(() => {
    const handle = dragHandleRef.current as HTMLElement | null;
    const card = cardRef.current as HTMLElement | null;
    if (!handle || !card) return;
    handle.draggable = true;
    const handleDragStart = (e: DragEvent) => {
      e.dataTransfer?.setData('text/plain', task.taskId);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      // Use the whole card as drag image
      if (e.dataTransfer) {
        e.dataTransfer.setDragImage(card, 20, 20);
      }
      // Hide original after a tick (browser needs it visible to capture drag image)
      requestAnimationFrame(() => setIsDragging(true));
    };
    const handleDragEnd = () => {
      setIsDragging(false);
    };
    handle.addEventListener('dragstart', handleDragStart);
    handle.addEventListener('dragend', handleDragEnd);
    return () => {
      handle.removeEventListener('dragstart', handleDragStart);
      handle.removeEventListener('dragend', handleDragEnd);
    };
  }, [task.taskId]);

  // Attach hover events via native DOM (RNW onHoverIn/onHoverOut not always reliable)
  useEffect(() => {
    const card = cardRef.current as HTMLElement | null;
    if (!card || (!onHoverIn && !onHoverOut)) return;
    const handleMouseEnter = () => onHoverIn?.();
    const handleMouseLeave = () => onHoverOut?.();
    card.addEventListener('mouseenter', handleMouseEnter);
    card.addEventListener('mouseleave', handleMouseLeave);
    return () => {
      card.removeEventListener('mouseenter', handleMouseEnter);
      card.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, [onHoverIn, onHoverOut]);

  // Compute border color with priority: dependency highlight > running > selected > default
  const borderColor = depConfig
    ? depConfig.border
    : task.running
      ? 'rgba(245,158,11,0.5)'
      : isSelected
        ? 'rgba(139,92,246,0.3)'
        : 'rgba(255,255,255,0.06)';

  const backgroundColor = depConfig
    ? depConfig.bg
    : isSelected
      ? 'rgba(139,92,246,0.12)'
      : 'rgba(255,255,255,0.05)';

  return (
    <Pressable onPress={onPress}>
      {/* @ts-ignore — web-only style */}
      <XStack
        ref={cardRef}
        backgroundColor={backgroundColor}
        borderRadius={8}
        borderWidth={1}
        borderColor={borderColor}
        opacity={isDragging ? 0.15 : 1}
        // @ts-expect-error — web-only
        style={{ userSelect: 'none', transition: 'background-color 0.15s ease, border-color 0.15s ease' }}
      >
        {/* Left strip: block-status dot (absolute top) + drag handle (centered) */}
        <View
          ref={dragHandleRef}
          style={{
            width: 22,
            borderTopLeftRadius: 8,
            borderBottomLeftRadius: 8,
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'grab',
            position: 'relative',
          }}
        >
          {/* Block status indicator — colored dot */}
          <View
            style={{
              position: 'absolute',
              top: 9,
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: blockConfig.color,
              opacity: 0.85,
            }}
          />

          {/* Grip icon — always centered */}
          <GripVertical size={10} color="rgba(255,255,255,0.2)" />
        </View>

        {/* Card content */}
        <YStack flex={1} padding="$2" paddingLeft={6} gap={4}>
          {/* Title + Running indicator */}
          <XStack alignItems="flex-start" gap={6}>
            {/* @ts-ignore — web-only style */}
            <Text
              fontSize={13}
              color="$color"
              fontWeight="500"
              flex={1}
              numberOfLines={2}
              style={{ userSelect: 'text', cursor: 'text' }}
            >
              {task.title}
            </Text>
            {task.running && (
              <AppSpinner size="xs" variant="warning" style={{ marginTop: 2 }} />
            )}
          </XStack>

          {/* Dependency highlight label */}
          {depConfig && (
            <XStack alignItems="center" gap={4}>
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: depConfig.labelColor,
                }}
              />
              <Text fontSize={9} color={depConfig.labelColor} fontWeight="600" opacity={0.9}>
                {depConfig.label}
              </Text>
            </XStack>
          )}

          {/* Bottom row: agent + conversation + actions */}
          <XStack alignItems="center" marginTop={2}>
            {task.assignedAgentId && (
              <XStack alignItems="center" gap={4} flex={1}>
                {agentMap[task.assignedAgentId]?.avatarUrl ? (
                  <View
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 7,
                      overflow: 'hidden',
                      backgroundColor: 'rgba(139,92,246,0.2)',
                    }}
                  >
                    <img
                      src={agentMap[task.assignedAgentId].avatarUrl}
                      style={{ width: 14, height: 14, borderRadius: 7, objectFit: 'cover' }}
                    />
                  </View>
                ) : (
                  <View
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 7,
                      backgroundColor: 'rgba(139,92,246,0.25)',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text fontSize={8} color="#8B5CF6" fontWeight="700">
                      {(agentMap[task.assignedAgentId]?.name || '?')[0]}
                    </Text>
                  </View>
                )}
                <Text fontSize={10} color="$color" opacity={0.6} numberOfLines={1}>
                  {agentMap[task.assignedAgentId]?.name || task.assignedAgentId.slice(0, 12)}
                </Text>
              </XStack>
            )}
            {!task.assignedAgentId && <View style={{ flex: 1 }} />}

            {task.channelId && (
              <TouchableOpacity
                onPress={(e) => {
                  e.stopPropagation?.();
                  onOpenConversation(task.channelId!);
                }}
                style={{ padding: 2, marginRight: 4 }}
              >
                <MessageSquare size={12} color="#3B82F6" />
              </TouchableOpacity>
            )}

            <Text fontSize={9} color="$color" opacity={0.3}>
              {timeAgo(task.createdAt)}
            </Text>
          </XStack>
        </YStack>
      </XStack>
    </Pressable>
  );
}
