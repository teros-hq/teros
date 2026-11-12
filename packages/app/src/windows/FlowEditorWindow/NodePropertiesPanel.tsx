/**
 * NodePropertiesPanel — Right sidebar for editing the selected node
 *
 * Shows and allows editing:
 * - Node label
 * - Node description
 * - Instructions (for action nodes that create tasks)
 * - Role (agentId or 'human')
 * - Input gates (add/remove/edit) — with artifact selector
 * - Output gates (add/remove/edit) — with artifact selector
 *
 * Supports two rendering variants:
 * - 'inline' (default): renders as a fixed-width sidebar (desktop)
 * - 'drawer': renders as the body content inside a Drawer overlay (mobile)
 */

import type { Gate, Artifact, Trigger, TriggerType } from "@teros/workflows"
import { EmptyState, IconBtn, Ph, T, Tile } from "../../components/ui/ds"
import { NODE_TYPE_META, type FlowNodeData, type NodeType, createDefaultGate } from "./types"
import type { ProjectData } from "../../services/ProjectApi"
import type { BoardColumn } from "../../services/BoardApi"
import { GateEditor } from "./GateEditor"
import type { AgentMapEntry, MemberType } from "../BoardWindow/board-utils"
import { getAvatarBorderColor, inferMemberType } from "../BoardWindow/board-utils"
import {
  useFlowEditorTheme,
  useFlowEditorStyles,
  type FlowEditorStyles,
} from "./useFlowEditorTheme"

interface NodePropertiesPanelProps {
  nodeData: FlowNodeData | null
  nodeId: string | null
  onChange: (updates: Partial<FlowNodeData>) => void
  onDelete: () => void
  onDuplicate: () => void
  /** Available artifacts for the gate selector */
  artifacts?: Artifact[]
  /** Whether artifacts are currently loading */
  artifactsLoading?: boolean
  /** Available projects for the project override selector (action nodes) */
  projects?: ProjectData[]
  /** Board columns for the column selector (action nodes) — from the selected project's board */
  boardColumns?: BoardColumn[]
  /** Whether board columns are currently loading */
  boardColumnsLoading?: boolean
  /** Workspace members (agents + humans) for the assignee selector (action nodes) */
  workspaceMembers?: Record<string, AgentMapEntry>
  /** Rendering variant: 'inline' = fixed sidebar, 'drawer' = drawer body */
  variant?: "inline" | "drawer"
  /** Called when the drawer requests to close (only used in drawer mode) */
  onClose?: () => void
  /** Called when user clicks "Edit Schema" on a selected artifact */
  onEditArtifact?: (artifact: Artifact) => void
  /** Called when user clicks "Create New Artifact" */
  onCreateArtifact?: () => void
}

