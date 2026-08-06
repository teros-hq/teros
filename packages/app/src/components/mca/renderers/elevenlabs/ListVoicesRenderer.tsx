/**
 * List Voices Renderer
 */

import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { Badge, ErrorBlock, ToolCallCard } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { useElevenLabsColors, parseOutput } from './shared';

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

export function ListVoicesRenderer({
  input,
  status,
  output,
  error,
  appIcon,
}: ToolCallRendererProps) {
  const c = useElevenLabsColors();
  const colors = useElevenLabsColors();
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
      ? <Badge text="failed" variant="error" />
      : count > 0
        ? <Badge text={`${count} voices`} variant="info" />
        : <Badge text="0 voices" variant="gray" />;

  return (
    <ToolCallCard
      status={status}
      description={description}
      badge={badge}
      iconUri={appIcon}
    >
      <YStack backgroundColor={c.bgInner} borderRadius={6} overflow="hidden">
        {/* Filters */}
        {(search || category) && (
          <XStack
            paddingVertical={6}
            paddingHorizontal={10}
            alignItems="center"
            gap={6}
            borderBottomWidth={1}
            borderBottomColor={c.border}
          >
            {search && (
              <>
                <Text color={c.text3} fontSize={9}>
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
                <Text color={c.text3} fontSize={9}>
                  Category:
                </Text>
                <Badge text={category} variant="info" />
              </>
            )}
          </XStack>
        )}

        {/* Error */}
        {displayError ? (
          <YStack padding={10}>
            <ErrorBlock error={displayError} />
          </YStack>
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
              borderBottomColor={c.border}
            >
              <Text
                color={c.text}
                fontSize={10}
                fontWeight="500"
                flex={1}
                numberOfLines={1}
              >
                {voice.name}
              </Text>
              {voice.category && <Badge text={voice.category} variant="gray" />}
              <Text
                color={c.text3}
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
            <Text color={c.text3} fontSize={10}>
              No voices found
            </Text>
          </XStack>
        )}
      </YStack>
    </ToolCallCard>
  );
}
