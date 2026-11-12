/**
 * FormWidget — inline user form for the built-in `request-user-input` tool
 * (docs/specs/20260705_inline-user-forms.md).
 *
 * Renders the LLM-composed form spec (the tool call's `input`) while the tool
 * waits in `pending_user_input`, and a read-only summary of the answers (the
 * tool's `output`) once resolved. A free-text Notes field is ALWAYS appended
 * platform-side — the spec never contains it.
 *
 * Composed on the design-system primitives (ToolCallCard → HeaderRow +
 * ExpandedContainer) so it reads like every other tool card in the chat.
 * Three live layouts:
 *   - full (default): every field at once.
 *   - wizard (`spec.presentation === 'wizard'`, >1 field): one field per step
 *     with a progress badge in the card header; choice fields auto-advance on
 *     selection, and the final step is a REVIEW of every answer (rows jump
 *     back to their step) + Notes + Send.
 *   - question: a spec with a SINGLE select/radio field renders as a compact
 *     multiple-choice question (the field label becomes the card header) —
 *     the building block of agent-driven question-by-question flows. Options
 *     only select; submission is always explicit via the Send button.
 *
 * Mounted by ToolCallBlock via a toolName branch (the tool is a built-in with
 * no mcaId, so McaRegistry matching does not apply). Submit/dismiss go through
 * `client.respondToForm`; on `accepted: false` the form stays pending and the
 * server-side validation errors render inline. The widget flips when the
 * authoritative `tool_status_update` chunk lands — no optimistic store write
 * needed (the backend response path is idempotent).
 */

import { FormSpecSchema, validateFormValues, type FormField, type FormSpec } from "@teros/shared"
import { useMemo, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, TextInput } from "react-native"
import { XStack, YStack } from "tamagui"
import { T } from "../ui/ds/Text"
import { getTerosClient } from "../../services/terosClientSingleton"
import type { ToolCall } from "../chat/bubbles/types"
import { Badge } from "./primitives/Badge"
import { FONT_SANS } from "./primitives/fonts"
import { Check } from "./primitives/icons"
import { PillBtn } from "./primitives/Pill"
import { ToolCallCard } from "./primitives/ToolCallCard"
import { useColors } from "./primitives/useColors"

// User-facing copy lives in the app i18n (formWidget.* in src/i18n/locales) —
// unlike the MCA renderer primitives (MCA_STRINGS, en-US only), this widget is
// end-user chat UI and must follow the interface language.

/** Raw field state: strings for everything text-shaped, booleans for checkbox. */
export type RawValues = Record<string, string | boolean>

function initialValues(spec: FormSpec): RawValues {
  const values: RawValues = {}
  for (const field of spec.fields) {
    if (field.type === "checkbox") {
      values[field.id] = field.defaultValue ?? false
    } else if (field.defaultValue !== undefined) {
      values[field.id] = String(field.defaultValue)
    } else {
      values[field.id] = ""
    }
  }
  return values
}

/** Coerce raw input state to the typed values the backend validates. Empty
 * optional fields are omitted (required-ness is enforced server-side too).
 * Also used by the To Do window's form output (TODOAP-REQ-16). */
export function coerceValues(spec: Pick<FormSpec, "fields">, raw: RawValues): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const field of spec.fields) {
    const value = raw[field.id]
    if (field.type === "checkbox") {
      out[field.id] = value === true
      continue
    }
    const text = typeof value === "string" ? value.trim() : ""
    if (text === "") continue
    out[field.id] = field.type === "number" ? Number(text) : text
  }
  return out
}

const DATE_PLACEHOLDERS: Partial<Record<FormField["type"], string>> = {
  date: "YYYY-MM-DD",
  time: "HH:MM",
  datetime: "YYYY-MM-DD HH:MM",
}

/** A one-choice-field spec renders as a compact multiple-choice question. */
function isSingleQuestion(spec: FormSpec): boolean {
  return (
    spec.fields.length === 1 &&
    (spec.fields[0].type === "select" || spec.fields[0].type === "radio")
  )
}

