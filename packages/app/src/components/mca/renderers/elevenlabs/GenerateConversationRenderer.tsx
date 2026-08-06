/**
 * Generate Conversation Renderer
 */

import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { Badge, ErrorBlock, ToolCallCard } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { useElevenLabsColors, getFileUrl, parseOutput } from './shared';

interface ConversationOutput {
  outputPath?: string;
  speakers?: number;
  lines?: number;
  duration?: number;
}

export function GenerateConversationRenderer({
  input,
  status,
  output,
  error,
  appIcon,
}: ToolCallRendererProps) {
  const c = useElevenLabsColors();
  const colors = useElevenLabsColors();
  const data = parseOutput<ConversationOutput>(output);
  const scriptPath = input?.scriptPath || '';
  const filename = scriptPath.split('/').pop() || scriptPath;

  const displayError = error || (status === 'failed' ? output : null);

  const badge =
    status === 'failed'
      ? <Badge text="failed" variant="error" />
      : data?.outputPath
        ? <Badge text="generated" variant="success" />
        : null;

  return (
    <ToolCallCard
      status={status}
      description={`Generate conversation: ${filename}`}
      badge={badge}
      iconUri={appIcon}
    >
      <YStack backgroundColor={c.bgInner} borderRadius={6} padding={10} gap={6}>
        {/* Script path */}
        <XStack alignItems="center" gap={6}>
          <Text color={c.text3} fontSize={9} width={60}>
            Script
          </Text>
          <Text color={c.text2} fontSize={10} fontFamily="$mono" flex={1}>
            {scriptPath}
          </Text>
        </XStack>

        {/* Stats */}
        {status === 'completed' && (
          <>
            {data?.speakers && (
              <XStack alignItems="center" gap={6}>
                <Text color={c.text3} fontSize={9} width={60}>
                  Speakers
                </Text>
                <Text color={c.text} fontSize={10}>
                  {data.speakers}
                </Text>
              </XStack>
            )}

            {data?.lines && (
              <XStack alignItems="center" gap={6}>
                <Text color={c.text3} fontSize={9} width={60}>
                  Lines
                </Text>
                <Text color={c.text} fontSize={10}>
                  {data.lines}
                </Text>
              </XStack>
            )}

            {/* Output file */}
            {data?.outputPath && (
              <>
                <XStack alignItems="center" gap={6}>
                  <Text color={c.text3} fontSize={9} width={60}>
                    Output
                  </Text>
                  <Text color={c.text} fontSize={10} fontFamily="$mono" flex={1}>
                    {data.outputPath}
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
                    src={getFileUrl(data.outputPath)}
                  >
                    Your browser does not support audio playback.
                  </audio>
                </YStack>
              </>
            )}
          </>
        )}

        {/* Error */}
        {displayError && <ErrorBlock error={displayError} />}
      </YStack>
    </ToolCallCard>
  );
}
