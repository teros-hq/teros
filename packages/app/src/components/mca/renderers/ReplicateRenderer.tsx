/**
 * Replicate MCA - Custom Tool Call Renderer
 *
 * Main entry point that delegates to specific sub-renderers based on tool name.
 *
 * Supported tools:
 * - replicate-flux-pro, replicate-flux-dev (FLUX 1.x image generation)
 * - replicate-flux-2-pro, replicate-flux-2-dev, replicate-flux-2-flex (FLUX 2.x)
 * - replicate-minimax-video (Minimax video generation)
 * - replicate-veo-video (Google Veo video generation)
 * - replicate-run (generic model execution)
 * - replicate-get-prediction (prediction status)
 */

import type React from 'react';

import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { GenericRunRenderer, GetPredictionRenderer } from './replicate/GenericRenderer';

// Import sub-renderers
import { Flux2Renderer, FluxDevRenderer, FluxProRenderer } from './replicate/ImageRenderer';
import { Badge, getShortToolName, HeaderRow } from './replicate/shared';
import { MinimaxVideoRenderer, VeoVideoRenderer } from './replicate/VideoRenderer';

// ============================================================================
// Tool Name to Renderer Mapping
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  // FLUX 1.x Image Generation
  'replicate-flux-pro': FluxProRenderer,
  'replicate-flux-dev': FluxDevRenderer,

  // FLUX 2.x Image Generation
  'replicate-flux-2-pro': Flux2Renderer,
  'replicate-flux-2-dev': Flux2Renderer,
  'replicate-flux-2-flex': Flux2Renderer,

  // Video Generation
  'replicate-minimax-video': MinimaxVideoRenderer,
  'replicate-veo-video': VeoVideoRenderer,

  // Generic
  'replicate-run': GenericRunRenderer,
  'replicate-get-prediction': GetPredictionRenderer,
};

// ============================================================================
// Fallback Renderer
// ============================================================================

function FallbackRenderer({ toolName, status, duration }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName);

  let badge: { text: string; variant: 'success' | 'red' | 'gray' } | undefined;
  if (status === 'completed') {
    badge = { text: 'done', variant: 'success' };
  } else if (status === 'failed') {
    badge = { text: 'failed', variant: 'red' };
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

function ReplicateRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] || FallbackRenderer;

  return <Renderer {...props} />;
}

export const ReplicateToolCallRenderer = withPermissionSupport(ReplicateRendererBase);
export default ReplicateToolCallRenderer;
