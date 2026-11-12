/**
 * ContextEditor — unified context editing component for all entity levels.
 *
 * Used by: Workspace, Agent, Project, and Skill windows.
 * OS prototype vocabulary (design-testing): uppercase FieldLabel, a mono
 * textarea Field on the `c.field` fill, help line + pill buttons underneath.
 */

import React, { useState, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { useColors } from "./mca/primitives/useColors"
import { Btn, Field, FieldHelp, FieldLabel, T } from "./ui/ds"

export interface ContextEditorProps {
  /** Visible title above the editor */
  title: string
  /** Optional explanatory text below the title */
  description?: string
  /** Current value (controlled) */
  value: string
  /** Called on every keystroke */
  onChange: (value: string) => void
  /** Called when user presses Save */
  onSave: () => Promise<void>
  /** Called when user presses Cancel. If omitted, Cancel is hidden. */
  onCancel?: () => void
  /** Whether a save is in flight */
  isSaving?: boolean
  /** Placeholder text for the empty state */
  placeholder?: string
  /** Minimum height of the text area (px) */
  minHeight?: number
  /** When true, hides the Save/Cancel footer (use inside forms that have their own buttons) */
  formMode?: boolean
  /** Disable editing */
  readOnly?: boolean
}

export function ContextEditor({
  title,
  description,
  value,
  onChange,
  onSave,
  onCancel,
  isSaving = false,
  placeholder = "Write context here...",
  minHeight = 160,
  formMode = false,
  readOnly = false,
}: ContextEditorProps) {
  const { t } = useTranslation()
  const [hasChanges, setHasChanges] = useState(false)
  const c = useColors()

  const handleChange = useCallback(
    (text: string) => {
      onChange(text)
      setHasChanges(true)
    },
    [onChange],
  )

  const handleSave = useCallback(async () => {
    await onSave()
    setHasChanges(false)
  }, [onSave])

  const handleCancel = useCallback(() => {
    onCancel?.()
    setHasChanges(false)
  }, [onCancel])

  return (
    <View style={{ gap: 0 }}>
      <FieldLabel>{title}</FieldLabel>
      {description ? (
        <T step="12" tone="text3" style={{ marginBottom: 10, marginTop: -4 }}>
          {description}
        </T>
      ) : null}

      <Field
        area
        mono
        minHeight={minHeight}
        value={value}
        onChangeText={handleChange}
        placeholder={placeholder}
        editable={!readOnly && !isSaving}
        containerStyle={hasChanges ? { borderColor: c.borderAccent } : undefined}
      />

      {/* Footer — hidden in formMode (parent form handles Save/Cancel) */}
      {!formMode && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            marginTop: 10,
            flexWrap: "wrap",
          }}
        >
          <FieldHelp style={{ marginTop: 0, flex: 1, minWidth: 120 }}>
            {isSaving
              ? t("common.saving", { defaultValue: "Saving..." })
              : hasChanges
                ? t("contextEditor.unsaved", { defaultValue: "Unsaved changes" })
                : t("contextEditor.allSaved", { defaultValue: "All changes saved" })}
          </FieldHelp>
          {onCancel && (
            <Btn variant="ghost" size="sm" icon="x" disabled={isSaving} onPress={handleCancel}>
              {t("common.cancel", { defaultValue: "Cancel" })}
            </Btn>
          )}
          <Btn
            variant="primary"
            size="sm"
            icon="check"
            disabled={isSaving || !hasChanges}
            loading={isSaving}
            onPress={handleSave}
          >
            {isSaving
              ? t("common.saving", { defaultValue: "Saving..." })
              : t("common.save", { defaultValue: "Save" })}
          </Btn>
        </View>
      )}
    </View>
  )
}
