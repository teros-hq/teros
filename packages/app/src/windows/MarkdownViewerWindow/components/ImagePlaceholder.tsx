/**
 * ImagePlaceholder
 *
 * Shown in place of any image node in the rendered Markdown.
 * - External images (http:// / https://) are always blocked (security constraint).
 * - Local workspace images are also shown as placeholders in v1.
 *
 * Displays the alt text and the blocked URL so the user knows what was there.
 */

import React from 'react';
import { Platform } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { useColors } from '../../../components/mca/primitives/useColors';
import { colors as semanticColors } from '../../../components/mca/primitives/colors';

interface ImagePlaceholderProps {
  /** Alt text from the Markdown image syntax */
  alt?: string;
  /** The src URL that was blocked */
  url?: string;
  /** True when the image is a local workspace path (not external) */
  local?: boolean;
}

export function ImagePlaceholder({ alt, url, local = false }: ImagePlaceholderProps) {
  const c = useColors();
  const label = local ? 'Local image (not loaded in v1)' : 'External image blocked';
  const icon = '🖼️';

  if (Platform.OS === 'web') {
    return (
      <div
        style={{
          display: 'inline-flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 4,
          padding: '8px 12px',
          margin: '4px 0',
          border: `1.5px dashed ${semanticColors.indigo}66`,
          borderRadius: 8,
          backgroundColor: semanticColors.indigoGlow,
          maxWidth: '100%',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 16 }}>{icon}</span>
          <span
            style={{
              fontSize: 12,
              color: semanticColors.indigoLight,
              fontWeight: 500,
            }}
          >
            {label}
          </span>
        </div>
        {alt && (
          <span style={{ fontSize: 12, color: c.text2, fontStyle: 'italic' }}>
            {alt}
          </span>
        )}
        {url && (
          <span
            style={{
              fontSize: 11,
              color: c.text3,
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              wordBreak: 'break-all',
            }}
          >
            {url}
          </span>
        )}
      </div>
    );
  }

  // Native fallback
  return (
    <YStack
      borderWidth={1.5}
      borderStyle="dashed"
      borderColor={`${semanticColors.indigo}66`}
      borderRadius={8}
      backgroundColor={semanticColors.indigoGlow}
      padding={10}
      marginVertical={4}
      gap={4}
    >
      <XStack alignItems="center" gap={6}>
        <Text fontSize={16}>{icon}</Text>
        <Text fontSize={12} color={semanticColors.indigoLight} fontWeight="500">
          {label}
        </Text>
      </XStack>
      {alt ? (
        <Text fontSize={12} color={c.text2} fontStyle="italic">
          {alt}
        </Text>
      ) : null}
      {url ? (
        <Text fontSize={11} color={c.text3} fontFamily="$mono">
          {url}
        </Text>
      ) : null}
    </YStack>
  );
}
