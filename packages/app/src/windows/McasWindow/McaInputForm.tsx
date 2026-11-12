/**
 * Input-form body for the Retest Sheet (Task 2 / D-02/D-03). Renders one generated field per flat
 * primitive property, or a single raw-JSON textarea for non-flat schemas. Submit is gated on
 * required-only fields (flat) or JSON-parse + required-key success (raw). All chrome strings via
 * mca.status.form.*. Each field variant is its own small component so the render stays under the
 * cognitive-complexity limit (CLAUDE.md). Built from the `ui/ds` form primitives.
 */
import type React from "react"
import { ScrollView, View } from "react-native"
import {
  type ActiveForm,
  type FormField,
  buildFormFields,
  isFlatSchema,
  rawJsonRequiredFilled,
} from "./mcaHealth.utils"
import { Btn, ChipBtn, Field, FieldHelp, FieldLabel, IconBtn, T } from "../../components/ui/ds"

type Translate = (key: string, opts?: Record<string, unknown>) => string
type SetField = (name: string, value: unknown) => void

/** Boolean field — a true/false chip pair. */
function BooleanField({
  field,
  value,
  setField,
}: {
  field: FormField
  value: unknown
  setField: SetField
}) {
  return (
    <View style={{ flexDirection: "row", gap: 6 }}>
      {[true, false].map((val) => (
        <ChipBtn
          key={String(val)}
          mono
          on={value === val}
          onPress={() => setField(field.name, val)}
        >
          {val ? "true" : "false"}
        </ChipBtn>
      ))}
    </View>
  )
}

/** Enum field — one selectable chip per allowed value. */
function EnumField({
  field,
  value,
  setField,
}: {
  field: FormField
  value: unknown
  setField: SetField
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {(field.enum ?? []).map((opt) => (
        <ChipBtn key={opt} mono on={value === opt} onPress={() => setField(field.name, opt)}>
          {opt}
        </ChipBtn>
      ))}
    </View>
  )
}

/** String / number / integer field — a text input; numerics coerce on change, keeping raw text on NaN. */
function TextField({
  field,
  value,
  setField,
}: {
  field: FormField
  value: unknown
  setField: SetField
}) {
  const numeric = field.type === "number" || field.type === "integer"
  return (
    <Field
      mono
      keyboardType={numeric ? "numeric" : "default"}
      value={value !== undefined ? String(value) : ""}
      onChangeText={(text) => {
        if (!numeric) {
          setField(field.name, text)
          return
        }
        const num = Number(text)
        setField(field.name, text === "" ? "" : Number.isNaN(num) ? text : num)
      }}
    />
  )
}

/** Raw-JSON editor for non-flat schemas (D-02 fallback): label + hint + monospace textarea. */
function RawJsonField({
  rawJson,
  setRawJson,
  t,
}: {
  rawJson: string
  setRawJson: (v: string) => void
  t: Translate
}) {
  return (
    <View>
      <FieldLabel>{t("mca.status.form.rawJsonLabel")}</FieldLabel>
      <Field area mono minHeight={180} value={rawJson} onChangeText={setRawJson} />
      <FieldHelp>{t("mca.status.form.rawJsonHint")}</FieldHelp>
    </View>
  )
}

/** One generated flat field: label + the variant control for its type. */
function FlatField({
  field,
  value,
  setField,
}: {
  field: FormField
  value: unknown
  setField: SetField
}) {
  return (
    <View>
      <FieldLabel required={field.required}>{field.name}</FieldLabel>
      {field.type === "boolean" ? (
        <BooleanField field={field} value={value} setField={setField} />
      ) : field.enum ? (
        <EnumField field={field} value={value} setField={setField} />
      ) : (
        <TextField field={field} value={value} setField={setField} />
      )}
    </View>
  )
}

/** Compute the Submit gate + blocked-reason message from the current form state (D-03). */
function useSubmitGate(
  activeForm: ActiveForm,
  formValues: Record<string, unknown>,
  rawJson: string,
  t: Translate,
): { flat: boolean; fields: FormField[]; canSubmit: boolean; blockedMessage: string } {
  const { schema } = activeForm
  const flat = isFlatSchema(schema.inputSchema)
  const fields = flat ? buildFormFields(schema.inputSchema) : []

  let jsonParses = false
  if (!flat) {
    try {
      JSON.parse(rawJson)
      jsonParses = true
    } catch {
      jsonParses = false
    }
  }
  const requiredFilled = fields
    .filter((f) => f.required)
    .every((f) => {
      const v = formValues[f.name]
      return v !== undefined && v !== null && String(v).trim() !== ""
    })
  const rawRequiredFilled =
    !flat && jsonParses && rawJsonRequiredFilled(rawJson, schema.inputSchema)
  const canSubmit = flat ? requiredFilled : rawRequiredFilled
  // Distinguish the two raw-mode blockers: unparseable JSON vs. parseable-but-missing-required.
  const blockedMessage = flat
    ? t("mca.status.form.requiredError")
    : !jsonParses
      ? t("mca.status.form.invalidJson")
      : t("mca.status.form.requiredError")
  return { flat, fields, canSubmit, blockedMessage }
}

export function McaInputForm({
  activeForm,
  formValues,
  setFormValues,
  rawJson,
  setRawJson,
  onCancel,
  onSubmit,
  t,
}: {
  activeForm: ActiveForm
  formValues: Record<string, unknown>
  setFormValues: React.Dispatch<React.SetStateAction<Record<string, unknown>>>
  rawJson: string
  setRawJson: (v: string) => void
  onCancel: () => void
  onSubmit: () => void
  t: Translate
}) {
  const { tool } = activeForm
  const { flat, fields, canSubmit, blockedMessage } = useSubmitGate(
    activeForm,
    formValues,
    rawJson,
    t,
  )

  const setField: SetField = (name, value) => {
    setFormValues((prev) => ({ ...prev, [name]: value }))
  }

  return (
    <View style={{ gap: 16 }}>
      {/* Header */}
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <T step="xl" style={{ flex: 1 }}>
          {t("mca.status.form.title", { tool })}
        </T>
        <IconBtn icon="x" plain onPress={onCancel} />
      </View>

      {/* Body */}
      <ScrollView style={{ maxHeight: 360 }}>
        <View style={{ gap: 16 }}>
          {flat ? (
            fields.map((field) => (
              <FlatField
                key={field.name}
                field={field}
                value={formValues[field.name]}
                setField={setField}
              />
            ))
          ) : (
            <RawJsonField rawJson={rawJson} setRawJson={setRawJson} t={t} />
          )}
          {!canSubmit && (
            <T step="12" tone="danger">
              {blockedMessage}
            </T>
          )}
        </View>
      </ScrollView>

      {/* Footer: Cancel / Submit (D-15) */}
      <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
        <Btn variant="sec" full style={{ flex: 1 }} onPress={onCancel}>
          {t("mca.status.form.cancel")}
        </Btn>
        <Btn
          variant="primary"
          icon="play"
          full
          style={{ flex: 1 }}
          disabled={!canSubmit}
          onPress={onSubmit}
        >
          {t("mca.status.form.submit")}
        </Btn>
      </View>
    </View>
  )
}
