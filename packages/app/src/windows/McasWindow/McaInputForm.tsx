/**
 * Input-form body for the Retest Sheet (Task 2 / D-02/D-03). Renders one generated field per flat
 * primitive property, or a single raw-JSON textarea for non-flat schemas. Submit is gated on
 * required-only fields (flat) or JSON-parse + required-key success (raw). All chrome strings via
 * mca.status.form.*. Each field variant is its own small component so the render stays under the
 * cognitive-complexity limit (CLAUDE.md).
 */
import { X } from "@tamagui/lucide-icons"
import type React from "react"
import { Button, Input, ScrollView, Text, XStack, YStack } from "tamagui"
import {
  type ActiveForm,
  type FormField,
  STATUS_COLORS,
  buildFormFields,
  isFlatSchema,
  rawJsonRequiredFilled,
} from "./mcaHealth.utils"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semanticColors, controlsBar } from "../../components/mca/primitives/colors"

type Translate = (key: string, opts?: Record<string, unknown>) => string
type SetField = (name: string, value: unknown) => void

/** Boolean field — a true/false segmented toggle. */
function BooleanField({
  field,
  value,
  setField,
}: {
  field: FormField
  value: unknown
  setField: SetField
}) {
  const c = useColors()
  return (
    <XStack gap="$2">
      {[true, false].map((val) => {
        const selected = value === val
        return (
          <Button
            key={String(val)}
            size="$3"
            flex={1}
            backgroundColor={selected ? controlsBar.allow.bg : c.bgCardHover}
            borderWidth={1}
            borderColor={selected ? controlsBar.allow.border : c.borderStrong}
            onPress={() => setField(field.name, val)}
          >
            <Text color={selected ? semanticColors.green : c.text2}>{val ? "true" : "false"}</Text>
          </Button>
        )
      })}
    </XStack>
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
  const c = useColors()
  return (
    <XStack gap="$2" flexWrap="wrap">
      {(field.enum ?? []).map((opt) => {
        const selected = value === opt
        return (
          <Button
            key={opt}
            size="$3"
            backgroundColor={selected ? controlsBar.allow.bg : c.bgCardHover}
            borderWidth={1}
            borderColor={selected ? controlsBar.allow.border : c.borderStrong}
            onPress={() => setField(field.name, opt)}
          >
            <Text color={selected ? semanticColors.green : c.text2}>{opt}</Text>
          </Button>
        )
      })}
    </XStack>
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
  const c = useColors()
  const numeric = field.type === "number" || field.type === "integer"
  return (
    <Input
      size="$3"
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
      backgroundColor={c.bgInner}
      borderColor={c.borderStrong}
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
  const c = useColors()
  return (
    <YStack gap="$1.5">
      <Text fontSize="$2" color={c.text2}>
        {t("mca.status.form.rawJsonLabel")}
      </Text>
      <Text fontSize="$1" color={c.text3}>
        {t("mca.status.form.rawJsonHint")}
      </Text>
      <Input
        size="$3"
        multiline
        numberOfLines={8}
        value={rawJson}
        onChangeText={setRawJson}
        backgroundColor={c.bgInner}
        borderColor={c.borderStrong}
        fontFamily="$mono"
      />
    </YStack>
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
  const c = useColors()
  return (
    <YStack gap="$1.5">
      <Text fontSize="$2" color={c.text2}>
        {field.name}
        {field.required ? " *" : ""}
      </Text>
      {field.type === "boolean" ? (
        <BooleanField field={field} value={value} setField={setField} />
      ) : field.enum ? (
        <EnumField field={field} value={value} setField={setField} />
      ) : (
        <TextField field={field} value={value} setField={setField} />
      )}
    </YStack>
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
  const c = useColors()
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
    <YStack gap="$4">
      {/* Header */}
      <XStack justifyContent="space-between" alignItems="center">
        <Text fontSize="$5" fontWeight="600" color="$color">
          {t("mca.status.form.title", { tool })}
        </Text>
        <Button size="$2" circular backgroundColor="transparent" onPress={onCancel}>
          <X size={18} color={c.text2} />
        </Button>
      </XStack>

      {/* Body */}
      <ScrollView maxHeight={360}>
        <YStack gap="$3">
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
            <Text fontSize="$1" color={STATUS_COLORS.fail}>
              {blockedMessage}
            </Text>
          )}
        </YStack>
      </ScrollView>

      {/* Footer: Cancel / Submit (D-15) */}
      <XStack gap="$3" marginTop="$2">
        <Button
          flex={1}
          size="$4"
          onPress={onCancel}
          backgroundColor={c.bgCardHover}
          borderWidth={1}
          borderColor={c.borderStrong}
        >
          <Text color={c.text2}>{t("mca.status.form.cancel")}</Text>
        </Button>
        <Button
          flex={1}
          size="$4"
          disabled={!canSubmit}
          opacity={canSubmit ? 1 : 0.5}
          onPress={onSubmit}
          backgroundColor={controlsBar.allow.bg}
          borderWidth={1}
          borderColor={controlsBar.allow.border}
        >
          <Text color={semanticColors.green}>{t("mca.status.form.submit")}</Text>
        </Button>
      </XStack>
    </YStack>
  )
}
