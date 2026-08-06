/**
 * Built-in inline-form tool — `request-user-input`.
 *
 *
 * A synthetic tool injected by McaToolExecutor (gated by the `tools.user-forms`
 * feature flag) that lets the agent send the user a structured form to fill
 * inline in the chat. The tool call blocks — like a permission wait — until the
 * user submits or dismisses, and the answers come back as the tool result.
 *
 * Naming invariant: no underscore in the name, so it can never collide with
 * namespaced `${appName}_${tool}` app tools (same rule as the proxy meta-tools).
 *
 * This definition is description-only — the handler lives in McaToolExecutor,
 * which intercepts the name before the permission gate. The tool is NEVER
 * permission-gated: it IS user interaction, there is nothing to protect.
 */

import { FORM_TOOL_NAME, MAX_FORM_FIELDS } from "@teros/shared"
import type { ToolDefinition } from "./mca-manager.types"

export { FORM_TOOL_NAME }

export function isFormTool(toolName: string): boolean {
  return toolName === FORM_TOOL_NAME
}

const FIELD_PROPERTIES = {
  id: {
    type: "string",
    description:
      "Unique field id (alphanumeric, - and _, starts with a letter). Key of this field's answer in the result.",
  },
  type: {
    type: "string",
    enum: ["text", "textarea", "number", "select", "radio", "checkbox", "date", "time", "datetime"],
  },
  label: { type: "string", description: "Short human-readable label shown next to the control." },
  description: { type: "string", description: "Optional helper text under the label." },
  required: { type: "boolean" },
  placeholder: { type: "string" },
  defaultValue: {
    description: "Pre-filled value. string for most types, number for 'number', boolean for 'checkbox'.",
  },
  options: {
    type: "array",
    description: "REQUIRED for select/radio: the choices.",
    items: {
      type: "object",
      properties: { value: { type: "string" }, label: { type: "string" } },
      required: ["value", "label"],
    },
  },
  min: { description: "Lower bound: number for 'number', ISO string for date/datetime." },
  max: { description: "Upper bound: number for 'number', ISO string for date/datetime." },
} as const

export function buildFormToolDefinition(): ToolDefinition {
  return {
    name: FORM_TOOL_NAME,
    description:
      "Send the user a structured form to fill inline in the chat, and wait for their answers. " +
      "Use this instead of asking several questions in prose whenever you need specific, typed values " +
      "(choices, dates, amounts, short texts). The call blocks until the user submits; the result contains " +
      "their answers keyed by field id, plus an optional free-text 'notes' the user can always add — read it, " +
      "it may qualify or correct their answers. If the result says the form was dismissed, do not re-send it: " +
      "continue conversationally. If it says forms are unavailable on this channel (voice/headless), ask for " +
      `each field in conversation instead. Keep forms short (max ${MAX_FORM_FIELDS} fields, ideally fewer). ` +
      "For an adaptive question-by-question flow, send a form with a SINGLE select/radio field (it renders as a " +
      "compact multiple-choice question; the notes field doubles as a free-text answer) and chain calls, deciding " +
      "each next question from the previous answer. For a long fixed questionnaire, set presentation: 'wizard' " +
      "to walk the user through the fields one at a time with progress and back/next.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short form title." },
        description: { type: "string", description: "One-line explanation of why you need this." },
        fields: {
          type: "array",
          description: `1-${MAX_FORM_FIELDS} typed fields. Do NOT add a notes/comments field — the platform always appends one.`,
          items: {
            type: "object",
            properties: FIELD_PROPERTIES,
            required: ["id", "type", "label"],
          },
        },
        submitLabel: { type: "string", description: "Optional custom label for the submit button." },
        presentation: {
          type: "string",
          enum: ["full", "wizard"],
          description:
            "'full' (default) shows every field at once; 'wizard' walks the user through the fields one at a time — prefer it for 5+ fields.",
        },
      },
      required: ["fields"],
    },
    // Descriptive only — the executor intercepts this name before the gate,
    // so no permission policy ever applies. Waiting for user input mutates
    // nothing; readOnlyHint documents that for tooling.
    annotations: { readOnlyHint: true },
  }
}
