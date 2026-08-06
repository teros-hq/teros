/**
 * Field whitelists for curated tool responses.
 *
 * The Figma REST API returns deeply nested documents (full node trees with
 * fills, strokes, effects, blendMode, layoutAlign, individualStrokeWeights,
 * etc.) that explode the agent's context window. These whitelists define
 * what travels over the wire by default.
 *
 * Visual fields (`color`, `thumbnailUrl`, `iconUri`) are always included so
 * the renderer can paint branded chips and previews without a second request.
 *
 * Callers can pass `includeRaw: true` to get the full upstream payload
 * (escape hatch), or `fields: [...]` to override the whitelist.
 */

// ============================================================================
// FILES
// ============================================================================

export const FILE_FIELDS = [
  "name",
  "lastModified",
  "version",
  "thumbnailUrl",
  "document",
  "componentCount",
  "styleCount",
  "role",
  "editorType",
] as const

// ============================================================================
// NODES
// ============================================================================

export const NODE_FIELDS = [
  "id",
  "name",
  "type",
  "fills",
  "strokes",
  "strokeWeight",
  "cornerRadius",
  "textStyle",
  "bounds",
  "componentId",
  "componentSetId",
  "children",
  "childCount",
] as const

// ============================================================================
// COMPONENTS
// ============================================================================

export const COMPONENT_FIELDS = ["id", "key", "name", "description", "componentSetId"] as const

export const COMPONENT_SET_FIELDS = ["id", "key", "name", "description"] as const

// ============================================================================
// STYLES
// ============================================================================

export const STYLE_FIELDS = ["id", "key", "name", "type", "description"] as const

// ============================================================================
// VARIABLES
// ============================================================================

export const VARIABLE_FIELDS = ["id", "name", "type", "values", "description"] as const

export const VARIABLE_COLLECTION_FIELDS = [
  "id",
  "name",
  "modes",
  "variables",
  "defaultModeId",
] as const

// ============================================================================
// COMMENTS
// ============================================================================

export const COMMENT_FIELDS = [
  "id",
  "message",
  "createdAt",
  "user",
  "resolved",
  "parentId",
  "clientMeta",
] as const

// ============================================================================
// VERSIONS
// ============================================================================

export const VERSION_FIELDS = [
  "id",
  "createdAt",
  "label",
  "description",
  "user",
  "thumbnailUrl",
] as const

// ============================================================================
// EXPORTED IMAGES
// ============================================================================

export const EXPORTED_IMAGE_FIELDS = ["nodeId", "url", "format", "scale"] as const

// ============================================================================
// TYPES
// ============================================================================

export type FieldList = readonly string[]
