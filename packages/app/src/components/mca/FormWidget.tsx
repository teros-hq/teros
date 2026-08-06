/**
 * FormWidget — inline user form for the built-in `request-user-input` tool
 *.
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

import { FormSpecSchema, validateFormValues, type FormField, type FormSpec } from '@teros/shared';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, TextInput, TouchableOpacity } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../services/terosClientSingleton';
import type { ToolCall } from '../chat/bubbles/types';
import { Badge } from './primitives/Badge';
import { colors, controlsBar as controlsBarTokens } from './primitives/colors';
import { Check } from './primitives/icons';
import { ToolCallCard } from './primitives/ToolCallCard';
import { useColors } from './primitives/useColors';

// User-facing copy lives in the app i18n (formWidget.* in src/i18n/locales) —
// unlike the MCA renderer primitives (MCA_STRINGS, en-US only), this widget is
// end-user chat UI and must follow the interface language.

/** Raw field state: strings for everything text-shaped, booleans for checkbox. */
type RawValues = Record<string, string | boolean>;

function initialValues(spec: FormSpec): RawValues {
  const values: RawValues = {};
  for (const field of spec.fields) {
    if (field.type === 'checkbox') {
      values[field.id] = field.defaultValue ?? false;
    } else if (field.defaultValue !== undefined) {
      values[field.id] = String(field.defaultValue);
    } else {
      values[field.id] = '';
    }
  }
  return values;
}

/** Coerce raw input state to the typed values the backend validates. Empty
 * optional fields are omitted (required-ness is enforced server-side too). */
function coerceValues(spec: FormSpec, raw: RawValues): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const field of spec.fields) {
    const value = raw[field.id];
    if (field.type === 'checkbox') {
      out[field.id] = value === true;
      continue;
    }
    const text = typeof value === 'string' ? value.trim() : '';
    if (text === '') continue;
    out[field.id] = field.type === 'number' ? Number(text) : text;
  }
  return out;
}

const DATE_PLACEHOLDERS: Partial<Record<FormField['type'], string>> = {
  date: 'YYYY-MM-DD',
  time: 'HH:MM',
  datetime: 'YYYY-MM-DD HH:MM',
};

/** A one-choice-field spec renders as a compact multiple-choice question. */
function isSingleQuestion(spec: FormSpec): boolean {
  return spec.fields.length === 1 && (spec.fields[0].type === 'select' || spec.fields[0].type === 'radio');
}

export function FormWidget({ tool }: { tool: ToolCall }) {
  const { t } = useTranslation();
  const parsed = useMemo(() => FormSpecSchema.safeParse(tool.input), [tool.input]);

  if (!parsed.success) {
    // Spec no longer parses (shared-schema drift, corrupted persist). The
    // backend validated it before rendering, so this is exceptional.
    return <FormCard status="failed" description={t('formWidget.invalidSpec')} />;
  }
  const spec = parsed.data;
  const headerTitle =
    spec.title || (isSingleQuestion(spec) ? spec.fields[0].label : t('formWidget.title'));

  if (tool.status === 'pending_user_input' && tool.formRequestId) {
    return <LiveForm spec={spec} headerTitle={headerTitle} formRequestId={tool.formRequestId} />;
  }
  if (tool.status === 'completed') {
    return <ResolvedForm spec={spec} headerTitle={headerTitle} output={tool.output} />;
  }
  if (tool.status === 'failed') {
    return <FormCard status="failed" description={headerTitle} />;
  }
  // pending (about to flip) / running (just submitted, result in flight).
  return <FormCard status="running" description={headerTitle} />;
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
  status: 'pending_user_input' | 'running' | 'completed' | 'failed';
  description: string;
  badge?: ReactNode;
  defaultExpanded?: boolean;
  children?: ReactNode;
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
  );
}

// ---------------------------------------------------------------------------
// Live form (full / wizard / single-question)
// ---------------------------------------------------------------------------

