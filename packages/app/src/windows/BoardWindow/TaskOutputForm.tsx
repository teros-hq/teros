/**
 * TaskOutputForm — Modal form for completing workflow tasks with output gates.
 *
 * When a human presses "Completar" on a task that has a `workflowOutputGate`,
 * this modal appears with the appropriate input:
 *
 * - Signal (schemaId: null): no form — completes directly.
 * - Markdown (schemaId: "markdown"): a textarea for free-form markdown output.
 * - Structured JSON (schemaId: "art_xxx"): a form rendered from the artifact's
 *   ArtifactSchema properties. Each property becomes a field.
 *
 * On submit, the output data is sent via `onSubmit(outputData)` which calls
 * `board.moveTask(taskId, doneCol, undefined, outputData)` — the backend
 * persists it to `output.data` before the ActionBridge fires.
 *
 * Also renders a read-only view of an existing `output.data` when viewing
 * a completed task (the "Output" tab content).
 *
 * Presentation follows the OS prototype (design-testing): `Card` blocks,
 * `FieldLabel` + `Field` controls, pill buttons, 400 weight everywhere.
 */

import React, { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { Modal, Platform, Pressable, ScrollView, View } from "react-native"
import { useColors } from "../../components/mca/primitives/useColors"
import { FONT_SANS } from "../../components/mca/primitives/fonts"
import {
  Btn,
  Card,
  Check,
  ChipBtn,
  Field,
  FieldHelp,
  FieldLabel as DsFieldLabel,
  IconBtn,
  Ph,
  T,
  Tile,
} from "../../components/ui/ds"
import type { Task } from "../../store/boardStore"

// ─── Types ──────────────────────────────────────────────────────────────────

/** The output artifact of a task as the form sees it (type + optional label from the workflow gate). */
export interface TaskGate {
  gateId: string
  schemaId: string | null
  label?: string
  mode?: string
}

/** An artifact schema property (from the workflow models). */
interface ArtifactProperty {
  name: string
  type: string
  required?: boolean
  enum?: (string | number | boolean | null)[]
  description?: string
  // UI metadata
  label?: string
  placeholder?: string
  defaultValue?: unknown
  hint?: string
  format?: string
}

/** An artifact schema (from the workflow models). */
export interface ArtifactSchema {
  name: string
  title: string
  type: string
  description?: string
  properties: Record<string, ArtifactProperty>
  strict?: boolean
}

/** Props for the output form modal. */
interface TaskOutputFormModalProps {
  /** The task being completed. */
  task: Task
  /** Whether the form is visible. */
  visible: boolean
  /** Called when the user submits the form. Receives the output data. */
  onSubmit: (outputData: unknown) => void
  /** Called when the user cancels. */
  onCancel: () => void
  /** Whether the submission is in progress. */
  submitting?: boolean
}

// ─── Gate type helpers ──────────────────────────────────────────────────────

/**
 * The output artifact of a task, if it has one. Source of truth is
 * `task.output` (docs/specs/tasks/artifacts.md); the workflow gate only
 * contributes its label/gateId when present.
 */
export function getOutputGate(task: Task): TaskGate | null {
  const gate = task.workflowOutputGate as unknown as Partial<TaskGate> | undefined
  if (task.output) {
    return { gateId: gate?.gateId ?? 'output', schemaId: task.output.schemaId ?? null, label: gate?.label, mode: gate?.mode }
  }
  if (!gate || !gate.gateId) return null
  return gate as TaskGate
}

/** Schema snapshot of the output artifact (structured outputs render a form from it). */
export function getOutputSchema(task: Task): ArtifactSchema | null {
  const schema = task.output?.schema as unknown as ArtifactSchema | undefined
  if (schema && schema.properties) return schema
  return null
}

/** Current value of the output artifact. */
export function getOutputData(task: Task): unknown {
  return task.output?.data
}

/** Determine the output type from the gate's schemaId. */
export type OutputType = "signal" | "markdown" | "structured"

export function getOutputType(gate: TaskGate | null): OutputType {
  if (!gate) return "signal"
  if (gate.schemaId === null) return "signal"
  if (gate.schemaId === "markdown") return "markdown"
  return "structured"
}

// ─── ArtifactSchema → form fields conversion ────────────────────────────────

/** A simplified field descriptor derived from an ArtifactProperty. */
export interface FormFieldDescriptor {
  id: string
  label: string
  type: "text" | "textarea" | "number" | "select" | "checkbox"
  required: boolean
  description?: string
  options?: { value: string; label: string }[]
  // UI metadata from the artifact schema
  placeholder?: string
  hint?: string
  defaultValue?: string | boolean
  format?: string
}

/** Convert an ArtifactSchema into form field descriptors. */
export function schemaToFields(schema: ArtifactSchema): FormFieldDescriptor[] {
  const fields: FormFieldDescriptor[] = []
  for (const [key, prop] of Object.entries(schema.properties)) {
    // Skip nested objects and arrays for now — they're rare in output gates
    // and the form would need recursive rendering. We render them as text
    // (JSON input) if they appear.
    let fieldType: FormFieldDescriptor["type"] = "text"

    if (prop.enum && prop.enum.length > 0) {
      fieldType = "select"
    } else if (prop.type === "boolean") {
      fieldType = "checkbox"
    } else if (prop.type === "number" || prop.type === "integer") {
      fieldType = "number"
    } else if (prop.format === "markdown") {
      // Format hint 'markdown' → textarea
      fieldType = "textarea"
    } else if (prop.type === "string" && prop.description && prop.description.length > 80) {
      // Long descriptions suggest a textarea is more appropriate
      fieldType = "textarea"
    } else if (prop.type === "object" || prop.type === "array") {
      fieldType = "textarea"
    }

    const field: FormFieldDescriptor = {
      id: key,
      // Use label if provided, otherwise fall back to name, then key
      label: prop.label || prop.name || key,
      type: fieldType,
      required: prop.required ?? false,
      description: prop.description,
      placeholder: prop.placeholder,
      hint: prop.hint,
      format: prop.format,
    }

    // Coerce defaultValue to string|boolean for form state
    if (prop.defaultValue !== undefined && prop.defaultValue !== null) {
      if (fieldType === "checkbox") {
        field.defaultValue = Boolean(prop.defaultValue)
      } else {
        field.defaultValue = String(prop.defaultValue)
      }
    }

    if (fieldType === "select" && prop.enum) {
      field.options = prop.enum.map((val) => ({
        value: String(val),
        label: String(val),
      }))
    }

    fields.push(field)
  }
  return fields
}

// ─── Input style helper (kept for callers that style a raw TextInput) ───────

export function inputStyle(
  c: ReturnType<typeof useColors>,
  opts: { multiline?: boolean; focused?: boolean } = {},
): Record<string, unknown> {
  return {
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: c.field,
    borderWidth: 1,
    borderColor: opts.focused ? "rgba(111,39,255,0.45)" : c.border,
    borderRadius: 10,
    color: c.text,
    fontFamily: FONT_SANS,
    fontSize: 13,
    ...(opts.multiline ? { minHeight: 96, textAlignVertical: "top" as const } : {}),
  }
}

// ─── Field label ────────────────────────────────────────────────────────────

/** Uppercase 10px label (+ required mark) with the optional help line. */
export function FieldLabel({
  label,
  required,
  description,
  hint,
}: {
  label: string
  required?: boolean
  description?: string
  hint?: string
}) {
  // hint is the preferred help text; fall back to description for backwards compat
  const helpText = hint || description
  return (
    <View>
      <DsFieldLabel required={required} style={{ marginBottom: helpText ? 4 : 8 }}>
        {label}
      </DsFieldLabel>
      {helpText ? (
        <FieldHelp style={{ marginTop: 0, marginBottom: 8 }}>{helpText}</FieldHelp>
      ) : null}
    </View>
  )
}

// ─── Individual field control ───────────────────────────────────────────────

export function FieldControl({
  field,
  value,
  disabled,
  onChange,
}: {
  field: FormFieldDescriptor
  value: string | boolean | undefined
  disabled: boolean
  onChange: (value: string | boolean) => void
}) {
  const c = useColors()

  if (field.type === "checkbox") {
    const checked = value === true
    return (
      <Pressable
        onPress={() => !disabled && onChange(!checked)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked, disabled }}
        style={[
          {
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingVertical: 4,
            opacity: disabled ? 0.6 : 1,
          },
          Platform.OS === "web" ? ({ cursor: disabled ? "default" : "pointer" } as any) : null,
        ]}
      >
        <Check on={checked} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <T step="sm">{field.label}</T>
            {field.required ? (
              <T step="xs" color={c.accent}>
                *
              </T>
            ) : null}
          </View>
          {field.hint ? (
            <T step="12" tone="text3">
              {field.hint}
            </T>
          ) : null}
        </View>
      </Pressable>
    )
  }

  if (field.type === "select") {
    const selected = typeof value === "string" ? value : ""
    return (
      <View>
        <FieldLabel label={field.label} required={field.required} hint={field.hint} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {field.options?.map((option) => {
            const isSelected = selected === option.value
            return (
              <ChipBtn
                key={option.value}
                on={isSelected}
                icon={isSelected ? "check" : undefined}
                disabled={disabled}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
                onPress={() => !disabled && onChange(isSelected ? "" : option.value)}
              >
                {option.label}
              </ChipBtn>
            )
          })}
        </View>
      </View>
    )
  }

  const isTextarea = field.type === "textarea"

  // Determine keyboardType from format hint
  let keyboardType: "default" | "numeric" | "email-address" | "phone-pad" | "url" = "default"
  if (field.type === "number") {
    keyboardType = "numeric"
  } else if (field.format === "email") {
    keyboardType = "email-address"
  } else if (field.format === "phone") {
    keyboardType = "phone-pad"
  } else if (field.format === "url") {
    keyboardType = "url"
  }

  return (
    <View>
      <FieldLabel label={field.label} required={field.required} hint={field.hint} />
      <Field
        value={typeof value === "string" ? value : ""}
        onChangeText={(text) => onChange(text)}
        editable={!disabled}
        keyboardType={keyboardType}
        area={isTextarea}
        minHeight={96}
        mono={field.type === "number"}
        placeholder={field.placeholder}
      />
    </View>
  )
}

