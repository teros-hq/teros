import type React from 'react';
import { Text, XStack } from 'tamagui';
import { useColors } from './useColors';

interface IconChipProps {
  /** Icon React node (p.ej. <User size={9} color={...} />). Opcional. */
  icon?: React.ReactNode;
  /** Texto corto del chip. */
  text: string;
  /** Color de acento — afecta texto, borde y fondo semi-translúcido. */
  accent?: string;
  /** Si true, pinta solo el borde y el texto (sin fondo). Default false. */
  outline?: boolean;
}

export function IconChip({ icon, text, accent, outline = false }: IconChipProps): React.ReactNode {
  const c = useColors();
  // Default accent: theme-adaptive info badge text (good contrast in both themes).
  const color = accent ?? c.badges.info.text;
  const bg = outline ? 'transparent' : `${color}1a`; // ~10% alpha
  const borderColor = outline ? `${color}66` : `${color}33`;

  return (
    <XStack
      backgroundColor={bg}
      borderWidth={1}
      borderColor={borderColor}
      borderRadius={3}
      paddingHorizontal={5}
      paddingVertical={1}
      alignItems="center"
      gap={3}
    >
      {icon}
      <Text color={color} fontSize={9} fontFamily="$mono">
        {text}
      </Text>
    </XStack>
  );
}
