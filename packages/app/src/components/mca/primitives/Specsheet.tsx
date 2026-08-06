import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { useColors } from './useColors';

export interface SpecsheetRow {
  key: string;
  value: React.ReactNode;
}

export interface SpecsheetSection {
  title: string;
  rows: SpecsheetRow[];
}

interface SpecsheetProps {
  sections: SpecsheetSection[];
}

/**
 * Editorial datasheet. Sustituto del `KeyValueGrid` plano cuando hay datos
 * agrupados por dominio (Identity / Physical / Timeline en `stat`,
 * Roots / Diagnostics en `health-check`, etc.).
 *
 *   IDENTITY ──────────────────────
 *     name        photo.png
 *     type        file
 *     mime        image/png
 *
 *   PHYSICAL ──────────────────────
 *     size        12.4 KB
 *     ...
 *
 * Solo composición de Tamagui primitivos — cero estilos hard-coded fuera
 * de los tokens del sistema.
 */
export function Specsheet({ sections }: SpecsheetProps): React.ReactNode {
  const c = useColors();
  if (!sections || sections.length === 0) return null;
  return (
    <YStack gap={10}>
      {sections.map((section, idx) => (
        <YStack
          // biome-ignore lint/suspicious/noArrayIndexKey: stable
          key={`${section.title}-${idx}`}
          gap={4}
        >
          <XStack alignItems="center" gap={6}>
            <Text
              color={c.text3}
              fontSize={9}
              fontFamily="$mono"
              fontWeight="bold"
              letterSpacing={1.2}
              textTransform="uppercase"
            >
              {section.title}
            </Text>
            <YStack flex={1} height={1} backgroundColor={c.border} />
          </XStack>
          <YStack gap={2}>
            {section.rows.map((row, rowIdx) => (
              <XStack
                // biome-ignore lint/suspicious/noArrayIndexKey: stable
                key={`${row.key}-${rowIdx}`}
                gap={12}
                alignItems="baseline"
              >
                <Text
                  color={c.text3}
                  fontSize={10}
                  fontFamily="$mono"
                  width={88}
                >
                  {row.key}
                </Text>
                <YStack flex={1}>
                  {typeof row.value === 'string' ? (
                    <Text color={c.text} fontSize={11} fontFamily="$mono">
                      {row.value}
                    </Text>
                  ) : (
                    row.value
                  )}
                </YStack>
              </XStack>
            ))}
          </YStack>
        </YStack>
      ))}
    </YStack>
  );
}
