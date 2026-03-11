/**
 * ElevenLabs MCA - Custom Tool Call Renderer
 *
 * Ultra Compact design for ElevenLabs TTS tools.
 * Delegates to specific sub-renderers based on tool name.
 *
 * Supported tools:
 * - text-to-speech: Generate speech from text (with audio player)
 * - list-voices: List available voices
 * - get-voice: Get voice details
 * - generate-conversation: Multi-speaker conversation (with audio player)
 * - get-subscription: Subscription info
 */

import type React from 'react';
import { useState } from 'react';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { GenerateConversationRenderer } from './elevenlabs/GenerateConversationRenderer';
import { GetSubscriptionRenderer } from './elevenlabs/GetSubscriptionRenderer';
import { GetVoiceRenderer } from './elevenlabs/GetVoiceRenderer';
import { ListVoicesRenderer } from './elevenlabs/ListVoicesRenderer';
import { getShortToolName, HeaderRow } from './elevenlabs/shared';
import { TextToSpeechRenderer } from './elevenlabs/TextToSpeechRenderer';

// ============================================================================
// Tool Name to Renderer Mapping
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<any>> = {
  'text-to-speech': TextToSpeechRenderer,
  'list-voices': ListVoicesRenderer,
  'get-voice': GetVoiceRenderer,
  'generate-conversation': GenerateConversationRenderer,
  'get-subscription': GetSubscriptionRenderer,
};

// ============================================================================
// Fallback Renderer
// ============================================================================

function FallbackRenderer({ toolName, status, duration }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName);

  let badge: { text: string; variant: 'green' | 'red' | 'gray' } | undefined;
  if (status === 'completed') {
    badge = { text: 'done', variant: 'green' };
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

function ElevenLabsRendererBase(props: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] || FallbackRenderer;

  return <Renderer {...props} expanded={expanded} onToggle={() => setExpanded(!expanded)} />;
}

export const ElevenLabsToolCallRenderer = withPermissionSupport(ElevenLabsRendererBase);
export default ElevenLabsToolCallRenderer;
