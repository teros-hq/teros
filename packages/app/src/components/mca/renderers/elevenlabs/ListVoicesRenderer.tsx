/**
 * List Voices Renderer
 */

import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import type { ToolCallRendererProps } from '../../types';
import { Badge, colors, ExpandedBody, ExpandedContainer, HeaderRow, parseOutput } from './shared';

interface Voice {
  voiceId: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  previewUrl?: string;
}

interface ListVoicesOutput {
  voices: Voice[];
}

interface SubRendererProps extends ToolCallRendererProps {
  expanded: boolean;
  onToggle: () => void;
}

export function ListVoicesRenderer({
  input,
  status,
  output,
  error,
  duration,
  expanded,
  onToggle,
}: SubRendererProps) {
  const data = parseOutput<ListVoicesOutput>(output);
  const count = data?.voices?.length ?? 0;
  const search = input?.search;
  const category = input?.category;

  const displayError = error || (status === 'failed' ? output : null);

  let description = 'List voices';
  if (search) {
    description += `: "${search}"`;
  } else if (category) {
    description += `: ${category}`;
  }

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as const }
      : count > 0
        ? { text: `${count} voices`, variant: 'blue' as const }
        : { text: '0 voices', variant: 'gray' as const };

  const headerProps = {
    status,
    description,
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
        <YStack backgroundColor={colors.bgInner} borderRadius={6} overflow="hidden">
          {/* Filters */}
          {(search || category) && (
            <XStack
              paddingVertical={6}
              paddingHorizontal={10}
              alignItems="center"
              gap={6}
              borderBottomWidth={1}
              borderBottomColor={colors.border}
            >
              {search && (
                <>
                  <Text color={colors.muted} fontSize={9}>
                    Search:
                  </Text>
                  <XStack
                    backgroundColor={colors.badgeBlue.bg}
                    paddingHorizontal={6}
                    paddingVertical={2}
                    borderRadius={3}
                  >
                    <Text color={colors.badgeBlue.text} fontSize={10} fontFamily="$mono">
                      {search}
                    </Text>
                  </XStack>
                </>
              )}
              {category && (
                <>
                  <Text color={colors.muted} fontSize={9}>
                    Category:
                  </Text>
                  <Badge text={category} variant="purple" />
                </>
              )}
            </XStack>
          )}

          {/* Error */}
          {displayError ? (
            <XStack paddingVertical={6} paddingHorizontal={10} alignItems="center" gap={6}>
              <Text color={colors.badgeRed.text} fontSize={10} flex={1}>
                {displayError}
              </Text>
            </XStack>
          ) : data?.voices && data.voices.length > 0 ? (
            /* Voice list */
            data.voices.map((voice, idx) => (
              <XStack
                key={voice.voiceId || idx}
                paddingVertical={6}
                paddingHorizontal={10}
                alignItems="center"
                gap={8}
                borderBottomWidth={idx < data.voices.length - 1 ? 1 : 0}
                borderBottomColor={colors.border}
              >
                <Text
                  color={colors.primary}
                  fontSize={10}
                  fontWeight="500"
                  flex={1}
                  numberOfLines={1}
                >
                  {voice.name}
                </Text>
                {voice.category && <Badge text={voice.category} variant="gray" />}
                <Text
                  color={colors.muted}
                  fontSize={9}
                  fontFamily="$mono"
                  flexShrink={0}
                  numberOfLines={1}
                >
                  {voice.voiceId ? `${voice.voiceId.slice(0, 8)}...` : 'N/A'}
                </Text>
              </XStack>
            ))
          ) : (
            <XStack paddingVertical={6} paddingHorizontal={10}>
              <Text color={colors.muted} fontSize={10}>
                No voices found
              </Text>
            </XStack>
          )}
        </YStack>
      </ExpandedBody>
    </ExpandedContainer>
  );
}