// ─── Artifact header ────────────────────────────────────────────────────────

/**
 * ArtifactHeader — Displays the artifact's icon, name, color, and description
 * at the top of the output form. Provides visual context for what the user
 * is filling out.
 */
export function ArtifactHeader({
  schema,
  artifactColor,
  artifactIcon,
}: {
  schema: ArtifactSchema
  artifactColor?: string
  artifactIcon?: string
}) {
  const c = useColors()
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <Tile sm style={artifactColor ? { backgroundColor: `${artifactColor}1A` } : undefined}>
        {artifactIcon ? (
          <T step="base">{artifactIcon}</T>
        ) : (
          <Ph name="package" size={18} color={artifactColor || c.accent} />
        )}
      </Tile>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T step="hsm" ellipsis>
          {schema.title || schema.name}
        </T>
        {schema.description ? (
          <T step="12" tone="text3" numberOfLines={2}>
            {schema.description}
          </T>
        ) : null}
      </View>
    </View>
  )
}

// ─── Save status line ───────────────────────────────────────────────────────

function SaveStatusLine({
  autoSavePending,
  saving,
  saveStatus,
}: {
  autoSavePending: boolean
  saving: boolean
  saveStatus: "idle" | "saved" | "error"
}) {
  const c = useColors()
  const { t } = useTranslation()
  if (saving) {
    return (
      <T step="12" tone="text3">
        {t("board.output.saving", { defaultValue: "Guardando…" })}
      </T>
    )
  }
  if (autoSavePending) {
    return (
      <T step="12" tone="text3">
        …
      </T>
    )
  }
  if (saveStatus === "saved") {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        <Ph name="check" size={12} color={c.tint.g.tx} />
        <T step="12" color={c.tint.g.tx}>
          {t("board.output.saved", { defaultValue: "Guardado" })}
        </T>
      </View>
    )
  }
  if (saveStatus === "error") {
    return (
      <T step="12" tone="danger">
        {t("board.output.saveError", { defaultValue: "Error guardando" })}
      </T>
    )
  }
  return null
}

