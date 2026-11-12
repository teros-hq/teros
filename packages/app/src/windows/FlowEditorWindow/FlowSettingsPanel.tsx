/**
 * FlowSettingsPanel — Modal for editing flow-level configuration
 *
 * Consolidates all flow-level settings into a single, clean screen:
 * - Flow name (text input)
 * - Description (textarea)
 * - Associated project (dropdown)
 * - Flow status (draft / active / archived)
 * - Read-only metadata (created/updated dates, node/edge counts, flow ID)
 *
 * Follows the same modal pattern and dark theme as ArtifactEditor.
 * On save, calls `onSave(updatedData)` which the parent wires to the
 * `create-flow` MCA tool (upsert).
 */

import { useState, useEffect, useCallback } from "react"
import { Btn, IconBtn, Ph, T, Tile } from "../../components/ui/ds"
import type { ProjectData } from "../../services/ProjectApi"
import { useFlowEditorTheme, useFlowEditorStyles } from "./useFlowEditorTheme"

// ============================================================================
// TYPES
// ============================================================================

export interface FlowSettingsData {
  name: string
  description: string
  projectId: string
  status: string
}

export interface FlowSettingsPanelProps {
  /** Whether the modal is visible */
  visible: boolean
  /** Current flow data — used to initialize the form fields */
  flowName: string
  flowDescription: string
  flowProjectId: string
  flowStatus: string
  flowId: string | null
  /** Workspace projects for the project selector */
  projects: ProjectData[]
  /** Node/edge counts for the metadata section */
  nodeCount: number
  edgeCount: number
  /** Created/updated timestamps (ISO strings) for the metadata section */
  createdAt?: string
  updatedAt?: string
  /** Called when the user saves — parent persists changes via MCA */
  onSave: (data: FlowSettingsData) => Promise<void>
  /** Called when the user closes the modal */
  onClose: () => void
  /** Whether the save is currently in progress */
  saving?: boolean
  /** Called when the user clicks Execute — parent runs the flow via MCA */
  onExecute?: () => void
  /** Called when the user clicks Activate/Deactivate — parent toggles flow status */
  onToggleActive?: () => void
  /** Whether execution is currently in progress */
  isExecuting?: boolean
  /** whether the activate/deactivate toggle is in progress */
  isTogglingActive?: boolean
}

// ============================================================================
// STATUS OPTIONS
// ============================================================================

