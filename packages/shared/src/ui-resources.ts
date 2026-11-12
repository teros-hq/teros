/**
 * UI Resources Protocol — Declarative renderable components
 *
 * Allows Agent Apps to declare renderable UI components (tree views, node
 * detail panels, forms) that the host interprets and displays to the user.
 *
 * Design principle: declaring UI should be as natural as declaring a tool.
 *   app.tool('list-repos', { ... })   ← tools
 *   app.ui('tree', { ... })           ← UI resources
 *
 * The resource type ('tree', 'detail', 'form') is the first argument and is
 * immediately obvious to a developer reading the code for the first time.
 *
 * @see docs/specs/mca/card-body-rendering-agentapps.md
 */

import { z } from 'zod';

// ============================================================================
// RESOURCE TYPE ENUM
// ============================================================================

/**
 * The kind of renderable component a resource produces.
 *
 * - `tree`: A hierarchical list of nodes (file trees, project structures,
 *   nested categories). The host renders an expandable tree view.
 * - `detail`: A flat key-value panel for a single entity (repo details,
 *   issue summary, user profile). The host renders a detail card.
 * - `form`: An interactive form with typed fields that the user fills in
 *   and submits. The host renders form inputs and sends results back.
 */
export const UiResourceTypeSchema = z.enum(['tree', 'detail', 'form']);
export type UiResourceType = z.infer<typeof UiResourceTypeSchema>;

// ============================================================================
// TREE RESOURCE
// ============================================================================

/**
 * A single node in a tree view.
 *
 * `id` is unique within the tree (used for expand/collapse state).
 * `label` is what the user sees. `children` are optional — when absent,
 * the node is a leaf. `badge` is a small status indicator (e.g. "3 issues",
 * "modified"). `icon` is a hint for the host (e.g. "folder", "file", "repo").
 */
export const TreeNodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    label: z.string(),
    icon: z.string().optional(),
    badge: z.string().optional(),
    /** Whether this node is expanded by default (host decides initial state) */
    expanded: z.boolean().optional(),
    /** Nested children. Absent = leaf node. */
    children: z.array(TreeNodeSchema).optional(),
    /** Arbitrary metadata the host can use for context menus or actions */
    meta: z.record(z.unknown()).optional(),
  }),
);
export type TreeNode = {
  id: string;
  label: string;
  icon?: string;
  badge?: string;
  expanded?: boolean;
  children?: TreeNode[];
  meta?: Record<string, unknown>;
};

/**
 * The data a `tree` resource handler returns.
 */
export const TreeResourceDataSchema = z.object({
  type: z.literal('tree'),
  /** Root nodes of the tree */
  nodes: z.array(TreeNodeSchema),
  /** Optional title shown above the tree */
  title: z.string().optional(),
  /** Whether the tree supports multi-select (host hint) */
  multiSelect: z.boolean().optional(),
});
export type TreeResourceData = z.infer<typeof TreeResourceDataSchema>;

// ============================================================================
// DETAIL RESOURCE
// ============================================================================

/**
 * A single field in a detail panel.
 *
 * `label` is the human-readable field name. `value` is the display value
 * (string, number, boolean, or ISO date string). `type` hints at rendering:
 * `text` (default), `code` (monospace), `date` (formatted), `url` (link),
 * `markdown` (rich text), `image` (thumbnail).
 */
export const DetailFieldSchema = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
  type: z.enum(['text', 'code', 'date', 'url', 'markdown', 'image']).default('text'),
  /** For `url` type: display text if different from the URL */
  linkText: z.string().optional(),
  /** For `image` type: alt text */
  alt: z.string().optional(),
});
export type DetailField = z.infer<typeof DetailFieldSchema>;

/**
 * A section within a detail panel. Groups related fields.
 */
export const DetailSectionSchema = z.object({
  title: z.string().optional(),
  fields: z.array(DetailFieldSchema),
  /** Optional icon for the section header */
  icon: z.string().optional(),
});
export type DetailSection = z.infer<typeof DetailSectionSchema>;

/**
 * The data a `detail` resource handler returns.
 */
export const DetailResourceDataSchema = z.object({
  type: z.literal('detail'),
  /** Entity title (e.g. "repo: teros/teros") */
  title: z.string().optional(),
  /** Subtitle or description */
  subtitle: z.string().optional(),
  /** Sections of key-value fields. If a single section has no title,
   * the host renders a flat panel. */
  sections: z.array(DetailSectionSchema),
  /** Optional avatar/image URL for the entity */
  imageUrl: z.string().optional(),
  /** Optional badge text (e.g. "active", "archived") */
  badge: z.string().optional(),
});
export type DetailResourceData = z.infer<typeof DetailResourceDataSchema>;

// ============================================================================
// FORM RESOURCE
// ============================================================================

/**
 * A single field in a form.
 *
 * `name` is the form key returned on submit. `label` is what the user sees.
 * `fieldType` determines the input control: `text`, `textarea`, `number`,
 * `select` (dropdown), `checkbox`, `radio`, `date`, `time`, `datetime`.
 *
 * `options` is required for `select` and `radio` types — an array of
 * `{ value, label }` choices.
 *
 * `placeholder`, `defaultValue`, `helpText` are all optional UX hints.
 * `required` makes the field mandatory.
 */
export const UiFormFieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  fieldType: z.enum([
    'text',
    'textarea',
    'number',
    'select',
    'checkbox',
    'radio',
    'date',
    'time',
    'datetime',
  ]),
  /** Required for `select` and `radio` — the available choices */
  options: z
    .array(
      z.object({
        value: z.string(),
        label: z.string(),
      }),
    )
    .optional(),
  placeholder: z.string().optional(),
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  helpText: z.string().optional(),
  required: z.boolean().optional(),
  /** Min/max for `number` fields */
  min: z.number().optional(),
  max: z.number().optional(),
  /** Pattern for `text` fields (regex string) */
  pattern: z.string().optional(),
});
export type UiFormField = z.infer<typeof UiFormFieldSchema>;

