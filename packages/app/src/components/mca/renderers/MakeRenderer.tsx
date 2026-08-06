/**
 * mca.make — Tool Call Renderer (dispatch).
 *
 * 100% coverage: every Make tool has a dedicated sub-renderer composing global
 * primitives. The FallbackRenderer is a dev-only signal of a missing renderer
 * (a bug), never a production path.
 *
 * Tools:
 *   - trigger-webhook → WebhookResultRenderer
 *   - list-scenarios  → ScenariosListRenderer
 *   - run-scenario    → RunScenarioRenderer
 *   - -health-check   → HealthCheckRenderer
 */

import type React from 'react';
import { Badge, getShortToolName, ToolCallCard } from '../primitives';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { HealthCheckRenderer } from './make/HealthCheckRenderer';
import { RunScenarioRenderer } from './make/RunScenarioRenderer';
import { ScenariosListRenderer } from './make/ScenariosListRenderer';
import { WebhookResultRenderer } from './make/WebhookResultRenderer';

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  'trigger-webhook': WebhookResultRenderer,
  'list-scenarios': ScenariosListRenderer,
  'run-scenario': RunScenarioRenderer,
  '-health-check': HealthCheckRenderer,
};

function FallbackRenderer({ toolName, status, appIcon }: ToolCallRendererProps): React.ReactNode {
  if (typeof console !== 'undefined') {
    console.warn(`[MakeRenderer] No dedicated renderer for tool: ${toolName}`);
  }
  const shortName = getShortToolName(toolName);
  const badge =
    status === 'completed' ? (
      <Badge text="done" variant="success" />
    ) : status === 'failed' ? (
      <Badge text="failed" variant="error" />
    ) : null;

  return (
    <ToolCallCard status={status} verb={shortName.replace(/-/g, ' ')} badge={badge} iconUri={appIcon} />
  );
}

function MakeRendererBase(props: ToolCallRendererProps): React.ReactNode {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] ?? FallbackRenderer;
  return <Renderer {...props} />;
}

export const MakeToolCallRenderer = withPermissionSupport(MakeRendererBase);
export default MakeToolCallRenderer;