// ─── Read-only output display ───────────────────────────────────────────────

/** Render the existing output artifact as a read-only key-value list. */
export function TaskOutputDisplay({ task }: { task: Task }) {
  const { t } = useTranslation()
  const gate = getOutputGate(task)
  const outputType = getOutputType(gate)

  if (!gate || outputType === "signal") {
    return null
  }

  const outputData = getOutputData(task)
  if (outputData === undefined || outputData === null) {
    return null
  }

  // Markdown output: render as text
  if (outputType === "markdown") {
    return (
      <View style={{ padding: 12, paddingTop: 0 }}>
        <DsFieldLabel>{t("board.output.title", { defaultValue: "Output" })}</DsFieldLabel>
        <Card nested pad>
          <T step="sm" tone="text2" selectable>
            {String(outputData)}
          </T>
        </Card>
      </View>
    )
  }

  // Structured output: render as key-value pairs
  const data = outputData as Record<string, unknown>
  if (typeof data !== "object" || data === null) {
    return null
  }

  // Schema snapshot for label resolution
  const readOnlySchema = getOutputSchema(task) ?? undefined

  return (
    <View style={{ padding: 12, paddingTop: 0 }}>
      <DsFieldLabel>{t("board.output.title", { defaultValue: "Output" })}</DsFieldLabel>
      <Card nested pad style={{ gap: 10 }}>
        {Object.entries(data).map(([key, value]) => {
          // Use label from schema if available, otherwise fall back to key
          const propLabel = readOnlySchema?.properties?.[key]?.label || key
          return (
            <View key={key} style={{ gap: 2 }}>
              <T step="codenote" tone="text3">
                {propLabel}
              </T>
              <T step="sm" tone="text2" selectable>
                {typeof value === "boolean"
                  ? value
                    ? t("board.output.yes", { defaultValue: "Sí" })
                    : t("board.output.no", { defaultValue: "No" })
                  : typeof value === "object"
                    ? JSON.stringify(value)
                    : String(value)}
              </T>
            </View>
          )
        })}
      </Card>
    </View>
  )
}

