/**
 * Text-to-Speech Renderer
 */

import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { Badge, ErrorBlock, ToolCallCard } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { useElevenLabsColors, getFileUrl, parseOutput, truncate } from './shared';

interface TTSOutput {
  filePath?: string;
  duration?: number;
  characterCount?: number;
}

export function TextToSpeechRenderer({
  input,
  status,
  output,
  error,
  appIcon,
}: ToolCallRendererProps) {
  const c = useElevenLabsColors();
  const colors = useElevenLabsColors();
  const data = parseOutput<TTSOutput>(output);
  const text = input?.text || '';
  const voiceId = input?.voiceId;
  const modelId = input?.modelId || 'eleven_flash_v2_5';

  const displayError = error || (status === 'failed' ? output : null);

  const badge =
    status === 'failed'
      ? <Badge text="failed" variant="error" />
      : data?.filePath
        ? <Badge text="generated" variant="success" />
        : null;

  return (
    <ToolCallCard
      status={status}
      description={`Generate speech: "${truncate(text, 35)}"`}
      badge={badge}
      iconUri={appIcon}
    >
      <YStack backgroundColor={c.bgInner} borderRadius={6} padding={10} gap={6}>
        {/* Text */}
        <XStack alignItems="flex-start" gap={6}>
          <Text color={c.text3} fontSize={9} width={60} flexShrink={0}>
            Text
          </Text>
          <Text color={c.text2} fontSize={10} flex={1}>
            {truncate(text, 200)}
          </Text>
        </XStack>

        {/* Voice */}
        {voiceId && (
          <XStack alignItems="center" gap={6}>
            <Text color={c.text3} fontSize={9} width={60}>
              Voice
            </Text>
            <Text color={c.text} fontSize={10}>
              {voiceId}
            </Text>
          </XStack>
        )}

        {/* Model */}
        <XStack alignItems="center" gap={6}>
          <Text color={c.text3} fontSize={9} width={60}>
            Model
          </Text>
          <Text color={c.text2} fontSize={10} fontFamily="$mono">
            {modelId}
          </Text>
        </XStack>

        {/* Settings */}
        {(input?.stability !== undefined || input?.similarityBoost !== undefined) && (
          <XStack alignItems="center" gap={6}>
            <Text color={c.text3} fontSize={9} width={60}>
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
              <Text color={c.text3} fontSize={9} width={60}>
                Output
              </Text>
              <Text color={c.text} fontSize={10} fontFamily="$mono" flex={1}>
                {data.filePath}
              </Text>
            </XStack>

            {/* Audio player */}
            <YStack
              backgroundColor={c.bgInner}
              borderRadius={5}
              padding={8}
              borderWidth={1}
              borderColor={c.border}
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
            <Text color={c.text3} fontSize={9} width={60}>
              Characters
            </Text>
            <Text color={c.text2} fontSize={10}>
              {data.characterCount}
            </Text>
          </XStack>
        )}

        {/* Error */}
        {displayError && <ErrorBlock error={displayError} />}
      </YStack>
    </ToolCallCard>
  );
}
