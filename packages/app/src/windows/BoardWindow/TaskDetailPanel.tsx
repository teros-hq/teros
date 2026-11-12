// ============================================================================
// TASK DETAIL PANEL
// The right-hand task sheet of the board (OS prototype, design-testing):
// a sheet-coloured panel with a header strip (assignee · play/stop · tools),
// the serif title with its status dot, badges, and tabbed content in cards.
// ============================================================================

import React, { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Modal, Platform, Pressable, ScrollView, View, type ViewStyle } from "react-native"
import { PRIORITY_CONFIG, type BoardColumn, type Task } from "../../store/boardStore"
import { normalizeTags } from "@teros/shared"
import { useChannelAgentHours } from "../../hooks/useChannelAgentHours"
import { getColumnColor, timeAgoNatural, type MemberType, type AgentMapEntry } from "./board-utils"
import { CompactMarkdown } from "./CompactMarkdown"
import { ConversationPreview } from "./ConversationPreview"
import {
  TaskOutputDisplay,
  TaskOutputFormInline,
  getOutputGate,
  getOutputType,
  shouldShowOutputForm,
  TaskInputDisplay,
} from "./TaskOutputForm"
import { AppSpinner } from "../../components/ui"
import { Avatar } from "../../components/Avatar"
import { colors as semantic } from "../../components/mca/primitives/colors"
import { useColors } from "../../components/mca/primitives/useColors"
import {
  Badge,
  Btn,
  Card,
  Dot,
  Field,
  FieldLabel,
  IconBtn,
  LGroup,
  LRow,
  PTabs,
  Ph,
  T,
  Tile,
  type BadgeTone,
} from "../../components/ui/ds"

// ─── Helpers ────────────────────────────────────────────────────────────────

/** True for any system-prefixed actor ('system', 'system:autoplay', etc.) */
function isSystemActor(actor: string | undefined | null): boolean {
  if (!actor) return true
  return actor === "system" || actor.startsWith("system:")
}

/** Priority → status tint of the DS (Urgente red · Alta amber · Media violet · Baja neutral). */
const PRIORITY_TONE: Record<string, BadgeTone> = {
  urgent: "r",
  high: "a",
  medium: "i",
  low: "neutral",
}

/** Inline Teros logo as data URI — 6 hexagon circles, white on transparent */
const TEROS_LOGO_DATA_URI =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">' +
      '<circle cx="256" cy="76.8" r="35.84" fill="white"/>' +
      '<circle cx="411.2" cy="166.4" r="35.84" fill="white"/>' +
      '<circle cx="100.8" cy="166.4" r="35.84" fill="white"/>' +
      '<circle cx="411.2" cy="345.6" r="35.84" fill="white"/>' +
      '<circle cx="100.8" cy="345.6" r="35.84" fill="white"/>' +
      '<circle cx="256" cy="435.2" r="35.84" fill="white"/>' +
      "</svg>",
  )

// ─── Agent avatar (inline) ──────────────────────────────────────────────────

function PanelAgentAvatar({
  name,
  avatarUrl,
  size = 28,
  isSystem = false,
  type,
}: {
  name: string
  avatarUrl?: string
  size?: number
  isSystem?: boolean
  memberId?: string
  type?: MemberType
}) {
  if (isSystem) {
    // The system actor is Teros itself — the brand mark on the violet disc.
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: semantic.purple300,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        {Platform.OS === "web" ? (
          <img
            src={TEROS_LOGO_DATA_URI}
            alt="Teros"
            style={{ width: size * 0.6, height: size * 0.6, objectFit: "contain" }}
          />
        ) : (
          <Ph name="hexagon" size={size * 0.6} color="#FFFFFF" />
        )}
      </View>
    )
  }
  return <Avatar name={name} imageUrl={avatarUrl} size={size} isAgent={type !== "human"} />
}

// ─── Progress note item (markdown + collapsible) ─────────────────────────────

const NOTE_COLLAPSED_HEIGHT = 110 // ~5-6 lines

interface ProgressNoteItemProps {
  text: string
  actor?: string
  timestamp: string
  actorName: string
  avatarUrl?: string
  type?: MemberType
}