export function NodePropertiesPanel({
  nodeData,
  nodeId,
  onChange,
  onDelete,
  onDuplicate,
  artifacts = [],
  artifactsLoading = false,
  projects = [],
  boardColumns = [],
  boardColumnsLoading = false,
  workspaceMembers = {},
  variant = "inline",
  onClose,
  onEditArtifact,
  onCreateArtifact,
}: NodePropertiesPanelProps) {
  const t = useFlowEditorTheme()
  const s = usePanelStyles()
  const isDrawer = variant === "drawer"

  if (!nodeData || !nodeId) {
    return (
      <div style={isDrawer ? s.drawerBody : s.panel}>
        <div style={s.emptyState}>
          <EmptyState
            icon="crosshair"
            title="Nothing selected"
            text="Select a node to edit its properties"
          />
        </div>
      </div>
    )
  }

  const meta = NODE_TYPE_META[nodeData.nodeType]

  const updateInputGate = (index: number, gate: Gate) => {
    const gates = [...nodeData.inputs]
    gates[index] = gate
    onChange({ inputs: gates })
  }

  const removeInputGate = (index: number) => {
    const gates = nodeData.inputs.filter((_, i) => i !== index)
    onChange({ inputs: gates })
  }

  const addInputGate = () => {
    const gate = createDefaultGate("input", nodeData.inputs.length)
    onChange({ inputs: [...nodeData.inputs, gate] })
  }

  const updateOutputGate = (index: number, gate: Gate) => {
    const gates = [...nodeData.outputs]
    gates[index] = gate
    onChange({ outputs: gates })
  }

  const removeOutputGate = (index: number) => {
    const gates = nodeData.outputs.filter((_, i) => i !== index)
    onChange({ outputs: gates })
  }

  const addOutputGate = () => {
    const gate = createDefaultGate("output", nodeData.outputs.length)
    onChange({ outputs: [...nodeData.outputs, gate] })
  }

  return (
    <div style={isDrawer ? s.drawerBody : s.panel}>
      {/* Header */}
      <div style={s.header}>
        <Tile xs icon={meta.phIcon} />
        <T step="sm" ellipsis style={{ flex: 1 }}>
          {meta.label} Properties
        </T>
        {meta.canDuplicate && (
          <IconBtn icon="copy" plain sm onPress={onDuplicate} title="Duplicate node" />
        )}
        {meta.canDelete && (
          <IconBtn icon="trash" plain sm danger onPress={onDelete} title="Delete node" />
        )}
        {isDrawer && onClose && <IconBtn icon="x" plain sm onPress={onClose} title="Close" />}
      </div>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "14px 16px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {/* Label */}
        <div>
          <label style={s.label}>Label</label>
          <input
            type="text"
            value={nodeData.label}
            onChange={(e) => onChange({ label: e.target.value })}
            style={s.input}
            placeholder="Node label"
          />
        </div>

        {/* Description */}
        <div>
          <label style={s.label}>Description</label>
          <textarea
            value={nodeData.description}
            onChange={(e) => onChange({ description: e.target.value })}
            style={s.textarea}
            placeholder="What does this node do?"
          />
        </div>

        {/* Assignee selector (only for action nodes) */}
        {meta.createsTask && (
          <AssigneeSelector
            value={nodeData.role}
            workspaceMembers={workspaceMembers}
            onChange={(role) => onChange({ role })}
          />
        )}

        {/* Instructions (only for action nodes) */}
        {meta.createsTask && (
          <div>
            <label style={s.label}>Instructions</label>
            <textarea
              value={nodeData.instructions}
              onChange={(e) => onChange({ instructions: e.target.value })}
              style={s.code}
              placeholder="Instructions sent to the agent. Supports Markdown and {{variable}} interpolation."
            />
          </div>
        )}

        {/* Project override (only for action nodes) */}
        {meta.createsTask && (
          <div>
            <label style={s.label}>Project (override)</label>
            <select
              value={nodeData.projectId ?? ""}
              onChange={(e) => {
                // When project changes, reset the target column since columns
                // are project-specific. The parent will reload columns for the
                // new project.
                const newData = { ...nodeData.data }
                delete newData.targetColumn
                onChange({ projectId: e.target.value || undefined, data: newData })
              }}
              style={s.input}
            >
              <option value="">Use flow default</option>
              {projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.name}
                </option>
              ))}
            </select>
            <div style={s.help}>
              Override which project board this node's task goes to. Leave empty to use the flow's
              default.
            </div>
          </div>
        )}

        {/* Column selector (only for action nodes) */}
        {meta.createsTask && (
          <ColumnSelector
            columns={boardColumns}
            loading={boardColumnsLoading}
            value={extractTargetColumnId(nodeData.data)}
            onChange={(columnId) =>
              onChange({ data: { ...nodeData.data, targetColumn: columnId } })
            }
          />
        )}

        {/* Function code (only for function nodes) */}
        {nodeData.nodeType === "function" && (
          <div>
            <label style={s.label}>Function Code</label>
            <textarea
              value={String(nodeData.data?.code || "")}
              onChange={(e) => onChange({ data: { ...nodeData.data, code: e.target.value } })}
              style={s.code}
              placeholder="// JavaScript function code"
            />
            <div style={s.help}>
              Function nodes execute code automatically. In Phase 1, they pass data through
              unchanged.
            </div>
          </div>
        )}

        {/* Integration config (only for integration nodes) */}
        {nodeData.nodeType === "integration" && (
          <div>
            <label style={s.label}>Integration MCA</label>
            <input
              type="text"
              value={String(nodeData.data?.mcaId || "")}
              onChange={(e) => onChange({ data: { ...nodeData.data, mcaId: e.target.value } })}
              style={s.input}
              placeholder="e.g. mca.teros.gmail"
            />
            <div style={s.help}>
              The MCA to execute. In Phase 1, integration nodes pass data through unchanged.
            </div>
          </div>
        )}

        {/* Trigger configuration (only for start nodes) */}
        {nodeData.nodeType === "start" && (
          <TriggerConfig
            value={extractTrigger(nodeData.data)}
            onChange={(trigger) => onChange({ data: { ...nodeData.data, trigger } })}
          />
        )}

        {/* Input Gates */}
        <div>
          <div style={s.sectionHeader}>
            <span style={{ color: t.tint.a.tx, display: "flex", alignItems: "center", gap: 6 }}>
              <Ph name="arrow-left" size={12} color={t.warning} /> Input Gates
            </span>
            <span style={{ flex: 1 }} />
            <button onClick={addInputGate} style={s.addButton}>
              <Ph name="plus" size={11} color={t.text2} /> Add
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
            {nodeData.inputs.length === 0 && <div style={s.emptyGates}>No input gates</div>}
            {nodeData.inputs.map((gate, index) => (
              <GateEditor
                key={gate.gateId}
                gate={gate}
                direction="input"
                index={index}
                onChange={(g) => updateInputGate(index, g)}
                onRemove={() => removeInputGate(index)}
                canRemove={true}
                artifacts={artifacts}
                artifactsLoading={artifactsLoading}
                onEditArtifact={onEditArtifact}
                onCreateArtifact={onCreateArtifact}
              />
            ))}
          </div>
        </div>

        {/* Output Gates */}
        <div>
          <div style={s.sectionHeader}>
            <span style={{ color: t.tint.g.tx, display: "flex", alignItems: "center", gap: 6 }}>
              Output Gates <Ph name="arrow-right" size={12} color={t.success} />
            </span>
            <span style={{ flex: 1 }} />
            <button onClick={addOutputGate} style={s.addButton}>
              <Ph name="plus" size={11} color={t.text2} /> Add
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
            {nodeData.outputs.length === 0 && <div style={s.emptyGates}>No output gates</div>}
            {nodeData.outputs.map((gate, index) => (
              <GateEditor
                key={gate.gateId}
                gate={gate}
                direction="output"
                index={index}
                onChange={(g) => updateOutputGate(index, g)}
                onRemove={() => removeOutputGate(index)}
                canRemove={true}
                artifacts={artifacts}
                artifactsLoading={artifactsLoading}
                onEditArtifact={onEditArtifact}
                onCreateArtifact={onCreateArtifact}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// ASSIGNEE SELECTOR — Dropdown for selecting agent or human assignee
// ============================================================================

interface AssigneeSelectorProps {
  value: string
  workspaceMembers: Record<string, AgentMapEntry>
  onChange: (role: string) => void
}

function AssigneeSelector({ value, workspaceMembers, onChange }: AssigneeSelectorProps) {
  const t = useFlowEditorTheme()
  const s = usePanelStyles()
  // Build sorted list: agents first, then humans, alphabetically within each group
  const memberEntries = Object.entries(workspaceMembers)
  const agents = memberEntries
    .filter(([id, entry]) => (entry.type ?? inferMemberType(id)) === "agent")
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
  const humans = memberEntries
    .filter(([id, entry]) => (entry.type ?? inferMemberType(id)) === "human")
    .sort((a, b) => a[1].name.localeCompare(b[1].name))

  const selectedEntry = value ? workspaceMembers[value] : undefined
  const selectedType: MemberType | undefined =
    selectedEntry?.type ?? (value ? inferMemberType(value) : undefined)

  return (
    <div>
      <label style={s.label}>Assignee (who executes this)</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={s.input}>
        <option value="">— Select assignee —</option>
        {agents.length > 0 && (
          <optgroup label="Agents">
            {agents.map(([id, entry]) => (
              <option key={id} value={id}>
                {entry.name}
              </option>
            ))}
          </optgroup>
        )}
        {humans.length > 0 && (
          <optgroup label="Humans">
            {humans.map(([id, entry]) => (
              <option key={id} value={id}>
                {entry.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {/* Selected assignee preview with avatar */}
      {selectedEntry && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 8,
            padding: "8px 10px",
            background: t.nestBg,
            borderRadius: 12,
          }}
        >
          <AvatarBadge
            name={selectedEntry.name}
            avatarUrl={selectedEntry.avatarUrl}
            borderColor={getAvatarBorderColor(value, selectedType)}
            size={28}
          />
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            <span
              style={{
                fontSize: 13,
                color: t.text,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {selectedEntry.name}
            </span>
            <span
              style={{
                fontSize: 10,
                letterSpacing: 1.3,
                textTransform: "uppercase",
                color: selectedType === "human" ? t.tint.m.tx : t.accent,
              }}
            >
              {selectedType}
            </span>
          </div>
        </div>
      )}
      {value && !selectedEntry && (
        <div style={{ ...s.help, color: t.tint.a.tx }}>
          Assignee "{value}" not found in workspace — it may have been removed
        </div>
      )}
      {!value && <div style={s.help}>Select an agent or human to assign this task</div>}
    </div>
  )
}

/**
 * Avatar badge — circular avatar with colored border.
 * Used in the assignee selector preview and on canvas nodes.
 */
export function AvatarBadge({
  name,
  avatarUrl,
  borderColor,
  size = 24,
}: {
  name: string
  avatarUrl?: string
  borderColor: string
  size?: number
}) {
  const t = useFlowEditorTheme()
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={name}
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          border: `2px solid ${borderColor}`,
          objectFit: "cover",
          flexShrink: 0,
        }}
      />
    )
  }
  // Fallback: initials in a colored circle
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: `2px solid ${borderColor}`,
        background: t.tile,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: t.fontSerif,
        fontSize: size * 0.4,
        color: t.text,
        flexShrink: 0,
        boxSizing: "border-box",
      }}
    >
      {initials}
    </div>
  )
}

// ============================================================================
// COLUMN SELECTOR — Dropdown for selecting which board column the task goes to
// ============================================================================

/** Extract the target column ID from node data (stored as node.data.targetColumn). */
function extractTargetColumnId(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined
  const target = data.targetColumn
  if (typeof target === "string") return target
  if (target && typeof target === "object" && "columnId" in target) {
    return String((target as { columnId: string }).columnId)
  }
  return undefined
}

interface ColumnSelectorProps {
  columns: BoardColumn[]
  loading: boolean
  value: string | undefined
  onChange: (columnId: string | undefined) => void
}

function ColumnSelector({ columns, loading, value, onChange }: ColumnSelectorProps) {
  const t = useFlowEditorTheme()
  const s = usePanelStyles()
  return (
    <div>
      <label style={s.label}>Target Column</label>
      {loading ? (
        <div style={{ ...s.input, display: "flex", alignItems: "center", color: t.text3 }}>
          Loading columns…
        </div>
      ) : columns.length === 0 ? (
        <div style={{ ...s.input, display: "flex", alignItems: "center", color: t.text3 }}>
          No columns available — select a project first
        </div>
      ) : (
        <select
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || undefined)}
          style={s.input}
        >
          <option value="">Backlog (default)</option>
          {columns.map((col) => (
            <option key={col.columnId} value={col.columnId}>
              {col.name}
            </option>
          ))}
        </select>
      )}
      <div style={s.help}>
        Choose which board column the task is created in. Defaults to the board's first column
        (Backlog).
      </div>
    </div>
  )
}

