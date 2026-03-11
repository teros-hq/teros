/**
 * Generate Conversation Renderer
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
} from './shared';

interface ConversationOutput {
  outputPath?: string;
  speakers?: number;
  lines?: number;
  duration?: number;
}

interface SubRendererProps extends ToolCallRendererProps {
  expanded: boolean;
  onToggle: () => void;
}

export function GenerateConversationRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const data = parseOutput<ConversationOutput>(output);
  const scriptPath = input?.scriptPath || '';
  const filename = scriptPath.split('/').pop() || scriptPath;

  const displayError = error || (status === 'failed' ? output : null);

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : data?.outputPath
        ? { text: 'generated', variant: 'green' as const }
        : undefined;

  const headerProps = {
    status,
    description: `Generate conversation: ${filename}`,
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
          {/* Script path */}
          <XStack alignItems="center" gap={6}>
            <Text color={colors.muted} fontSize={9} width={60}>
              Script
            </Text>
            <Text color={colors.secondary} fontSize={10} fontFamily="$mono" flex={1}>
              {scriptPath}
            </Text>
          </XStack>

          {/* Stats */}
          {status === 'completed' && (
            <>
              {data?.speakers && (
                <XStack alignItems="center" gap={6}>
                  <Text color={colors.muted} fontSize={9} width={60}>
                    Speakers
                  </Text>
                  <Text color={colors.primary} fontSize={10}>
                    {data.speakers}
                  </Text>
                </XStack>
              )}

              {data?.lines && (
                <XStack alignItems="center" gap={6}>
                  <Text color={colors.muted} fontSize={9} width={60}>
                    Lines
                  </Text>
                  <Text color={colors.primary} fontSize={10}>
                    {data.lines}
                  </Text>
                </XStack>
              )}

              {/* Output file */}
              {data?.outputPath && (
                <>
                  <XStack alignItems="center" gap={6}>
                    <Text color={colors.muted} fontSize={9} width={60}>
                      Output
                    </Text>
                    <Text color={colors.bright} fontSize={10} fontFamily="$mono" flex={1}>
                      {data.outputPath}
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