// ─── Input artifact display ─────────────────────────────────────────────────

/**
 * Render the task's input artifact (docs/specs/tasks/artifacts.md): the type
 * header when it is typed, then the data as a key-value list labelled from the
 * schema snapshot, or as JSON when untyped / not an object.
 */
export function TaskInputDisplay({ task }: { task: Task }) {
  const { t } = useTranslation()
  const input = task.input
  if (!input || input.data === undefined || input.data === null) return null
  const schema = (input.schema as unknown as ArtifactSchema | undefined) ?? undefined
  const data = input.data
  const isObject = typeof data === "object" && data !== null && !Array.isArray(data)

  return (
    <View style={{ gap: 10 }}>
      {input.schemaId ? (
        <View style={{ gap: 4 }}>
          <ArtifactHeader
            schema={schema ?? { name: input.schemaId, title: input.schemaId, type: "object", properties: {} }}
            artifactIcon={input.schemaId.startsWith("art_evt_") ? "⚡" : undefined}
          />
          <T step="codenote" tone="text3">
            {t("board.input.typed", { defaultValue: "Artefacto de entrada · {{id}}", id: input.schemaId })}
          </T>
        </View>
      ) : (
        <T step="codenote" tone="text3">
          {t("board.input.untyped", { defaultValue: "Datos de entrada (sin tipo)" })}
        </T>
      )}
      <Card nested pad style={{ gap: 10 }}>
        {isObject ? (
          Object.entries(data as Record<string, unknown>).map(([key, value]) => {
            const propLabel = schema?.properties?.[key]?.label || key
            return (
              <View key={key} style={{ gap: 2 }}>
                <T step="codenote" tone="text3">
                  {propLabel}
                </T>
                <T step="sm" tone="text2" selectable>
                  {typeof value === "boolean"
                    ? value
                      ? t("board.output.yes", { defaultValue: "Sí" })
                      : t("board.output.no", { defaultValue: "No" })
                    : value === null || value === undefined
                      ? "—"
                      : typeof value === "object"
                        ? JSON.stringify(value)
                        : String(value)}
                </T>
              </View>
            )
          })
        ) : (
          <T step="sm" tone="text2" selectable>
            {typeof data === "string" ? data : JSON.stringify(data, null, 2)}
          </T>
        )}
      </Card>
    </View>
  )
}

