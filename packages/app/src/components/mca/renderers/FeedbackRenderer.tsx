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
import { Badge, getShortToolName, HeaderRow } from './feedback/shared';

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

function FallbackRenderer({ toolName, status, duration }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName);

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="done" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  return (
    <HeaderRow
      status={status}
      description={shortName}
      duration={duration}
      badge={badge}
      expanded={false}
      onToggle={() => {}}
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
