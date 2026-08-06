/**
 * Teros Design System Constants
 *
 * Shared constants for colors, icons, and other design tokens.
 * Used by both frontend and backend for validation and rendering.
 */

import { LUCIDE_ICONS } from './generated/lucide-icons.js';

// ============================================================================
// COLORS
// ============================================================================

/**
 * Available workspace colors (use the 500 shade as primary)
 */
export const WORKSPACE_COLORS = [
  'gray',
  'indigo',   // Teros brand accent
  'blue',
  'cyan',
  'green',
  'amber',
  'orange',
  'red',
  'pink',
  'purple',
] as const;

export type WorkspaceColor = (typeof WORKSPACE_COLORS)[number];

/**
 * Color palette with all shades (50-900)
 * The 500 shade is the primary color for each scale
 */
export const COLOR_PALETTE: Record<WorkspaceColor, Record<string, string>> = {
  gray: {
    '50': '#F8F8FA',
    '100': '#E4E4E8',
    '200': '#C4C4CC',
    '300': '#9A9AA6',
    '400': '#6E6E7A',
    '500': '#4A4A56',
    '600': '#2E2E3A',
    '700': '#1F1F2A',
    '800': '#14141E',
    '900': '#0A0A0F',
  },
  indigo: {
    '50': '#F0EFFF',
    '100': '#E0DBFF',
    '200': '#C4B8FF',
    '300': '#A08FFF',
    '400': '#7E6EF2',
    '500': '#5E6AD2',
    '600': '#4F5BB8',
    '700': '#3F4A9E',
    '800': '#30397A',
    '900': '#21285A',
  },
  blue: {
    '50': '#EFF4FF',
    '100': '#DBE4FE',
    '200': '#BFCFFF',
    '300': '#93BBFD',
    '400': '#6094FA',
    '500': '#3B82F6',
    '600': '#2563EB',
    '700': '#1D4ED8',
    '800': '#1E40AF',
    '900': '#1E3A8A',
  },
  cyan: {
    '50': '#E9F4F6',
    '100': '#C9E4E9',
    '200': '#A1D0D9',
    '300': '#78BBC8',
    '400': '#5AABBB',
    '500': '#4A9BA8',
    '600': '#3E8490',
    '700': '#336C76',
    '800': '#28545C',
    '900': '#1D3D42',
  },
  green: {
    '50': '#EBF5ED',
    '100': '#CEE7D4',
    '200': '#A8D4B3',
    '300': '#7DBF8D',
    '400': '#5EAD72',
    '500': '#4A9E5B',
    '600': '#3F874E',
    '700': '#346E40',
    '800': '#295532',
    '900': '#1E3D24',
  },
  amber: {
    '50': '#F8F2E8',
    '100': '#EFDFC5',
    '200': '#E3C89A',
    '300': '#D6AE6A',
    '400': '#CE9D4A',
    '500': '#C4923B',
    '600': '#A87D32',
    '700': '#8A6629',
    '800': '#6B4F20',
    '900': '#4A3518',
  },
  orange: {
    '50': '#F9EFE8',
    '100': '#F0D8C7',
    '200': '#E5BC9E',
    '300': '#D99D72',
    '400': '#CF8450',
    '500': '#C4713B',
    '600': '#A86032',
    '700': '#8A4E29',
    '800': '#6B3D20',
    '900': '#4D2D1A',
  },
  red: {
    '50': '#F8EBEA',
    '100': '#EFCFCC',
    '200': '#E3ABA6',
    '300': '#D6847D',
    '400': '#CE6660',
    '500': '#C75450',
    '600': '#AB4844',
    '700': '#8C3B38',
    '800': '#6B2D2B',
    '900': '#4A1F1D',
  },
  pink: {
    '50': '#F8EBF0',
    '100': '#EFCFDB',
    '200': '#E3ABB8',
    '300': '#D68494',
    '400': '#CE667A',
    '500': '#C4546A',
    '600': '#A8485A',
    '700': '#8A3B4A',
    '800': '#6B2D3A',
    '900': '#4A1D30',
  },
  purple: {
    '50': '#F0EBF5',
    '100': '#DACFE8',
    '200': '#BFABD6',
    '300': '#A184C2',
    '400': '#8A66B2',
    '500': '#7A54A6',
    '600': '#68488E',
    '700': '#553B74',
    '800': '#422D5A',
    '900': '#2D1D42',
  },
};

/**
 * Get a specific shade of a color
 */
export function getColorShade(color: WorkspaceColor, shade: string = '500'): string {
  return COLOR_PALETTE[color]?.[shade] ?? COLOR_PALETTE.gray['500'];
}

// ============================================================================
// ICONS
// ============================================================================

/**
 * Available workspace icons (Lucide icon names in kebab-case)
 * Curated list of ~50 favourite icons shown by default in the icon picker.
 * Users can search across all ~1760 Lucide icons using the search input.
 */
export const WORKSPACE_ICONS = [
  // General / Abstract
  'folder',
  'box',
  'star',
  'heart',
  'zap',
  'sparkles',
  'flame',
  'gem',
  'crown',
  'award',

  // Work / Business
  'briefcase',
  'building-2',
  'wallet',
  'calculator',
  'chart-bar',
  'trending-up',
  'target',

  // Tech / Development
  'code',
  'terminal',
  'cpu',
  'server',
  'database',
  'git-branch',
  'bug',
  'wrench',
  'settings',

  // Files / Documents
  'file-text',
  'file-code',
  'book-open',
  'notebook',
  'clipboard-list',
  'library',

  // Communication
  'mail',
  'message-circle',
  'bell',
  'megaphone',
  'send',

  // Creative / Design
  'palette',
  'paintbrush',
  'camera',
  'music',
  'headphones',

  // People / Social
  'user',
  'users',
  'home',
  'graduation-cap',
  'trophy',

  // Science / Analytics
  'brain',
  'atom',
  'microscope',

  // Misc Useful
  'lightbulb',
  'rocket',
  'globe',
  'shield',
  'key',
  'clock',
  'calendar',
  'bookmark',
  'flag',
  'package',
] as const;

export type WorkspaceIcon = (typeof WORKSPACE_ICONS)[number] | string;

/**
 * Check if a string is a valid workspace color
 */
export function isValidWorkspaceColor(color: string): color is WorkspaceColor {
  return WORKSPACE_COLORS.includes(color as WorkspaceColor);
}

/**
 * Check if a string is a valid workspace icon.
 * Validates against the full set of real Lucide icon names (kebab-case).
 * Generated from @tamagui/lucide-icons — run `bun run generate-icons` in packages/shared to update.
 */
export function isValidWorkspaceIcon(icon: string): icon is WorkspaceIcon {
  return LUCIDE_ICONS.has(icon);
}

/**
 * Convert kebab-case icon name to PascalCase for React imports
 * e.g., 'git-branch' -> 'GitBranch'
 */
export function iconToPascalCase(icon: string): string {
  return icon
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Convert PascalCase to kebab-case
 * e.g., 'GitBranch' -> 'git-branch'
 */
export function iconToKebabCase(icon: string): string {
  return icon
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}
