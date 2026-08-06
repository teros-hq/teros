import type React from 'react';
import { Image, Text, XStack } from 'tamagui';
import { colors } from './colors';

interface AvatarProps {
  /** URL de la imagen. Si falta, se pinta el fallback con inicial. */
  src?: string;
  /** Texto para extraer inicial cuando no hay src (e.g., fullName). */
  name?: string;
  /** Tamaño en px. Default 20. */
  size?: number;
  /** Color de fondo del fallback. Default auto según `name`. */
  bg?: string;
}

const FALLBACK_COLORS = [
  '#5E6AD2', // purple
  '#22c55e', // green
  '#ef4444', // red
  '#f59e0b', // amber
  '#3b82f6', // blue
  '#a855f7', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
];

function colorFromName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const idx = Math.abs(hash) % FALLBACK_COLORS.length;
  return FALLBACK_COLORS[idx] ?? colors.indigo;
}

function getInitial(name?: string): string {
  if (!name) return '?';
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return trimmed.charAt(0).toUpperCase();
}

export function Avatar({ src, name, size = 20, bg }: AvatarProps): React.ReactNode {
  if (src) {
    return (
      <Image source={{ uri: src }} width={size} height={size} borderRadius={size / 2} />
    );
  }

  const initial = getInitial(name);
  const backgroundColor = bg ?? colorFromName(name ?? '?');
  const fontSize = Math.max(8, Math.round(size * 0.5));

  return (
    <XStack
      width={size}
      height={size}
      borderRadius={size / 2}
      backgroundColor={backgroundColor}
      alignItems="center"
      justifyContent="center"
      flexShrink={0}
    >
      <Text color="white" fontSize={fontSize} fontWeight="600">
        {initial}
      </Text>
    </XStack>
  );
}