export function FormWidget({ tool }: { tool: ToolCall }) {
  const { t } = useTranslation()
  const parsed = useMemo(() => FormSpecSchema.safeParse(tool.input), [tool.input])

  if (!parsed.success) {
    // Spec no longer parses (shared-schema drift, corrupted persist). The
    // backend validated it before rendering, so this is exceptional.
    return <FormCard status="failed" description={t("formWidget.invalidSpec")} />
  }
  const spec = parsed.data
  const headerTitle =
    spec.title || (isSingleQuestion(spec) ? spec.fields[0].label : t("formWidget.title"))

  if (tool.status === "completed") {
    // Non-blocking: the tool completes immediately with a
    // {status:'form_displayed', formRequestId} marker — the turn ended and
    // the form is live, waiting for the user's answer (submit/dismiss arrives
    // later via app.form-response). Render the live form from the marker's
    // formRequestId instead of the resolved summary.
    const marker = parseFormOutput(tool.output)
    const markerFormRequestId =
      typeof marker?.formRequestId === "string" ? marker.formRequestId : null
    if (marker && marker.status === "form_displayed" && markerFormRequestId) {
      return (
        <LiveForm spec={spec} headerTitle={headerTitle} formRequestId={markerFormRequestId} />
      )
    }
    return <ResolvedForm spec={spec} headerTitle={headerTitle} output={tool.output} />
  }
  if (tool.status === "failed") {
    return <FormCard status="failed" description={headerTitle} />
  }
  // pending (about to flip) / running (just submitted, result in flight).
  return <FormCard status="running" description={headerTitle} />
}

/** Thin wrapper: every state of the widget is a standard tool card.
 *
 * `key={status}` remounts the card on status transitions: the widget first
 * mounts as 'running' (header only), and ToolCallCard's expansion is a
 * useState initialized from `defaultExpanded` at MOUNT time — without the
 * remount, the live form would inherit the collapsed state of that first
 * render and appear folded. */
function FormCard({
  status,
  description,
  badge,
  defaultExpanded,
  children,
}: {
  status: "pending_user_input" | "running" | "completed" | "failed"
  description: string
  badge?: ReactNode
  defaultExpanded?: boolean
  children?: ReactNode
}) {
  return (
    <ToolCallCard
      key={status}
      status={status}
      description={description}
      badge={badge}
      defaultExpanded={defaultExpanded}
    >
      {children}
    </ToolCallCard>
  )
}

// ---------------------------------------------------------------------------
// Live form (full / wizard / single-question)
// ---------------------------------------------------------------------------

