/**
 * WorkspaceIcon Component
 *
 * Renders a Lucide icon dynamically based on the icon name (kebab-case).
 * Falls back to Folder icon if the icon is not found.
 */

import * as LucideIcons from '@tamagui/lucide-icons';
import { COLOR_PALETTE, type WorkspaceColor } from '@teros/shared';
import React from 'react';
import { StyleSheet, View } from 'react-native';

// Convert kebab-case to PascalCase
function toPascalCase(str: string): string {
  return str
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

interface WorkspaceIconProps {
  /** Icon name in kebab-case (e.g., 'git-branch', 'rocket') */
  icon?: string;
  /** Color name from design system (e.g., 'blue', 'purple') */
  color?: string;
  /** Icon size (default: 14) */
  size?: number;
  /** Whether to show background container (default: true) */
  showBackground?: boolean;
  /** Container size (default: 24) */
  containerSize?: number;
}

export function WorkspaceIcon({
  icon = 'folder',
  color = 'amber',
  size = 14,
  showBackground = true,
  containerSize = 24,
}: WorkspaceIconProps) {
  // Get the icon component
  const iconName = toPascalCase(icon);
  const IconComponent = (LucideIcons as any)[iconName] || LucideIcons.Folder;

  // Get colors from palette
  const palette = COLOR_PALETTE[color as WorkspaceColor] || COLOR_PALETTE.amber;
  const iconColor = palette['500'];
  const bgColor = palette['900'] + '40'; // 40 = 25% opacity in hex

  if (!showBackground) {
    return <IconComponent size={size} color={iconColor} />;
  }

  return (
    <View
      style={[
        styles.container,
        {
          width: containerSize,
          height: containerSize,
          backgroundColor: bgColor,
        },
      ]}
    >
      <IconComponent size={size} color={iconColor} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
