import type React from 'react';
import { Image, Text, XStack } from 'tamagui';
import { colors } from './colors';

interface IconTileProps {
  /** URL de imagen. Prioriza sobre icon/fallback. */
  src?: string;
  /** Icon React node (fallback si no hay src). */
  icon?: React.ReactNode;
  /** Texto corto (ej. inicial o 2 letras) si no hay src ni icon. */
  label?: string;
  /** Tamaño en px. Default 32. */
  size?: number;
  /** Color acento: pinta el bg semi-translúcido y el label. */
  accent?: string;
  /** Rounded corners. Default 6 (suave, tipo app icon). */
  radius?: number;
}

export function IconTile({
  src,
  icon,
  label,
  size = 32,
  accent,
  radius = 6,
}: IconTileProps): React.ReactNode {
  if (src) {
    return (
      <Image source={{ uri: src }} width={size} height={size} borderRadius={radius} />
    );
  }

  const color = accent ?? colors.indigo;
  const bg = `${color}1a`;
  const fontSize = Math.max(9, Math.round(size * 0.35));

  return (
    <XStack
      width={size}
      height={size}
      borderRadius={radius}
      backgroundColor={bg}
      borderWidth={1}
      borderColor={`${color}33`}
      alignItems="center"
      justifyContent="center"
      flexShrink={0}
    >
      {icon ?? (
        <Text color={color} fontSize={fontSize} fontWeight="600" fontFamily="$mono">
          {label?.slice(0, 2) ?? '?'}
        </Text>
      )}
    </XStack>
  );
}
