// ============================================================================
// KANBAN COLUMN — the `.colk` of the OS prototype (design-testing, Oct 2026)
//
// A washed, rounded (16) container 280 wide: header = colour dot + mono caps
// name + count; cards stacked with 10px gap; a ghost "+ Añadir tarea" row at
// the bottom. While a card is dragged over it the column takes the violet
// gradient wash and lifts 2px (`.colk.drop`).
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, ScrollView, View } from "react-native"
import { type BoardColumn, type Task } from "../../store/boardStore"
import { type DependencyHighlight, getColumnColor, type AgentMapEntry } from "./board-utils"
import { TaskCard } from "./TaskCard"
import { Btn, Dot, Field, Ph, T } from "../../components/ui/ds"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors } from "../../components/mca/primitives/colors"

export const KANBAN_COLUMN_WIDTH = 280

interface KanbanColumnProps {
  column: BoardColumn
  tasks: Task[]
  allTasks: Task[]
  totalTasksCount: number
  allColumns: BoardColumn[]
  selectedTaskId: string | null
  addingToColumn: string | null
  newTaskTitle: string
  isCreatingTask: boolean
  /** Map of taskId → DependencyHighlight for the currently hovered task */
  dependencyHighlights: Map<string, DependencyHighlight>
  onSelectTask: (taskId: string) => void
  onAddTask: () => void
  onCancelAdd: () => void
  onChangeNewTitle: (text: string) => void
  onSubmitNewTask: () => void
  onMoveTask: (taskId: string, columnId: string, position?: number) => void
  onDeleteTask: (taskId: string) => void
  onOpenConversation: (channelId: string) => void
  agentMap: Record<string, AgentMapEntry>
  onTaskHoverIn: (taskId: string) => void
  onTaskHoverOut: () => void
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
  const { t } = useTranslation()
  const c = useColors()
  const color = getColumnColor(column.slug)
  const isAdding = addingToColumn === column.columnId
  const hiddenCount = totalTasksCount - tasks.length
  const [dragOver, setDragOver] = useState(false)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [addHover, setAddHover] = useState(false)
  const columnRef = useRef<any>(null)
  const tasksContainerRef = useRef<any>(null)
  const onMoveTaskRef = useRef(onMoveTask)
  onMoveTaskRef.current = onMoveTask
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks

