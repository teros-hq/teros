// ============================================================================
// TASK DETAIL PANEL
// ============================================================================

import {
  Archive,
  CheckCircle2,
  ChevronDown,
  Clock,
  ExternalLink,
  FileText,
  Info,
  MessageSquare,
  Play,
  Square,
  X,
} from '@tamagui/lucide-icons';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Platform, ScrollView, TextInput, TouchableOpacity, View } from 'react-native';
import { Text, useThemeName, XStack, YStack } from 'tamagui';
import {
  PRIORITY_CONFIG,
  type BoardColumn,
  type Task,
} from '../../store/boardStore';
import { getColumnColor, timeAgoNatural } from './board-utils';
import { CompactMarkdown } from './CompactMarkdown';
import { ConversationPreview } from './ConversationPreview';
import { AppSpinner } from '../../components/ui';
import { colors } from '../../components/mca/primitives/colors';
import { useColors } from '../../components/mca/primitives/useColors';


// ─── Agent avatar (inline) ──────────────────────────────────────────────────

function PanelAgentAvatar({
  name,
  avatarUrl,
  size = 28,
}: {
  name: string;
  avatarUrl?: string;
  size?: number;
}) {
  const radius = size / 2;
  if (avatarUrl) {
    return (
      <View style={{ width: size, height: size, borderRadius: radius, overflow: 'hidden' }}>
        <img src={avatarUrl} style={{ width: size, height: size, borderRadius: radius, objectFit: 'cover' }} />
      </View>
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: colors.violetGlow,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text fontSize={size * 0.5} color={colors.violet} fontWeight="700">
        {name[0] || '?'}
      </Text>
    </View>
  );
}

// ─── Collapsible description ────────────────────────────────────────────────

const COLLAPSED_HEIGHT = 220; // taller — ~7 lines

interface CollapsibleDescriptionProps {
  children: React.ReactNode;
}

function CollapsibleDescription({ children }: CollapsibleDescriptionProps) {
  const c = useColors();
  const [expanded, setExpanded] = useState(false);
  const themeName = useThemeName();
  const isLight = typeof themeName === 'string' && themeName.startsWith('light');
  // Panel background — matches $background token in tamagui.config.ts
  const panelBg = isLight ? c.bgPage : c.bgPage;

  if (Platform.OS === 'web') {
    return (
      <YStack>
        <View
          style={{
            maxHeight: expanded ? 2000 : COLLAPSED_HEIGHT,
            overflow: 'hidden',
            transition: 'max-height 0.3s ease',
          } as any}
        >
          {children}
        </View>
        {/* Fade overlay when collapsed — uses panel bg with alpha 0
             instead of CSS "transparent" (which is rgba(0,0,0,0) and
             creates a dark shadow on light themes) */}
        {!expanded && (
          <View
            style={{
              height: 50,
              marginTop: -50,
              background: `linear-gradient(to bottom, ${panelBg}00, ${panelBg})`,
              pointerEvents: 'none',
            } as any}
          />
        )}
        <TouchableOpacity
          onPress={() => setExpanded((v) => !v)}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 3,
            paddingTop: 3,
            paddingBottom: 6,
          }}
        >
          <ChevronDown
            size={10}
            color={c.text3}
            style={
              expanded
                ? ({ transform: 'rotate(180deg)', transition: 'transform 0.25s' } as any)
                : ({ transition: 'transform 0.25s' } as any)
            }
          />
          <Text fontSize={11.5} color={c.text3}>
            {expanded ? 'Show less' : 'Show more'}
          </Text>
        </TouchableOpacity>
      </YStack>
    );
  }

  // Native fallback
  return (
    <YStack>
      <View
        style={{
          maxHeight: expanded ? undefined : COLLAPSED_HEIGHT,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
      <TouchableOpacity
        onPress={() => setExpanded((v) => !v)}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 3,
          paddingTop: 3,
          paddingBottom: 6,
        }}
      >
        <ChevronDown
          size={10}
          color={c.text3}
          style={expanded ? { transform: [{ rotate: '180deg' }] } : undefined}
        />
        <Text fontSize={11.5} color={c.text3}>
          {expanded ? 'Show less' : 'Show more'}
        </Text>
      </TouchableOpacity>
    </YStack>
  );
}