function LiveForm({
  spec,
  headerTitle,
  formRequestId,
}: {
  spec: FormSpec;
  headerTitle: string;
  formRequestId: string;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const [raw, setRaw] = useState<RawValues>(() => initialValues(spec));
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState(0);

  const singleQuestion = isSingleQuestion(spec);
  const wizard = spec.presentation === 'wizard' && spec.fields.length > 1 && !singleQuestion;
  // Wizard steps: one per field + a final review step (verify before sending).
  const reviewStep = spec.fields.length;
  const totalSteps = reviewStep + 1;
  const onReviewStep = wizard && step === reviewStep;

  const setField = (id: string, value: string | boolean) =>
    setRaw((prev) => ({ ...prev, [id]: value }));

  /** Wizard-only: required check for the current step before advancing. */
  const stepBlocked = (field: FormField): string | null => {
    if (!field.required) return null;
    const value = raw[field.id];
    const empty = field.type === 'checkbox' ? false : (typeof value === 'string' ? value.trim() : '') === '';
    return empty ? `'${field.id}' is required` : null;
  };

  const handleNext = () => {
    const blocked = stepBlocked(spec.fields[step]);
    if (blocked) {
      setErrors([blocked]);
      return;
    }
    setErrors([]);
    setStep((s) => Math.min(s + 1, reviewStep));
  };

  const handleSubmit = async () => {
    if (submitting) return;
    const values = coerceValues(spec, raw);
    // Same validator the backend runs — catches everything except races.
    const local = validateFormValues(spec, values);
    if (!local.ok) {
      setErrors(local.errors);
      return;
    }
    setErrors([]);
    setSubmitting(true);
    try {
      const result = await getTerosClient().respondToForm(formRequestId, {
        values,
        notes: notes.trim() || undefined,
      });
      if (!result.accepted && result.errors?.length) {
        setErrors(result.errors);
        setSubmitting(false);
      }
      // On accepted the tool_status_update chunk flips the widget; keep the
      // disabled "Sending…" state until it lands.
    } catch (err) {
      console.error('[FormWidget] submit failed:', err);
      setErrors([String((err as Error)?.message ?? err)]);
      setSubmitting(false);
    }
  };

  const handleDismiss = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await getTerosClient().respondToForm(formRequestId, { dismissed: true });
    } catch (err) {
      console.error('[FormWidget] dismiss failed:', err);
      setSubmitting(false);
    }
  };

  /** Wizard: selecting an option on a choice field advances automatically —
   * the review step is the safety net before anything is sent. Deselecting
   * (tapping the active chip) stays on the step. */
  const handleFieldChange = (field: FormField, value: string | boolean) => {
    setField(field.id, value);
    if (
      wizard &&
      !onReviewStep &&
      (field.type === 'select' || field.type === 'radio') &&
      typeof value === 'string' &&
      value !== ''
    ) {
      setErrors([]);
      setStep((s) => Math.min(s + 1, reviewStep));
    }
  };

  const visibleFields = onReviewStep ? [] : wizard ? [spec.fields[step]] : spec.fields;
  const showFinalControls = !wizard || onReviewStep;

  const progressBadge = wizard ? (
    <Badge
      text={t('formWidget.progress', { current: Math.min(step, reviewStep) + 1, total: totalSteps })}
      variant="gray"
    />
  ) : undefined;

  return (
    <FormCard
      status="pending_user_input"
      description={headerTitle}
      badge={progressBadge}
      defaultExpanded
    >
      <YStack gap={10} paddingTop={2}>
        {spec.description && (!wizard || step === 0) ? (
          <Text fontSize={11} color={c.text2}>
            {spec.description}
          </Text>
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
            <Text fontSize={11} fontWeight="600" color={c.text}>
              {t('formWidget.review')}
            </Text>
            {spec.fields.map((field, index) => {
              const value = raw[field.id];
              const display =
                field.type === 'checkbox'
                  ? value === true
                    ? t('formWidget.yes')
                    : t('formWidget.no')
                  : typeof value === 'string' && value.trim() !== ''
                    ? displayValue(field, value)
                    : t('formWidget.reviewEmpty');
              return (
                // Tapping a row jumps back to that step to edit it.
                <Pressable key={field.id} onPress={() => !submitting && setStep(index)}>
                  <XStack gap={8} alignItems="baseline">
                    <Text fontSize={11} color={c.text3} minWidth={110}>
                      {field.label}
                    </Text>
                    <Text fontSize={11} color={c.text2} flex={1}>
                      {display}
                    </Text>
                  </XStack>
                </Pressable>
              );
            })}
          </YStack>
        )}

        {/* Always-on platform Notes field — on wizard flows it belongs to the
            review step, next to Send. */}
        {showFinalControls && (
          <YStack gap={4}>
            <FieldLabel label={t('formWidget.notesLabel')} />
            <TextInput
              value={notes}
              onChangeText={setNotes}
              editable={!submitting}
              placeholder={t('formWidget.notesPlaceholder')}
              placeholderTextColor={c.text3}
              multiline
              numberOfLines={2}
              style={inputStyle(c, { multiline: true })}
            />
          </YStack>
        )}

        {errors.length > 0 && (
          <YStack gap={2}>
            <Text fontSize={11} fontWeight="600" color={colors.red}>
              {t('formWidget.validationIntro')}
            </Text>
            {errors.map((error) => (
              <Text key={error} fontSize={11} color={colors.red}>
                · {error}
              </Text>
            ))}
          </YStack>
        )}

        <XStack alignItems="center" justifyContent="space-between" gap={8}>
          <TouchableOpacity onPress={handleDismiss} disabled={submitting} activeOpacity={0.7}>
            <Text fontSize={10} color={c.text3} textDecorationLine="underline">
              {t('formWidget.dismiss')}
            </Text>
          </TouchableOpacity>
          <XStack gap={6} alignItems="center">
            {wizard && step > 0 && (
              <ActionButton
                label={t('formWidget.back')}
                variant="secondary"
                disabled={submitting}
                onPress={() => {
                  setErrors([]);
                  setStep((s) => Math.max(0, s - 1));
                }}
              />
            )}
            {wizard && !onReviewStep ? (
              <ActionButton
                label={t('formWidget.next')}
                variant="primary"
                disabled={submitting}
                onPress={handleNext}
              />
            ) : (
              <ActionButton
                label={
                  submitting
                    ? t('formWidget.submitting')
                    : spec.submitLabel || t('formWidget.submit')
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
  );
}

/** Same visual family as the ControlsBar Allow/Deny buttons — tinted pill,
 * violet for the form's primary action ("waiting on the human" hue). */
function ActionButton({
  label,
  variant,
  disabled,
  onPress,
}: {
  label: string;
  variant: 'primary' | 'secondary';
  disabled?: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  const primary = variant === 'primary';
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{
        paddingVertical: 4,
        paddingHorizontal: 12,
        borderRadius: 5,
        opacity: disabled ? 0.6 : 1,
        backgroundColor: primary ? 'rgba(139,92,246,0.15)' : 'transparent',
        borderWidth: 1,
        borderColor: primary ? 'rgba(139,92,246,0.20)' : c.borderStrong,
      }}
    >
      <Text
        fontSize={10}
        fontWeight="500"
        color={primary ? controlsBarTokens.permission.fg : c.text2}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// Field controls
// ---------------------------------------------------------------------------

function FieldControl({
  field,
  value,
  disabled,
  hideLabel,
  onChange,
}: {
  field: FormField;
  value: string | boolean | undefined;
  disabled: boolean;
  hideLabel?: boolean;
  onChange: (value: string | boolean) => void;
}) {
  const c = useColors();

  if (field.type === 'checkbox') {
    const checked = value === true;
    return (
      <Pressable
        onPress={() => !disabled && onChange(!checked)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
      >
        <XStack alignItems="center" gap={8}>
          <YStack
            width={16}
            height={16}
            borderRadius={4}
            borderWidth={1}
            borderColor={checked ? colors.violet : c.borderStrong}
            backgroundColor={checked ? colors.violet : 'transparent'}
            alignItems="center"
            justifyContent="center"
          >
            {checked && <Check size={11} color="#FFFFFF" />}
          </YStack>
          <FieldLabel label={field.label} required={field.required} />
        </XStack>
        {field.description ? (
          <Text fontSize={10} color={c.text3} marginLeft={24}>
            {field.description}
          </Text>
        ) : null}
      </Pressable>
    );
  }

  if (field.type === 'select' || field.type === 'radio') {
    const selected = typeof value === 'string' ? value : '';
    return (
      <YStack gap={6}>
        {!hideLabel && (
          <FieldLabel label={field.label} required={field.required} description={field.description} />
        )}
        {hideLabel && field.description ? (
          <Text fontSize={10} color={c.text3}>
            {field.description}
          </Text>
        ) : null}
        <XStack flexWrap="wrap" gap={6}>
          {field.options.map((option) => {
            const isSelected = selected === option.value;
            return (
              <Pressable
                key={option.value}
                onPress={() => !disabled && onChange(isSelected ? '' : option.value)}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
              >
                <XStack
                  paddingVertical={5}
                  paddingHorizontal={10}
                  borderRadius={5}
                  borderWidth={1}
                  borderColor={isSelected ? 'rgba(139,92,246,0.35)' : c.borderStrong}
                  backgroundColor={isSelected ? 'rgba(139,92,246,0.15)' : c.bgInner}
                  alignItems="center"
                  gap={4}
                >
                  {isSelected && <Check size={10} color={controlsBarTokens.permission.fg} />}
                  <Text fontSize={11} color={isSelected ? c.text : c.text2}>
                    {option.label}
                  </Text>
                </XStack>
              </Pressable>
            );
          })}
        </XStack>
      </YStack>
    );
  }

  // text / textarea / number / date / time / datetime → text input variants.
  const isTextarea = field.type === 'textarea';
  return (
    <YStack gap={4}>
      {!hideLabel && (
        <FieldLabel label={field.label} required={field.required} description={field.description} />
      )}
      <TextInput
        value={typeof value === 'string' ? value : ''}
        onChangeText={(text) => onChange(text)}
        editable={!disabled}
        placeholder={field.placeholder || DATE_PLACEHOLDERS[field.type] || ''}
        placeholderTextColor={c.text3}
        keyboardType={field.type === 'number' ? 'numeric' : 'default'}
        multiline={isTextarea}
        numberOfLines={isTextarea ? 3 : 1}
        style={inputStyle(c, { multiline: isTextarea })}
      />
    </YStack>
  );
}

function FieldLabel({
  label,
  required,
  description,
}: {
  label: string;
  required?: boolean;
  description?: string;
}) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <YStack gap={1}>
      <XStack gap={4} alignItems="baseline">
        <Text fontSize={11} fontWeight="500" color={c.text}>
          {label}
        </Text>
        {required && (
          <Text fontSize={9} color={c.text3}>
            ({t('formWidget.required')})
          </Text>
        )}
      </XStack>
      {description ? (
        <Text fontSize={10} color={c.text3}>
          {description}
        </Text>
      ) : null}
    </YStack>
  );
}

function inputStyle(
  c: ReturnType<typeof useColors>,
  opts: { multiline?: boolean } = {},
): Record<string, unknown> {
  return {
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: c.bgInner,
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: 5,
    color: c.text,
    fontSize: 12,
    ...(opts.multiline ? { minHeight: 56, textAlignVertical: 'top' as const } : {}),
  };
}

/** Option values display as their labels; everything else as-is. */
function displayValue(field: FormField, value: unknown): string {
  if (field.type === 'select' || field.type === 'radio') {
    const option = field.options.find((o) => o.value === value);
    if (option) return option.label;
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Resolved state
// ---------------------------------------------------------------------------

function ResolvedForm({
  spec,
  headerTitle,
  output,
}: {
  spec: FormSpec;
  headerTitle: string;
  output?: string;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const result = useMemo(() => {
    try {
      return output ? JSON.parse(output) : null;
    } catch {
      return null;
    }
  }, [output]);

  // Headless bypass result — the agent collected the answers conversationally;
  // rendering the internal fallback would just be noise in the transcript.
  if (result && result.available === false) return null;

  if (!result || result.submitted !== true) {
    return <FormCard status="completed" description={t('formWidget.dismissedTitle')} />;
  }

  const values: Record<string, unknown> = result.values ?? {};
  return (
    // Expanded by default: the read-back of what was submitted is the user's
    // trust signal; the chevron still collapses it.
    <FormCard status="completed" description={headerTitle} defaultExpanded>
      <YStack gap={6} paddingTop={2}>
        {spec.fields
          .filter((field) => values[field.id] !== undefined)
          .map((field) => (
            <XStack key={field.id} gap={8}>
              <Text fontSize={11} color={c.text3} minWidth={110}>
                {field.label}
              </Text>
              <Text fontSize={11} color={c.text2} flex={1}>
                {field.type === 'checkbox'
                  ? values[field.id] === true
                    ? t('formWidget.yes')
                    : t('formWidget.no')
                  : displayValue(field, values[field.id])}
              </Text>
            </XStack>
          ))}
        {result.notes ? (
          <XStack gap={8}>
            <Text fontSize={11} color={c.text3} minWidth={110}>
              {t('formWidget.notesLabel')}
            </Text>
            <Text fontSize={11} color={c.text2} flex={1}>
              {String(result.notes)}
            </Text>
          </XStack>
        ) : null}
      </YStack>
    </FormCard>
  );
}
