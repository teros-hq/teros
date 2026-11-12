/**
 * ArtifactEditor — Modal for creating and editing artifact schemas
 *
 * Allows the user to:
 * - Set artifact metadata (name, title, description, color, icon)
 * - Add/remove/rename properties
 * - Set each property's type and required flag
 * - Configure UI metadata per property: label, placeholder, defaultValue, hint, format
 * - See a live preview of how each field will render
 *
 * On save, calls `onSave(artifact)` which the parent wires to the
 * `create-artifact` or `update-artifact` MCA tool.
 */

import { useState, useEffect, useCallback } from "react"
import { Btn, IconBtn, Ph, T, Tile } from "../../components/ui/ds"
import type { Artifact, ArtifactProperty, ArtifactSchema } from "@teros/workflows"
import { useFlowEditorTheme, useFlowEditorStyles } from "./useFlowEditorTheme"

// ============================================================================
// TYPES
// ============================================================================

export interface ArtifactEditorProps {
  /** Whether the modal is visible */
  visible: boolean
  /** Existing artifact to edit, or null to create a new one */
  artifact: Artifact | null
  /** Called when the user saves — parent calls create-artifact or update-artifact MCA tool */
  onSave: (artifact: ArtifactEditorSaveData) => Promise<void>
  /** Called when the user closes the modal */
  onClose: () => void
  /** Whether the save is currently in progress */
  saving?: boolean
}

/** The data passed to the parent on save. */
export interface ArtifactEditorSaveData {
  /** Existing artifactId if editing, null if creating */
  artifactId: string | null
  name: string
  title: string
  description: string
  color: string
  icon: string
  source: "global" | "workspace" | "flow"
  schema: ArtifactSchema
}

// ============================================================================
// CONSTANTS
// ============================================================================

const PROPERTY_TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"]

const FORMAT_OPTIONS = [
  { value: "", label: "— None —" },
  { value: "text", label: "Text" },
  { value: "email", label: "Email" },
  { value: "url", label: "URL" },
  { value: "phone", label: "Phone" },
  { value: "date", label: "Date" },
  { value: "markdown", label: "Markdown" },
]

const DEFAULT_COLORS = [
  "#5E6AD2",
  "#FF5733",
  "#10B981",
  "#F59E0B",
  "#3B82F6",
  "#EF4444",
  "#8B5CF6",
  "#EC4899",
  "#06B6D4",
  "#14B8A6",
]

