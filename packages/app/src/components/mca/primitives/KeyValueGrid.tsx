import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { useColors } from './useColors';

export interface KeyValueRow {
  key: string;
  value: React.ReactNode;
  /**
   * If true, renders the value in `$mono` font. Useful for IDs, hashes,
   * paths, code snippets. When `value` is already a React node, this
   * prop is ignored (the node controls its own font).
   */
  mono?: boolean;
}

interface KeyValueGridProps {
  rows: KeyValueRow[];
  keyWidth?: number;
}

export function KeyValueGrid({ rows, keyWidth = 90 }: KeyValueGridProps) {
  const c = useColors();
  if (rows.length === 0) return null;

  return (
    <YStack gap={3}>
      {rows.map(({ key, value, mono }) => (
        <XStack key={key} gap={8} alignItems="flex-start">
          <Text
            width={keyWidth}
            color={c.text2}
            fontSize={10}
            fontFamily="$mono"
            flexShrink={0}
          >
            {key}
          </Text>
          {typeof value === 'string' || typeof value === 'number' ? (
            <Text
              flex={1}
              color={c.text}
              fontSize={10}
              fontFamily={mono ? '$mono' : undefined}
            >
              {value}
            </Text>
          ) : (
            <YStack flex={1}>{value}</YStack>
          )}
        </XStack>
      ))}
    </YStack>
  );
}
