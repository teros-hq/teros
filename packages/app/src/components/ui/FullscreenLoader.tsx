/**
 * FullscreenLoader — Full-area centered loading state
 *
 * Replaces the repeated pattern of:
 *   <YStack flex={1} justifyContent="center" alignItems="center">
 *     <ActivityIndicator size="large" color="..." />
 *   </YStack>
 *
 * Usage:
 *   <FullscreenLoader />
 *   <FullscreenLoader size="lg" variant="brand" />
 *   <FullscreenLoader label="Loading data…" />
 */

import React from 'react';
import { Text, YStack } from 'tamagui';
import { AppSpinner, type SpinnerSize, type SpinnerVariant } from './AppSpinner';

export interface FullscreenLoaderProps {
  /** Size of the inner spinner (default: 'lg') */
  size?: SpinnerSize;
  /** Color variant (default: 'brand') */
  variant?: SpinnerVariant;
  /** Override color directly */
  color?: string;
  /** Optional label shown below the spinner */
  label?: string;
}

export function FullscreenLoader({
  size = 'lg',
  variant = 'brand',
  color,
  label,
}: FullscreenLoaderProps) {
  return (
    <YStack flex={1} justifyContent="center" alignItems="center" gap={12}>
      <AppSpinner size={size} variant={variant} color={color} />
      {label ? (
        <Text color="#71717A" fontSize={13}>
          {label}
        </Text>
      ) : null}
    </YStack>
  );
}
