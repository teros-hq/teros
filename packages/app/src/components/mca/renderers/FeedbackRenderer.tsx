/**
 * Feedback MCA - Custom Tool Call Renderer
 *
 * Main entry point that delegates to specific sub-renderers based on tool name.
 */

import type React from 'react';

import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
// Import sub-renderers
import {
  GetFeedbackRenderer,
  ListMyFeedbackRenderer,
  ReportBugRenderer,
  ReportSuggestionRenderer,
} from './feedback/renderers';
import { ToolCallCard } from '../primitives';
import { Badge, getShortToolName } from './feedback/shared';

// ============================================================================
// Tool Name to Renderer Mapping
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  'report-bug': ReportBugRenderer,
  'report-suggestion': ReportSuggestionRenderer,
  'list-my-feedback': ListMyFeedbackRenderer,
  'get-feedback': GetFeedbackRenderer,
};

// ============================================================================
// Fallback Renderer
// ============================================================================

function FallbackRenderer({ toolName, status, appIcon }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName);

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="done" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  return (
    <ToolCallCard
      status={status}
      verb={shortName.replace(/-/g, ' ')}
      badge={badge}
      iconUri={appIcon}
    />
  );
}

// ============================================================================
// Main Renderer
// ============================================================================

function FeedbackRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] || FallbackRenderer;

  return <Renderer {...props} />;
}

export const FeedbackToolCallRenderer = withPermissionSupport(FeedbackRendererBase);
export default FeedbackToolCallRenderer;
