/**
 * Sancho MCA (SanchoCMO/Growth4U via MCP) — custom Tool Call Renderer.
 *
 * Main entry point that delegates to specific sub-renderers by
 * `shortToolName` (the tool name after the `<appName>_` prefix — see
 * `getShortToolName`). 13 tools in tools.json; every one has a sub-renderer
 * except `mcp-call`, which intentionally composes `FallbackBody` (344
 * arbitrary server tools — nothing curated adds over ParamsTable + Output).
 *
 * `pending_permission` is handled centrally: `withPermissionSupport` (applied
 * again by `McaRegistry.register`, idempotently) injects the ControlsBar and
 * PermissionDetail.
 */

import type React from 'react';

import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { Badge, FallbackBody, getShortToolName, ToolCallCard } from '../primitives';
import { getToolLabel, SANCHO_ICON } from './sancho/shared';
import { HealthCheckRenderer } from './sancho/HealthCheckRenderer';
import { McpCallRenderer, McpListToolsRenderer, McpStatusRenderer } from './sancho/MetaRenderer';
import {
  GetClientContextRenderer,
  ListClientsRenderer,
} from './sancho/ClientsRenderer';
import {
  CreateTaskRenderer,
  GetTaskRenderer,
  ListTasksRenderer,
  UpdateTaskRenderer,
} from './sancho/TasksRenderer';
import {
  GetDocumentRenderer,
  ListDocumentsRenderer,
} from './sancho/DocumentsRenderer';
import { RecallRenderer } from './sancho/RecallRenderer';

// ============================================================================
// Tool Name to Renderer Mapping — keys are shortToolName
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  // Health
  '-health-check': HealthCheckRenderer,

  // MCP meta
  'mcp-status': McpStatusRenderer,
  'mcp-list-tools': McpListToolsRenderer,
  'mcp-call': McpCallRenderer,

  // Clients
  'list-clients': ListClientsRenderer,
  'get-client-context': GetClientContextRenderer,

  // Tasks
  'list-tasks': ListTasksRenderer,
  'get-task': GetTaskRenderer,
  'update-task': UpdateTaskRenderer,
  'create-task': CreateTaskRenderer,

  // Brand Brain documents
  'list-documents': ListDocumentsRenderer,
  'get-document': GetDocumentRenderer,

  // Semantic recall
  recall: RecallRenderer,
};

// ============================================================================
// Fallback Renderer — tools not in the map (future tools.json additions)
// ============================================================================

function FallbackRenderer({
  toolName,
  status,
  input,
  output,
  error,
  appIcon,
}: ToolCallRendererProps) {
  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.warn(
      `[SanchoRenderer] missing dedicated renderer for tool: ${toolName}. ` +
        'Add a sub-renderer and register it in RENDERERS.',
    );
  }

  const badge =
    status === 'completed' ? (
      <Badge text="done (fallback)" variant="warning" />
    ) : status === 'failed' ? (
      <Badge text="failed" variant="error" />
    ) : null;

  return (
    <ToolCallCard
      status={status}
      description={`${getToolLabel(toolName)} (no renderer)`}
      badge={badge}
      iconUri={appIcon ?? SANCHO_ICON}
    >
      <FallbackBody status={status} input={input} output={output} error={error} />
    </ToolCallCard>
  );
}

// ============================================================================
// Main Renderer
// ============================================================================

function SanchoRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] || FallbackRenderer;
  return <Renderer {...props} />;
}

export const SanchoToolCallRenderer = withPermissionSupport(SanchoRendererBase);
export default SanchoToolCallRenderer;