// ─── Main modal component ───────────────────────────────────────────────────

export function TaskOutputFormModal({
  task,
  visible,
  onSubmit,
  onCancel,
  submitting = false,
}: TaskOutputFormModalProps) {
  const c = useColors()
  const { t } = useTranslation()
  const gate = getOutputGate(task)
  const outputType = getOutputType(gate)

  // Markdown output state
  const [markdownText, setMarkdownText] = useState("")

  // Structured form state
  const [fieldValues, setFieldValues] = useState<Record<string, string | boolean>>({})

  // For structured outputs, the schema snapshot travels with the task.
  const structuredSchema = useMemo(() => {
    if (outputType !== "structured") return null
    return getOutputSchema(task)
  }, [task.output, outputType])

  // Reset state when the modal opens for a different task
  // Preload defaultValues from the schema when the modal opens
  React.useEffect(() => {
    if (visible) {
      setMarkdownText("")
      // Preload default values from schema
      if (outputType === "structured" && structuredSchema) {
        const defaults: Record<string, string | boolean> = {}
        const formFields = schemaToFields(structuredSchema)
        for (const field of formFields) {
          if (field.defaultValue !== undefined) {
            defaults[field.id] = field.defaultValue
          }
        }
        setFieldValues(defaults)
      } else {
        setFieldValues({})
      }
    }
  }, [visible, task.taskId, outputType, structuredSchema])

  // Form fields — memoized ABOVE the signal early-return below: hooks must run
  // unconditionally, or a task whose output gate type changes between renders
  // (signal ↔ structured/markdown) throws "Rendered more hooks than during
  // the previous render" and takes the whole window down with it.
  const fields = useMemo(() => {
    if (!structuredSchema) return []
    return schemaToFields(structuredSchema)
  }, [structuredSchema])

  // Don't render anything for signal-only gates — the caller should handle
  // this case by completing directly without showing the modal.
  if (outputType === "signal") {
    return null
  }

  const handleSubmit = () => {
    if (outputType === "markdown") {
      onSubmit(markdownText)
    } else if (outputType === "structured" && structuredSchema) {
      // Coerce field values to the right types
      const output: Record<string, unknown> = {}
      for (const field of fields) {
        const value = fieldValues[field.id]
        if (value === undefined || value === "") continue
        if (field.type === "checkbox") {
          output[field.id] = value === true
        } else if (field.type === "number") {
          output[field.id] = Number(value)
        } else {
          output[field.id] = value
        }
      }
      onSubmit(output)
    }
  }

  const isDisabled = submitting || (outputType === "markdown" && !markdownText.trim())

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      {/* Backdrop */}
      <Pressable
        style={{
          flex: 1,
          backgroundColor: "rgba(32,28,39,0.55)",
          justifyContent: "center",
          alignItems: "center",
          padding: 16,
        }}
        onPress={onCancel}
      >
        {/* Modal content — stop propagation so tapping inside doesn't close */}
        <Pressable
          style={[
            {
              width: "100%",
              maxWidth: 460,
              maxHeight: "80%",
              backgroundColor: c.bgStep,
              borderRadius: 16,
              overflow: "hidden",
            },
            Platform.OS === "web" ? ({ boxShadow: c.elevRaised, cursor: "default" } as any) : null,
          ]}
          onPress={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingHorizontal: 20,
              paddingVertical: 14,
              borderBottomWidth: 1,
              borderBottomColor: c.border,
            }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <T step="xl" ellipsis>
                {gate?.label ||
                  t("board.output.formTitle", { defaultValue: "Resultado de la tarea" })}
              </T>
              <T step="12" tone="text3" ellipsis>
                {task.title}
              </T>
            </View>
            <IconBtn icon="x" plain sm onPress={onCancel} />
          </View>

          {/* Body */}
          <ScrollView style={{ maxHeight: 400 }} contentContainerStyle={{ padding: 20 }}>
            {outputType === "markdown" && (
              <View>
                <FieldLabel
                  label={t("board.output.markdownLabel", { defaultValue: "Output (Markdown)" })}
                  description={t("board.output.markdownHelp", {
                    defaultValue: "Escribe el resultado en markdown.",
                  })}
                />
                <Field
                  value={markdownText}
                  onChangeText={setMarkdownText}
                  editable={!submitting}
                  placeholder={t("board.output.placeholder", {
                    defaultValue: "Escribe el resultado…",
                  })}
                  area
                  minHeight={160}
                />
              </View>
            )}

            {outputType === "structured" && (
              <View style={{ gap: 16 }}>
                {structuredSchema ? (
                  <>
                    <ArtifactHeader schema={structuredSchema} />
                    {fields.map((field) => (
                      <FieldControl
                        key={field.id}
                        field={field}
                        value={fieldValues[field.id]}
                        disabled={submitting}
                        onChange={(value) =>
                          setFieldValues((prev) => ({ ...prev, [field.id]: value }))
                        }
                      />
                    ))}
                  </>
                ) : (
                  <MissingSchemaHint schemaId={gate?.schemaId} />
                )}
              </View>
            )}
          </ScrollView>

          {/* Footer */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: 8,
              paddingHorizontal: 20,
              paddingVertical: 14,
              borderTopWidth: 1,
              borderTopColor: c.border,
            }}
          >
            <Btn variant="ghost" onPress={onCancel} disabled={submitting}>
              {t("board.output.cancel", { defaultValue: "Cancelar" })}
            </Btn>
            <Btn
              variant="primary"
              icon="check-circle"
              onPress={handleSubmit}
              disabled={isDisabled}
              loading={submitting}
            >
              {t("board.output.complete", { defaultValue: "Completar" })}
            </Btn>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