/**
 * The data a `form` resource handler returns.
 *
 * This is the *spec* of the form — the host renders it, the user fills it in,
 * and the submitted values are sent back via a tool call or callback.
 */
export const FormResourceDataSchema = z.object({
  type: z.literal('form'),
  /** Form title shown to the user */
  title: z.string().optional(),
  /** Description / instructions */
  description: z.string().optional(),
  /** The fields to render */
  fields: z.array(UiFormFieldSchema),
  /** Submit button text (default: "Submit") */
  submitLabel: z.string().optional(),
  /** Cancel button text (default: "Cancel") */
  cancelLabel: z.string().optional(),
  /**
   * The tool to call when the form is submitted. The host calls this tool
   * with the form values as arguments. If absent, the host sends the
   * values back via the protocol's `submit_ui_resource` message.
   */
  submitTool: z.string().optional(),
});
export type FormResourceData = z.infer<typeof FormResourceDataSchema>;

// ============================================================================
// UNION — RESOURCE DATA
// ============================================================================

/**
 * The discriminated union of all resource data types.
 * The `type` field is the discriminator.
 */
export const UiResourceDataSchema = z.discriminatedUnion('type', [
  TreeResourceDataSchema,
  DetailResourceDataSchema,
  FormResourceDataSchema,
]);
export type UiResourceData = z.infer<typeof UiResourceDataSchema>;

// ============================================================================
// RESOURCE DEFINITION (declarative — what the app registers)
// ============================================================================

/**
 * The parameters a `tree` resource accepts.
 *
 * These are passed to the handler when the host requests the resource.
 * For example, a tree of GitHub repos might accept `{ org: 'teros' }`.
 */
export const ResourceParametersSchema = z.object({
  type: z.literal('object'),
  properties: z.record(z.unknown()),
  required: z.array(z.string()).optional(),
});

/**
 * A UI resource definition as declared by the app.
 *
 * This is the static metadata the host uses to discover and route to
 * resources. The `handler` is not included here — it lives in the SDK's
 * `McaServer` registration. This schema is what travels over the wire
 * in `list_ui_resources` responses.
 */
export const UiResourceDefinitionSchema = z.object({
  /** Unique name within the app (e.g. 'repo-tree', 'issue-detail') */
  name: z.string(),
  /** Resource type — determines how the host renders the result */
  resourceType: UiResourceTypeSchema,
  /** Human-readable description */
  description: z.string(),
  /**
   * JSON Schema for the parameters the handler accepts.
   * The host may use this to build a parameter form for the user.
   */
  parameters: ResourceParametersSchema.optional(),
  /**
   * Optional: which tools this resource is associated with.
   * The host may offer a "view as tree" action on results from these tools.
   */
  boundTools: z.array(z.string()).optional(),
  /**
   * Optional: which events trigger a refresh of this resource.
   * The host re-fetches the resource when these events fire.
   */
  refreshOnEvents: z.array(z.string()).optional(),
});
export type UiResourceDefinition = z.infer<typeof UiResourceDefinitionSchema>;

// ============================================================================
// PROTOCOL MESSAGES
// ============================================================================

/**
 * List UI resources available on an app.
 *
 * Sent by the host to discover what renderable components an app declares.
 * The response carries `UiResourceDefinition[]` — static metadata only.
 */
export const ListUiResourcesRequestSchema = z.object({
  type: z.literal('list_ui_resources'),
  requestId: z.string().optional(),
});

export const ListUiResourcesResponseSchema = z.object({
  type: z.literal('ui_resources_list'),
  resources: z.array(UiResourceDefinitionSchema),
});

/**
 * Get a specific UI resource's renderable data.
 *
 * Sent by the host when it needs to display a resource. The `name` matches
 * a resource from `list_ui_resources`. `params` are passed to the handler.
 */
export const GetUiResourceRequestSchema = z.object({
  type: z.literal('get_ui_resource'),
  requestId: z.string().optional(),
  /** Resource name (from the definition) */
  name: z.string(),
  /** Parameters for the handler */
  params: z.record(z.unknown()).optional(),
});

export const GetUiResourceResponseSchema = z.object({
  type: z.literal('ui_resource_data'),
  /** The renderable data (tree, detail, or form) */
  data: UiResourceDataSchema,
});

/**
 * Submit a form resource.
 *
 * Sent by the host when the user fills in and submits a `form` resource.
 * If the form definition had `submitTool`, the host calls that tool instead
 * and this message is not sent. This message is the fallback path.
 */
export const SubmitUiResourceRequestSchema = z.object({
  type: z.literal('submit_ui_resource'),
  requestId: z.string().optional(),
  /** Resource name (the form that was submitted) */
  name: z.string(),
  /** The user's submitted values */
  values: z.record(z.unknown()),
});

export const SubmitUiResourceResponseSchema = z.object({
  type: z.literal('ui_resource_submitted'),
  success: z.boolean(),
  message: z.string().optional(),
});

// ============================================================================
// TYPE GUARDS
// ============================================================================

export function isUiResourceType(value: unknown): value is UiResourceType {
  return UiResourceTypeSchema.safeParse(value).success;
}

export function isTreeResourceData(data: unknown): data is TreeResourceData {
  return TreeResourceDataSchema.safeParse(data).success;
}

export function isDetailResourceData(data: unknown): data is DetailResourceData {
  return DetailResourceDataSchema.safeParse(data).success;
}

export function isFormResourceData(data: unknown): data is FormResourceData {
  return FormResourceDataSchema.safeParse(data).success;
}
