import type React from 'react';
import { Text, XStack } from 'tamagui';
import { useColors } from './useColors';

interface PillListProps {
  /** Items simples como texto, o React nodes (Badge, IconChip) ya renderizados. */
  items: Array<string | React.ReactElement>;
  /** Máximo a mostrar; el resto se resume como "+N more". */
  max?: number;
  /** Accent para los pills auto-renderizados desde string. */
  accent?: string;
}

/**
 * Lista horizontal de pills compactos. Útil para tags, members, labels,
 * roles, categorías — cualquier lista plana que deba ser browseable en un
 * solo vistazo.
 *
 * Strings se convierten a pill simple; React elements (Badge, IconChip) se
 * insertan tal cual para permitir colores/iconos por item.
 */
export function PillList({ items, max = 8, accent }: PillListProps): React.ReactNode {
  const c = useColors();
  const visible = items.slice(0, max);
  const overflow = items.length - visible.length;
  const color = accent ?? c.text2;

  return (
    <XStack flexWrap="wrap" gap={4} alignItems="center">
      {visible.map((item, i) => {
        if (typeof item === 'string') {
          return (
            <XStack
              // biome-ignore lint/suspicious/noArrayIndexKey: stable, no reorder
              key={`${i}-${item}`}
              backgroundColor={`${color}1a`}
              borderWidth={1}
              borderColor={`${color}33`}
              borderRadius={3}
              paddingHorizontal={5}
              paddingVertical={1}
            >
              <Text color={color} fontSize={9} fontFamily="$mono">
                {item}
              </Text>
            </XStack>
          );
        }
        // React element — clonar con key
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable, no reorder
          <XStack key={i}>{item}</XStack>
        );
      })}
      {overflow > 0 && (
        <Text color={c.text3} fontSize={9} fontFamily="$mono">
          +{overflow} more
        </Text>
      )}
    </XStack>
  );
}