function LiveForm({
  spec,
  headerTitle,
  formRequestId,
}: {
  spec: FormSpec
  headerTitle: string
  formRequestId: string
}) {
  const { t } = useTranslation()
  const c = useColors()
  const [raw, setRaw] = useState<RawValues>(() => initialValues(spec))
  const [notes, setNotes] = useState("")
  const [errors, setErrors] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [step, setStep] = useState(0)

  const singleQuestion = isSingleQuestion(spec)
  const wizard = spec.presentation === "wizard" && spec.fields.length > 1 && !singleQuestion
  // Wizard steps: one per field + a final review step (verify before sending).
  const reviewStep = spec.fields.length
  const totalSteps = reviewStep + 1
  const onReviewStep = wizard && step === reviewStep

  const setField = (id: string, value: string | boolean) =>
    setRaw((prev) => ({ ...prev, [id]: value }))

  /** Wizard-only: required check for the current step before advancing. */
  const stepBlocked = (field: FormField): string | null => {
    if (!field.required) return null
    const value = raw[field.id]
    const empty =
      field.type === "checkbox" ? false : (typeof value === "string" ? value.trim() : "") === ""
    return empty ? `'${field.id}' is required` : null
  }

  const handleNext = () => {
    const blocked = stepBlocked(spec.fields[step])
    if (blocked) {
      setErrors([blocked])
      return
    }
    setErrors([])
    setStep((s) => Math.min(s + 1, reviewStep))
  }

  const handleSubmit = async () => {
    if (submitting) return
    const values = coerceValues(spec, raw)
    // Same validator the backend runs — catches everything except races.
    const local = validateFormValues(spec, values)
    if (!local.ok) {
      setErrors(local.errors)
      return
    }
    setErrors([])
    setSubmitting(true)
    try {
      const result = await getTerosClient().respondToForm(formRequestId, {
        values,
        notes: notes.trim() || undefined,
      })
      if (!result.accepted && result.errors?.length) {
        setErrors(result.errors)
        setSubmitting(false)
      }
      // On accepted the tool_status_update chunk flips the widget; keep the
      // disabled "Sending…" state until it lands.
    } catch (err) {
      console.error("[FormWidget] submit failed:", err)
      setErrors([String((err as Error)?.message ?? err)])
      setSubmitting(false)
    }
  }

  const handleDismiss = async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      await getTerosClient().respondToForm(formRequestId, { dismissed: true })
    } catch (err) {
      console.error("[FormWidget] dismiss failed:", err)
      setSubmitting(false)
    }
  }

  /** Wizard: selecting an option on a choice field advances automatically —
   * the review step is the safety net before anything is sent. Deselecting
   * (tapping the active chip) stays on the step. */
  const handleFieldChange = (field: FormField, value: string | boolean) => {
    setField(field.id, value)
    if (
      wizard &&
      !onReviewStep &&
      (field.type === "select" || field.type === "radio") &&
      typeof value === "string" &&
      value !== ""
    ) {
      setErrors([])
      setStep((s) => Math.min(s + 1, reviewStep))
    }
  }

  const visibleFields = onReviewStep ? [] : wizard ? [spec.fields[step]] : spec.fields
  const showFinalControls = !wizard || onReviewStep

  const progressBadge = wizard ? (
    <Badge
      text={t("formWidget.progress", {
        current: Math.min(step, reviewStep) + 1,
        total: totalSteps,
      })}
      variant="gray"
    />
  ) : undefined

  return (
    <FormCard
      status="pending_user_input"
      description={headerTitle}
      badge={progressBadge}
      defaultExpanded
    >
      <YStack gap={14} paddingTop={4}>
        {spec.description && (!wizard || step === 0) ? (
          <T step="sm" tone="text2">
            {spec.description}
          </T>
        ) : null}

        {visibleFields.map((field) => (
          <FieldControl
            key={field.id}
            field={field}
            value={raw[field.id]}
            disabled={submitting}
            // The header already shows the question for the single-question
            // variant — repeating the label right above the chips reads twice.
            hideLabel={singleQuestion && !spec.title}
            onChange={(value) => handleFieldChange(field, value)}
          />
        ))}

        {onReviewStep && (
          <YStack gap={6}>
            <T step="codenote" tone="text3">
              {t("formWidget.review")}
            </T>
            {spec.fields.map((field, index) => {
              const value = raw[field.id]
              const display =
                field.type === "checkbox"
                  ? value === true
                    ? t("formWidget.yes")
                    : t("formWidget.no")
                  : typeof value === "string" && value.trim() !== ""
                    ? displayValue(field, value)
                    : t("formWidget.reviewEmpty")
              return (
                // Tapping a row jumps back to that step to edit it.
                <Pressable
                  key={field.id}
                  onPress={() => !submitting && setStep(index)}
                  style={Platform.OS === "web" ? ({ cursor: "pointer" } as any) : undefined}
                >
                  <XStack gap={12} alignItems="flex-start">
                    <T
                      step="code"
                      tone="text3"
                      numberOfLines={1}
                      style={{ width: 110, flexShrink: 0, fontSize: 11, lineHeight: 18 }}
                    >
                      {field.label}
                    </T>
                    <T step="sm" tone="text2" style={{ flex: 1, minWidth: 0, lineHeight: 18 }}>
                      {display}
                    </T>
                  </XStack>
                </Pressable>
              )
            })}
          </YStack>
        )}

        {/* Always-on platform Notes field — on wizard flows it belongs to the
            review step, next to Send. */}
        {showFinalControls && (
          <YStack gap={4}>
            <FieldLabel label={t("formWidget.notesLabel")} />
            <TextInput
              value={notes}
              onChangeText={setNotes}
              editable={!submitting}
              placeholder={t("formWidget.notesPlaceholder")}
              placeholderTextColor={c.text3}
              multiline
              numberOfLines={2}
              style={inputStyle(c, { multiline: true })}
            />
          </YStack>
        )}

        {errors.length > 0 && (
          <YStack gap={2}>
            <T step="12" color={c.tint.r.tx}>
              {t("formWidget.validationIntro")}
            </T>
            {errors.map((error) => (
              <T key={error} step="12" color={c.tint.r.tx}>
                · {error}
              </T>
            ))}
          </YStack>
        )}

        {/* `.iform .ff` — the footer row above a hairline. */}
        <XStack
          alignItems="center"
          justifyContent="space-between"
          gap={8}
          flexWrap="wrap"
          paddingTop={12}
          borderTopWidth={1}
          borderTopColor={c.border}
        >
          <PillBtn
            variant="ghost"
            label={t("formWidget.dismiss")}
            disabled={submitting}
            onPress={handleDismiss}
          />
          <XStack gap={6} alignItems="center">
            {wizard && step > 0 && (
              <ActionButton
                label={t("formWidget.back")}
                variant="secondary"
                disabled={submitting}
                onPress={() => {
                  setErrors([])
                  setStep((s) => Math.max(0, s - 1))
                }}
              />
            )}
            {wizard && !onReviewStep ? (
              <ActionButton
                label={t("formWidget.next")}
                variant="primary"
                disabled={submitting}
                onPress={handleNext}
              />
            ) : (
              <ActionButton
                label={
                  submitting
                    ? t("formWidget.submitting")
                    : spec.submitLabel || t("formWidget.submit")
                }
                variant="primary"
                disabled={submitting}
                onPress={handleSubmit}
              />
            )}
          </XStack>
        </XStack>
      </YStack>
    </FormCard>
  )
}

