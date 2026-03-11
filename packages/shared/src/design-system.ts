/**
 * Teros Design System Constants
 *
 * Shared constants for colors, icons, and other design tokens.
 * Used by both frontend and backend for validation and rendering.
 */

// ============================================================================
// COLORS
// ============================================================================

/**
 * Available workspace colors (use the 500 shade as primary)
 */
export const WORKSPACE_COLORS = [
  'gray',
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
    '50': '#FAFAFA',
    '100': '#E5E5E5',
    '200': '#C4C4C4',
    '300': '#9A9A9A',
    '400': '#6B6B6B',
    '500': '#4A4A4A',
    '600': '#2E2E2E',
    '700': '#1F1F1F',
    '800': '#141414',
    '900': '#0A0A0A',
  },
  blue: {
    '50': '#E8F1F8',
    '100': '#C5DCF0',
    '200': '#9AC4E4',
    '300': '#6AAAD6',
    '400': '#4A93C9',
    '500': '#3B82C4',
    '600': '#3271AB',
    '700': '#285A8A',
    '800': '#1F4569',
    '900': '#1A3A52',
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
 * Curated list of ~120 icons suitable for workspace identification
 */
export const WORKSPACE_ICONS = [
  // General / Abstract
  'box',
  'circle',
  'square',
  'triangle',
  'hexagon',
  'pentagon',
  'octagon',
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
  'building',
  'building-2',
  'landmark',
  'store',
  'factory',
  'wallet',
  'credit-card',
  'piggy-bank',
  'banknote',
  'receipt',
  'calculator',

  // Tech / Development
  'code',
  'code-2',
  'terminal',
  'cpu',
  'server',
  'database',
  'hard-drive',
  'git-branch',
  'git-commit',
  'git-merge',
  'bug',
  'wrench',
  'settings',
  'cog',

  // Files / Documents
  'file',
  'file-text',
  'file-code',
  'folder',
  'folder-open',
  'archive',
  'clipboard',
  'clipboard-list',
  'book-open',
  'book',
  'notebook',
  'library',

  // Communication
  'mail',
  'message-circle',
  'message-square',
  'phone',
  'video',
  'radio',
  'megaphone',
  'bell',
  'send',
  'inbox',
  'at-sign',

  // Creative / Design
  'palette',
  'paintbrush',
  'pen-tool',
  'pencil',
  'brush',
  'eraser',
  'camera',
  'image',
  'film',
  'music',
  'mic',
  'headphones',

  // Science / Analytics
  'flask',
  'microscope',
  'atom',
  'dna',
  'brain',
  'activity',
  'bar-chart',
  'pie-chart',
  'trending-up',
  'line-chart',
  'target',

  // Nature / Environment
  'sun',
  'moon',
  'cloud',
  'umbrella',
  'snowflake',
  'leaf',
  'tree',
  'flower',
  'mountain',
  'waves',
  'wind',

  // Transport / Travel
  'car',
  'plane',
  'ship',
  'rocket',
  'bike',
  'train',
  'globe',
  'map',
  'map-pin',
  'compass',
  'navigation',

  // People / Social
  'user',
  'users',
  'user-circle',
  'user-plus',
  'hand-heart',
  'home',
  'school',
  'graduation-cap',
  'trophy',

  // Security / Privacy
  'shield',
  'shield-check',
  'lock',
  'unlock',
  'key',
  'fingerprint',
  'eye',
  'eye-off',
  'scan',

  // Time / Calendar
  'clock',
  'calendar',
  'timer',
  'hourglass',
  'history',
  'alarm-clock',

  // Misc Useful
  'lightbulb',
  'puzzle',
  'gamepad-2',
  'dice-5',
  'gift',
  'package',
  'shopping-cart',
  'shopping-bag',
  'tag',
  'bookmark',
  'flag',
  'anchor',
] as const;

export type WorkspaceIcon = (typeof WORKSPACE_ICONS)[number];

/**
 * Check if a string is a valid workspace color
 */
export function isValidWorkspaceColor(color: string): color is WorkspaceColor {
  return WORKSPACE_COLORS.includes(color as WorkspaceColor);
}

/**
 * Check if a string is a valid workspace icon
 */
export function isValidWorkspaceIcon(icon: string): icon is WorkspaceIcon {
  return WORKSPACE_ICONS.includes(icon as WorkspaceIcon);
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
