/**
 * Get Voice Renderer
 */

import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { Badge, ErrorBlock, ToolCallCard } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { useElevenLabsColors, parseOutput } from './shared';

// MCA returns snake_case fields directly at root level
interface VoiceOutput {
  voice_id?: string;
  name?: string;
  category?: string;
  description?: string;
  labels?: Record<string, string>;
  samples?: Array<{ sample_id: string; file_name: string; mime_type: string }>;
  settings?: {
    stability?: number;
    similarity_boost?: number;
    style?: number;
    use_speaker_boost?: boolean;
    speed?: number;
  };
}

export function GetVoiceRenderer({
  input,
  status,
  output,
  error,
  appIcon,
}: ToolCallRendererProps) {
  const c = useElevenLabsColors();
  const colors = useElevenLabsColors();
  // Output is the voice object directly (not wrapped in { voice: ... })
  const voice = parseOutput<VoiceOutput>(output);
  const voiceId = input?.voiceId || voice?.voice_id || '';

  const displayError = error || (status === 'failed' ? output : null);

  const badge = status === 'failed' ? <Badge text="failed" variant="error" /> : null;

  return (
    <ToolCallCard
      status={status}
      description={`Get voice: ${voice?.name || voiceId}`}
      badge={badge}
      iconUri={appIcon}
    >
      <YStack backgroundColor={c.bgInner} borderRadius={6} padding={10} gap={6}>
        {displayError ? (
          <ErrorBlock error={displayError} />
        ) : voice ? (
          <>
            {/* Name */}
            {voice.name && (
              <XStack alignItems="center" gap={6}>
                <Text color={c.text3} fontSize={9} width={60}>
                  Name
                </Text>
                <Text color={c.text} fontSize={10} fontWeight="500">
                  {voice.name}
                </Text>
              </XStack>
            )}

            {/* Voice ID */}
            {voice.voice_id && (
              <XStack alignItems="center" gap={6}>
                <Text color={c.text3} fontSize={9} width={60}>
                  ID
                </Text>
                <Text color={c.text2} fontSize={9} fontFamily="$mono">
                  {voice.voice_id}
                </Text>
              </XStack>
            )}

            {/* Category */}
            {voice.category && (
              <XStack alignItems="center" gap={6}>
                <Text color={c.text3} fontSize={9} width={60}>
                  Category
                </Text>
                <Badge text={voice.category} variant="info" />
              </XStack>
            )}

            {/* Description */}
            {voice.description && (
              <XStack alignItems="flex-start" gap={6}>
                <Text color={c.text3} fontSize={9} width={60}>
                  Description
                </Text>
                <Text color={c.text2} fontSize={10} flex={1}>
                  {voice.description}
                </Text>
              </XStack>
            )}

            {/* Labels */}
            {voice.labels && Object.keys(voice.labels).length > 0 && (
              <XStack alignItems="flex-start" gap={6}>
                <Text color={c.text3} fontSize={9} width={60}>
                  Labels
                </Text>
                <XStack gap={4} flexWrap="wrap" flex={1}>
                  {Object.entries(voice.labels).map(([key, value]) => (
                    <Badge key={key} text={`${key}: ${value}`} variant="gray" />
                  ))}
                </XStack>
              </XStack>
            )}

            {/* Settings */}
            {voice.settings && (
              <XStack alignItems="flex-start" gap={6}>
                <Text color={c.text3} fontSize={9} width={60}>
                  Settings
                </Text>
                <YStack gap={2} flex={1}>
                  {voice.settings.stability !== undefined && (
                    <Text color={c.text2} fontSize={10}>
                      Stability: {voice.settings.stability.toFixed(2)}
                    </Text>
                  )}
                  {voice.settings.similarity_boost !== undefined && (
                    <Text color={c.text2} fontSize={10}>
                      Similarity: {voice.settings.similarity_boost.toFixed(2)}
                    </Text>
                  )}
                  {voice.settings.style !== undefined && (
                    <Text color={c.text2} fontSize={10}>
                      Style: {voice.settings.style.toFixed(2)}
                    </Text>
                  )}
                  {voice.settings.speed !== undefined && (
                    <Text color={c.text2} fontSize={10}>
                      Speed: {voice.settings.speed.toFixed(2)}
                    </Text>
                  )}
                </YStack>
              </XStack>
            )}

            {/* Samples */}
            {voice.samples && voice.samples.length > 0 && (
              <XStack alignItems="center" gap={6}>
                <Text color={c.text3} fontSize={9} width={60}>
                  Samples
                </Text>
                <Text color={c.text2} fontSize={10}>
                  {voice.samples.length} available
                </Text>
              </XStack>
            )}
          </>
        ) : (
          <Text color={c.text3} fontSize={10}>
            No voice data
          </Text>
        )}
      </YStack>
    </ToolCallCard>
  );
}
