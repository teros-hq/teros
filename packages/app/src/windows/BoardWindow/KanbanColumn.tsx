// ============================================================================
// KANBAN COLUMN
// ============================================================================

import { EyeOff, Plus } from '@tamagui/lucide-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, TextInput, TouchableOpacity, View } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { type BoardColumn, type Task } from '../../store/boardStore';
import { type DependencyHighlight, getColumnColor } from './board-utils';
import { TaskCard } from './TaskCard';

interface KanbanColumnProps {
  column: BoardColumn;
  tasks: Task[];
  allTasks: Task[];
  totalTasksCount: number;
  allColumns: BoardColumn[];
  selectedTaskId: string | null;
  addingToColumn: string | null;
  newTaskTitle: string;
  isCreatingTask: boolean;
  /** Map of taskId → DependencyHighlight for the currently hovered task */
  dependencyHighlights: Map<string, DependencyHighlight>;
  onSelectTask: (taskId: string) => void;
  onAddTask: () => void;
  onCancelAdd: () => void;
  onChangeNewTitle: (text: string) => void;
  onSubmitNewTask: () => void;
  onMoveTask: (taskId: string, columnId: string, position?: number) => void;
  onDeleteTask: (taskId: string) => void;
  onOpenConversation: (channelId: string) => void;
  agentMap: Record<string, { name: string; avatarUrl?: string }>;
  onTaskHoverIn: (taskId: string) => void;
  onTaskHoverOut: () => void;
}