function MissingSchemaHint({ schemaId }: { schemaId?: string | null }) {
  const { t } = useTranslation()
  return (
    <View style={{ alignItems: "center", paddingVertical: 20, gap: 8 }}>
      <T step="sm" tone="text3" center>
        {t("board.output.missingSchema", {
          defaultValue:
            "Esta tarea tiene un gate estructurado (artefacto: {{schemaId}}), pero el esquema no viene en los datos de la tarea.",
          schemaId: schemaId ?? "—",
        })}
      </T>
      <T step="12" tone="text3" center>
        {t("board.output.missingSchemaHint", {
          defaultValue:
            "Puedes completar la tarea igualmente — el motor de workflows validará el resultado.",
        })}
      </T>
    </View>
  )
}

// ─── Inline (tab) output form ────────────────────────────────────────────────

/**
 * TaskOutputFormInline — inline (non-modal) version of the output form.
 *
 * Renders directly inside the "Output" tab of TaskDetailPanel.
 * State is controlled by the parent: `markdownText`, `fieldValues`, and
 * `onChange*` callbacks are passed down so the panel owns the form state
 * and it persists across tab switches.
 *
 * For markdown output, supports an "append" mode where the user can add
 * content to the existing output progressively.
 */
export interface TaskOutputFormInlineProps {
  task: Task
  outputType: OutputType
  gate: TaskGate | null
  markdownText: string
  onMarkdownChange: (text: string) => void
  fieldValues: Record<string, string | boolean>
  onFieldChange: (fieldId: string, value: string | boolean) => void
  submitting?: boolean
  /** When true, the form is read-only (task already completed with output) */
  readOnly?: boolean
  /** Called when the user presses "Guardar" to save output without completing. */
  onSave?: (outputData: unknown, mode: "replace" | "append") => void
  /** When true, a save operation is in progress. */
  saving?: boolean
  /** Save status: 'idle' | 'saved' | 'error' — used to show feedback. */
  saveStatus?: "idle" | "saved" | "error"
  /** When true, auto-save is pending (user is typing, timer hasn't fired yet). */
  autoSavePending?: boolean
}

