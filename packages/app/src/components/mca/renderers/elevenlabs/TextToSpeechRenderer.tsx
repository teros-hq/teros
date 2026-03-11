/**
 * Text-to-Speech Renderer
 */

import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  colors,
  ExpandedBody,
  ExpandedContainer,
  getFileUrl,
  HeaderRow,
  parseOutput,
  truncate,
} from './shared';

interface TTSOutput {
  filePath?: string;
  duration?: number;
  characterCount?: number;
}

interface SubRendererProps extends ToolCallRendererProps {
  expanded: boolean;
  onToggle: () => void;
}

export function TextToSpeechRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const data = parseOutput<TTSOutput>(output);
  const text = input?.text || '';
  const voiceId = input?.voiceId;
  const modelId = input?.modelId || 'eleven_flash_v2_5';

  const displayError = error || (status === 'failed' ? output : null);

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : data?.filePath
        ? { text: 'generated', variant: 'green' as const }
        : undefined;

  const headerProps = {
    status,
    description: `Generate speech: "${truncate(text, 35)}"`,
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
          {/* Text */}
          <XStack alignItems="flex-start" gap={6}>
            <Text color={colors.muted} fontSize={9} width={60} flexShrink={0}>
              Text
            </Text>
            <Text color={colors.secondary} fontSize={10} flex={1}>
              {truncate(text, 200)}
            </Text>
          </XStack>

          {/* Voice */}
          {voiceId && (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9} width={60}>
                Voice
              </Text>
              <Text color={colors.primary} fontSize={10}>
                {voiceId}
              </Text>
            </XStack>
          )}

          {/* Model */}
          <XStack alignItems="center" gap={6}>
            <Text color={colors.muted} fontSize={9} width={60}>
              Model
            </Text>
            <Text color={colors.secondary} fontSize={10} fontFamily="$mono">
              {modelId}
            </Text>
          </XStack>

          {/* Settings */}
          {(input?.stability !== undefined || input?.similarityBoost !== undefined) && (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9} width={60}>
                Settings
              </Text>
              <XStack gap={4}>
                {input.stability !== undefined && (
                  <Badge text={`stability: ${input.stability.toFixed(2)}`} variant="gray" />
                )}
                {input.similarityBoost !== undefined && (
                  <Badge
                    text={`similarity: ${input.similarityBoost.toFixed(2)}`}
                    variant="gray"
                  />
                )}
              </XStack>
            </XStack>
          )}

          {/* Output file */}
          {status === 'completed' && data?.filePath && (
            <>
              <XStack alignItems="center" gap={6}>
                <Text color={colors.muted} fontSize={9} width={60}>
                  Output
                </Text>
                <Text color={colors.bright} fontSize={10} fontFamily="$mono" flex={1}>
                  {data.filePath}
                </Text>
              </XStack>

              {/* Audio player */}
              <YStack
                backgroundColor={colors.bgInner}
                borderRadius={5}
                padding={8}
                borderWidth={1}
                borderColor={colors.border}
              >
                <audio
                  controls
                  style={{
                    width: '100%',
                    height: 32,
                    outline: 'none',
                  }}
                  src={getFileUrl(data.filePath)}
                >
                  Your browser does not support audio playback.
                </audio>
              </YStack>
            </>
          )}

          {/* Character count */}
          {data?.characterCount && (
            <XStack alignItems="center" gap={6}>
              <Text color={colors.muted} fontSize={9} width={60}>
                Characters
              </Text>
              <Text color={colors.secondary} fontSize={10}>
                {data.characterCount}
              </Text>
            </XStack>
          )}

          {/* Error */}
          {displayError && (
            <XStack alignItems="flex-start" gap={6}>
              <Text color={colors.muted} fontSize={9} width={60}>
                Error
              </Text>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                {displayError}
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}
