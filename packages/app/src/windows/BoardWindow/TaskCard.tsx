// ============================================================================
// TASK CARD — the `.tcard` of the OS prototype (design-testing, Oct 2026)
//
// A white/step card one step off the washed column, radius 16, padding 14:
//   row 1  status glyph (by column) + title (sans 13)
//   row 2  priority Badge + #tag chips
//   row 3  dependency note (amber / red) when the task waits on others
//   row 4  assignee Avatar 20 + name · meta (chat glyph, age in mono)
// The whole card is the drag handle (cursor grab, opacity .4 while dragging).
// ============================================================================

import React, { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, View } from "react-native"
import { PRIORITY_CONFIG, type BoardColumn, type Task } from "../../store/boardStore"
import {
  BLOCK_STATUS_CONFIG,
  type DependencyHighlight,
  getBlockStatus,
  timeAgo,
  type AgentMapEntry,
} from "./board-utils"
import { AppSpinner } from "../../components/ui"
import { Avatar } from "../../components/Avatar"
import { Badge, type BadgeTone, Ph, T } from "../../components/ui/ds"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors } from "../../components/mca/primitives/colors"
import { normalizeTags } from "@teros/shared"
import { useChannelAgentHours } from "../../hooks/useChannelAgentHours"

interface TaskCardProps {
  task: Task
  isSelected: boolean
  /**
   * Highlight state driven by hovering/selecting another task that this task
   * depends on:
   *   - 'will-unblock'  → completing the hovered task fully unblocks this one (orange)
   *   - 'still-blocked' → this task would still be blocked by other deps (dark red)
   *   - null            → no highlight
   */
  dependencyHighlight?: DependencyHighlight
  allColumns: BoardColumn[]
  allTasks: Task[]
  currentColumnSlug: string
  onPress: () => void
  onMoveTask: (taskId: string, columnId: string, position?: number) => void
  onDeleteTask: (taskId: string) => void
  onOpenConversation: (channelId: string) => void
  agentMap: Record<string, AgentMapEntry>
  /** Called when the card is hovered (mouse enter) */
  onHoverIn?: () => void
  /** Called when the card is no longer hovered (mouse leave) */
  onHoverOut?: () => void
}

// ─── Shared bits (also used by the list view) ───────────────────────────────

/** Priority → badge tone + label (the prototype's Media/Alta/Baja/Urgente tints).
 *  Labels come from the store's PRIORITY_CONFIG so cards, list and detail agree;
 *  `board.priority_<key>` overrides them per locale when present. */
export function priorityMeta(
  priority: Task["priority"] | undefined,
  t: (k: string, o?: any) => string,
): { tone: BadgeTone; label: string } {
  const key = priority ?? "medium"
  const label = t(`board.priority_${key}`, { defaultValue: PRIORITY_CONFIG[key]?.label ?? key })
  const tone: BadgeTone =
    key === "urgent" ? "r" : key === "high" ? "a" : key === "low" ? "neutral" : "i"
  return { tone, label }
}

/** The `.status-mark` glyph of a task, decided by the column it sits in. */
export function StatusMark({
  slug,
  running,
  size = 18,
}: {
  slug: string
  running?: boolean
  size?: number
}) {
  const c = useColors()
  if (running) return <AppSpinner size="xs" variant="warning" />
  let name = "circle-dashed"
  let color = c.text3
  switch (slug) {
    case "in_progress":
      name = "circle-notch"
      color = colors.amber
      break
    case "blocked":
      name = "x-circle"
      color = colors.red
      break
    case "review":
      name = "circle"
      color = c.accent
      break
    case "done":
      name = "check-circle"
      color = colors.green
      break
    default:
      break
  }
  return <Ph name={name} size={size} color={color} />
}

// Dependency highlight style config (hover of a dependency)
const DEPENDENCY_HIGHLIGHT_CONFIG: Record<
  NonNullable<DependencyHighlight>,
  { tone: "a" | "r"; color: string; label: string }
> = {
  "will-unblock": { tone: "a", color: colors.orange, label: "Would unblock" },
  "still-blocked": { tone: "r", color: colors.red, label: "Would remain blocked" },
}

