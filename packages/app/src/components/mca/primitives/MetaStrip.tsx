import type React from 'react';
import { Text, XStack } from 'tamagui';
import { useColors } from './useColors';

interface MetaItem {
  /** Short label (will be rendered muted, uppercase-tracked). */
  key: string;
  /** Value text. Numbers are stringified by the caller. */
  value: string;
  /** Optional accent dot before the key. */
  accent?: string;
}

interface MetaStripProps {
  items: MetaItem[];
  /** Hide labels when only the values matter. Default false. */
  valuesOnly?: boolean;
}

/**
 * Horizontal strip of compact key-value pills. Sustituto editorial del
 * `KeyValueGrid` cuando los pares son pocos (≤6) y caben en una línea.
 *
 * Cada pill:  [• KEY] value     [• KEY] value     ...
 *
 * Wrap si overflow. No background sólido — la jerarquía la da el contraste
 * tipográfico (key muted small, value bright mono).
 */
export function MetaStrip({ items, valuesOnly }: MetaStripProps): React.ReactNode {
  const c = useColors();
  if (!items || items.length === 0) return null;
  return (
    <XStack flexWrap="wrap" gap={12} alignItems="center" paddingVertical={2}>
      {items.map((item, idx) => (
        <XStack
          // biome-ignore lint/suspicious/noArrayIndexKey: stable order by caller
          key={`${item.key}-${idx}`}
          alignItems="center"
          gap={5}
        >
          {item.accent ? (
            <Text color={item.accent} fontSize={10} lineHeight={10}>
              ●
            </Text>
          ) : null}
          {!valuesOnly && (
            <Text
              color={c.text3}
              fontSize={9}
              fontFamily="$mono"
              letterSpacing={0.6}
              textTransform="uppercase"
            >
              {item.key}
            </Text>
          )}
          <Text color={c.text} fontSize={11} fontFamily="$mono">
            {item.value}
          </Text>
        </XStack>
      ))}
    </XStack>
  );
}