export function TaskOutputFormInline({
  task,
  outputType,
  gate,
  markdownText,
  onMarkdownChange,
  fieldValues,
  onFieldChange,
  submitting = false,
  readOnly = false,
  onSave,
  saving = false,
  saveStatus = "idle",
  autoSavePending = false,
}: TaskOutputFormInlineProps) {
  const c = useColors()
  const { t } = useTranslation()

  // For structured outputs, the schema snapshot travels with the task.
  // Both memos sit ABOVE the signal early-return below: hooks must run
  // unconditionally, or a task whose output gate type changes between renders
  // (signal ↔ structured/markdown) throws "Rendered more hooks than during
  // the previous render" and takes the whole window down with it.
  const structuredSchema = useMemo(() => {
    if (outputType !== "structured") return null
    return getOutputSchema(task)
  }, [task.output, outputType])

  const fields = useMemo(() => {
    if (!structuredSchema) return []
    return schemaToFields(structuredSchema)
  }, [structuredSchema])

  // Signal — no form needed
  if (outputType === "signal") {
    return (
      <View
        style={{
          padding: 12,
          alignItems: "center",
          justifyContent: "center",
          minHeight: 200,
          gap: 10,
        }}
      >
        <Tile icon="check-circle" tone="muted" />
        <T step="sm" tone="text3" center>
          {t("board.output.noForm", {
            defaultValue:
              'Esta tarea no tiene formulario de resultado. Pulsa "Completar" cuando termines.',
          })}
        </T>
      </View>
    )
  }

  const readOnlyLine = readOnly ? (
    <T step="12" tone="text3">
      {t("board.output.readOnly", { defaultValue: "Solo lectura — la tarea ya está completada" })}
    </T>
  ) : null

  // ── Markdown output ──
  if (outputType === "markdown") {
    const existingOutput = getOutputData(task)
    const hasExistingOutput = existingOutput !== undefined && existingOutput !== null
    const existingText = typeof existingOutput === "string" ? existingOutput : ""
    const canSave =
      !submitting && !saving && !readOnly && !!onSave && markdownText.trim().length > 0
    // If there's existing saved output, the textarea acts as an append input.
    // If no existing output, the textarea is the full output (replace mode).
    const saveMode: "replace" | "append" = hasExistingOutput ? "append" : "replace"

    return (
      <View style={{ padding: 12, paddingTop: 0 }}>
        <Card pad style={{ gap: 12 }}>
          <FieldLabel
            label={t("board.output.markdownLabel", { defaultValue: "Output (Markdown)" })}
            description={
              hasExistingOutput
                ? t("board.output.appendHelp", {
                    defaultValue:
                      "Añade contenido al resultado guardado. Guardar no completa la tarea.",
                  })
                : t("board.output.writeHelp", {
                    defaultValue: "Escribe el resultado en markdown. Guardar no completa la tarea.",
                  })
            }
          />

          {/* Show existing saved output (read-only) */}
          {hasExistingOutput && existingText && (
            <Card nested pad style={{ marginTop: -4 }}>
              <T step="codenote" tone="text3" style={{ marginBottom: 6 }}>
                {t("board.output.savedOutput", { defaultValue: "Resultado guardado" })}
              </T>
              <T step="sm" tone="text2" selectable>
                {existingText}
              </T>
            </Card>
          )}

          {/* Textarea — for append when existing, for full output when new */}
          <Field
            value={markdownText}
            onChangeText={onMarkdownChange}
            editable={!submitting && !readOnly}
            placeholder={
              readOnly
                ? ""
                : hasExistingOutput
                  ? t("board.output.appendPlaceholder", { defaultValue: "Añade contenido…" })
                  : t("board.output.placeholder", { defaultValue: "Escribe el resultado…" })
            }
            area
            minHeight={hasExistingOutput ? 120 : 200}
            containerStyle={{ marginTop: -4 }}
          />

          {/* Guardar + status feedback */}
          {!readOnly && onSave && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Btn
                variant="sec"
                size="sm"
                icon="floppy-disk"
                onPress={() => onSave(markdownText, saveMode)}
                disabled={!canSave}
                loading={saving}
              >
                {hasExistingOutput
                  ? t("board.output.saveAppend", { defaultValue: "Guardar (añadir)" })
                  : t("board.output.save", { defaultValue: "Guardar" })}
              </Btn>
              <SaveStatusLine
                autoSavePending={autoSavePending}
                saving={saving}
                saveStatus={saveStatus}
              />
            </View>
          )}
          {readOnly || !onSave ? (
            <SaveStatusLine
              autoSavePending={autoSavePending}
              saving={saving}
              saveStatus={saveStatus}
            />
          ) : null}

          {readOnlyLine}
        </Card>
      </View>
    )
  }

  // ── Structured output ──
  return (
    <View style={{ padding: 12, paddingTop: 0 }}>
      <Card pad style={{ gap: 16 }}>
        {structuredSchema ? (
          <>
            <ArtifactHeader schema={structuredSchema} />
            <View style={{ height: 1, backgroundColor: c.border }} />
            {fields.map((field) => (
              <FieldControl
                key={field.id}
                field={field}
                value={fieldValues[field.id]}
                disabled={submitting || readOnly}
                onChange={(value) => onFieldChange(field.id, value)}
              />
            ))}
            {readOnlyLine}

            {/* Guardar — saves structured output without completing */}
            {!readOnly && onSave && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                <Btn
                  variant="sec"
                  size="sm"
                  icon="floppy-disk"
                  onPress={() => {
                    const output: Record<string, unknown> = {}
                    for (const field of fields) {
                      const value = fieldValues[field.id]
                      if (value === undefined || value === "") continue
                      if (field.type === "checkbox") {
                        output[field.id] = value === true
                      } else if (field.type === "number") {
                        output[field.id] = Number(value)
                      } else {
                        output[field.id] = value
                      }
                    }
                    onSave(output, "replace")
                  }}
                  disabled={submitting || saving}
                  loading={saving}
                >
                  {t("board.output.save", { defaultValue: "Guardar" })}
                </Btn>
                <SaveStatusLine
                  autoSavePending={autoSavePending}
                  saving={saving}
                  saveStatus={saveStatus}
                />
              </View>
            )}
          </>
        ) : (
          <MissingSchemaHint schemaId={gate?.schemaId} />
        )}
      </Card>
    </View>
  )
}

// ─── Helper: should show output form for a task? ────────────────────────────

/** Returns true if completing this task should show an output form. */
export function shouldShowOutputForm(task: Task): boolean {
  const gate = getOutputGate(task)
  const outputType = getOutputType(gate)
  return outputType !== "signal"
}
