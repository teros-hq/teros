// ============================================================================
// TASK DETAIL PANEL
// ============================================================================

import {
  ArrowRight,
  ChevronDown,
  Clock,
  Info,
  MessageSquare,
  Trash2,
  User,
  X,
} from '@tamagui/lucide-icons';
import React, { useState } from 'react';
import { Platform, ScrollView, TouchableOpacity, View } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import {
  PRIORITY_CONFIG,
  type BoardColumn,
  type Task,
  type TaskStatus,
} from '../../store/boardStore';
import { getColumnColor } from './board-utils';
import { CompactMarkdown } from './CompactMarkdown';
import { ConversationPreview } from './ConversationPreview';
import { AppSpinner } from '../../components/ui';

const STATUS_CONFIG: Record<TaskStatus, { label: string; color: string; bg: string }> = {
  idle: { label: 'Idle', color: '#9CA3AF', bg: 'rgba(156,163,175,0.15)' },
  assigned: { label: 'Assigned', color: '#60A5FA', bg: 'rgba(96,165,250,0.15)' },
  working: { label: 'Working', color: '#F59E0B', bg: 'rgba(245,158,11,0.15)' },
  blocked: { label: 'Blocked', color: '#EF4444', bg: 'rgba(239,68,68,0.15)' },
  review: { label: 'Review', color: '#A78BFA', bg: 'rgba(167,139,250,0.15)' },
  done: { label: 'Done', color: '#22C55E', bg: 'rgba(34,197,94,0.15)' },
};

// ─── Collapsible description ────────────────────────────────────────────────

const COLLAPSED_HEIGHT = 52; // ~3 lines × ~17px line-height

interface CollapsibleDescriptionProps {
  children: React.ReactNode;
}