export function TaskCard({
  task,
  isSelected,
  dependencyHighlight,
  allColumns,
  allTasks,
  currentColumnSlug,
  onPress,
  onOpenConversation,
  agentMap,
  onHoverIn,
  onHoverOut,
}: TaskCardProps) {
  const { t } = useTranslation()
  const c = useColors()
  const [isDragging, setIsDragging] = useState(false)
  const [hover, setHover] = useState(false)
  const blockStatus = getBlockStatus(task, allTasks, allColumns)
  const blockConfig = BLOCK_STATUS_CONFIG[blockStatus]
  const cardRef = useRef<any>(null)

  const depConfig = dependencyHighlight ? DEPENDENCY_HIGHLIGHT_CONFIG[dependencyHighlight] : null

  // Attach native drag events (RNW doesn't forward drag events). The whole
  // card is the handle, like the prototype (`.tcard { cursor: grab }`).
  useEffect(() => {
    const card = cardRef.current as HTMLElement | null
    if (!card) return
    card.draggable = true
    const handleDragStart = (e: DragEvent) => {
      e.dataTransfer?.setData("text/plain", task.taskId)
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move"
        e.dataTransfer.setDragImage(card, 20, 20)
      }
      // Hide original after a tick (browser needs it visible to capture drag image)
      requestAnimationFrame(() => setIsDragging(true))
    }
    const handleDragEnd = () => {
      setIsDragging(false)
    }
    card.addEventListener("dragstart", handleDragStart)
    card.addEventListener("dragend", handleDragEnd)
    return () => {
      card.removeEventListener("dragstart", handleDragStart)
      card.removeEventListener("dragend", handleDragEnd)
    }
  }, [task.taskId])

  // Attach hover events via native DOM (RNW onHoverIn/onHoverOut not always reliable)
  useEffect(() => {
    const card = cardRef.current as HTMLElement | null
    if (!card) return
    const handleMouseEnter = () => {
      setHover(true)
      onHoverIn?.()
    }
    const handleMouseLeave = () => {
      setHover(false)
      onHoverOut?.()
    }
    card.addEventListener("mouseenter", handleMouseEnter)
    card.addEventListener("mouseleave", handleMouseLeave)
    return () => {
      card.removeEventListener("mouseenter", handleMouseEnter)
      card.removeEventListener("mouseleave", handleMouseLeave)
    }
  }, [onHoverIn, onHoverOut])

  const assignee = task.assignedAgentId ? agentMap[task.assignedAgentId] : undefined
  const assigneeName = task.assignedAgentId
    ? assignee?.name || task.assignedAgentId.slice(0, 12)
    : ""
  const priority = priorityMeta(task.priority, t)
  // WS2: the task inherits the agent-hours of its linked conversation (same
  // shared cache as the chat header chip and the conversations list).
  const agentHours = useChannelAgentHours(task.channelId)
  // Legacy data guard: tags can arrive as a JSON/CSV string from Mongo —
  // normalize before any array op (bug "task.tags.slice(...).map is not a function").
  const tags = normalizeTags(task.tags)
  const hasDeps = !!task.dependencies && task.dependencies.length > 0
  const showBlockNote = hasDeps && blockStatus !== "green" && !depConfig

  // Left accent strip: running → amber, blocked column → red (the prototype's
  // In Progress / Blocked cards carry a coloured edge).
  const edge =
    task.running || currentColumnSlug === "in_progress"
      ? colors.amber
      : currentColumnSlug === "blocked"
        ? colors.red
        : null

  // Border: dependency highlight > selected > hairline (transparent).
  const borderColor = depConfig
    ? depConfig.color
    : isSelected
      ? c.borderAccentStrong
      : "transparent"
  const backgroundColor = depConfig ? c.tint[depConfig.tone].bg : c.bgStep

  return (
    <Pressable
      onPress={onPress}
      {...(Platform.OS === "web" ? ({ "data-task-card": true } as any) : {})}
    >
      <View
        ref={cardRef}
        style={[
          {
            borderRadius: 16,
            backgroundColor,
            borderWidth: 1,
            borderColor,
            padding: 14,
            paddingLeft: edge ? 14 : 14,
            gap: 10,
            opacity: isDragging ? 0.4 : 1,
            overflow: "hidden",
          },
          Platform.OS === "web"
            ? ({
                cursor: "grab",
                userSelect: "none",
                boxShadow: hover ? c.liftSmHover : c.liftSm,
                transform: hover && !isDragging ? "translateY(-2px)" : "none",
                transition:
                  "box-shadow 0.3s cubic-bezier(.16,1,.3,1), transform 0.3s cubic-bezier(.16,1,.3,1), border-color 0.2s, opacity 0.2s",
              } as any)
            : null,
        ]}
      >
        {edge ? (
          <View
            style={{
              position: "absolute",
              left: 0,
              top: 10,
              bottom: 10,
              width: 3,
              borderRadius: 2,
              backgroundColor: edge,
            }}
          />
        ) : null}

        {/* Row 1: status glyph + title (+ stop badge) */}
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
          <View
            style={{
              width: 18,
              height: 18,
              alignItems: "center",
              justifyContent: "center",
              marginTop: 0,
            }}
          >
            <StatusMark slug={currentColumnSlug} running={task.running} />
          </View>
          <T step="sm" style={{ flex: 1 }} numberOfLines={3}>
            {task.title}
          </T>
          {task.stopRequested ? (
            <Badge tone="a" sm cap>
              {t("board.stopPending", { defaultValue: "Stop" })}
            </Badge>
          ) : null}
        </View>

        {/* Row 2: priority + tags + agent-hours (WS2) */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Badge tone={priority.tone} sm>
            {priority.label}
          </Badge>
          {tags.slice(0, 3).map((tag) => (
            <Badge key={tag} tone="neutral" sm>
              {`#${tag}`}
            </Badge>
          ))}
          {tags.length > 3 ? (
            <T step="codenote" tone="text3">
              +{tags.length - 3}
            </T>
          ) : null}
          {/* WS2: agent-hours inherited from the linked conversation. Quiet
              text3 mini badge under the title — hidden until loaded and for
              tasks without a linked channel. */}
          {task.channelId && !agentHours.loading ? (
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 3, marginLeft: "auto" }}
              testID={`task-card-agent-hours-${task.taskId}`}
            >
              <Ph name="clock" size={11} color={c.text3} />
              <T step="codenote" tone="text3">
                {agentHours.formatted}
              </T>
            </View>
          ) : null}
        </View>

        {/* Row 3: dependency notes */}
        {depConfig ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Ph
              name={dependencyHighlight === "will-unblock" ? "lock-key-open" : "lock-key"}
              size={12}
              color={depConfig.color}
            />
            <T step="12" color={depConfig.color}>
              {depConfig.label}
            </T>
          </View>
        ) : showBlockNote ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Ph
              name={blockStatus === "circular" ? "warning" : "hourglass"}
              size={12}
              color={blockConfig.color}
            />
            <T step="12" color={blockConfig.color}>
              {blockConfig.label}
            </T>
          </View>
        ) : null}

        {/* Row 4: assignee + meta */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {task.assignedAgentId ? (
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 7, flex: 1, minWidth: 0 }}
            >
              <Avatar
                name={assigneeName}
                imageUrl={assignee?.avatarUrl}
                size={20}
                isAgent={assignee?.type !== "human"}
              />
              <T step="12" tone="text2" ellipsis style={{ flexShrink: 1 }}>
                {assigneeName}
              </T>
            </View>
          ) : (
            <View style={{ flex: 1 }} />
          )}

          {task.channelId ? (
            <Pressable
              onPress={(e) => {
                e.stopPropagation?.()
                onOpenConversation(task.channelId!)
              }}
              hitSlop={6}
              {...(Platform.OS === "web" ? ({ title: t("board.conversation") } as any) : {})}
              style={{ flexDirection: "row", alignItems: "center", gap: 3 }}
            >
              <Ph name="chat-circle" size={13} color={c.text3} />
            </Pressable>
          ) : null}

          <T step="codenote" tone="text3">
            {timeAgo(task.createdAt)}
          </T>
        </View>
      </View>
    </Pressable>
  )
}