const STATUS_OPTIONS: {
  value: string
  label: string
  tone: "g" | "a" | "muted"
  description: string
}[] = [
  {
    value: "draft",
    label: "Draft",
    tone: "muted",
    description: "Work in progress — not executable",
  },
  { value: "active", label: "Active", tone: "g", description: "Live and ready to execute" },
  { value: "archived", label: "Archived", tone: "a", description: "Stored but inactive" },
]

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function FlowSettingsPanel({
  visible,
  flowName: initialName,
  flowDescription: initialDescription,
  flowProjectId: initialProjectId,
  flowStatus: initialStatus,
  flowId,
  projects,
  nodeCount,
  edgeCount,
  createdAt,
  updatedAt,
  onSave,
  onClose,
  saving = false,
  onExecute,
  onToggleActive,
  isExecuting = false,
  isTogglingActive = false,
}: FlowSettingsPanelProps) {
  const t = useFlowEditorTheme()
  const s = useSettingsStyles()
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)
  const [projectId, setProjectId] = useState(initialProjectId)
  const [status, setStatus] = useState(initialStatus)
  const [error, setError] = useState("")

  // ── Initialize / reset fields when the modal opens ───────────────────

  useEffect(() => {
    if (!visible) return
    setName(initialName)
    setDescription(initialDescription)
    setProjectId(initialProjectId)
    setStatus(initialStatus)
    setError("")
  }, [visible, initialName, initialDescription, initialProjectId, initialStatus])

  // ── Handlers ─────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      setError("Flow name is required")
      return
    }
    setError("")
    try {
      await onSave({ name: name.trim(), description, projectId, status })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings")
    }
  }, [name, description, projectId, status, onSave])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape" && !saving) {
        onClose()
      }
    },
    [saving, onClose],
  )

  // ── Helpers ──────────────────────────────────────────────────────────

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return "—"
    const d = new Date(dateStr)
    return d.toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  // ── Render ───────────────────────────────────────────────────────────

  if (!visible) return null

  return (
    <div
      onClick={onClose}
      onKeyDown={handleKeyDown}
      style={{
        position: "absolute",
        inset: 0,
        background: t.modalOverlay,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1100,
        fontFamily: t.fontSans,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: t.modalBg,
          borderRadius: 16,
          width: "90%",
          maxWidth: 560,
          maxHeight: "85%",
          display: "flex",
          flexDirection: "column",
          boxShadow: t.modalShadow,
        }}
      >
        {/* ── Header ──────────────────────────────────────────────── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "16px 20px",
            borderBottom: `1px solid ${t.sidebarBorder}`,
            flexShrink: 0,
          }}
        >
          <Tile xs icon="gear-six" />
          <T step="xl" ellipsis style={{ flex: 1 }}>
            Flow settings
          </T>
          <IconBtn icon="x" plain onPress={onClose} disabled={saving} title="Close" />
        </div>

        {/* ── Body (scrollable) ───────────────────────────────────── */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "20px",
            display: "flex",
            flexDirection: "column",
            gap: 20,
          }}
        >
          {/* ── Name ───────────────────────────────────────────── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={s.label}>
              <Ph name="hash" size={12} color={t.text3} />
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Untitled Flow"
              style={s.input}
              autoFocus
            />
          </div>

          {/* ── Description ────────────────────────────────────── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={s.label}>
              <Ph name="file-text" size={12} color={t.text3} />
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what this flow does…"
              rows={3}
              style={s.textarea}
            />
          </div>

          {/* ── Project ────────────────────────────────────────── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={s.label}>
              <Ph name="flow-arrow" size={12} color={t.text3} />
              Associated Project
            </label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              style={s.input}
            >
              <option value="">No project (select at execution time)</option>
              {projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.name}
                </option>
              ))}
            </select>
            <span style={s.help}>
              Tasks created by this flow will be placed on this project's board by default.
            </span>
          </div>

          {/* ── Status (Activate / Deactivate) ─────────────────── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={s.label}>
              <Ph name="clock" size={12} color={t.text3} />
              Status
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {onToggleActive ? (
                <Btn
                  variant={status === "active" ? "sec" : "mint"}
                  icon="power"
                  loading={isTogglingActive}
                  onPress={onToggleActive}
                  testID="flow-settings-toggle-active"
                >
                  {status === "active" ? "Deactivate" : "Activate"}
                </Btn>
              ) : (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", flex: 1 }}>
                  {STATUS_OPTIONS.map((opt) => {
                    const isSelected = status === opt.value
                    return (
                      <button
                        key={opt.value}
                        onClick={() => setStatus(opt.value)}
                        style={{
                          background: isSelected ? t.navActive : t.nestBg,
                          border: "1px solid transparent",
                          borderRadius: 12,
                          padding: "10px 14px",
                          cursor: "pointer",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "flex-start",
                          gap: 2,
                          fontFamily: t.fontSans,
                          transition: "background 0.2s",
                          flex: 1,
                          minWidth: 120,
                        }}
                      >
                        <span style={{ fontSize: 13, color: isSelected ? t.accent : t.text }}>
                          {opt.label}
                        </span>
                        <span style={{ fontSize: 12, color: t.text3, whiteSpace: "nowrap" }}>
                          {opt.description}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
              {/* Execute button — only shown when onExecute is provided */}
              {onExecute && flowId && (
                <Btn
                  variant="primary"
                  icon="play"
                  loading={isExecuting}
                  onPress={onExecute}
                  testID="flow-settings-execute"
                >
                  Execute
                </Btn>
              )}
            </div>
            <span style={s.help}>
              {status === "active"
                ? "Flow is live and can be executed or triggered."
                : "Activate the flow to make it executable."}
            </span>
          </div>

          {/* ── Metadata (read-only) ───────────────────────────── */}
          {flowId && (
            <div
              style={{
                background: t.metadataBg,
                borderRadius: 12,
                padding: "14px 16px",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <span style={{ ...s.label, marginBottom: 0 }}>Metadata</span>

              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                {/* Node count */}
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <Ph name="flow-arrow" size={12} color={t.text3} />
                  <span style={{ fontSize: 12, color: t.text3 }}>{nodeCount} nodes</span>
                </div>
                {/* Edge count */}
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <Ph name="lightning" size={12} color={t.text3} />
                  <span style={{ fontSize: 12, color: t.text3 }}>{edgeCount} edges</span>
                </div>
                {/* Created */}
                {createdAt && (
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <Ph name="clock" size={12} color={t.text3} />
                    <span style={{ fontSize: 12, color: t.text3 }}>
                      Created {formatDate(createdAt)}
                    </span>
                  </div>
                )}
                {/* Updated */}
                {updatedAt && (
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <Ph name="clock" size={12} color={t.text3} />
                    <span style={{ fontSize: 12, color: t.text3 }}>
                      Updated {formatDate(updatedAt)}
                    </span>
                  </div>
                )}
              </div>

              {/* Flow ID */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  paddingTop: 4,
                  borderTop: `1px solid ${t.modalHeaderBorder}`,
                }}
              >
                <Ph name="hash" size={11} color={t.text3} />
                <span
                  style={{
                    fontSize: 11,
                    color: t.text3,
                    fontFamily: t.fontMono,
                    userSelect: "all",
                  }}
                >
                  {flowId}
                </span>
              </div>
            </div>
          )}

          {/* ── Error ──────────────────────────────────────────── */}
          {error && (
            <div
              style={{
                background: t.errorBg,
                border: `1px solid ${t.errorBorder}`,
                borderRadius: 12,
                padding: "10px 14px",
                fontSize: 13,
                color: t.errorText,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <Ph name="warning-circle" size={14} color={t.errorText} />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* ── Footer ─────────────────────────────────────────────── */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 20px",
            borderTop: `1px solid ${t.metadataBorder}`,
            flexShrink: 0,
          }}
        >
          <Btn variant="ghost" onPress={onClose} disabled={saving}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            icon="floppy-disk"
            loading={saving}
            disabled={!name.trim()}
            onPress={handleSave}
            testID="flow-settings-save"
          >
            Save settings
          </Btn>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// SHARED STYLES
// ============================================================================

function useSettingsStyles() {
  const ds = useFlowEditorStyles()
  return {
    label: ds.label,
    input: ds.input,
    textarea: ds.textarea,
    help: ds.help,
  }
}