function CollapsibleDescription({ children }: CollapsibleDescriptionProps) {
  const [expanded, setExpanded] = useState(false);

  if (Platform.OS === 'web') {
    return (
      <YStack>
        <View
          style={{
            maxHeight: expanded ? 2000 : COLLAPSED_HEIGHT,
            overflow: 'hidden',
            // Smooth transition on web
            transition: 'max-height 0.3s ease',
          } as any}
        >
          {children}
        </View>
        {/* Fade overlay when collapsed */}
        {!expanded && (
          <View
            style={{
              height: 60,
              marginTop: -60,
              background: 'linear-gradient(to bottom, transparent, #000000)',
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
            color="rgba(229,231,235,0.35)"
            style={
              expanded
                ? ({ transform: 'rotate(180deg)', transition: 'transform 0.25s' } as any)
                : ({ transition: 'transform 0.25s' } as any)
            }
          />
          <Text fontSize={10.5} color="rgba(229,231,235,0.35)">
            {expanded ? 'Show less' : 'Show more'}
          </Text>
        </TouchableOpacity>
      </YStack>
    );
  }

  // Native fallback (no CSS transitions available)
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
          color="rgba(229,231,235,0.35)"
          style={expanded ? { transform: [{ rotate: '180deg' }] } : undefined}
        />
        <Text fontSize={10.5} color="rgba(229,231,235,0.35)">
          {expanded ? 'Show less' : 'Show more'}
        </Text>
      </TouchableOpacity>
    </YStack>
  );
}

// ─── Tab types ───────────────────────────────────────────────────────────────

type TabId = 'info' | 'conversation';

interface TabButtonProps {
  id: TabId;
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onPress: (id: TabId) => void;
}

function TabButton({ id, label, icon, active, onPress }: TabButtonProps) {
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
        borderBottomColor: active ? '#8B5CF6' : 'transparent',
      }}
    >
      <View style={{ opacity: active ? 1 : 0.38 }}>{icon}</View>
      <Text
        fontSize={11.5}
        fontWeight="500"
        color={active ? '#e5e7eb' : 'rgba(229,231,235,0.38)'}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

interface TaskDetailPanelProps {
  task: Task;
  columns: BoardColumn[];
  onClose: () => void;
  onMoveTask: (taskId: string, columnId: string, position?: number) => void;
  onDeleteTask: (taskId: string) => void;
  onOpenConversation: (channelId: string) => void;
  onAssignTask: (taskId: string, agentId: string | null) => void;
  onStartTask: (taskId: string, agentId?: string) => void;
  agentMap: Record<string, { name: string; avatarUrl?: string }>;
}

export function TaskDetailPanel({
  task,
  columns,
  onClose,
  onMoveTask,
  onDeleteTask,
  onOpenConversation,
  onAssignTask,
  onStartTask,
  agentMap,
}: TaskDetailPanelProps) {
  const priority = PRIORITY_CONFIG[task.priority] || PRIORITY_CONFIG.medium;
  const statusCfg = STATUS_CONFIG[task.taskStatus] || STATUS_CONFIG.idle;
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('info');

  return (
    <YStack
      position="absolute"
      right={0}
      top={0}
      bottom={0}
      width={320}
      backgroundColor="$background"
      borderLeftWidth={1}
      borderLeftColor="rgba(255,255,255,0.08)"
      zIndex={50}
    >
      {/* Header */}
      <XStack
        paddingHorizontal="$3"
        paddingVertical="$2"
        alignItems="center"
        borderBottomWidth={1}
        borderBottomColor="rgba(255,255,255,0.06)"
      >
        <Text fontSize={14} fontWeight="600" color="$color" flex={1}>
          Detalle
        </Text>
        {task.running && (
          <XStack alignItems="center" gap={4} marginRight={8}>
            <AppSpinner size="xs" variant="warning" />
            <Text fontSize={10} color="#F59E0B" fontWeight="600">
              Running
            </Text>
          </XStack>
        )}
        <TouchableOpacity
          onPress={() => onDeleteTask(task.taskId)}
          style={{ padding: 4, marginRight: 8 }}
        >
          <Trash2 size={14} color="#EF4444" />
        </TouchableOpacity>
        <TouchableOpacity onPress={onClose} style={{ padding: 4 }}>
          <X size={16} color="$color" />
        </TouchableOpacity>
      </XStack>

      {/* Title + Description */}
      <YStack paddingHorizontal={12} paddingTop={10} paddingBottom={0} flexShrink={0}>
        <Text fontSize={13} fontWeight="600" color="$color" lineHeight={18} marginBottom={6}>
          {task.title}
        </Text>
        {task.description && (
          <CollapsibleDescription>
            <CompactMarkdown text={task.description} />
          </CollapsibleDescription>
        )}
      </YStack>

      {/* Tab Navbar */}
      <XStack
        borderBottomWidth={1}
        borderBottomColor="rgba(255,255,255,0.06)"
        paddingHorizontal={10}
        flexShrink={0}
      >
        <TabButton
          id="info"
          label="Info"
          icon={<Info size={10} color={activeTab === 'info' ? '#e5e7eb' : 'rgba(229,231,235,0.38)'} />}
          active={activeTab === 'info'}
          onPress={setActiveTab}
        />
        <TabButton
          id="conversation"
          label="Conversation"
          icon={<MessageSquare size={10} color={activeTab === 'conversation' ? '#e5e7eb' : 'rgba(229,231,235,0.38)'} />}
          active={activeTab === 'conversation'}
          onPress={setActiveTab}
        />
      </XStack>

      {/* Tab Content */}
      {activeTab === 'info' && (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, gap: 10 }}>
          {/* Properties */}
          <YStack gap={0}>
            {/* Status */}
            <XStack
              alignItems="center"
              paddingVertical={5}
              borderBottomWidth={1}
              borderBottomColor="rgba(255,255,255,0.04)"
            >
              <Text fontSize={11} color="$color" opacity={0.32} width={64}>
                Estado
              </Text>
              <View
                style={{
                  backgroundColor: statusCfg.bg,
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: 3,
                }}
              >
                <Text fontSize={10.5} color={statusCfg.color} fontWeight="600">
                  {statusCfg.label}
                </Text>
              </View>
            </XStack>

            {/* Column */}
            <XStack
              alignItems="center"
              paddingVertical={5}
              borderBottomWidth={1}
              borderBottomColor="rgba(255,255,255,0.04)"
            >
              <Text fontSize={11} color="$color" opacity={0.32} width={64}>
                Columna
              </Text>
              <XStack gap={3} flexWrap="wrap" flex={1}>
                {columns.map((col) => (
                  <TouchableOpacity
                    key={col.columnId}
                    onPress={() => {
                      if (col.columnId !== task.columnId) {
                        onMoveTask(task.taskId, col.columnId);
                      }
                    }}
                    style={{
                      paddingHorizontal: 6,
                      paddingVertical: 2,
                      borderRadius: 3,
                      backgroundColor:
                        col.columnId === task.columnId
                          ? getColumnColor(col.slug)
                          : 'rgba(255,255,255,0.05)',
                    }}
                  >
                    <Text
                      fontSize={10.5}
                      color={col.columnId === task.columnId ? 'white' : 'rgba(229,231,235,0.38)'}
                      fontWeight={col.columnId === task.columnId ? '600' : '400'}
                    >
                      {col.name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </XStack>
            </XStack>

            {/* Priority */}
            <XStack
              alignItems="center"
              paddingVertical={5}
              borderBottomWidth={1}
              borderBottomColor="rgba(255,255,255,0.04)"
            >
              <Text fontSize={11} color="$color" opacity={0.32} width={64}>
                Prioridad
              </Text>
              <View
                style={{
                  backgroundColor: priority.bg,
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: 3,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 3,
                }}
              >
                <Text fontSize={10} color={priority.color} fontWeight="800">
                  {priority.icon}
                </Text>
                <Text fontSize={10.5} color={priority.color} fontWeight="600">
                  {priority.label}
                </Text>
              </View>
            </XStack>

            {/* Agent */}
            <XStack
              alignItems="center"
              paddingVertical={5}
              borderBottomWidth={1}
              borderBottomColor="rgba(255,255,255,0.04)"
            >
              <Text fontSize={11} color="$color" opacity={0.32} width={64}>
                Agente
              </Text>
              <XStack flex={1} alignItems="center" gap={6}>
                <TouchableOpacity
                  onPress={() => setShowAgentPicker(!showAgentPicker)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 3,
                    backgroundColor: task.assignedAgentId
                      ? 'rgba(139,92,246,0.12)'
                      : 'rgba(255,255,255,0.06)',
                    paddingHorizontal: 7,
                    paddingVertical: 2,
                    borderRadius: 3,
                  }}
                >
                  <User size={11} color={task.assignedAgentId ? '#A78BFA' : '#6B7280'} />
                  <Text
                    fontSize={10.5}
                    color={task.assignedAgentId ? '#A78BFA' : 'rgba(229,231,235,0.38)'}
                    fontWeight={task.assignedAgentId ? '600' : '400'}
                  >
                    {task.assignedAgentId
                      ? agentMap[task.assignedAgentId]?.name || task.assignedAgentId.slice(0, 12)
                      : 'Asignar agente'}
                  </Text>
                  <ChevronDown size={10} color="#6B7280" />
                </TouchableOpacity>

                {/* Start button */}
                {task.assignedAgentId && task.taskStatus !== 'done' && !task.running && (
                  <TouchableOpacity
                    onPress={async () => {
                      setIsStarting(true);
                      try {
                        await onStartTask(task.taskId, task.assignedAgentId!);
                      } finally {
                        setIsStarting(false);
                      }
                    }}
                    disabled={isStarting}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 3,
                      backgroundColor: 'rgba(34,197,94,0.15)',
                      paddingHorizontal: 7,
                      paddingVertical: 2,
                      borderRadius: 3,
                      opacity: isStarting ? 0.5 : 1,
                    }}
                  >
                    {isStarting ? (
                      <AppSpinner size="xs" variant="success" />
                    ) : (
                      <ArrowRight size={11} color="#22C55E" />
                    )}
                    <Text fontSize={10.5} color="#22C55E" fontWeight="600">
                      Start
                    </Text>
                  </TouchableOpacity>
                )}
              </XStack>
            </XStack>

            {/* Agent picker dropdown */}
            {showAgentPicker && (
              <YStack
                backgroundColor="rgba(30,30,30,0.98)"
                borderRadius={8}
                borderWidth={1}
                borderColor="rgba(255,255,255,0.1)"
                padding="$1"
                marginLeft={68}
              >
                {task.assignedAgentId && (
                  <TouchableOpacity
                    onPress={() => {
                      onAssignTask(task.taskId, null);
                      setShowAgentPicker(false);
                    }}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      borderRadius: 4,
                      borderBottomWidth: 1,
                      borderBottomColor: 'rgba(255,255,255,0.06)',
                    }}
                  >
                    <Text fontSize={12} color="#EF4444" opacity={0.8}>
                      Desasignar
                    </Text>
                  </TouchableOpacity>
                )}
                {Object.entries(agentMap).map(([agentId, agent]) => (
                  <TouchableOpacity
                    key={agentId}
                    onPress={() => {
                      onAssignTask(task.taskId, agentId);
                      setShowAgentPicker(false);
                    }}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      borderRadius: 4,
                      backgroundColor:
                        agentId === task.assignedAgentId ? 'rgba(139,92,246,0.15)' : 'transparent',
                    }}
                  >
                    <Text
                      fontSize={12}
                      color="$color"
                      fontWeight={agentId === task.assignedAgentId ? '600' : '400'}
                    >
                      {agent.name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </YStack>
            )}

            {/* Tags */}
            {task.tags.length > 0 && (
              <XStack
                alignItems="flex-start"
                paddingVertical={5}
              >
                <Text fontSize={11} color="$color" opacity={0.32} width={64} marginTop={2}>
                  Tags
                </Text>
                <XStack flexWrap="wrap" gap={3} flex={1}>
                  {task.tags.map((tag) => (
                    <View
                      key={tag}
                      style={{
                        backgroundColor: 'rgba(139,92,246,0.13)',
                        paddingHorizontal: 6,
                        paddingVertical: 2,
                        borderRadius: 3,
                      }}
                    >
                      <Text fontSize={10.5} color="#A78BFA">
                        {tag}
                      </Text>
                    </View>
                  ))}
                </XStack>
              </XStack>
            )}
          </YStack>

          {/* Progress Notes */}
          {task.progressNotes && task.progressNotes.length > 0 && (
            <YStack gap={6} marginTop={8}>
              <Text
                fontSize={10}
                fontWeight="600"
                color="rgba(229,231,235,0.35)"
                style={{ textTransform: 'uppercase', letterSpacing: 0.8 }}
              >
                Notas de progreso
              </Text>
              {[...task.progressNotes].reverse().map((note, i) => (
                <YStack
                  key={i}
                  backgroundColor="rgba(255,255,255,0.04)"
                  borderRadius={5}
                  padding="$2"
                  borderLeftWidth={2}
                  borderLeftColor="#8B5CF6"
                >
                  <Text fontSize={11.5} color="rgba(229,231,235,0.75)" lineHeight={17}>
                    {note.text}
                  </Text>
                  <XStack marginTop={3} gap={5} alignItems="center">
                    <Text fontSize={10} color="rgba(229,231,235,0.38)">
                      {note.actor.startsWith('user_')
                        ? 'You'
                        : agentMap[note.actor]?.name || note.actor.slice(0, 12)}
                    </Text>
                    <Text fontSize={10} color="rgba(229,231,235,0.26)">
                      {new Date(note.timestamp).toLocaleString()}
                    </Text>
                  </XStack>
                </YStack>
              ))}
            </YStack>
          )}

          {/* Activity log */}
          {task.activity.length > 0 && (
            <YStack gap={6} marginTop={8}>
              <Text
                fontSize={10}
                fontWeight="600"
                color="rgba(229,231,235,0.35)"
                style={{ textTransform: 'uppercase', letterSpacing: 0.8 }}
              >
                Actividad
              </Text>
              {task.activity
                .slice(-10)
                .reverse()
                .map((entry, i) => {
                  const actorName = entry.actor.startsWith('user_')
                    ? 'You'
                    : agentMap[entry.actor]?.name || entry.actor.slice(0, 12);
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
                      <Clock size={10} color="#6B7280" style={{ marginTop: 3 }} />
                      <YStack flex={1}>
                        <Text fontSize={11} color="rgba(229,231,235,0.52)">
                          <Text fontSize={11} color="rgba(229,231,235,0.72)" fontWeight="500">
                            {actorName}
                          </Text>{' '}
                          {eventLabel}
                          {detail}
                        </Text>
                        <Text fontSize={10} color="rgba(229,231,235,0.26)">
                          {new Date(entry.timestamp).toLocaleString()}
                        </Text>
                      </YStack>
                    </XStack>
                  );
                })}
            </YStack>
          )}
        </ScrollView>
      )}

      {/* Conversation Tab */}
      {activeTab === 'conversation' && (
        <YStack flex={1} overflow="hidden">
          {task.channelId ? (
            <ConversationPreview
              channelId={task.channelId}
              onOpenConversation={onOpenConversation}
              agentMap={agentMap}
            />
          ) : (
            <YStack flex={1} alignItems="center" justifyContent="center" padding="$4">
              <MessageSquare size={24} color="rgba(229,231,235,0.15)" />
              <Text
                fontSize={12}
                color="rgba(229,231,235,0.3)"
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
    </YStack>
  );
}
