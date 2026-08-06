/**
 * Railway Renderer - Shared Constants, Types & Helpers
 *
 * Renderer UX Guide v2/v2.1 — zero local components; identity comes from:
 *  - the global `ToolCallCard` (logo via `iconUri`)
 *  - the Railway palette in `useRailwayColors()`
 *  - vendor enum colors (deploy status → variant via `getDeployStatusVariant`)
 */

import { colors, useColors, useMcaTheme } from '../../primitives';
import type React from 'react';
import { Text, XStack } from 'tamagui';

// ============================================================================
// Colors — theme-adaptive Railway palette
// ============================================================================

export function useRailwayColors() {
  const c = useColors();
  const theme = useMcaTheme();
  const isDark = theme === 'dark';

  return {
    // Expose the full v2 adaptive surface set (bgPage, bgCard, text, text2,
    // text3, border, borderStrong, shadow, …) plus badges.
    ...c,

    theme,
    isDark,

    // Railway brand (theme-agnostic vendor identity)
    railwayRed: '#E54D2E',
    railwayRedDim: '#C43E22',

    // Brand icon (theme-agnostic)
    icon: '#E54D2E',

    // Badges (theme-adaptive — semantic enum)
    badgeSuccess: c.badges.ok,
    badgeError: c.badges.err,
    badgeInfo: c.badges.info,
    badgeWarning: c.badges.warn,
    badgeGray: c.badges.gray,
    badgeRailway: { text: '#fca89a', bg: 'rgba(229,77,46,0.12)' },

    // Deploy status (semantic, theme-agnostic) — reuse the shared Design
    // System tokens so success/error/warning never drift from the rest of
    // the renderer system. Sleeping uses a mid-gray with no DS equivalent.
    deploying: colors.amber,
    deploySuccess: colors.green,
    deployFailed: colors.red,
    deploySleeping: '#6b7280',

    // Text (theme-adaptive) — legacy aliases for v2 text/text2/text3
    primary: c.text,
    secondary: c.text2,
    muted: c.text3,

    // Backgrounds (theme-adaptive) — legacy aliases
    bgInner: c.bgInner,
    bgDark: c.bgInner,
    border: c.border,
  };
}

// ============================================================================
// Types
// ============================================================================

export type DeployStatus =
  | 'DEPLOYING'
  | 'SUCCESS'
  | 'FAILED'
  | 'SLEEPING'
  | 'CRASHED'
  | 'REMOVING'
  | 'REMOVED'
  | 'WAITING'
  | 'SKIPPED'
  | string;

export interface RailwayProject {
  id: string;
  name: string;
  description?: string;
  createdAt?: string;
  environments?: Array<{ id: string; name: string }>;
  services?: Array<{ id: string; name: string }>;
}

export interface RailwayService {
  id: string;
  name: string;
}

export interface RailwayEnvironment {
  id: string;
  name: string;
}

export interface RailwayDeployment {
  id: string;
  status: DeployStatus;
  createdAt?: string;
  updatedAt?: string;
  url?: string | null;
  staticUrl?: string | null;
}

// ============================================================================
// Utilities
// ============================================================================

export function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

export function parseOutput<T>(output: string): T | string | null {
  try {
    return JSON.parse(output) as T;
  } catch {
    return output;
  }
}

export function truncate(text: string, maxLength: number = 50): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

// Deploy status colors — reuse the shared Design System semantic tokens
// (green/amber/red) so they never drift from the rest of the renderer system.
// Sleeping uses a mid-gray with no DS equivalent.
const DEPLOY_COLORS = {
  success: colors.green,
  deploying: colors.amber,
  failed: colors.red,
  sleeping: '#6b7280',
};

export function getDeployStatusColor(status?: DeployStatus): string {
  if (!status) return DEPLOY_COLORS.sleeping;
  const upper = status.toUpperCase();
  if (upper === 'SUCCESS') return DEPLOY_COLORS.success;
  if (upper === 'DEPLOYING' || upper === 'WAITING') return DEPLOY_COLORS.deploying;
  if (upper === 'FAILED' || upper === 'CRASHED' || upper === 'REMOVING' || upper === 'REMOVED')
    return DEPLOY_COLORS.failed;
  return DEPLOY_COLORS.sleeping;
}

export function getDeployStatusVariant(
  status?: DeployStatus,
): 'success' | 'error' | 'warning' | 'gray' {
  if (!status) return 'gray';
  const upper = status.toUpperCase();
  if (upper === 'SUCCESS') return 'success';
  if (upper === 'DEPLOYING' || upper === 'WAITING') return 'warning';
  if (upper === 'FAILED' || upper === 'CRASHED') return 'error';
  return 'gray';
}

// ============================================================================
// Badge — small Railway-themed chip (composes on Text+XStack, no primitives dup)
// ============================================================================

interface BadgeProps {
  text: string;
  variant: 'success' | 'error' | 'info' | 'warning' | 'gray' | 'railway';
}

export function Badge({ text, variant }: BadgeProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();
  const styles = {
    success: c.badges.ok,
    error: c.badges.err,
    info: c.badges.info,
    warning: c.badges.warn,
    gray: c.badges.gray,
    railway: colors.badgeRailway,
  };
  const { text: textColor, bg } = styles[variant];

  return (
    <XStack backgroundColor={bg} paddingHorizontal={4} paddingVertical={1} borderRadius={3}>
      <Text color={textColor} fontSize={9} fontFamily="$mono">
        {text}
      </Text>
    </XStack>
  );
}

export function DeployStatusBadge({ status }: { status: DeployStatus }) {
  return <Badge text={status.toLowerCase()} variant={getDeployStatusVariant(status)} />;
}

// ============================================================================
// InfoRow — label/value row used inside ToolCallCard children
// ============================================================================

interface InfoRowProps {
  label: string;
  value: string;
  mono?: boolean;
}

export function InfoRow({ label, value, mono }: InfoRowProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();
  return (
    <XStack gap={6} alignItems="flex-start">
      <Text color={c.text3} fontSize={9} fontFamily="$mono" width={80} flexShrink={0}>
        {label}
      </Text>
      <Text
        flex={1}
        color={c.text2}
        fontSize={9}
        fontFamily={mono ? '$mono' : undefined}
        numberOfLines={1}
      >
        {value}
      </Text>
    </XStack>
  );
}
