/**
 * Inline user forms — agent → user structured input
 *
 *
 * The agent composes a form from a CLOSED set of platform-defined field types
 * via the built-in `request-user-input` tool; the user fills it inline in the
 * chat and the answers come back as the tool result in the same turn.
 *
 * The form spec lives in the tool call's `input` (persisted at tool_call_start)
 * and the submitted answers in the tool's `output` — no dedicated message
 * content fields, so `completeToolMessage`'s full-content rewrite never
 * clobbers them. Only `status: 'pending_user_input'` + `formRequestId` are
 * added to the tool_execution content while the form is waiting.
 *
 * Naming invariant: the tool name contains NO underscore. Real app tools are
 * always namespaced `${appName}_${tool}`, so a collision is impossible by
 * construction (same rule as the tool-execution proxy meta-tools).
 */

import { z } from 'zod';

export const FORM_TOOL_NAME = 'request-user-input';

export const MAX_FORM_FIELDS = 12;

// ---------------------------------------------------------------------------
// Field schemas — discriminated union by `type`
// ---------------------------------------------------------------------------

/** `id` doubles as the key in the submitted values record. Kept strict so the
 * LLM cannot smuggle arbitrary structures through field ids. */
const FieldIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'field id must be alphanumeric (plus - _), starting with a letter');

const FieldBase = {
  id: FieldIdSchema,
  label: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  required: z.boolean().optional(),
  placeholder: z.string().max(200).optional(),
};

export const FormFieldSchema = z.discriminatedUnion('type', [
  z.object({
    ...FieldBase,
    type: z.literal('text'),
    defaultValue: z.string().optional(),
  }),
  z.object({
    ...FieldBase,
    type: z.literal('textarea'),
    defaultValue: z.string().optional(),
  }),
  z.object({
    ...FieldBase,
    type: z.literal('number'),
    defaultValue: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({
    ...FieldBase,
    type: z.literal('select'),
    options: z
      .array(z.object({ value: z.string().min(1).max(100), label: z.string().min(1).max(200) }))
      .min(2)
      .max(24),
    defaultValue: z.string().optional(),
  }),
  z.object({
    ...FieldBase,
    type: z.literal('radio'),
    options: z
      .array(z.object({ value: z.string().min(1).max(100), label: z.string().min(1).max(200) }))
      .min(2)
      .max(8),
    defaultValue: z.string().optional(),
  }),
  z.object({
    ...FieldBase,
    type: z.literal('checkbox'),
    defaultValue: z.boolean().optional(),
  }),
  // Date/time values travel as strings: date 'YYYY-MM-DD', time 'HH:mm',
  // datetime ISO 8601. min/max are bounds in the same format.
  z.object({
    ...FieldBase,
    type: z.literal('date'),
    defaultValue: z.string().optional(),
    min: z.string().optional(),
    max: z.string().optional(),
  }),
  z.object({
    ...FieldBase,
    type: z.literal('time'),
    defaultValue: z.string().optional(),
  }),
  z.object({
    ...FieldBase,
    type: z.literal('datetime'),
    defaultValue: z.string().optional(),
    min: z.string().optional(),
    max: z.string().optional(),
  }),
]);
export type FormField = z.infer<typeof FormFieldSchema>;

// ---------------------------------------------------------------------------
// Form spec — the tool's input, as composed by the LLM
// ---------------------------------------------------------------------------

/** A free-text "Notes" field is ALWAYS appended by the platform (frontend
 * renders it, backend accepts `notes` in the response) — it is deliberately
 * NOT part of the spec so the LLM can neither omit nor duplicate it. */
export const FormSpecSchema = z
  .object({
    title: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
    fields: z.array(FormFieldSchema).min(1).max(MAX_FORM_FIELDS),
    submitLabel: z.string().max(60).optional(),
    /**
     * How the client renders the form. 'full' (default) shows every field at
     * once; 'wizard' walks the user through the fields one at a time with
     * back/next and a progress indicator, submitting everything at the end.
     * Purely presentational — the submitted payload is identical.
     */
    presentation: z.enum(['full', 'wizard']).optional(),
  })
  .superRefine((spec, ctx) => {
    const seen = new Set<string>();
    for (const field of spec.fields) {
      if (seen.has(field.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate field id '${field.id}'`,
        });
      }
      seen.add(field.id);
    }
  });
export type FormSpec = z.infer<typeof FormSpecSchema>;

// ---------------------------------------------------------------------------
// Form response — what the client submits back
// ---------------------------------------------------------------------------

export const FormValuesSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);
export type FormValues = z.infer<typeof FormValuesSchema>;

export interface FormSubmission {
  values: FormValues;
  /** The always-on platform Notes field. */
  notes?: string;
}

// ---------------------------------------------------------------------------
// Server-side validation of submitted values against the persisted spec.
// Shared so the frontend can reuse the exact same rules for inline validation.
// ---------------------------------------------------------------------------

export interface FormValidationResult {
  ok: boolean;
  /** Normalized values (unknown keys stripped) — only meaningful when ok. */
  values: FormValues;
  errors: string[];
}

export function validateFormValues(spec: FormSpec, rawValues: unknown): FormValidationResult {
  const errors: string[] = [];
  const parsed = FormValuesSchema.safeParse(rawValues ?? {});
  if (!parsed.success) {
    return { ok: false, values: {}, errors: ['values must be a record of string|number|boolean'] };
  }
  const input = parsed.data;
  const values: FormValues = {};

  for (const field of spec.fields) {
    const value = input[field.id];
    const missing = value === undefined || value === '';
    if (missing) {
      if (field.required) errors.push(`'${field.id}' is required`);
      continue;
    }
    switch (field.type) {
      case 'text':
      case 'textarea':
      case 'date':
      case 'time':
      case 'datetime':
        if (typeof value !== 'string') {
          errors.push(`'${field.id}' must be a string`);
          continue;
        }
        if ((field.type === 'date' || field.type === 'datetime') && field.min && value < field.min) {
          errors.push(`'${field.id}' must be >= ${field.min}`);
          continue;
        }
        if ((field.type === 'date' || field.type === 'datetime') && field.max && value > field.max) {
          errors.push(`'${field.id}' must be <= ${field.max}`);
          continue;
        }
        break;
      case 'number':
        if (typeof value !== 'number' || Number.isNaN(value)) {
          errors.push(`'${field.id}' must be a number`);
          continue;
        }
        if (field.min !== undefined && value < field.min) {
          errors.push(`'${field.id}' must be >= ${field.min}`);
          continue;
        }
        if (field.max !== undefined && value > field.max) {
          errors.push(`'${field.id}' must be <= ${field.max}`);
          continue;
        }
        break;
      case 'select':
      case 'radio':
        if (typeof value !== 'string' || !field.options.some((o) => o.value === value)) {
          errors.push(`'${field.id}' must be one of the listed options`);
          continue;
        }
        break;
      case 'checkbox':
        if (typeof value !== 'boolean') {
          errors.push(`'${field.id}' must be a boolean`);
          continue;
        }
        break;
    }
    values[field.id] = value;
  }

  return { ok: errors.length === 0, values, errors };
}
