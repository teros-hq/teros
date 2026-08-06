/**
 * Avatar component - displays user/agent avatar with fallback to initials
 */

import React from 'react';
import { Image, Platform } from 'react-native';
import { Text, View } from 'tamagui';
import { useImageWithFallback } from '../hooks/useImageWithFallback';
import { useColors } from './mca/primitives/useColors';
import { colors as semanticColors } from './mca/primitives/colors';

interface AvatarProps {
  /** Display name (used for initials fallback) */
  name: string;
  /** Avatar image URL */
  imageUrl?: string;
  /** Size in pixels (default: 32) */
  size?: number;
  /** Whether this is an agent (uses cyan color) or user (uses gray) */
  isAgent?: boolean;
}

/**
 * Get initials from a name (first letter of first and last word)
 */
function getInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length === 1) {
    return words[0].charAt(0).toUpperCase();
  }
  return (words[0].charAt(0) + words[words.length - 1].charAt(0)).toUpperCase();
}

export function Avatar({ name, imageUrl, size = 32, isAgent = false }: AvatarProps) {
  const initials = getInitials(name);
  const fontSize = Math.max(10, Math.floor(size * 0.4));
  const c = useColors();

  // Fall back to initials when the image fails to load (404, broken URL…) instead
  // of showing the browser's broken-image glyph. Without this, the initials branch
  // only renders when imageUrl is falsy — a present-but-404 URL stayed broken.
  const { showImage, onError } = useImageWithFallback(imageUrl);

  // Agent: cyan background, User: muted background
  const bgColor = isAgent ? semanticColors.indigoGlow : c.bgInner;
  const textColor = isAgent ? semanticColors.indigo : c.text2;

  if (showImage) {
    return (
      <View
        width={size}
        height={size}
        borderRadius={size / 2}
        overflow="hidden"
        backgroundColor={bgColor}
      >
        {Platform.OS === 'web' ? (
          <img
            src={imageUrl}
            alt={name}
            style={{
              width: size,
              height: size,
              borderRadius: size / 2,
              objectFit: 'cover',
            }}
            onError={onError}
          />
        ) : (
          <Image
            source={{ uri: imageUrl }}
            style={{
              width: size,
              height: size,
              borderRadius: size / 2,
            }}
            onError={onError}
          />
        )}
      </View>
    );
  }

  return (
    <View
      width={size}
      height={size}
      borderRadius={size / 2}
      backgroundColor={bgColor}
      alignItems="center"
      justifyContent="center"
    >
      <Text fontSize={fontSize} fontWeight="600" color={textColor}>
        {initials}
      </Text>
    </View>
  );
}