function ProgressNoteItem({
  text,
  actor,
  actorName,
  timestamp,
  avatarUrl,
  type,
}: ProgressNoteItemProps) {
  const c = useColors()
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  // The row sits on the LGroup card (`c.bgStep`), so the fade resolves to it.
  const noteBg = c.bgStep

  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
      {/* Header: avatar + actor + time */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <PanelAgentAvatar
          name={actorName}
          avatarUrl={avatarUrl}
          size={20}
          isSystem={isSystemActor(actor)}
          type={type}
        />
        <T step="sm" ellipsis style={{ flexShrink: 1 }}>
          {actorName}
        </T>
        <View style={{ flex: 1 }} />
        <T step="codenote" tone="text3">
          {timeAgoNatural(timestamp)}
        </T>
      </View>

      {/* Markdown content — collapsible */}
      <View
        style={[
          { maxHeight: expanded ? 5000 : NOTE_COLLAPSED_HEIGHT, overflow: "hidden" },
          Platform.OS === "web" ? ({ transition: "max-height 0.3s ease" } as any) : null,
        ]}
      >
        <CompactMarkdown text={text} fontSize={12} />
      </View>

      {/* Fade overlay when collapsed — resolves to the card background. */}
      {!expanded && Platform.OS === "web" && (
        <View
          style={
            {
              height: 32,
              marginTop: -32,
              marginBottom: 4,
              background: `linear-gradient(to bottom, ${noteBg}00, ${noteBg})`,
              pointerEvents: "none",
            } as any
          }
        />
      )}

      {/* Show more / less */}
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        style={[
          {
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            paddingTop: 4,
            alignSelf: "flex-start",
          },
          Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
        ]}
      >
        <Ph name={expanded ? "caret-up" : "caret-down"} size={11} color={c.text3} />
        <T step="12" tone="text3">
          {expanded
            ? t("board.taskDetail.showLess", { defaultValue: "Ver menos" })
            : t("board.taskDetail.showMore", { defaultValue: "Ver más" })}
        </T>
      </Pressable>
    </View>
  )
}

// ─── Small empty block (tab content) ────────────────────────────────────────

function TabEmpty({ icon, text }: { icon: string; text: string }) {
  return (
    <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 36, gap: 10 }}>
      <Tile icon={icon} tone="muted" />
      <T step="sm" tone="text3" center style={{ maxWidth: 280 }}>
        {text}
      </T>
    </View>
  )
}

// ─── Confirm dialog (stop / archive) ────────────────────────────────────────

function ConfirmDialog({
  visible,
  icon,
  title,
  text,
  children,
  cancelLabel,
  confirmLabel,
  confirmVariant = "primary",
  onCancel,
  onConfirm,
}: {
  visible: boolean
  icon: string
  title: string
  text: string
  children?: React.ReactNode
  cancelLabel: string
  confirmLabel: string
  confirmVariant?: "primary" | "danger" | "dangerSoft" | "sec"
  onCancel: () => void
  onConfirm: () => void
}) {
  const c = useColors()
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable
        onPress={onCancel}
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: "rgba(32,28,39,0.55)",
          padding: 16,
        }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={[
            {
              width: "100%",
              maxWidth: 360,
              backgroundColor: c.bgStep,
              borderRadius: 16,
              padding: 20,
            },
            Platform.OS === "web" ? ({ boxShadow: c.elevRaised, cursor: "default" } as any) : null,
          ]}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <Tile
              sm
              icon={icon}
              tone={
                confirmVariant === "danger" || confirmVariant === "dangerSoft" ? "pink" : "accent"
              }
            />
            <T step="xl" style={{ flex: 1 }}>
              {title}
            </T>
          </View>
          <T step="sm" tone="text2" style={{ marginBottom: 16 }}>
            {text}
          </T>
          {children}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <Btn variant="ghost" onPress={onCancel}>
              {cancelLabel}
            </Btn>
            <Btn variant={confirmVariant} onPress={onConfirm}>
              {confirmLabel}
            </Btn>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

// ─── Tab types ───────────────────────────────────────────────────────────────

type TabId = "instructions" | "input" | "progress" | "output" | "conversation"

// ─── Main panel ──────────────────────────────────────────────────────────────

