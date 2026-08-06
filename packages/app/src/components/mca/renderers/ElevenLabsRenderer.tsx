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
import { Badge, ToolCallCard } from '../primitives';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { GenerateConversationRenderer } from './elevenlabs/GenerateConversationRenderer';
import { GetSubscriptionRenderer } from './elevenlabs/GetSubscriptionRenderer';
import { GetVoiceRenderer } from './elevenlabs/GetVoiceRenderer';
import { ListVoicesRenderer } from './elevenlabs/ListVoicesRenderer';
import { getShortToolName } from './elevenlabs/shared';
import { TextToSpeechRenderer } from './elevenlabs/TextToSpeechRenderer';

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  'text-to-speech': TextToSpeechRenderer,
  'list-voices': ListVoicesRenderer,
  'get-voice': GetVoiceRenderer,
  'generate-conversation': GenerateConversationRenderer,
  'get-subscription': GetSubscriptionRenderer,
};

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

function ElevenLabsRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] || FallbackRenderer;
  return <Renderer {...props} />;
}

export const ElevenLabsToolCallRenderer = withPermissionSupport(ElevenLabsRendererBase);
export default ElevenLabsToolCallRenderer;