// ============================================================================
// TRIGGER CONFIG — Trigger configuration for Start nodes
// ============================================================================

/** Extract trigger config from node data. */
function extractTrigger(data: Record<string, unknown> | undefined): Trigger | undefined {
  if (!data) return undefined
  const trigger = data.trigger
  if (trigger && typeof trigger === "object" && "type" in trigger) {
    return trigger as Trigger
  }
  return undefined
}

interface TriggerConfigProps {
  value: Trigger | undefined
  onChange: (trigger: Trigger | undefined) => void
}

function TriggerConfig({ value, onChange }: TriggerConfigProps) {
  const t = useFlowEditorTheme()
  const s = usePanelStyles()
  const triggerType: TriggerType = value?.type ?? "manual"

  const updateTrigger = (type: TriggerType, config?: Record<string, unknown>) => {
    onChange({
      triggerId: value?.triggerId ?? "trigger_1",
      type,
      config: config ?? {},
    })
  }

  const updateConfig = (config: Record<string, unknown>) => {
    onChange({
      triggerId: value?.triggerId ?? "trigger_1",
      type: triggerType,
      config: { ...value?.config, ...config },
    })
  }

  return (
    <div>
      <div style={s.sectionHeader}>
        <span style={{ color: t.accent, display: "flex", alignItems: "center", gap: 6 }}>
          <Ph name="clock" size={12} color={t.accent} /> Trigger
        </span>
      </div>

      {/* Trigger type selector */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
        {(
          [
            ["manual", "Manual", "hand-tap", () => updateTrigger("manual")],
            [
              "schedule",
              "Schedule",
              "clock",
              () => updateTrigger("schedule", { cronExpression: "" }),
            ],
            ["webhook", "Webhook", "webhooks-logo", () => updateTrigger("webhook", { secret: "" })],
            ["event", "Event", "lightning", () => updateTrigger("event", { topic: "" })],
          ] as [TriggerType, string, string, () => void][]
        ).map(([type, label, icon, onPick]) => {
          const on = triggerType === type
          return (
            <button key={type} onClick={onPick} style={{ ...s.chip, ...(on ? s.chipOn : {}) }}>
              <Ph name={icon} size={12} color={on ? t.accent : t.text2} />
              {label}
            </button>
          )
        })}
      </div>

      {/* Manual trigger info */}
      {triggerType === "manual" && (
        <div style={s.help}>The flow can only be executed manually via the Execute button.</div>
      )}

      {/* Schedule trigger config */}
      {triggerType === "schedule" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          <label style={s.label}>Cron Expression</label>
          <input
            type="text"
            value={String(value?.config?.cronExpression ?? "")}
            onChange={(e) => updateConfig({ cronExpression: e.target.value })}
            placeholder="*/5 * * * *"
            style={{ ...s.input, fontFamily: t.fontMono, fontSize: 12 }}
          />
          <div style={s.help}>
            Format: min hour day month weekday (5-field cron). Save and activate to enable.
          </div>
        </div>
      )}

      {/* Webhook trigger config */}
      {triggerType === "webhook" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          <label style={s.label}>Secret (optional)</label>
          <input
            type="text"
            value={String(value?.config?.secret ?? "")}
            onChange={(e) => updateConfig({ secret: e.target.value })}
            placeholder="Optional auth secret"
            style={s.input}
          />
          <div style={s.help}>
            Send POST requests to the webhook URL with JSON body. If a secret is set, include it in
            the x-webhook-secret header. The URL is generated after saving and activating.
          </div>
        </div>
      )}

      {/* Event trigger config */}
      {triggerType === "event" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          <label style={s.label}>Event Topic</label>
          <select
            value={String(value?.config?.topic ?? "")}
            onChange={(e) => updateConfig({ topic: e.target.value })}
            style={{ ...s.input, fontFamily: t.fontMono, fontSize: 12 }}
          >
            <option value="">Select an event…</option>
            <optgroup label="Board">
              <option value="board.task_created">Task Created</option>
              <option value="board.task_completed">Task Completed</option>
              <option value="board.task_moved">Task Moved</option>
              <option value="board.task_blocked">Task Blocked</option>
            </optgroup>
            <optgroup label="Gmail">
              <option value="gmail.email_received">Email Received</option>
            </optgroup>
            <optgroup label="Scheduler">
              <option value="scheduler.reminder">Reminder Triggered</option>
              <option value="scheduler.recurring_task">Recurring Task</option>
            </optgroup>
            <optgroup label="Workflows">
              <option value="workflow.execution_completed">Execution Completed</option>
              <option value="workflow.execution_failed">Execution Failed</option>
            </optgroup>
            <optgroup label="Channel">
              <option value="channel:turn_start">Conversation Turn Start</option>
              <option value="channel:turn_end">Conversation Turn End</option>
            </optgroup>
          </select>
          <div style={s.help}>
            The flow will execute automatically when this event fires. Wildcards supported: board.*
            matches all board events. Save and activate to enable.
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// SHARED STYLES (theme-adaptive via useFlowEditorTheme)
// ============================================================================

function usePanelStyles(): Record<string, React.CSSProperties> &
  Pick<
    FlowEditorStyles,
    "label" | "input" | "textarea" | "code" | "help" | "sectionHeader" | "chip" | "chipOn"
  > {
  const t = useFlowEditorTheme()
  const ds = useFlowEditorStyles()
  return {
    label: ds.label,
    input: ds.input,
    textarea: ds.textarea,
    code: ds.code,
    help: ds.help,
    sectionHeader: ds.sectionHeader,
    chip: ds.chip,
    chipOn: ds.chipOn,
    panel: {
      width: 320,
      minWidth: 320,
      background: t.sidebarBg,
      borderLeft: `1px solid ${t.sidebarBorder}`,
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      fontFamily: t.fontSans,
    },
    drawerBody: {
      width: "100%",
      flex: 1,
      background: t.sidebarBg,
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      fontFamily: t.fontSans,
    },
    emptyState: {
      flex: 1,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      textAlign: "center",
      padding: 20,
    },
    header: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      minHeight: 52,
      padding: "10px 12px 10px 16px",
      borderBottom: `1px solid ${t.sidebarBorder}`,
      flexShrink: 0,
    },
    addButton: ds.btnSm,
    emptyGates: {
      fontFamily: t.fontSans,
      fontSize: 12,
      color: t.text3,
      textAlign: "center",
      padding: "10px 0",
    },
  }
}
