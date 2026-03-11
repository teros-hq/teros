/**
 * Avatar component - displays user/agent avatar with fallback to initials
 */

import React from 'react';
import { Image, Platform } from 'react-native';
import { Text, View } from 'tamagui';

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

  // Agent: cyan background, User: gray background
  const bgColor = isAgent ? 'rgba(6, 182, 212, 0.3)' : 'rgba(255, 255, 255, 0.15)';
  const textColor = isAgent ? '#06B6D4' : 'rgba(255, 255, 255, 0.7)';

  if (imageUrl) {
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
          />
        ) : (
          <Image
            source={{ uri: imageUrl }}
            style={{
              width: size,
              height: size,
              borderRadius: size / 2,
            }}
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
