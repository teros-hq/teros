/**
 * Figma MCA — Tool Call Renderer entry point.
 *
 * Dispatches each tool call to a dedicated sub-renderer by short name.
 * 14/14 tools covered (11 read-only + 3 from Lote A: list-file-versions,
 * create-comment, delete-comment). `FallbackRenderer` is a dev-only warning
 * signalling a missing entry in the RENDERERS map — in production it should
 * never render.
 *
 * Replaces the pre-TER-281 monolith (1821 LOC) with a 140-LOC dispatcher
 * + figma/* sub-renderers that compose global primitives. Zero local
 * components.
 */

import type React from "react"
import { Text, YStack } from "tamagui"
import {
  Badge,
  FallbackBody,
  colors as globalColors,
  ToolCallCard,
} from "../primitives"
import type { ToolCallRendererProps } from "../types"
import { withPermissionSupport } from "../withPermissionSupport"
import {
  CreateCommentRenderer,
  DeleteCommentRenderer,
  ExportImagesRenderer,
  ExtractColorsRenderer,
  ExtractTypographyRenderer,
  FIGMA_ICON,
  GetCommentsRenderer,
  GetComponentSetsRenderer,
  GetComponentsRenderer,
  GetFileRenderer,
  GetFileStylesRenderer,
  GetFileVariablesRenderer,
  GetNodeRenderer,
  getShortToolName,
  getToolLabel,
  HealthCheckRenderer,
  ListFileVersionsRenderer,
  toolStatusForPrimitive,
} from "./figma"

// ============================================================================
// Registry — 14/14 coverage
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  // Health (SDK contract — shipped in every MCA)
  "-health-check": HealthCheckRenderer,
  // Files / nodes
  "get-file": GetFileRenderer,
  "get-node": GetNodeRenderer,
  // Styles / variables
  "get-file-styles": GetFileStylesRenderer,
  "get-file-variables": GetFileVariablesRenderer,
  // Components
  "get-components": GetComponentsRenderer,
  "get-component-sets": GetComponentSetsRenderer,
  // Export
  "export-images": ExportImagesRenderer,
  // Comments (read + write)
  "get-comments": GetCommentsRenderer,
  "create-comment": CreateCommentRenderer,
  "delete-comment": DeleteCommentRenderer,
  // Versions
  "list-file-versions": ListFileVersionsRenderer,
  // Extract (CSS / Tailwind / JSON)
  "extract-colors": ExtractColorsRenderer,
  "extract-typography": ExtractTypographyRenderer,
}

// ============================================================================
// FallbackRenderer — dev-only warning
// ============================================================================

function FallbackRenderer({ toolName, input, status, output, error }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName)

  const badge = __DEV__ ? (
    <Badge text="no renderer" variant="error" />
  ) : status === "completed" ? (
    <Badge text="done" variant="success" />
  ) : status === "failed" ? (
    <Badge text="failed" variant="error" />
  ) : null

  return (
    <ToolCallCard
      status={toolStatusForPrimitive(status)}
      verb={getToolLabel(toolName)}
      iconUri={FIGMA_ICON}
      badge={badge}
      animateExpand
    >
      {__DEV__ && (
        <YStack
          backgroundColor="rgba(239,68,68,0.12)"
          borderRadius={5}
          padding={8}
          borderWidth={1}
          borderColor="rgba(239,68,68,0.3)"
          gap={2}
          marginBottom={6}
        >
          <Text color={globalColors.badgeError.text} fontSize={10} fontWeight="600">
            [dev] Missing sub-renderer for "{shortName}"
          </Text>
          <Text color={globalColors.secondary} fontSize={9}>
            Register it in the RENDERERS map in FigmaRenderer.tsx.
          </Text>
        </YStack>
      )}
      <FallbackBody status={status} input={input} output={output} error={error} />
    </ToolCallCard>
  )
}

// ============================================================================
// Entry point
// ============================================================================

function FigmaRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName)
  const Renderer = RENDERERS[shortName] ?? FallbackRenderer
  return <Renderer {...props} />
}

export const FigmaToolCallRenderer = withPermissionSupport(FigmaRendererBase)
export default FigmaToolCallRenderer