const DEFAULT_ICONS = ["📦", "📋", "📄", "✉️", "🎯", "💡", "🔧", "📊", "🔔", "🏷️"]

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function ArtifactEditor({
  visible,
  artifact,
  onSave,
  onClose,
  saving = false,
}: ArtifactEditorProps) {
  const t = useFlowEditorTheme()
  const s = useArtifactEditorStyles()
  const [name, setName] = useState("")
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [color, setColor] = useState("#5E6AD2")
  const [icon, setIcon] = useState("📦")
  const [properties, setProperties] = useState<EditableProperty[]>([])
  const [schemaName, setSchemaName] = useState("")
  const [schemaTitle, setSchemaTitle] = useState("")
  const [strict, setStrict] = useState(false)
  const [error, setError] = useState("")

  // ── Initialize from artifact when it changes ──────────────────────────

  useEffect(() => {
    if (!visible) return
    if (artifact) {
      setName(artifact.name)
      setTitle(artifact.title)
      setDescription(artifact.description)
      setColor(artifact.color || "#5E6AD2")
      setIcon(artifact.icon || "📦")
      const schema = artifact.schema
      setSchemaName(schema.name || artifact.name)
      setSchemaTitle(schema.title || artifact.title)
      setStrict(schema.strict ?? false)
      setProperties(
        Object.entries(schema.properties || {}).map(([key, prop]) => ({
          key,
          name: prop.name || key,
          type: prop.type || "string",
          required: prop.required ?? false,
          description: prop.description || "",
          label: prop.label || "",
          placeholder: prop.placeholder || "",
          defaultValue: prop.defaultValue != null ? String(prop.defaultValue) : "",
          hint: prop.hint || "",
          // ArtifactProperty no longer carries `format` — the UI keeps it for
          // the live preview (email/url inputType) but it is not persisted.
          format: (prop as { format?: string }).format || "",
        })),
      )
    } else {
      // New artifact defaults
      setName("")
      setTitle("")
      setDescription("")
      setColor("#5E6AD2")
      setIcon("📦")
      setSchemaName("")
      setSchemaTitle("")
      setStrict(false)
      setProperties([])
    }
    setError("")
  }, [visible, artifact])

  // ── Property management ───────────────────────────────────────────────

  const addProperty = useCallback(() => {
    setProperties((prev) => [
      ...prev,
      {
        key: `property_${Date.now()}`,
        name: "",
        type: "string",
        required: false,
        description: "",
        label: "",
        placeholder: "",
        defaultValue: "",
        hint: "",
        format: "",
      },
    ])
  }, [])

  const updateProperty = useCallback((index: number, updates: Partial<EditableProperty>) => {
    setProperties((prev) => prev.map((p, i) => (i === index ? { ...p, ...updates } : p)))
  }, [])

  const removeProperty = useCallback((index: number) => {
    setProperties((prev) => prev.filter((_, i) => i !== index))
  }, [])

  // ── Save handler ──────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    setError("")

    // Validate
    if (!name.trim()) {
      setError("Name is required")
      return
    }
    if (!title.trim()) {
      setError("Title is required")
      return
    }

    // Build schema properties object — filter out properties without a name
    const schemaProperties: Record<string, ArtifactProperty> = {}
    for (const prop of properties) {
      const propKey = (prop.name || prop.key).trim()
      if (!propKey) continue

      const artifactProp: ArtifactProperty = {
        name: propKey,
        // EditableProperty.type is a free string; ArtifactProperty.type is the
        // FieldType union. Coerce — unknown values fall back to 'text'.
        type: (FIELD_TYPES as readonly string[]).includes(prop.type)
          ? (prop.type as ArtifactProperty["type"])
          : "text",
        required: prop.required || undefined,
        description: prop.description || undefined,
        label: prop.label || undefined,
        placeholder: prop.placeholder || undefined,
        hint: prop.hint || undefined,
        // `format` is UI-only (live preview); ArtifactProperty has no such field.
      }

      // Only include defaultValue if non-empty
      if (prop.defaultValue.trim()) {
        if (prop.type === "boolean") {
          artifactProp.defaultValue = prop.defaultValue === "true"
        } else if (prop.type === "number" || prop.type === "integer") {
          const num = Number(prop.defaultValue)
          if (!isNaN(num)) artifactProp.defaultValue = num
        } else {
          artifactProp.defaultValue = prop.defaultValue
        }
      }

      schemaProperties[propKey] = artifactProp
    }

    const schema: ArtifactSchema = {
      name: schemaName || name,
      title: schemaTitle || title,
      type: "object",
      properties: schemaProperties,
      strict: strict || undefined,
    }

    const saveData: ArtifactEditorSaveData = {
      artifactId: artifact?.artifactId ?? null,
      name: name.trim(),
      title: title.trim(),
      description: description.trim(),
      color,
      icon,
      source: artifact?.source || "workspace",
      schema,
    }

    try {
      await onSave(saveData)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed")
    }
  }, [
    name,
    title,
    description,
    color,
    icon,
    properties,
    schemaName,
    schemaTitle,
    strict,
    artifact,
    onSave,
  ])

  if (!visible) return null

  return (
    <div
      onClick={onClose}
      style={{
        position: "absolute",
        inset: 0,
        background: t.modalOverlay,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: t.modalBg,
          borderRadius: 16,
          width: "90%",
          maxWidth: 640,
          maxHeight: "90%",
          display: "flex",
          flexDirection: "column",
          boxShadow: t.modalShadow,
          fontFamily: t.fontSans,
        }}
      >
        {/* ── Header ──────────────────────────────────────────── */}
        <div style={s.modalHeader}>
          <Tile xs icon="package" />
          <T step="xl" ellipsis style={{ flex: 1 }}>
            {artifact ? "Edit artifact" : "New artifact"}
          </T>
          <IconBtn icon="x" plain onPress={onClose} title="Close" />
        </div>

        {/* ── Body (scrollable) ───────────────────────────────── */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px" }}>
          {/* Artifact metadata */}
          <div style={s.sectionLabel}>Artifact metadata</div>

          <div style={s.fieldRow}>
            <div style={{ flex: 1 }}>
              <label style={s.fieldLabel}>Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={s.fieldInput}
                placeholder="e.g. Lead, Email, Report"
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={s.fieldLabel}>Title</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                style={s.fieldInput}
                placeholder="Human-readable title"
              />
            </div>
          </div>

          <div>
            <label style={s.fieldLabel}>Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={s.fieldInput}
              placeholder="What this artifact represents"
            />
          </div>

          {/* Color + Icon row */}
          <div style={{ display: "flex", gap: 20, marginTop: 14 }}>
            <div>
              <label style={s.fieldLabel}>Color</label>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", maxWidth: 200 }}>
                {DEFAULT_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 100,
                      border: `2px solid ${t.modalBg}`,
                      boxShadow: color === c ? `0 0 0 2px ${t.accent}` : "none",
                      background: c,
                      cursor: "pointer",
                      padding: 0,
                    }}
                    title={c}
                  />
                ))}
              </div>
            </div>
            <div>
              <label style={s.fieldLabel}>Icon</label>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", maxWidth: 200 }}>
                {DEFAULT_ICONS.map((ic) => (
                  <button
                    key={ic}
                    onClick={() => setIcon(ic)}
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 8,
                      border: "1px solid transparent",
                      boxShadow: icon === ic ? `0 0 0 2px ${t.accent}` : "none",
                      background: icon === ic ? t.navActive : t.inputBg,
                      cursor: "pointer",
                      padding: 0,
                      fontSize: 14,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                    title={ic}
                  >
                    {ic}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* ── Properties section ────────────────────────────── */}
          <div
            style={{
              ...s.sectionLabel,
              marginTop: 24,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span>Schema properties</span>
            <button onClick={addProperty} style={s.addPropBtn}>
              <Ph name="plus" size={11} color={t.text2} /> Add property
            </button>
          </div>

          {properties.length === 0 && (
            <div style={s.emptyProps}>
              No properties yet. Click "Add Property" to define the schema shape.
            </div>
          )}

          {properties.map((prop, index) => (
            <PropertyRow
              key={prop.key}
              property={prop}
              index={index}
              canRemove={true}
              onUpdate={(updates) => updateProperty(index, updates)}
              onRemove={() => removeProperty(index)}
            />
          ))}

          {/* Strict toggle */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 14,
              cursor: "pointer",
              fontSize: 13,
              color: t.text2,
            }}
          >
            <input
              type="checkbox"
              checked={strict}
              onChange={(e) => setStrict(e.target.checked)}
              style={{ cursor: "pointer" }}
            />
            Strict mode (reject extra properties not in schema)
          </label>
        </div>

        {/* ── Footer ──────────────────────────────────────────── */}
        <div style={s.modalFooter}>
          {error && (
            <span
              style={{
                fontSize: 12,
                color: t.tint.r.tx,
                flex: 1,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Ph name="warning-circle" size={13} color={t.tint.r.tx} />
              {error}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <Btn variant="ghost" onPress={onClose} disabled={saving}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            loading={saving}
            onPress={handleSave}
            testID="artifact-editor-save"
          >
            {artifact ? "Update artifact" : "Create artifact"}
          </Btn>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// EDITABLE PROPERTY TYPE
// ============================================================================

interface EditableProperty {
  key: string
  name: string
  type: string
  required: boolean
  description: string
  label: string
  placeholder: string
  defaultValue: string
  hint: string
  format: string
}

/** The FieldType union values (mirrors @teros/workflows FieldType). */
const FIELD_TYPES = [
  "text",
  "textarea",
  "number",
  "select",
  "checkbox",
  "radio",
  "date",
  "time",
  "datetime",
] as const

// ============================================================================
// PROPERTY ROW — One property with all its metadata fields + live preview
// ============================================================================

interface PropertyRowProps {
  property: EditableProperty
  index: number
  canRemove: boolean
  onUpdate: (updates: Partial<EditableProperty>) => void
  onRemove: () => void
}

function PropertyRow({ property, index, canRemove, onUpdate, onRemove }: PropertyRowProps) {
  const t = useFlowEditorTheme()
  const s = useArtifactEditorStyles()
  const [expanded, setExpanded] = useState(true)

  return (
    <div style={s.propRowContainer}>
      {/* Header row: property name + type + required + expand/collapse + remove */}
      <div
        style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: expanded ? 8 : 0 }}
      >
        <span
          style={{
            fontFamily: t.fontMono,
            fontSize: 10,
            letterSpacing: 0.5,
            color: t.text3,
            flexShrink: 0,
          }}
        >
          #{index + 1}
        </span>
        <input
          type="text"
          value={property.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          style={{ ...s.fieldInput, flex: 1, minWidth: 0 }}
          placeholder="property_name"
        />
        <select
          value={property.type}
          onChange={(e) => onUpdate({ type: e.target.value })}
          style={{ ...s.fieldInput, width: 96, flexShrink: 0 }}
        >
          {PROPERTY_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 12,
            color: t.text2,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <input
            type="checkbox"
            checked={property.required}
            onChange={(e) => onUpdate({ required: e.target.checked })}
            style={{ cursor: "pointer" }}
          />
          req
        </label>
        <IconBtn
          icon={expanded ? "caret-down" : "caret-right"}
          plain
          sm
          onPress={() => setExpanded((v) => !v)}
          title={expanded ? "Collapse" : "Expand"}
        />
        {canRemove && (
          <IconBtn icon="trash" plain sm danger onPress={onRemove} title="Remove property" />
        )}
      </div>

      {/* Expanded: metadata fields + preview */}
      {expanded && (
        <>
          {/* Metadata fields grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={s.metaLabel}>Label</label>
              <input
                type="text"
                value={property.label}
                onChange={(e) => onUpdate({ label: e.target.value })}
                style={s.fieldInput}
                placeholder="Display name"
              />
            </div>
            <div>
              <label style={s.metaLabel}>Format</label>
              <select
                value={property.format}
                onChange={(e) => onUpdate({ format: e.target.value })}
                style={s.fieldInput}
              >
                {FORMAT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={s.metaLabel}>Placeholder</label>
              <input
                type="text"
                value={property.placeholder}
                onChange={(e) => onUpdate({ placeholder: e.target.value })}
                style={s.fieldInput}
                placeholder="Input placeholder text"
              />
            </div>
            <div>
              <label style={s.metaLabel}>Default value</label>
              <input
                type="text"
                value={property.defaultValue}
                onChange={(e) => onUpdate({ defaultValue: e.target.value })}
                style={s.fieldInput}
                placeholder="Pre-loaded value"
              />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={s.metaLabel}>Hint</label>
              <input
                type="text"
                value={property.hint}
                onChange={(e) => onUpdate({ hint: e.target.value })}
                style={s.fieldInput}
                placeholder="Help text shown below the field"
              />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={s.metaLabel}>Description</label>
              <input
                type="text"
                value={property.description}
                onChange={(e) => onUpdate({ description: e.target.value })}
                style={s.fieldInput}
                placeholder="Internal description of this property"
              />
            </div>
          </div>

          {/* Live preview */}
          <div style={s.previewContainer}>
            <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 6 }}>
              <Ph name="eye" size={11} color={t.text3} />
              <span
                style={{
                  fontFamily: t.fontMono,
                  fontSize: 10,
                  color: t.text3,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                Preview
              </span>
            </div>
            <FieldPreview property={property} />
          </div>
        </>
      )}
    </div>
  )
}

// ============================================================================
// FIELD PREVIEW — Shows how the field will render in the output form
// ============================================================================

function FieldPreview({ property }: { property: EditableProperty }) {
  const t = useFlowEditorTheme()
  const s = useArtifactEditorStyles()
  const displayName = property.label || property.name || "field_name"
  const isRequired = property.required
  const placeholder = property.placeholder || ""
  const hint = property.hint || ""
  const defaultValue = property.defaultValue || ""
  const format = property.format || ""
  const fieldType = property.type

  // Determine input type for preview
  let inputType = "text"
  if (fieldType === "boolean") inputType = "checkbox"
  else if (fieldType === "number" || fieldType === "integer") inputType = "number"
  else if (format === "email") inputType = "email"
  else if (format === "url") inputType = "url"
  else if (format === "phone") inputType = "tel"
  else if (format === "date") inputType = "date"

  // For markdown format, show a textarea preview
  if (
    format === "markdown" ||
    (fieldType === "string" && property.description && property.description.length > 80)
  ) {
    return (
      <div>
        <label style={s.previewLabel}>
          {displayName}
          {isRequired && <span style={{ color: t.error, marginLeft: 2 }}>*</span>}
        </label>
        <textarea
          value={defaultValue}
          readOnly
          placeholder={placeholder}
          style={{ ...s.previewInput, minHeight: 50, resize: "none" }}
        />
        {hint && <div style={s.previewHint}>{hint}</div>}
      </div>
    )
  }

  // For boolean/checkbox
  if (fieldType === "boolean") {
    return (
      <div>
        <label
          style={{
            ...s.previewLabel,
            display: "flex",
            alignItems: "center",
            gap: 6,
            cursor: "default",
          }}
        >
          <input
            type="checkbox"
            checked={defaultValue === "true"}
            readOnly
            style={{ cursor: "default" }}
          />
          {displayName}
          {isRequired && <span style={{ color: t.error, marginLeft: 2 }}>*</span>}
        </label>
        {hint && <div style={s.previewHint}>{hint}</div>}
      </div>
    )
  }

  // Default: text input
  return (
    <div>
      <label style={s.previewLabel}>
        {displayName}
        {isRequired && <span style={{ color: t.error, marginLeft: 2 }}>*</span>}
      </label>
      <input
        type={inputType}
        value={defaultValue}
        readOnly
        placeholder={placeholder}
        style={s.previewInput}
      />
      {hint && <div style={s.previewHint}>{hint}</div>}
    </div>
  )
}

// ============================================================================
// ============================================================================
// SHARED STYLES (theme-adaptive via useFlowEditorTheme)
// ============================================================================

function useArtifactEditorStyles(): Record<string, React.CSSProperties> {
  const t = useFlowEditorTheme()
  const ds = useFlowEditorStyles()
  return {
    modalHeader: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "14px 16px 14px 20px",
      borderBottom: `1px solid ${t.modalHeaderBorder}`,
      flexShrink: 0,
    },

    modalFooter: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "12px 20px",
      borderTop: `1px solid ${t.modalFooterBorder}`,
      flexShrink: 0,
    },

    sectionLabel: {
      ...ds.sectionHeader,
      marginBottom: 14,
    },

    fieldRow: {
      display: "flex",
      gap: 12,
      marginBottom: 14,
    },

    fieldLabel: ds.label,

    fieldInput: ds.input,

    metaLabel: {
      ...ds.label,
      fontSize: 9,
      letterSpacing: 1.3,
      marginBottom: 6,
    },

    addPropBtn: ds.btnSm,

    emptyProps: {
      fontFamily: t.fontSans,
      fontSize: 13,
      color: t.text3,
      textAlign: "center",
      padding: "20px 0",
      background: t.nestBg,
      borderRadius: 12,
      marginBottom: 10,
    },

    propRowContainer: {
      background: t.nestBg,
      borderRadius: 12,
      padding: "12px 14px",
      marginBottom: 10,
      display: "flex",
      flexDirection: "column",
    },

    previewContainer: {
      marginTop: 12,
      padding: "12px 14px",
      background: t.modalBg,
      border: `1px dashed ${t.toolbarButtonBorder}`,
      borderRadius: 10,
    },

    previewLabel: {
      display: "block",
      fontFamily: t.fontSans,
      fontSize: 13,
      color: t.text,
      marginBottom: 6,
    },

    previewInput: {
      ...ds.input,
      color: t.text2,
    },

    previewHint: {
      ...ds.help,
      marginTop: 6,
    },
  }
}