interface TaskDetailPanelProps {
  task: Task
  columns: BoardColumn[]
  onClose: () => void
  onMoveTask: (taskId: string, columnId: string, position?: number) => void
  onOpenConversation: (channelId: string) => void
  onAssignTask: (taskId: string, agentId: string | null) => void
  onStartTask: (taskId: string, agentId?: string) => void
  onStopTask?: (taskId: string) => void
  onCompleteTask: (taskId: string, outputData?: unknown) => void
  onSaveOutput?: (taskId: string, outputData: unknown, mode: "replace" | "append") => void
  onArchiveTask: (taskId: string, reason?: string) => void
  agentMap: Record<string, AgentMapEntry>
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
  onSaveOutput,
  onArchiveTask,
  agentMap,
}: TaskDetailPanelProps) {
  const c = useColors()
  const priority = PRIORITY_CONFIG[task.priority] || PRIORITY_CONFIG.medium
  const priorityTone = PRIORITY_TONE[task.priority] ?? "i"
  const { t } = useTranslation()
  // WS2: the task inherits the agent-hours of its linked conversation (same
  // shared cache as the chat header chip and the conversations list).
  const agentHours = useChannelAgentHours(task.channelId)

  const [isStarting, setIsStarting] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>("instructions")

  // Modal state
  const [showAgentDropdown, setShowAgentDropdown] = useState(false)
  const [showStopConfirm, setShowStopConfirm] = useState(false)
  const [showArchiveModal, setShowArchiveModal] = useState(false)
  // Output form state — lives in the panel so it persists across tab switches
  const [outputMarkdownText, setOutputMarkdownText] = useState("")
  const [outputFieldValues, setOutputFieldValues] = useState<Record<string, string | boolean>>({})
  const [submittingOutput, setSubmittingOutput] = useState(false)
  const [savingOutput, setSavingOutput] = useState(false)
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle")
  // Auto-save debounce: timer ref + 'pending' state for visual indicator
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [autoSavePending, setAutoSavePending] = useState(false)

  const [archiveReason, setArchiveReason] = useState("")

  // Derived state
  const currentColumn = columns.find((col) => col.columnId === task.columnId)
  const isDone = currentColumn?.slug === "done"
  const isBacklog = currentColumn?.slug === "backlog"
  const todoColumn = columns.find((col) => col.slug === "todo")
  // Sort agent entries: agents first, then humans — so the dropdown groups them visually.
  const agentEntries = Object.entries(agentMap).sort(([, a], [, b]) => {
    const aType = a.type ?? (a.name ? "agent" : "agent")
    const bType = b.type ?? (b.name ? "agent" : "agent")
    if (aType === bType) return 0
    return aType === "agent" ? -1 : 1
  })

  // Output gate derived state (after isDone is defined)
  const outputGate = getOutputGate(task)
  const outputType = getOutputType(outputGate)
  const hasOutputGate = outputGate !== null
  const hasExistingOutput = task.output?.data !== undefined && task.output?.data !== null
  const outputReadOnly = hasExistingOutput && isDone
  const hasInput = task.input?.data !== undefined && task.input?.data !== null

  const assignee = task.assignedAgentId ? agentMap[task.assignedAgentId] : undefined
  const columnColor = currentColumn ? getColumnColor(currentColumn.slug) : c.text3

  // ─── Stop pulse animation (matches composer StopButton) ──────────────────
  const stopPulseCss = useMemo(
    () => `
      @keyframes taskStopPulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.10); }
        50% { box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.18); }
      }
      .task-stop-pulse {
        animation: taskStopPulse 2.5s ease-in-out infinite;
        border-radius: 100px;
      }
    `,
    [],
  )

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const handlePlayPress = async () => {
    if (!task.assignedAgentId || task.running) return
    setIsStarting(true)
    try {
      await onStartTask(task.taskId, task.assignedAgentId!)
    } finally {
      setIsStarting(false)
    }
  }

  const handleStopPress = () => {
    setShowStopConfirm(true)
  }

  const confirmStop = () => {
    setShowStopConfirm(false)
    if (onStopTask) onStopTask(task.taskId)
  }

  const handleArchivePress = () => {
    if (isDone) {
      // Task is in Done — archive directly
      onArchiveTask(task.taskId)
    } else {
      // Task is NOT in Done — show confirmation modal
      setShowArchiveModal(true)
    }
  }

  const confirmArchive = () => {
    setShowArchiveModal(false)
    onArchiveTask(task.taskId, archiveReason.trim() || undefined)
    setArchiveReason("")
  }

  /**
   * Gather the output data from the inline form state.
   * Returns undefined for signal gates (no output needed).
   */
  const gatherOutputData = (): unknown => {
    if (outputType === "signal") return undefined
    if (outputType === "markdown") {
      return outputMarkdownText
    }
    // Structured — coerce field values to proper types
    const output: Record<string, unknown> = {}
    for (const [fieldId, value] of Object.entries(outputFieldValues)) {
      if (value === undefined || value === "") continue
      if (typeof value === "boolean") {
        output[fieldId] = value
      } else {
        // Try numeric coercion
        const num = Number(value)
        output[fieldId] = isNaN(num) ? value : num
      }
    }
    return output
  }

  const handleComplete = () => {
    // Cancel any pending auto-save timer — Completar saves + completes in one step
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
      setAutoSavePending(false)
    }
    if (shouldShowOutputForm(task)) {
      const outputData = gatherOutputData()
      setSubmittingOutput(true)
      onCompleteTask(task.taskId, outputData)
      setSubmittingOutput(false)
    } else {
      onCompleteTask(task.taskId)
    }
  }

  /**
   * Save output data without completing the task.
   * Calls onSaveOutput which persists to output.data via board.save-task-output.
   * No column move, no ActionBridge — just persists the output for later.
   */
  const handleSaveOutput = async (
    outputData: unknown,
    mode: "replace" | "append",
    autoSave = false,
  ) => {
    if (!onSaveOutput) return
    setSavingOutput(true)
    setSaveStatus("idle")
    try {
      await onSaveOutput(task.taskId, outputData, mode)
      setSaveStatus("saved")
      // Only clear the markdown textarea on manual save (button press).
      // For auto-save, keep the text so the user can continue editing.
      if (!autoSave) {
        setOutputMarkdownText("")
      }
      // Auto-clear the "saved" status after 2 seconds
      setTimeout(() => setSaveStatus("idle"), 2000)
    } catch {
      setSaveStatus("error")
      setTimeout(() => setSaveStatus("idle"), 5000)
    } finally {
      setSavingOutput(false)
    }
  }

  // ─── Auto-save debounce ──────────────────────────────────────────────────
  // When the user stops typing for 2s, automatically save the output.
  // Skipped when read-only, when no save handler, or when content is empty.
  useEffect(() => {
    // Don't auto-save if read-only, no save handler, or currently saving/completing
    if (outputReadOnly || !onSaveOutput || savingOutput || submittingOutput) {
      setAutoSavePending(false)
      return
    }

    // For markdown: need non-empty text to trigger
    if (outputType === "markdown" && !outputMarkdownText.trim()) {
      setAutoSavePending(false)
      return
    }
    // For structured: need at least one non-empty field
    if (outputType === "structured") {
      const hasContent = Object.values(outputFieldValues).some(
        (v) => v !== undefined && v !== "" && v !== false,
      )
      if (!hasContent) {
        setAutoSavePending(false)
        return
      }
    }
    // Signal gates have no form — nothing to auto-save
    if (outputType === "signal") {
      return
    }

    // Clear any existing timer (debounce reset)
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
    }

    // Mark as pending and start the 2s timer
    setAutoSavePending(true)
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null
      setAutoSavePending(false)
      // Determine save mode: append if there's existing output, replace otherwise
      const mode: "replace" | "append" = hasExistingOutput ? "append" : "replace"
      const outputData = gatherOutputData()
      if (outputData !== undefined) {
        handleSaveOutput(outputData, mode, true)
      }
    }, 2000)

    // Cleanup timer on unmount or before next run
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
        autoSaveTimerRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputMarkdownText, outputFieldValues, outputReadOnly, outputType, hasExistingOutput])

  // ─── Tabs ──────────────────────────────────────────────────────────────────

  const tabItems = useMemo(() => {
    const items: { key: TabId; label: string; icon: string }[] = [
      {
        key: "instructions",
        label: t("board.taskDetail.tabInstructions", { defaultValue: "Instrucciones" }),
        icon: "file-text",
      },
      {
        key: "progress",
        label: t("board.taskDetail.tabProgress", { defaultValue: "Progreso" }),
        icon: "clock",
      },
    ]
    if (hasInput) {
      items.splice(1, 0, {
        key: "input",
        label: t("board.taskDetail.tabInput", { defaultValue: "Entrada" }),
        icon: "tray-arrow-down",
      })
    }
    if (hasOutputGate) {
      items.push({
        key: "output",
        label: t("board.taskDetail.tabOutput", { defaultValue: "Output" }),
        icon: "list-checks",
      })
    }
    items.push({
      key: "conversation",
      label: t("board.taskDetail.tabConversation", { defaultValue: "Conversación" }),
      icon: "chat-circle",
    })
    return items
  }, [hasOutputGate, t, hasInput])

  const dividerStyle: ViewStyle = { borderBottomWidth: 1, borderBottomColor: c.border }

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <View
      style={[
        {
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          width: 440,
          maxWidth: "100%",
          backgroundColor: c.bgSheet,
          borderLeftWidth: 1,
          borderLeftColor: c.border,
          zIndex: 50,
        },
        Platform.OS === "web" ? ({ boxShadow: c.lift } as any) : null,
      ]}
      // The board's click-outside detector looks for this marker. `testID`
      // becomes `data-testid` in the DOM; a bare `data-*` prop does not.
      testID="task-detail-panel"
      {...(Platform.OS === "web" ? ({ "data-task-detail-panel": true } as any) : {})}
    >
      {Platform.OS === "web" && <style>{stopPulseCss}</style>}

      {/* ── Header strip: assignee · play/stop · archive · close ─────────── */}
      <View
        style={[
          {
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            minHeight: 56,
            paddingHorizontal: 16,
            paddingVertical: 10,
            zIndex: 200,
          },
          dividerStyle,
        ]}
      >
        {/* Assignee selector — relative wrapper so the list can overlay */}
        <View style={{ position: "relative", zIndex: 201 }}>
          <Pressable
            onPress={() => setShowAgentDropdown(!showAgentDropdown)}
            accessibilityRole="button"
            style={[
              {
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                height: 36,
                paddingLeft: 6,
                paddingRight: 12,
                borderRadius: 100,
                backgroundColor: task.assignedAgentId ? c.navActive : c.wash,
                borderWidth: 1,
                borderColor: showAgentDropdown ? c.borderAccentStrong : "transparent",
                maxWidth: 190,
              },
              Platform.OS === "web"
                ? ({ cursor: "pointer", transition: "background 0.2s, border-color 0.2s" } as any)
                : null,
            ]}
          >
            {assignee ? (
              <PanelAgentAvatar
                name={assignee.name}
                avatarUrl={assignee.avatarUrl}
                size={24}
                type={assignee.type}
              />
            ) : (
              <View
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  backgroundColor: c.wash2,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Ph name="user" size={13} color={c.text3} />
              </View>
            )}
            <T
              step="sm"
              color={task.assignedAgentId ? c.text : c.text2}
              ellipsis
              style={{ flexShrink: 1 }}
            >
              {task.assignedAgentId
                ? assignee?.name || task.assignedAgentId.slice(0, 12)
                : t("board.taskDetail.assign", { defaultValue: "Asignar" })}
            </T>
            <Ph name={showAgentDropdown ? "caret-up" : "caret-down"} size={12} color={c.text3} />
          </Pressable>

          {/* Assignee list — absolute overlay, doesn't push content */}
          {showAgentDropdown && (
            <>
              {/* Click-outside catcher — covers entire viewport */}
              <View
                style={
                  { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 99 } as any
                }
                {...(Platform.OS === "web"
                  ? ({ onClick: () => setShowAgentDropdown(false) } as any)
                  : ({ onTouchStart: () => setShowAgentDropdown(false) } as any))}
              />
              <View
                style={[
                  {
                    position: "absolute",
                    top: "100%",
                    left: 0,
                    width: 220,
                    marginTop: 6,
                    zIndex: 100,
                    borderRadius: 12,
                    backgroundColor: c.bgStep,
                    overflow: "hidden",
                    paddingVertical: 4,
                  },
                  Platform.OS === "web" ? ({ boxShadow: c.elevRaised } as any) : null,
                ]}
                {...(Platform.OS === "web"
                  ? ({ onClick: (e: any) => e.stopPropagation() } as any)
                  : {})}
              >
                {/* Unassign option */}
                {task.assignedAgentId && (
                  <Pressable
                    onPress={() => {
                      onAssignTask(task.taskId, null)
                      setShowAgentDropdown(false)
                    }}
                    style={({ pressed }) => [
                      {
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 10,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        backgroundColor: pressed ? c.nestHover : "transparent",
                        borderBottomWidth: 1,
                        borderBottomColor: c.border,
                      },
                      Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
                    ]}
                  >
                    <View
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 12,
                        backgroundColor: c.tint.r.bg,
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Ph name="x" size={12} color={c.tint.r.tx} />
                    </View>
                    <T step="sm" tone="danger">
                      {t("board.taskDetail.unassign", { defaultValue: "Desasignar" })}
                    </T>
                  </Pressable>
                )}
                {/* Member options */}
                {agentEntries.map(([agentId, agent], idx) => {
                  const isAssigned = agentId === task.assignedAgentId
                  // Insert a divider when transitioning from agents to humans
                  const prevEntry = idx > 0 ? agentEntries[idx - 1] : null
                  const prevType = prevEntry?.[1].type ?? "agent"
                  const currType = agent.type ?? "agent"
                  const showDivider = idx > 0 && prevType === "agent" && currType === "human"
                  return (
                    <React.Fragment key={agentId}>
                      {showDivider && (
                        <View style={{ height: 1, backgroundColor: c.border, marginVertical: 4 }} />
                      )}
                      <Pressable
                        onPress={() => {
                          onAssignTask(task.taskId, isAssigned ? null : agentId)
                          setShowAgentDropdown(false)
                        }}
                        style={({ pressed }) => [
                          {
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 10,
                            paddingHorizontal: 12,
                            paddingVertical: 7,
                            backgroundColor: pressed
                              ? c.nestHover
                              : isAssigned
                                ? c.navActive
                                : "transparent",
                          },
                          Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
                        ]}
                      >
                        <PanelAgentAvatar
                          name={agent.name}
                          avatarUrl={agent.avatarUrl}
                          size={24}
                          type={agent.type}
                        />
                        <T
                          step="sm"
                          color={isAssigned ? c.accent : c.text}
                          ellipsis
                          style={{ flex: 1 }}
                        >
                          {agent.name}
                        </T>
                        {isAssigned && <Ph name="check" size={13} color={c.accent} />}
                      </Pressable>
                    </React.Fragment>
                  )
                })}
                {agentEntries.length === 0 && (
                  <T step="12" tone="text3" style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
                    {t("board.taskDetail.noMembers", {
                      defaultValue: "No hay miembros disponibles",
                    })}
                  </T>
                )}
              </View>
            </>
          )}
        </View>

        {/* Play — shown when NOT running (disabled if no agent assigned) */}
        {!task.running && (
          <Btn
            variant="mint"
            size="sm"
            icon="play"
            onPress={handlePlayPress}
            disabled={!task.assignedAgentId || isStarting || task.archived}
            loading={isStarting}
          >
            {t("board.taskDetail.play", { defaultValue: "Play" })}
          </Btn>
        )}

        {/* Stop — shown when running, with pulse animation */}
        {task.running && (
          <View
            {...(Platform.OS === "web" ? ({ className: "task-stop-pulse" } as any) : {})}
            style={{ borderRadius: 100 }}
          >
            <Btn
              variant="dangerSoft"
              size="sm"
              icon="stop"
              onPress={handleStopPress}
              disabled={task.stopRequested}
            >
              {task.stopRequested ? "…" : t("board.taskDetail.stop", { defaultValue: "Stop" })}
            </Btn>
          </View>
        )}

        {/* Running indicator */}
        {task.running && <AppSpinner size="xs" variant="warning" />}

        <View style={{ flex: 1 }} />

        <IconBtn
          icon="archive"
          plain
          sm
          onPress={handleArchivePress}
          title={t("board.taskDetail.archive", { defaultValue: "Archivar" })}
        />
        <IconBtn
          icon="x"
          plain
          sm
          onPress={onClose}
          title={t("board.taskDetail.close", { defaultValue: "Cerrar" })}
        />
      </View>

      {/* ── Title block — STICKY: always visible while scrolling ───────────── */}
      <View
        style={[
          { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 14, gap: 10 },
          dividerStyle,
        ]}
      >
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
          <View style={{ paddingTop: 9 }}>
            <Dot color={columnColor} size={8} />
          </View>
          <T step="xl" style={{ flex: 1 }} numberOfLines={3}>
            {task.title}
          </T>
        </View>
        {/* Column · priority · tags */}
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 6,
            paddingLeft: 18,
          }}
        >
          {currentColumn && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginRight: 4 }}>
              <T step="codenote" tone="text3">
                {currentColumn.name}
              </T>
            </View>
          )}
          <Badge tone={priorityTone}>{priority.label}</Badge>
          {normalizeTags(task.tags).map((tag) => (
            <Badge key={tag} tone="neutral">
              {tag.startsWith("#") ? tag : `#${tag}`}
            </Badge>
          ))}
          {/* WS2: "Tiempo de agente" — the task inherits the agent-hours of
              its linked conversation in the current billing period. `—` when
              the task has no linked channel. */}
          <View
            style={{ flexDirection: "row", alignItems: "center", gap: 4, marginLeft: "auto" }}
            testID="task-detail-agent-hours"
          >
            <Ph name="clock" size={11} color={c.text3} />
            <T step="codenote" tone="text3">
              {t("board.taskDetail.agentHours", { defaultValue: "Tiempo de agente" })}
              {": "}
              {!task.channelId ? "—" : agentHours.loading ? "…" : agentHours.formatted}
            </T>
          </View>
        </View>
      </View>

      {/* ── Scrollable: description → actions → tabs → content ─────────────── */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 24 }}
        {...(Platform.OS === "web" ? ({ className: "chat-scroll" } as any) : {})}
      >
        {/* Description */}
        {task.description ? (
          <T step="sm" tone="text2" style={{ paddingHorizontal: 20, paddingTop: 14 }}>
            {task.description}
          </T>
        ) : null}

        {/* ── Acciones ───────────────────────────────────────────────────── */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            paddingHorizontal: 20,
            paddingVertical: 14,
            flexWrap: "wrap",
          }}
        >
          {isDone ? (
            <>
              <Badge tone="g" pill icon="check-circle" lg>
                {t("board.taskDetail.completed", { defaultValue: "Completada" })}
              </Badge>
              <Btn
                variant="primary"
                size="sm"
                icon="archive"
                onPress={handleArchivePress}
                disabled={task.archived}
              >
                {t("board.taskDetail.archive", { defaultValue: "Archivar" })}
              </Btn>
            </>
          ) : (
            <>
              <Btn
                variant="dangerSoft"
                size="sm"
                icon="x"
                onPress={() => setShowArchiveModal(true)}
                disabled={task.archived}
              >
                {t("board.taskDetail.cancel", { defaultValue: "Cancelar" })}
              </Btn>
              {/* Primary action — rightmost. Backlog → "Mover a To Do"; otherwise "Completar". */}
              {isBacklog && todoColumn ? (
                <Btn
                  variant="primary"
                  size="sm"
                  iconRight="arrow-right"
                  onPress={() => onMoveTask(task.taskId, todoColumn.columnId)}
                  disabled={task.archived}
                >
                  {t("board.taskDetail.moveToTodo", { defaultValue: "Mover a To Do" })}
                </Btn>
              ) : (
                <Btn
                  variant="primary"
                  size="sm"
                  icon="check-circle"
                  onPress={handleComplete}
                  disabled={task.archived || submittingOutput}
                >
                  {t("board.taskDetail.complete", { defaultValue: "Completar" })}
                </Btn>
              )}
            </>
          )}
        </View>

        {/* ── Tabs ─────────────────────────────────────────────────────────── */}
        <View style={{ paddingHorizontal: 12, paddingBottom: 12 }}>
          <PTabs sm full items={tabItems} value={activeTab} onChange={setActiveTab} />
        </View>

        {/* ── Tab Content ──────────────────────────────────────────────────── */}

        {/* Instructions Tab — full markdown */}
        {activeTab === "instructions" && (
          <View style={{ paddingHorizontal: 12 }}>
            <Card pad>
              {task.instructions ? (
                <CompactMarkdown text={task.instructions} />
              ) : (
                <TabEmpty
                  icon="file-text"
                  text={t("board.taskDetail.noInstructions", {
                    defaultValue: "Esta tarea no tiene instrucciones",
                  })}
                />
              )}
            </Card>
          </View>
        )}

        {/* Input Tab — the task's input artifact (event payload, upstream flow data…) */}
        {activeTab === "input" && hasInput && (
          <View style={{ paddingHorizontal: 12 }}>
            <TaskInputDisplay task={task} />
          </View>
        )}

        {/* Progress Tab — notes + activity */}
        {activeTab === "progress" && (
          <View style={{ paddingHorizontal: 12, gap: 16 }}>
            {/* Progress Notes — most recent on top */}
            <View>
              <FieldLabel>
                {t("board.taskDetail.progressNotes", { defaultValue: "Notas de progreso" })}
              </FieldLabel>
              {task.progressNotes && task.progressNotes.length > 0 ? (
                <LGroup>
                  {[...task.progressNotes].reverse().map((note, i) => {
                    const actorName = isSystemActor(note.actor)
                      ? "System"
                      : note.actor!.startsWith("user_")
                        ? t("board.taskDetail.you", { defaultValue: "Tú" })
                        : agentMap[note.actor]?.name || note.actor!.slice(0, 12)
                    const entry = note.actor ? agentMap[note.actor] : undefined
                    return (
                      <ProgressNoteItem
                        key={i}
                        text={note.text}
                        actor={note.actor}
                        timestamp={note.timestamp}
                        actorName={actorName}
                        avatarUrl={entry?.avatarUrl}
                        type={
                          entry?.type ?? (note.actor?.startsWith("user_") ? "human" : undefined)
                        }
                      />
                    )
                  })}
                </LGroup>
              ) : (
                <Card pad>
                  <T step="12" tone="text3">
                    {t("board.taskDetail.noProgressNotes", {
                      defaultValue: "Sin notas de progreso",
                    })}
                  </T>
                </Card>
              )}
            </View>

            {/* Task Output (read-only display of existing output) */}
            {task.output?.data !== undefined && task.output?.data !== null && (
              <View style={{ marginHorizontal: -12 }}>
                <TaskOutputDisplay task={task} />
              </View>
            )}

            {/* Activity log */}
            {(task.activity?.length ?? 0) > 0 && (
              <View>
                <FieldLabel>
                  {t("board.taskDetail.activity", { defaultValue: "Actividad" })}
                </FieldLabel>
                <LGroup>
                  {(task.activity ?? [])
                    .slice(-10)
                    .reverse()
                    .map((entry, i) => {
                      const actor = entry.actor ?? "system"
                      const actorName = isSystemActor(entry.actor)
                        ? "System"
                        : actor.startsWith("user_")
                          ? t("board.taskDetail.you", { defaultValue: "Tú" })
                          : agentMap[actor]?.name || actor.slice(0, 12)
                      const eventLabel = entry.eventType.replace(/_/g, " ")
                      const detail = entry.details?.field
                        ? ` → ${entry.details.field}`
                        : entry.details?.fromColumn && entry.details?.toColumn
                          ? ` → ${entry.details.fromColumn} → ${entry.details.toColumn}`
                          : entry.details?.fromStatus && entry.details?.toStatus
                            ? ` → ${entry.details.fromStatus} → ${entry.details.toStatus}`
                            : ""
                      return (
                        <LRow key={i} padV={10} gap={10} style={{ alignItems: "flex-start" }}>
                          <View style={{ paddingTop: 6 }}>
                            <Dot color={c.text3} size={6} />
                          </View>
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <T step="sm" tone="text2">
                              <T step="sm">{actorName}</T> {eventLabel}
                              {detail}
                            </T>
                            <T step="codenote" tone="text3" style={{ marginTop: 2 }}>
                              {new Date(entry.timestamp).toLocaleString()}
                            </T>
                          </View>
                        </LRow>
                      )
                    })}
                </LGroup>
              </View>
            )}
          </View>
        )}

        {/* Output Tab — inline output form or read-only display */}
        {activeTab === "output" && hasOutputGate && (
          <View>
            {outputReadOnly ? (
              <TaskOutputDisplay task={task} />
            ) : (
              <TaskOutputFormInline
                task={task}
                outputType={outputType}
                gate={outputGate}
                markdownText={outputMarkdownText}
                onMarkdownChange={setOutputMarkdownText}
                fieldValues={outputFieldValues}
                onFieldChange={(fieldId, value) =>
                  setOutputFieldValues((prev) => ({ ...prev, [fieldId]: value }))
                }
                submitting={submittingOutput}
                readOnly={outputReadOnly}
                onSave={onSaveOutput ? handleSaveOutput : undefined}
                saving={savingOutput}
                saveStatus={saveStatus}
                autoSavePending={autoSavePending}
              />
            )}
          </View>
        )}

        {/* Conversation Tab */}
        {activeTab === "conversation" && (
          <View style={{ paddingHorizontal: 12, minHeight: 300 }}>
            {task.channelId ? (
              <ConversationPreview
                channelId={task.channelId}
                onOpenConversation={onOpenConversation}
                agentMap={agentMap}
              />
            ) : (
              <Card pad>
                <TabEmpty
                  icon="chat-circle"
                  text={t("board.taskDetail.noConversation", {
                    defaultValue: "Esta tarea no tiene una conversación vinculada",
                  })}
                />
              </Card>
            )}
          </View>
        )}
      </ScrollView>

      {/* ── Stop Confirmation ─────────────────────────────────────────────── */}
      <ConfirmDialog
        visible={showStopConfirm}
        icon="stop"
        title={t("board.taskDetail.stopTitle", { defaultValue: "Detener tarea" })}
        text={t("board.taskDetail.stopText", {
          defaultValue:
            "¿Seguro que quieres detener esta tarea? El agente terminará su paso actual y la tarea pasará a Blocked.",
        })}
        cancelLabel={t("board.taskDetail.cancel", { defaultValue: "Cancelar" })}
        confirmLabel={t("board.taskDetail.stopConfirm", { defaultValue: "Detener" })}
        confirmVariant="danger"
        onCancel={() => setShowStopConfirm(false)}
        onConfirm={confirmStop}
      />

      {/* ── Archive Confirmation ──────────────────────────────────────────── */}
      <ConfirmDialog
        visible={showArchiveModal}
        icon="archive"
        title={t("board.taskDetail.archiveTitle", { defaultValue: "Archivar tarea no completada" })}
        text={t("board.taskDetail.archiveText", {
          defaultValue:
            "Estás archivando una tarea que no ha sido completada. ¿Quieres cancelarla?",
        })}
        cancelLabel={t("board.taskDetail.cancel", { defaultValue: "Cancelar" })}
        confirmLabel={t("board.taskDetail.archive", { defaultValue: "Archivar" })}
        confirmVariant="dangerSoft"
        onCancel={() => {
          setShowArchiveModal(false)
          setArchiveReason("")
        }}
        onConfirm={confirmArchive}
      >
        <View style={{ marginBottom: 16 }}>
          <FieldLabel>{t("board.taskDetail.archiveReason", { defaultValue: "Razón" })}</FieldLabel>
          <Field
            value={archiveReason}
            onChangeText={setArchiveReason}
            placeholder={t("board.taskDetail.archiveReasonPlaceholder", {
              defaultValue: "Razón de cancelación (opcional)…",
            })}
            area
            minHeight={72}
          />
        </View>
      </ConfirmDialog>
    </View>
  )
}