/** Same visual family as the ControlsBar pills — violet primary for the
 * form's main action ("waiting on the human" hue), outlined secondary. */
function ActionButton({
  label,
  variant,
  disabled,
  onPress,
}: {
  label: string
  variant: "primary" | "secondary"
  disabled?: boolean
  onPress: () => void
}) {
  return (
    <PillBtn
      variant={variant === "primary" ? "primary" : "sec"}
      label={label}
      disabled={disabled}
      onPress={onPress}
    />
  )
}

// ---------------------------------------------------------------------------
// Field controls
// ---------------------------------------------------------------------------

/** One form field as its input; also renders the To Do form output (TODOAP-REQ-16). */
export function FieldControl({
  field,
  value,
  disabled,
  hideLabel,
  onChange,
}: {
  field: FormField
  value: string | boolean | undefined
  disabled: boolean
  hideLabel?: boolean
  onChange: (value: string | boolean) => void
}) {
  const c = useColors()

  if (field.type === "checkbox") {
    const checked = value === true
    return (
      <Pressable
        onPress={() => !disabled && onChange(!checked)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
      >
        <XStack alignItems="center" gap={10}>
          <YStack
            width={18}
            height={18}
            borderRadius={5}
            borderWidth={1}
            borderColor={checked ? c.accent : c.borderStrong}
            backgroundColor={checked ? c.accent : c.field}
            alignItems="center"
            justifyContent="center"
          >
            {checked && <Check size={12} color="#FFFFFF" />}
          </YStack>
          <FieldLabel label={field.label} required={field.required} />
        </XStack>
        {field.description ? (
          <T step="12" tone="text3" style={{ marginLeft: 28 }}>
            {field.description}
          </T>
        ) : null}
      </Pressable>
    )
  }

  if (field.type === "select" || field.type === "radio") {
    const selected = typeof value === "string" ? value : ""
    return (
      <YStack gap={6}>
        {!hideLabel && (
          <FieldLabel
            label={field.label}
            required={field.required}
            description={field.description}
          />
        )}
        {hideLabel && field.description ? (
          <T step="12" tone="text3">
            {field.description}
          </T>
        ) : null}
        {/* `.iform .chips` — 28px filter chips; the chosen one sits on the
            nav-active wash with the accent glyph. */}
        <XStack flexWrap="wrap" gap={6}>
          {field.options.map((option) => {
            const isSelected = selected === option.value
            return (
              <Pressable
                key={option.value}
                onPress={() => !disabled && onChange(isSelected ? "" : option.value)}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
                style={Platform.OS === "web" ? ({ cursor: "pointer" } as any) : undefined}
              >
                <XStack
                  height={28}
                  paddingHorizontal={12}
                  borderRadius={100}
                  backgroundColor={isSelected ? c.navActive : c.wash}
                  alignItems="center"
                  gap={6}
                >
                  {isSelected && <Check size={12} color={c.accent} />}
                  <T step="12" color={isSelected ? c.accent : c.text2} numberOfLines={1}>
                    {option.label}
                  </T>
                </XStack>
              </Pressable>
            )
          })}
        </XStack>
      </YStack>
    )
  }

  // text / textarea / number / date / time / datetime → text input variants.
  const isTextarea = field.type === "textarea"
  return (
    <YStack gap={4}>
      {!hideLabel && (
        <FieldLabel label={field.label} required={field.required} description={field.description} />
      )}
      <TextInput
        value={typeof value === "string" ? value : ""}
        onChangeText={(text) => onChange(text)}
        editable={!disabled}
        placeholder={field.placeholder || DATE_PLACEHOLDERS[field.type] || ""}
        placeholderTextColor={c.text3}
        keyboardType={field.type === "number" ? "numeric" : "default"}
        multiline={isTextarea}
        numberOfLines={isTextarea ? 3 : 1}
        style={inputStyle(c, { multiline: isTextarea })}
      />
    </YStack>
  )
}

function FieldLabel({
  label,
  required,
  description,
}: {
  label: string
  required?: boolean
  description?: string
}) {
  const { t } = useTranslation()
  return (
    <YStack gap={2}>
      {/* `.iform .fl > .lb` — sans 12 text2; `.req` in the accent. */}
      <XStack gap={5} alignItems="baseline">
        <T step="12" tone="text2">
          {label}
        </T>
        {required && (
          <T step="xxs" tone="accent">
            {t("formWidget.required")}
          </T>
        )}
      </XStack>
      {description ? (
        <T step="12" tone="text3">
          {description}
        </T>
      ) : null}
    </YStack>
  )
}

function inputStyle(
  c: ReturnType<typeof useColors>,
  opts: { multiline?: boolean } = {},
): Record<string, unknown> {
  // The prototype's `.field`: 36px, radius 10, `field` fill, hairline border.
  return {
    paddingHorizontal: 12,
    backgroundColor: c.field,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    color: c.text,
    fontSize: 13,
    fontFamily: FONT_SANS,
    fontWeight: "400",
    ...(Platform.OS === "web" ? { outlineColor: c.accent } : {}),
    ...(opts.multiline
      ? { paddingVertical: 9, minHeight: 72, textAlignVertical: "top" as const }
      : { height: 36, paddingVertical: 0 }),
  }
}

/** Option values display as their labels; everything else as-is. */
function displayValue(field: FormField, value: unknown): string {
  if (field.type === "select" || field.type === "radio") {
    const option = field.options.find((o) => o.value === value)
    if (option) return option.label
  }
  return String(value)
}

/** Parse a tool output JSON payload, null on absent/corrupt. Shared by the
 * v2 form_displayed marker check and the resolved summary. */
function parseFormOutput(output?: string): Record<string, unknown> | null {
  try {
    return output ? (JSON.parse(output) as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Resolved state
// ---------------------------------------------------------------------------

function ResolvedForm({
  spec,
  headerTitle,
  output,
}: {
  spec: FormSpec
  headerTitle: string
  output?: string
}) {
  const { t } = useTranslation()
  const result = useMemo(() => {
    try {
      return output ? JSON.parse(output) : null
    } catch {
      return null
    }
  }, [output])

  // Headless bypass result — the agent collected the answers conversationally;
  // rendering the internal fallback would just be noise in the transcript.
  if (result && result.available === false) return null

  if (!result || result.submitted !== true) {
    return <FormCard status="completed" description={t("formWidget.dismissedTitle")} />
  }

  const values: Record<string, unknown> = result.values ?? {}
  return (
    // Expanded by default: the read-back of what was submitted is the user's
    // trust signal; the chevron still collapses it.
    <FormCard status="completed" description={headerTitle} defaultExpanded>
      {/* `.iform.sent .kvl` — the read-back as a key/value list. */}
      <YStack gap={6} paddingTop={2}>
        {spec.fields
          .filter((field) => values[field.id] !== undefined)
          .map((field) => (
            <XStack key={field.id} gap={12} alignItems="flex-start">
              <T
                step="code"
                tone="text3"
                numberOfLines={1}
                style={{ width: 110, flexShrink: 0, fontSize: 11, lineHeight: 18 }}
              >
                {field.label}
              </T>
              <T step="sm" tone="text2" style={{ flex: 1, minWidth: 0, lineHeight: 18 }}>
                {field.type === "checkbox"
                  ? values[field.id] === true
                    ? t("formWidget.yes")
                    : t("formWidget.no")
                  : displayValue(field, values[field.id])}
              </T>
            </XStack>
          ))}
        {result.notes ? (
          <XStack gap={12} alignItems="flex-start">
            <T
              step="code"
              tone="text3"
              numberOfLines={1}
              style={{ width: 110, flexShrink: 0, fontSize: 11, lineHeight: 18 }}
            >
              {t("formWidget.notesLabel")}
            </T>
            <T step="sm" tone="text2" style={{ flex: 1, minWidth: 0, lineHeight: 18 }}>
              {String(result.notes)}
            </T>
          </XStack>
        ) : null}
      </YStack>
    </FormCard>
  )
}