// ─── Progress note item (markdown + collapsible) ─────────────────────────────

const NOTE_COLLAPSED_HEIGHT = 110; // ~5-6 lines

interface ProgressNoteItemProps {
  text: string;
  actor?: string;
  timestamp: string;
  actorName: string;
  avatarUrl?: string;
}

function ProgressNoteItem({ text, actorName, timestamp, avatarUrl }: ProgressNoteItemProps) {
  const c = useColors();
  const themeName = useThemeName();
  const isLight = typeof themeName === 'string' && themeName.startsWith('light');
  // Solid background — no transparency so the fade gradient matches exactly.
  // Light: bgInner composited on bgPage = #DDD6C6 (slightly darker, stands out)
  // Dark:  bgCard #16161D (lighter than bgPage #0A0A0F, stands out)
  const noteBg = isLight ? '#DDD6C6' : '#16161D';
  const [expanded, setExpanded] = useState(false);

  return (
    <YStack
      backgroundColor={noteBg}
      borderRadius={6}
      padding="$2.5"
    >
      {/* Header: avatar + actor + time */}
      <XStack alignItems="center" gap={6} marginBottom={7}>
        <PanelAgentAvatar name={actorName} avatarUrl={avatarUrl} size={18} />
        <Text fontSize={11.5} fontWeight="600" color={c.text}>
          {actorName}
        </Text>
        <Text fontSize={11} color={c.text3} marginLeft="auto">
          {timeAgoNatural(timestamp)}
        </Text>
      </XStack>

      {/* Markdown content — collapsible */}
      <View
        style={{
          maxHeight: expanded ? 5000 : NOTE_COLLAPSED_HEIGHT,
          overflow: 'hidden',
          ...(Platform.OS === 'web'
            ? { transition: 'max-height 0.3s ease' } as any
            : {}),
        }}
      >
        <CompactMarkdown text={text} fontSize={12} />
      </View>

      {/* Fade overlay when collapsed — gradient from transparent to page bg
           so the text fades smoothly. Sits right above "Ver más" with spacing. */}
      {!expanded && (
        <View
          style={{
            height: 32,
            marginTop: -32,
            marginBottom: 4,
            background: `linear-gradient(to bottom, ${noteBg}00, ${noteBg})`,
            pointerEvents: 'none',
          } as any}
        />
      )}

      {/* Show more / less */}
      <TouchableOpacity
        onPress={() => setExpanded((v) => !v)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 3, paddingTop: 2 }}
      >
        <ChevronDown
          size={10}
          color={c.text3}
          style={
            expanded
              ? ({ transform: 'rotate(180deg)', transition: 'transform 0.25s' } as any)
              : ({ transition: 'transform 0.25s' } as any)
          }
        />
        <Text fontSize={11} color={c.text3}>
          {expanded ? 'Ver menos' : 'Ver más'}
        </Text>
      </TouchableOpacity>
    </YStack>
  );
}

// ─── Tab types ───────────────────────────────────────────────────────────────

type TabId = 'instructions' | 'progress' | 'conversation';

interface TabButtonProps {
  id: TabId;
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onPress: (id: TabId) => void;
}

