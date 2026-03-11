/**
 * Get Voice Renderer
 */

import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import type { ToolCallRendererProps } from '../../types';
import { Badge, colors, ExpandedBody, ExpandedContainer, HeaderRow, parseOutput } from './shared';

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

interface SubRendererProps extends ToolCallRendererProps {
  expanded: boolean;
  onToggle: () => void;
}

export function GetVoiceRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  // Output is the voice object directly (not wrapped in { voice: ... })
  const voice = parseOutput<VoiceOutput>(output);
  const voiceId = input?.voiceId || voice?.voice_id || '';

  const displayError = error || (status === 'failed' ? output : null);

  const badge =
    status === 'failed' ? { text: 'failed', variant: 'red' as const } : undefined;

  const headerProps = {
    status,
    description: `Get voice: ${voice?.name || voiceId}`,
    duration,
    badge,
    expanded,
    onToggle,
  };

  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <YStack backgroundColor={colors.bgInnerDark} borderRadius={6} padding={10} gap={6}>
          {displayError ? (
            <XStack alignItems="flex-start" gap={6}>
              <Text color={colors.muted} fontSize={9} width={60}>
                Error
              </Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                {displayError}
              </Text>
            </XStack>
          ) : voice ? (
            <>
              {/* Name */}
              {voice.name && (
                <XStack alignItems="center" gap={6}>
                  <Text color={colors.muted} fontSize={9} width={60}>
                    Name
                  </Text>
                  <Text color={colors.bright} fontSize={10} fontWeight="500">
                    {voice.name}
                  </Text>
                </XStack>
              )}

              {/* Voice ID */}
              {voice.voice_id && (
                <XStack alignItems="center" gap={6}>
                  <Text color={colors.muted} fontSize={9} width={60}>
                    ID
                  </Text>
                  <Text color={colors.secondary} fontSize={9} fontFamily="$mono">
                    {voice.voice_id}
                  </Text>
                </XStack>
              )}

              {/* Category */}
              {voice.category && (
                <XStack alignItems="center" gap={6}>
                  <Text color={colors.muted} fontSize={9} width={60}>
                    Category
                  </Text>
                  <Badge text={voice.category} variant="purple" />
                </XStack>
              )}

              {/* Description */}
              {voice.description && (
                <XStack alignItems="flex-start" gap={6}>
                  <Text color={colors.muted} fontSize={9} width={60}>
                    Description
                  </Text>
                  <Text color={colors.secondary} fontSize={10} flex={1}>
                    {voice.description}
                  </Text>
                </XStack>
              )}

              {/* Labels */}
              {voice.labels && Object.keys(voice.labels).length > 0 && (
                <XStack alignItems="flex-start" gap={6}>
                  <Text color={colors.muted} fontSize={9} width={60}>
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
                  <Text color={colors.muted} fontSize={9} width={60}>
                    Settings
                  </Text>
                  <YStack gap={2} flex={1}>
                    {voice.settings.stability !== undefined && (
                      <Text color={colors.secondary} fontSize={10}>
                        Stability: {voice.settings.stability.toFixed(2)}
                      </Text>
                    )}
                    {voice.settings.similarity_boost !== undefined && (
                      <Text color={colors.secondary} fontSize={10}>
                        Similarity: {voice.settings.similarity_boost.toFixed(2)}
                      </Text>
                    )}
                    {voice.settings.style !== undefined && (
                      <Text color={colors.secondary} fontSize={10}>
                        Style: {voice.settings.style.toFixed(2)}
                      </Text>
                    )}
                    {voice.settings.speed !== undefined && (
                      <Text color={colors.secondary} fontSize={10}>
                        Speed: {voice.settings.speed.toFixed(2)}
                      </Text>
                    )}
                  </YStack>
                </XStack>
              )}

              {/* Samples */}
              {voice.samples && voice.samples.length > 0 && (
                <XStack alignItems="center" gap={6}>
                  <Text color={colors.muted} fontSize={9} width={60}>
                    Samples
                  </Text>
                  <Text color={colors.secondary} fontSize={10}>
                    {voice.samples.length} available
                  </Text>
                </XStack>
              )}
            </>
          ) : (
            <Text color={colors.muted} fontSize={10}>
              No voice data
            </Text>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}