  // Compute drop index from cursor Y position relative to task cards
  const computeDropIndex = useCallback(
    (y: number) => {
      const container = tasksContainerRef.current as HTMLElement | null
      if (!container) return tasks.length
      const cards = container.querySelectorAll('[data-task-card="true"]')
      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect()
        const midY = rect.top + rect.height / 2
        if (y < midY) return i
      }
      return cards.length
    },
    [tasks.length],
  )

  // Attach native drop target events (RNW doesn't forward drag events)
  useEffect(() => {
    const el = columnRef.current as HTMLElement | null
    if (!el) return
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
      setDragOver(true)
      setDropIndex(computeDropIndex(e.clientY))
    }
    const handleDragLeave = (e: DragEvent) => {
      if (!el.contains(e.relatedTarget as Node)) {
        setDragOver(false)
        setDropIndex(null)
      }
    }
    const handleDrop = (e: DragEvent) => {
      e.preventDefault()
      const idx = computeDropIndex(e.clientY)
      setDragOver(false)
      setDropIndex(null)
      const taskId = e.dataTransfer?.getData("text/plain")
      if (taskId) {
        // Skip if dropping in the same position within same column
        const currentIndex = tasksRef.current.findIndex((t) => t.taskId === taskId)
        if (currentIndex !== -1 && (idx === currentIndex || idx === currentIndex + 1)) {
          return
        }
        onMoveTaskRef.current(taskId, column.columnId, idx)
      }
    }
    el.addEventListener("dragover", handleDragOver)
    el.addEventListener("dragleave", handleDragLeave)
    el.addEventListener("drop", handleDrop)
    return () => {
      el.removeEventListener("dragover", handleDragOver)
      el.removeEventListener("dragleave", handleDragLeave)
      el.removeEventListener("drop", handleDrop)
    }
  }, [column.columnId, computeDropIndex])

  const dropLine = (
    <View
      style={{ height: 2, backgroundColor: colors.purple300, borderRadius: 1, marginVertical: -1 }}
    />
  )

  return (
    <View
      ref={columnRef}
      style={[
        {
          width: KANBAN_COLUMN_WIDTH,
          flexShrink: 0,
          borderRadius: 16,
          backgroundColor: dragOver ? c.navActive : c.wash,
          padding: 12,
          gap: 10,
          minHeight: 240,
          maxHeight: "100%",
        },
        Platform.OS === "web"
          ? ({
              transition:
                "background 0.25s, box-shadow 0.25s, transform 0.3s cubic-bezier(.16,1,.3,1)",
              ...(dragOver
                ? {
                    backgroundImage:
                      "linear-gradient(rgba(111,39,255,0.02) 0%, rgba(111,39,255,0.07) 45%, rgba(111,39,255,0.16) 100%)",
                    boxShadow: "inset 0 0 24px rgba(111,39,255,0.10)",
                    transform: "translateY(-2px)",
                  }
                : {}),
            } as any)
          : null,
      ]}
    >
      {/* Column header — dot + mono caps name + count */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 4,
          paddingTop: 4,
          paddingBottom: 2,
        }}
      >
        <Dot color={color} size={8} />
        <T step="codenote" color={color} ellipsis style={{ flexShrink: 1 }}>
          {column.name}
        </T>
        <View style={{ flex: 1 }} />
        <T step="codenote" tone="text3">
          {String(tasks.length)}
        </T>
      </View>

      {/* Backlog autoplay warning */}
      {column.slug === "backlog" && tasks.length > 0 && (
        <View
          style={{ flexDirection: "row", alignItems: "flex-start", gap: 6, paddingHorizontal: 4 }}
        >
          <Ph name="warning" size={12} color={c.tint.a.tx} style={{ marginTop: 1 }} />
          <View style={{ flex: 1, gap: 1 }}>
            <T step="12" color={c.tint.a.tx}>
              {t("board.backlogAutoplayWarning")}
            </T>
            <T step="12" tone="text3">
              {t("board.backlogAutoplayHint")}
            </T>
          </View>
        </View>
      )}

      {/* Tasks list */}
      <ScrollView style={{ flexGrow: 0, flexShrink: 1 }} showsVerticalScrollIndicator={false}>
        <View ref={tasksContainerRef} style={{ gap: 10 }}>
          {tasks.map((task, index) => (
            <React.Fragment key={task.taskId}>
              {dragOver && dropIndex === index && dropLine}
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
          {dragOver && dropIndex === tasks.length && dropLine}

          {/* Inline add task — a step card with the field + pills */}
          {isAdding && (
            <View
              style={[
                { borderRadius: 16, backgroundColor: c.bgStep, padding: 12, gap: 10 },
                Platform.OS === "web" ? ({ boxShadow: c.liftSm } as any) : null,
              ]}
            >
              <Field
                value={newTaskTitle}
                onChangeText={onChangeNewTitle}
                placeholder={t("board.taskTitlePlaceholder")}
                autoFocus
                onSubmitEditing={onSubmitNewTask}
                testID={`board-new-task-input-${column.slug}`}
              />
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Btn
                  variant="primary"
                  size="sm"
                  onPress={onSubmitNewTask}
                  disabled={isCreatingTask}
                  loading={isCreatingTask}
                >
                  {t("board.createTask")}
                </Btn>
                <Btn variant="ghost" size="sm" onPress={onCancelAdd}>
                  {t("common.cancel", { defaultValue: "Cancel" })}
                </Btn>
              </View>
            </View>
          )}

          {/* Hidden tasks indicator */}
          {hiddenCount > 0 && (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                paddingVertical: 6,
              }}
            >
              <Ph name="eye-slash" size={12} color={c.text3} />
              <T step="12" tone="text3">
                {t("board.hiddenTasksByFilters", { count: hiddenCount })}
              </T>
            </View>
          )}
        </View>
      </ScrollView>

      {/* Ghost "+ Añadir tarea" row */}
      {!isAdding && (
        <Pressable
          onPress={onAddTask}
          accessibilityRole="button"
          testID={`board-add-task-${column.slug}`}
          {...(Platform.OS === "web"
            ? { onHoverIn: () => setAddHover(true), onHoverOut: () => setAddHover(false) }
            : {})}
          style={[
            {
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingVertical: 8,
              paddingHorizontal: 10,
              borderRadius: 10,
              backgroundColor: addHover ? c.wash2 : "transparent",
            },
            Platform.OS === "web"
              ? ({ cursor: "pointer", transition: "background 0.2s" } as any)
              : null,
          ]}
        >
          <Ph name="plus" size={14} color={addHover ? c.accent : c.text2} />
          <T step="sm" color={addHover ? c.accent : c.text2}>
            {t("board.addTask", { defaultValue: "Add task" })}
          </T>
        </Pressable>
      )}
    </View>
  )
}