function TabButton({ id, label, icon, active, onPress }: TabButtonProps) {
  const c = useColors();
  return (
    <TouchableOpacity
      onPress={() => onPress(id)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 10,
        paddingTop: 7,
        paddingBottom: 6,
        marginBottom: -1,
        borderBottomWidth: 2,
        borderBottomColor: active ? colors.violet : 'transparent',
      }}
    >
      <View style={{ opacity: active ? 1 : 0.5 }}>{icon}</View>
      <Text
        fontSize={12.5}
        fontWeight="500"
        color={active ? c.text : c.text3}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// ─── Main panel ──────────────────────────────────────────────────────────────

interface TaskDetailPanelProps {
  task: Task;
  columns: BoardColumn[];
  onClose: () => void;
  onMoveTask: (taskId: string, columnId: string, position?: number) => void;
  onOpenConversation: (channelId: string) => void;
  onAssignTask: (taskId: string, agentId: string | null) => void;
  onStartTask: (taskId: string, agentId?: string) => void;
  onStopTask?: (taskId: string) => void;
  onCompleteTask: (taskId: string) => void;
  onArchiveTask: (taskId: string, reason?: string) => void;
  agentMap: Record<string, { name: string; avatarUrl?: string }>;
}

export function TaskDetailPanel({
  task,
  columns,
  onClose,
  onMoveTask,
  onOpenConversation,
  onAssignTask,
  onStartTask,
  onStopTask,
  onCompleteTask,
  onArchiveTask,
  agentMap,
}: TaskDetailPanelProps) {
  const c = useColors();
  const priority = PRIORITY_CONFIG[task.priority] || PRIORITY_CONFIG.medium;
  const { t } = useTranslation();

  const [isStarting, setIsStarting] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('instructions');

  // Modal state
  const [showAgentDropdown, setShowAgentDropdown] = useState(false);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [showArchiveModal, setShowArchiveModal] = useState(false);
  const [archiveReason, setArchiveReason] = useState('');

  // Derived state
  const currentColumn = columns.find((col) => col.columnId === task.columnId);
  const isDone = currentColumn?.slug === 'done';
  const agentEntries = Object.entries(agentMap);

  // ─── Stop pulse animation (matches composer StopButton) ──────────────────
  const stopPulseCss = useMemo(
    () => `
      @keyframes taskStopPulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.10); }
        50% { box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.18); }
      }
      .task-stop-pulse {
        animation: taskStopPulse 2.5s ease-in-out infinite;
      }
    `,
    [],
  );

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const handlePlayPress = async () => {
    if (!task.assignedAgentId || task.running) return;
    setIsStarting(true);
    try {
      await onStartTask(task.taskId, task.assignedAgentId!);
    } finally {
      setIsStarting(false);
    }
  };

  const handleStopPress = () => {
    setShowStopConfirm(true);
  };

  const confirmStop = () => {
    setShowStopConfirm(false);
    if (onStopTask) onStopTask(task.taskId);
  };

  const handleArchivePress = () => {
    if (isDone) {
      // Task is in Done — archive directly
      onArchiveTask(task.taskId);
    } else {
      // Task is NOT in Done — show confirmation modal
      setShowArchiveModal(true);
    }
  };

  const confirmArchive = () => {
    setShowArchiveModal(false);
    onArchiveTask(task.taskId, archiveReason.trim() || undefined);
    setArchiveReason('');
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <YStack
      position="absolute"
      right={0}
      top={0}
      bottom={0}
      width={440}
      backgroundColor="$background"
      borderLeftWidth={1}
      borderLeftColor={c.borderStrong}
      zIndex={50}
      {...(Platform.OS === 'web' ? { 'data-task-detail-panel': true } as any : {})}
    >
      {/* ── Unified Header: agent selector + play/stop + archive + close ─── */}
      <YStack
        paddingHorizontal={10}
        paddingVertical={8}
        borderBottomWidth={1}
        borderBottomColor={c.border}
        flexShrink={0}
        zIndex={200}
      >
        {/* Row: agent dropdown + play/stop + archive + close */}
        <XStack gap={6} alignItems="center">
          {/* Agent selector — relative wrapper so dropdown can overlay */}
          <View style={{ position: 'relative' }}>
            <TouchableOpacity
              onPress={() => setShowAgentDropdown(!showAgentDropdown)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                width: 130,
                backgroundColor: task.assignedAgentId ? 'rgba(139,92,246,0.08)' : c.bgInner,
                borderWidth: 1,
                borderColor: showAgentDropdown ? 'rgba(139,92,246,0.3)' : c.border,
                paddingHorizontal: 7,
                paddingVertical: 5,
                borderRadius: 5,
              }}
            >
              {task.assignedAgentId && agentMap[task.assignedAgentId] ? (
                <View style={{ position: 'relative' }}>
                  <PanelAgentAvatar
                    name={agentMap[task.assignedAgentId].name}
                    avatarUrl={agentMap[task.assignedAgentId].avatarUrl}
                    size={20}
                  />
                  <View
                    style={{
                      position: 'absolute',
                      bottom: -1,
                      right: -1,
                      width: 7,
                      height: 7,
                      borderRadius: 4,
                      backgroundColor: colors.green,
                      borderWidth: 1.5,
                      borderColor: c.bgPage,
                    }}
                  />
                </View>
              ) : (
                <View
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    backgroundColor: c.bgInner,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text fontSize={10} color={c.text3}>?</Text>
                </View>
              )}
              <Text
                fontSize={11.5}
                color={task.assignedAgentId ? c.text : c.text3}
                fontWeight={task.assignedAgentId ? '500' : '400'}
                flex={1}
                numberOfLines={1}
              >
                {task.assignedAgentId
                  ? agentMap[task.assignedAgentId]?.name || task.assignedAgentId.slice(0, 12)
                  : 'Asignar'}
              </Text>
              <ChevronDown
                size={12}
                color={c.text3}
                style={showAgentDropdown ? ({ transform: 'rotate(180deg)', transition: 'transform 0.2s' } as any) : ({ transition: 'transform 0.2s' } as any)}
              />
            </TouchableOpacity>

            {/* Agent dropdown list — absolute overlay, doesn't push content */}
            {showAgentDropdown && (
              <>
                {/* Click-outside catcher — covers entire viewport */}
                <View
                  style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    zIndex: 99,
                  } as any}
                  {...(Platform.OS === 'web'
                    ? { onClick: () => setShowAgentDropdown(false) } as any
                    : { onTouchStart: () => setShowAgentDropdown(false) } as any)}
                />
                <YStack
                  style={{
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    width: 180,
                    marginTop: 4,
                    zIndex: 100,
                    ...(Platform.OS === 'web'
                      ? {
                          backdropFilter: 'blur(12px)',
                          WebkitBackdropFilter: 'blur(12px)',
                        } as any
                      : {}),
                  } as any}
                  backgroundColor={Platform.OS === 'web' ? undefined : c.bgCard}
                  borderRadius={6}
                  borderWidth={1}
                  borderColor={c.borderStrong}
                  overflow="hidden"
                  {...(Platform.OS === 'web'
                    ? { onClick: (e: any) => e.stopPropagation() } as any
                    : {})}
                >
                  {/* Unassign option */}
                  {task.assignedAgentId && (
                    <TouchableOpacity
                      onPress={() => {
                        onAssignTask(task.taskId, null);
                        setShowAgentDropdown(false);
                      }}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                        paddingHorizontal: 10,
                        paddingVertical: 7,
                        borderBottomWidth: 1,
                        borderBottomColor: c.border,
                      }}
                    >
                      <View
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 11,
                          backgroundColor: c.badges.err.bg,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <X size={12} color={c.badges.err.text} />
                      </View>
                      <Text fontSize={12} color={c.badges.err.text}>
                        Desasignar
                      </Text>
                    </TouchableOpacity>
                  )}
                  {/* Agent options */}
                  {agentEntries.map(([agentId, agent]) => {
                    const isAssigned = agentId === task.assignedAgentId;
                    return (
                      <TouchableOpacity
                        key={agentId}
                        onPress={() => {
                          onAssignTask(task.taskId, isAssigned ? null : agentId);
                          setShowAgentDropdown(false);
                        }}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 8,
                          paddingHorizontal: 10,
                          paddingVertical: 7,
                          backgroundColor: isAssigned ? 'rgba(139,92,246,0.08)' : 'transparent',
                        }}
                      >
                        <View style={{ position: 'relative' }}>
                          <PanelAgentAvatar
                            name={agent.name}
                            avatarUrl={agent.avatarUrl}
                            size={22}
                          />
                          {isAssigned && (
                            <View
                              style={{
                                position: 'absolute',
                                bottom: -1,
                                right: -1,
                                width: 8,
                                height: 8,
                                borderRadius: 4,
                                backgroundColor: colors.green,
                                borderWidth: 1.5,
                                borderColor: c.bgCard,
                              }}
                            />
                          )}
                        </View>
                        <Text
                          fontSize={12}
                          color={c.text}
                          fontWeight={isAssigned ? '600' : '400'}
                          flex={1}
                          numberOfLines={1}
                        >
                          {agent.name}
                        </Text>
                        {isAssigned && (
                          <Text fontSize={10} color={colors.green} fontWeight="600">
                            ✓
                          </Text>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                  {agentEntries.length === 0 && (
                    <Text
                      fontSize={11}
                      color={c.text3}
                      paddingHorizontal={10}
                      paddingVertical={8}
                    >
                      No hay agentes disponibles
                    </Text>
                  )}
                </YStack>
              </>
            )}
          </View>

          {/* Play button — shown when NOT running (disabled if no agent assigned) */}
          {!task.running && (
            <TouchableOpacity
              onPress={handlePlayPress}
              disabled={!task.assignedAgentId || isStarting || task.archived}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                backgroundColor: c.badges.ok.bg,
                paddingHorizontal: 8,
                paddingVertical: 5,
                borderRadius: 5,
                opacity: (!task.assignedAgentId || isStarting || task.archived) ? 0.35 : 1,
              }}
            >
              {isStarting ? (
                <AppSpinner size="xs" variant="success" />
              ) : (
                <Play size={11} color={c.badges.ok.text} fill={c.badges.ok.text} />
              )}
              <Text fontSize={11} color={c.badges.ok.text} fontWeight="600">
                {isStarting ? '...' : 'Play'}
              </Text>
            </TouchableOpacity>
          )}

          {/* Stop button — shown when running, with pulse animation */}
          {task.running && (
            <View
              {...(Platform.OS === 'web'
                ? { className: 'task-stop-pulse' } as any
                : {})}
              style={{ borderRadius: 5, lineHeight: 0 }}
            >
              {Platform.OS === 'web' && <style>{stopPulseCss}</style>}
              <TouchableOpacity
                onPress={handleStopPress}
                disabled={task.stopRequested}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  backgroundColor: c.badges.err.bg,
                  paddingHorizontal: 8,
                  paddingVertical: 5,
                  borderRadius: 5,
                  opacity: task.stopRequested ? 0.35 : 1,
                }}
              >
                <Square size={11} color={c.badges.err.text} fill={c.badges.err.text} />
                <Text fontSize={11} color={c.badges.err.text} fontWeight="600">
                  {task.stopRequested ? '...' : 'Stop'}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Running indicator */}
          {task.running && (
            <AppSpinner size="xs" variant="warning" />
          )}

          {/* Spacer pushes archive + close to the right */}
          <View style={{ flex: 1 }} />

          {/* Archive icon */}
          <TouchableOpacity
            onPress={handleArchivePress}
            style={{ padding: 4 }}
          >
            <Archive size={14} color={c.text3} />
          </TouchableOpacity>

          {/* Close */}
          <TouchableOpacity onPress={onClose} style={{ padding: 4 }}>
            <X size={16} color={c.text} />
          </TouchableOpacity>
        </XStack>
      </YStack>

      {/* ── Tarea (title + tags) — STICKY: always visible while scrolling ─── */}
      <YStack
        paddingHorizontal={12}
        paddingTop={10}
        paddingBottom={10}
        flexShrink={0}
        borderBottomWidth={1}
        borderBottomColor={c.border}
      >
        <Text fontSize={15} fontWeight="600" color={c.text} lineHeight={18} marginBottom={6}>
          {task.title}
        </Text>
        {/* Column + Priority + Tags — always visible, in this order */}
        <XStack flexWrap="wrap" gap={4} alignItems="center">
          {/* Column badge */}
          {currentColumn && (
            <View
              style={{
                backgroundColor: getColumnColor(currentColumn.slug),
                paddingHorizontal: 6,
                paddingVertical: 2,
                borderRadius: 3,
              }}
            >
              <Text fontSize={11} color="white" fontWeight="600">
                {currentColumn.name}
              </Text>
            </View>
          )}
          {/* Priority badge */}
          <View
            style={{
              backgroundColor: priority.bg,
              paddingHorizontal: 6,
              paddingVertical: 2,
              borderRadius: 3,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 2,
            }}
          >
            <Text fontSize={10} color={priority.color} fontWeight="800">
              {priority.icon}
            </Text>
            <Text fontSize={11} color={priority.color} fontWeight="600">
              {priority.label}
            </Text>
          </View>
          {/* Tags */}
          {task.tags.map((tag) => (
            <View
              key={tag}
              style={{
                backgroundColor: 'rgba(139,92,246,0.10)',
                paddingHorizontal: 6,
                paddingVertical: 2,
                borderRadius: 3,
              }}
            >
              <Text fontSize={11} color={colors.violet}>
                {tag}
              </Text>
            </View>
          ))}
        </XStack>
      </YStack>

      {/* ── Scrollable: description → actions → tabs → content ─────────────── */}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20 }}>
        {/* Description */}
        {task.description && (
          <Text
            fontSize={13}
            color={c.text2}
            lineHeight={19}
            paddingHorizontal={12}
            paddingTop={10}
            paddingBottom={task.description ? 8 : 0}
          >
            {task.description}
          </Text>
        )}

        {/* ── Acciones ───────────────────────────────────────────────────── */}
        <XStack
          paddingHorizontal={12}
          paddingVertical={8}
          justifyContent="flex-end"
          alignItems="center"
        >
          {isDone ? (
            /* ── Done state: Completada badge + Archivar (purple highlight) ── */
            <>
              {/* Completada badge — visual only, not clickable */}
              <XStack
                alignItems="center"
                gap={5}
                backgroundColor={c.badges.ok.bg}
                paddingHorizontal={9}
                paddingVertical={5}
                borderRadius={5}
              >
                <CheckCircle2 size={13} color={c.badges.ok.text} />
                <Text fontSize={12} color={c.badges.ok.text} fontWeight="600">
                  Completada
                </Text>
              </XStack>

              {/* Gap between badge and archive */}
              <View style={{ width: 12 }} />

              {/* Archivar — highlighted in purple when task is done */}
              <TouchableOpacity
                onPress={handleArchivePress}
                disabled={task.archived}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 5,
                  backgroundColor: colors.violetGlow,
                  borderWidth: 1,
                  borderColor: 'rgba(139,92,246,0.3)',
                  paddingHorizontal: 9,
                  paddingVertical: 5,
                  borderRadius: 5,
                  opacity: task.archived ? 0.3 : 1,
                }}
              >
                <Archive size={13} color={colors.violet} />
                <Text fontSize={12} color={colors.violet} fontWeight="600">
                  Archivar
                </Text>
              </TouchableOpacity>
            </>
          ) : (
            /* ── Not Done state: Cancelar + Completar ── */
            <>
              {/* Cancelar button */}
              <TouchableOpacity
                onPress={() => setShowArchiveModal(true)}
                disabled={task.archived}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 5,
                  backgroundColor: c.badges.err.bg,
                  paddingHorizontal: 9,
                  paddingVertical: 5,
                  borderRadius: 5,
                  opacity: task.archived ? 0.3 : 1,
                }}
              >
                <X size={13} color={c.badges.err.text} />
                <Text fontSize={12} color={c.badges.err.text} fontWeight="600">
                  Cancelar
                </Text>
              </TouchableOpacity>

              {/* Gap between destructive and positive */}
              <View style={{ width: 12 }} />

              {/* Completar button — rightmost */}
              <TouchableOpacity
                onPress={() => onCompleteTask(task.taskId)}
                disabled={task.archived}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 5,
                  backgroundColor: c.badges.ok.bg,
                  paddingHorizontal: 9,
                  paddingVertical: 5,
                  borderRadius: 5,
                  opacity: task.archived ? 0.3 : 1,
                }}
              >
                <CheckCircle2 size={13} color={c.badges.ok.text} />
                <Text fontSize={12} color={c.badges.ok.text} fontWeight="600">
                  Completar
                </Text>
              </TouchableOpacity>
            </>
          )}
        </XStack>

        {/* ── Tab Navbar ───────────────────────────────────────────────────── */}
        <XStack
          borderBottomWidth={1}
          borderBottomColor={c.border}
          paddingHorizontal={10}
        >
          <TabButton
            id="instructions"
            label="Instructions"
            icon={<FileText size={10} color={activeTab === 'instructions' ? c.text : c.text3} />}
            active={activeTab === 'instructions'}
            onPress={setActiveTab}
          />
          <TabButton
            id="progress"
            label="Progreso"
            icon={<Clock size={10} color={activeTab === 'progress' ? c.text : c.text3} />}
            active={activeTab === 'progress'}
            onPress={setActiveTab}
          />
          <TabButton
            id="conversation"
            label="Conversation"
            icon={<MessageSquare size={10} color={activeTab === 'conversation' ? c.text : c.text3} />}
            active={activeTab === 'conversation'}
            onPress={setActiveTab}
          />
        </XStack>

        {/* ── Tab Content ──────────────────────────────────────────────────── */}

        {/* Instructions Tab — full markdown */}
        {activeTab === 'instructions' && (
          <YStack padding={12}>
            {task.instructions ? (
              <CompactMarkdown text={task.instructions} />
            ) : (
              <YStack alignItems="center" justifyContent="center" padding="$4">
                <FileText size={24} color={c.text3} />
                <Text
                  fontSize={13}
                  color={c.text3}
                  textAlign="center"
                  marginTop={8}
                  lineHeight={18}
                >
                  No instructions for this task
                </Text>
              </YStack>
            )}
          </YStack>
        )}

        {/* Progress Tab — notes + activity */}
        {activeTab === 'progress' && (
          <YStack padding={12} gap={10}>
            {/* Progress Notes — first, most recent on top */}
            <YStack gap={6}>
              <Text
                fontSize={11}
                fontWeight="600"
                color={c.text3}
                style={{ textTransform: 'uppercase', letterSpacing: 0.8 }}
              >
                Notas de progreso
              </Text>
              {task.progressNotes && task.progressNotes.length > 0 ? (
                [...task.progressNotes].reverse().map((note, i) => {
                  const actorName = !note.actor
                    ? 'system'
                    : note.actor.startsWith('user_')
                      ? 'You'
                      : agentMap[note.actor]?.name || note.actor.slice(0, 12);
                  const avatarUrl = note.actor ? agentMap[note.actor]?.avatarUrl : undefined;
                  return (
                    <ProgressNoteItem
                      key={i}
                      text={note.text}
                      actor={note.actor}
                      timestamp={note.timestamp}
                      actorName={actorName}
                      avatarUrl={avatarUrl}
                    />
                  );
                })
              ) : (
                <Text fontSize={12} color={c.text3} opacity={0.6} paddingVertical={4}>
                  Sin notas de progreso
                </Text>
              )}
            </YStack>

            {/* Activity log */}
            {task.activity.length > 0 && (
              <YStack gap={6} marginTop={4}>
                <Text
                  fontSize={11}
                  fontWeight="600"
                  color={c.text3}
                  style={{ textTransform: 'uppercase', letterSpacing: 0.8 }}
                >
                  Actividad
                </Text>
                {task.activity
                  .slice(-10)
                  .reverse()
                  .map((entry, i) => {
                    const actor = entry.actor ?? 'system';
                    const actorName = !entry.actor
                      ? 'system'
                      : actor.startsWith('user_')
                        ? 'You'
                        : agentMap[actor]?.name || actor.slice(0, 12);
                    const eventLabel = entry.eventType.replace(/_/g, ' ');
                    const detail = entry.details?.field
                      ? ` → ${entry.details.field}`
                      : entry.details?.fromColumn && entry.details?.toColumn
                        ? ` → ${entry.details.fromColumn} → ${entry.details.toColumn}`
                        : entry.details?.fromStatus && entry.details?.toStatus
                          ? ` → ${entry.details.fromStatus} → ${entry.details.toStatus}`
                          : '';
                    return (
                      <XStack key={i} gap={6} alignItems="flex-start">
                        <Clock size={10} color={c.text3} style={{ marginTop: 3 }} />
                        <YStack flex={1}>
                          <Text fontSize={12} color={c.text2}>
                            <Text fontSize={12} color={c.text} fontWeight="500">
                              {actorName}
                            </Text>{' '}
                            {eventLabel}
                            {detail}
                          </Text>
                          <Text fontSize={11} color={c.text3} opacity={0.7}>
                            {new Date(entry.timestamp).toLocaleString()}
                          </Text>
                        </YStack>
                      </XStack>
                    );
                  })}
              </YStack>
            )}
          </YStack>
        )}

        {/* Conversation Tab — CTA to open in new tab */}
        {activeTab === 'conversation' && (
          <YStack padding={12} minHeight={300}>
            {task.channelId ? (
              <ConversationPreview
                channelId={task.channelId}
                onOpenConversation={onOpenConversation}
                agentMap={agentMap}
              />
            ) : (
              <YStack alignItems="center" justifyContent="center" padding="$4">
                <MessageSquare size={24} color={c.text3} />
                <Text
                  fontSize={13}
                  color={c.text3}
                  textAlign="center"
                  marginTop={8}
                  lineHeight={18}
                >
                  No conversation linked to this task
                </Text>
              </YStack>
            )}
          </YStack>
        )}
      </ScrollView>

      {/* ── Stop Confirmation Modal ────────────────────────────────────────── */}
      <Modal
        visible={showStopConfirm}
        transparent
        animationType="fade"
        onRequestClose={() => setShowStopConfirm(false)}
      >
        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: 'rgba(0,0,0,0.5)',
          }}
        >
          <View
            style={{
              width: 260,
              backgroundColor: c.bgCard,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: c.borderStrong,
              padding: 16,
            }}
          >
            <XStack alignItems="center" gap={8} marginBottom={10}>
              <Square size={18} color={c.badges.err.text} fill={c.badges.err.text} />
              <Text fontSize={14} fontWeight="600" color={c.text}>
                Detener tarea
              </Text>
            </XStack>
            <Text fontSize={12} color={c.text2} lineHeight={18} marginBottom={14}>
              ¿Seguro que quieres detener esta tarea? El agente terminará su paso actual y la tarea pasará a Blocked.
            </Text>
            <XStack gap={8} justifyContent="flex-end">
              <TouchableOpacity
                onPress={() => setShowStopConfirm(false)}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 5,
                  backgroundColor: c.bgInner,
                }}
              >
                <Text fontSize={12} color={c.text3} fontWeight="500">
                  Cancelar
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={confirmStop}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 5,
                  backgroundColor: 'rgba(239,68,68,0.15)',
                }}
              >
                <Text fontSize={12} color={c.badges.err.text} fontWeight="600">
                  Detener
                </Text>
              </TouchableOpacity>
            </XStack>
          </View>
        </View>
      </Modal>

      {/* ── Archive Confirmation Modal ─────────────────────────────────────── */}
      <Modal
        visible={showArchiveModal}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setShowArchiveModal(false);
          setArchiveReason('');
        }}
      >
        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: 'rgba(0,0,0,0.5)',
          }}
        >
          <View
            style={{
              width: 280,
              backgroundColor: c.bgCard,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: c.borderStrong,
              padding: 16,
            }}
          >
            <XStack alignItems="center" gap={8} marginBottom={10}>
              <Archive size={18} color={c.text3} />
              <Text fontSize={14} fontWeight="600" color={c.text}>
                Archivar tarea no completada
              </Text>
            </XStack>
            <Text fontSize={12} color={c.text2} lineHeight={18} marginBottom={12}>
              Estás archivando una tarea que no ha sido completada. ¿Quieres cancelarla?
            </Text>
            {/* Optional reason textarea */}
            <TextInput
              value={archiveReason}
              onChangeText={setArchiveReason}
              placeholder="Razón de cancelación (opcional)..."
              placeholderTextColor={c.text3}
              multiline
              numberOfLines={3}
              style={{
                backgroundColor: c.bgInner,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: c.border,
                paddingHorizontal: 10,
                paddingVertical: 8,
                fontSize: 12,
                color: c.text,
                minHeight: 60,
                marginBottom: 14,
                textAlignVertical: 'top',
              }}
            />
            <XStack gap={8} justifyContent="flex-end">
              <TouchableOpacity
                onPress={() => {
                  setShowArchiveModal(false);
                  setArchiveReason('');
                }}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 5,
                  backgroundColor: c.bgInner,
                }}
              >
                <Text fontSize={12} color={c.text3} fontWeight="500">
                  Cancelar
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={confirmArchive}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 5,
                  backgroundColor: c.badges.gray.bg,
                }}
              >
                <Text fontSize={12} color={c.text3} fontWeight="600">
                  Archivar
                </Text>
              </TouchableOpacity>
            </XStack>
          </View>
        </View>
      </Modal>
    </YStack>
  );
}
