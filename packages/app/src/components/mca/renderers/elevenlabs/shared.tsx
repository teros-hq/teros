/**
 * Shared utilities for ElevenLabs renderer.
 *
 * Components (HeaderRow, StatusDot, ExpandedContainer, ErrorBlock,
 * SuccessBlock, Badge) live in `../../primitives` — this file only
 * exposes the renderer-local palette hook and pure helpers.
 */

import { colors, statusDotColors, useColors, useMcaTheme } from '../../primitives';
import { getTerosClient } from '../../../../services/terosClientSingleton';

// Get backend base URL for static assets and workspace files
function getBackendUrl(): string {
  try {
    const client = getTerosClient();
    return client.getBackendBaseUrl();
  } catch {
    return '';
  }
}

// ElevenLabs icon from backend static — lazy to avoid module-scope initialization error
export function getElevenLabsIcon(): string {
  return `${getBackendUrl()}/static/elevenlabs-icon.png`;
}

// ============================================================================
// Colors — Renderer UX Guide v2 §5 (theme-adaptive).
// ============================================================================

export function useElevenLabsColors() {
  const c = useColors();
  const theme = useMcaTheme();
  const isDark = theme === 'dark';

  return {
    // Status dot (semantic, theme-agnostic — guide §3)
    success: colors.green,
    running: colors.indigo,
    failed: colors.red,

    glowSuccess: statusDotColors.completed.glow,
    glowRunning: statusDotColors.running.glow,
    glowFailed: statusDotColors.failed.glow,

    // Badges (theme-adaptive)
    badgeGray: c.badges.gray,
    badgeGreen: c.badges.ok,
    badgeBlue: c.badges.info,
    badgeYellow: c.badges.warn,
    badgeRed: c.badges.err,
    // Purple badge — text tint inverts between themes for readability.
    badgePurple: {
      bg: 'rgba(139,92,246,0.1)',
    },

    // Text (theme-adaptive)
    primary: c.text,
    secondary: c.text2,
    muted: c.text3,
    bright: c.text,

    // Backgrounds (theme-adaptive)
    borderLight: c.borderStrong,
    ...c,  // spread all adaptive tokens
  };
}

// ============================================================================
// Utilities
// ============================================================================

export function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function parseOutput<T>(output?: string): T | null {
  if (!output) return null;
  try {
    return JSON.parse(output) as T;
  } catch {
    return null;
  }
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

export function formatCharacters(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1000000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Convert /workspace path to backend-accessible URL
 * /workspace/file.mp3 -> http://backend/workspace/file.mp3
 */
export function getFileUrl(filePath: string): string {
  if (!filePath) return '';
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
    return filePath;
  }
  const backendUrl = getBackendUrl();
  const cleanPath = filePath.replace(/^\/workspace\//, '');
  return `${backendUrl}/workspace/${cleanPath}`;
}

// `Badge` is re-exported from the global primitives — same variants
// ('success'|'error'|'info'|'warning'|'gray') are theme-adaptive.
export { Badge } from '../../primitives';