export function KanbanColumn({
  column,
  tasks,
  allTasks,
  totalTasksCount,
  allColumns,
  selectedTaskId,
  addingToColumn,
  newTaskTitle,
  isCreatingTask,
  dependencyHighlights,
  onSelectTask,
  onAddTask,
  onCancelAdd,
  onChangeNewTitle,
  onSubmitNewTask,
  onMoveTask,
  onDeleteTask,
  onOpenConversation,
  agentMap,
  onTaskHoverIn,
  onTaskHoverOut,
}: KanbanColumnProps) {
  const color = getColumnColor(column.slug);
  const isAdding = addingToColumn === column.columnId;
  const hiddenCount = totalTasksCount - tasks.length;
  const [dragOver, setDragOver] = useState(false);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const columnRef = useRef<any>(null);
  const tasksContainerRef = useRef<any>(null);
  const onMoveTaskRef = useRef(onMoveTask);
  onMoveTaskRef.current = onMoveTask;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  // Compute drop index from cursor Y position relative to task cards
  const computeDropIndex = useCallback(
    (y: number) => {
      const container = tasksContainerRef.current as HTMLElement | null;
      if (!container) return tasks.length;
      const cards = container.querySelectorAll('[data-task-card="true"]');
      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (y < midY) return i;
      }
      return cards.length;
    },
    [tasks.length],
  );

  // Attach native drop target events (RNW doesn't forward drag events)
  useEffect(() => {
    const el = columnRef.current as HTMLElement | null;
    if (!el) return;
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      setDragOver(true);
      setDropIndex(computeDropIndex(e.clientY));
    };
    const handleDragLeave = (e: DragEvent) => {
      if (!el.contains(e.relatedTarget as Node)) {
        setDragOver(false);
        setDropIndex(null);
      }
    };
    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      const idx = computeDropIndex(e.clientY);
      setDragOver(false);
      setDropIndex(null);
      const taskId = e.dataTransfer?.getData('text/plain');
      if (taskId) {
        // Skip if dropping in the same position within same column
        const currentIndex = tasksRef.current.findIndex((t) => t.taskId === taskId);
        if (currentIndex !== -1 && (idx === currentIndex || idx === currentIndex + 1)) {
          return;
        }
        onMoveTaskRef.current(taskId, column.columnId, idx);
      }
    };
    el.addEventListener('dragover', handleDragOver);
    el.addEventListener('dragleave', handleDragLeave);
    el.addEventListener('drop', handleDrop);
    return () => {
      el.removeEventListener('dragover', handleDragOver);
      el.removeEventListener('dragleave', handleDragLeave);
      el.removeEventListener('drop', handleDrop);
    };
  }, [column.columnId, computeDropIndex]);

  return (
    <YStack
      ref={columnRef}
      width={260}
      backgroundColor={dragOver ? 'rgba(139,92,246,0.08)' : 'rgba(255,255,255,0.03)'}
      borderRadius={10}
      overflow="hidden"
      borderWidth={2}
      borderColor={dragOver ? 'rgba(139,92,246,0.4)' : 'transparent'}
      maxHeight="100%"
    >
      {/* Column header */}
      <XStack
        paddingHorizontal="$3"
        paddingVertical="$2"
        alignItems="center"
        borderBottomWidth={1}
        borderBottomColor="rgba(255,255,255,0.06)"
      >
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: color,
            marginRight: 8,
          }}
        />
        <Text fontSize={13} fontWeight="600" color="$color" flex={1}>
          {column.name}
        </Text>
        <Text fontSize={11} color="$color" opacity={0.4} marginRight={4}>
          {tasks.length}
        </Text>
        <TouchableOpacity onPress={onAddTask} style={{ padding: 2 }}>
          <Plus size={14} color={color} />
        </TouchableOpacity>
      </XStack>

      {/* Tasks list */}
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        <YStack ref={tasksContainerRef} padding="$2" gap={6}>
          {tasks.map((task, index) => (
            <React.Fragment key={task.taskId}>
              {dragOver && dropIndex === index && (
                <View
                  style={{
                    height: 2,
                    backgroundColor: '#8B5CF6',
                    borderRadius: 1,
                    marginVertical: -2,
                  }}
                />
              )}
              <View
                // @ts-expect-error — web-only data attribute
                dataSet={{ taskCard: true }}
              >
                <TaskCard
                  task={task}
                  isSelected={task.taskId === selectedTaskId}
                  dependencyHighlight={dependencyHighlights.get(task.taskId) ?? null}
                  allColumns={allColumns}
                  allTasks={allTasks}
                  currentColumnSlug={column.slug}
                  onPress={() => onSelectTask(task.taskId)}
                  onMoveTask={onMoveTask}
                  onDeleteTask={onDeleteTask}
                  onOpenConversation={onOpenConversation}
                  agentMap={agentMap}
                  onHoverIn={() => onTaskHoverIn(task.taskId)}
                  onHoverOut={onTaskHoverOut}
                />
              </View>
            </React.Fragment>
          ))}
          {dragOver && dropIndex === tasks.length && (
            <View
              style={{ height: 2, backgroundColor: '#8B5CF6', borderRadius: 1, marginVertical: -2 }}
            />
          )}

          {/* Inline add task */}
          {isAdding && (
            <YStack backgroundColor="rgba(255,255,255,0.06)" borderRadius={8} padding="$2">
              <TextInput
                value={newTaskTitle}
                onChangeText={onChangeNewTitle}
                placeholder="Task title..."
                placeholderTextColor="#666"
                autoFocus
                onSubmitEditing={onSubmitNewTask}
                style={{
                  color: 'white',
                  fontSize: 13,
                  padding: 0,
                  marginBottom: 8,
                }}
              />
              <XStack gap="$2">
                <TouchableOpacity
                  onPress={onSubmitNewTask}
                  disabled={isCreatingTask}
                  style={{
                    backgroundColor: color,
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                    borderRadius: 4,
                    opacity: isCreatingTask ? 0.5 : 1,
                  }}
                >
                  <Text fontSize={12} color="white" fontWeight="600">
                    {isCreatingTask ? '...' : 'Crear'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={onCancelAdd}>
                  <Text fontSize={12} color="$color" opacity={0.5}>
                    Cancelar
                  </Text>
                </TouchableOpacity>
              </XStack>
            </YStack>
          )}

          {/* Hidden tasks indicator */}
          {hiddenCount > 0 && (
            <XStack
              alignItems="center"
              justifyContent="center"
              gap={4}
              paddingVertical={8}
              marginTop={4}
            >
              <EyeOff size={11} color="#6B7280" />
              <Text fontSize={11} color="#6B7280" opacity={0.7}>
                {hiddenCount} {hiddenCount !== 1 ? 'tareas ocultas' : 'tarea oculta'} por filtros
              </Text>
            </XStack>
          )}
        </YStack>
      </ScrollView>
    </YStack>
  );
}
