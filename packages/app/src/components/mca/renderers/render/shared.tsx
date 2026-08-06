/**
 * Render MCA Renderer - Shared Constants, Types & Helpers
 *
 * Renderer UX Guide v2/v2.1 — zero local components; identity comes from:
 *  - the global `ToolCallCard` (logo via `iconUri`)
 *  - the Render palette in `useRenderColors()`
 *  - vendor enum status colors (deploy/service status)
 */

import { colors, useColors, useMcaTheme } from '../../primitives';
import type React from 'react';
import { Text, XStack } from 'tamagui';

// ============================================================================
// Colors — theme-adaptive Render palette
// ============================================================================

export function useRenderColors() {
  const c = useColors();
  const theme = useMcaTheme();
  const isDark = theme === 'dark';

  return {
    // Expose the full v2 adaptive surface set (bgPage, bgCard, text, text2,
    // text3, border, borderStrong, shadow, …) plus badges.
    ...c,

    theme,
    isDark,

    // Render brand (theme-agnostic vendor identity — official Render.com hex)
    renderGreen: '#46E3B7',
    renderGreenDark: '#00C7A8',

    // Brand icon (theme-agnostic)
    icon: '#46E3B7',

    // Badges (theme-adaptive — semantic enum)
    badgeSuccess: c.badges.ok,
    badgeError: c.badges.err,
    badgeInfo: { text: '#6ee7d4', bg: 'rgba(70,227,183,0.1)' },
    badgeWarning: c.badges.warn,
    badgeGray: c.badges.gray,
    // Orange text needs a darker shade in light mode for readability.
    badgeOrange: {
      text: isDark ? '#fdba74' : '#c2410c',
      bg: 'rgba(249,115,22,0.1)',
    },

    // Deploy / service status (semantic — reuse DS tokens so they never drift)
    statusLive: colors.green,
    statusDeploying: '#46E3B7',
    statusFailed: colors.red,
    // Mid-gray works on both themes; no `colors.gray` in the DS.
    statusDeactivated: '#6b7280',
    statusSuspended: colors.orange,

    // Text (theme-adaptive — legacy aliases for v2 text/text2/text3)
    primary: c.text,
    secondary: c.text2,
    muted: c.text3,

    // Backgrounds (theme-adaptive)
    bgInner: c.bgInner,
    bgDark: c.bgInner,
    border: c.border,

    // Scrollbar thumb must invert between themes to stay visible.
    scrollbarColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)',
  };
}

// ============================================================================
// Types
// ============================================================================

export type DeployStatus =
  | 'live'
  | 'deploying'
  | 'build_failed'
  | 'update_failed'
  | 'canceled'
  | 'deactivated'
  | 'pre_deploy_failed'
  | string;

export type ServiceStatus =
  | 'suspended'
  | 'not_suspended'
  | 'live'
  | 'deploying'
  | 'failed'
  | string;

export type ServiceType =
  | 'web_service'
  | 'static_site'
  | 'background_worker'
  | 'private_service'
  | 'cron_job'
  | string;

export interface RenderService {
  id: string;
  name: string;
  type?: ServiceType;
  status?: ServiceStatus;
  slug?: string;
  ownerId?: string;
  createdAt?: string;
  updatedAt?: string;
  serviceDetails?: {
    url?: string;
    repoURL?: string;
    branch?: string;
    region?: string;
    plan?: string;
    buildCommand?: string;
    startCommand?: string;
    autoDeploy?: string;
  };
}

export interface RenderDeploy {
  id: string;
  serviceId?: string;
  status?: DeployStatus;
  trigger?: string;
  createdAt?: string;
  updatedAt?: string;
  finishedAt?: string | null;
  commit?: {
    id?: string;
    message?: string;
    createdAt?: string;
  } | null;
}

export interface RenderProject {
  id: string;
  name: string;
  ownerId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface RenderEnvironment {
  id: string;
  name: string;
  projectId?: string;
}

export interface RenderEnvVar {
  key: string;
  value: string;
}

export interface RenderDomain {
  id: string;
  name: string;
  verificationStatus?: string;
}

export interface RenderDisk {
  id: string;
  name: string;
  mountPath?: string;
  sizeGB?: number;
}

export interface RenderOwner {
  id: string;
  name: string;
  type?: string;
}

export interface RenderUser {
  id: string;
  name: string;
  email?: string;
}

export interface RenderLogEntry {
  id?: string;
  timestamp?: string;
  message?: string;
  level?: string;
  serviceId?: string;
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
  return text.slice(0, maxLength) + '…';
}

export function isSuccessOutput(parsed: unknown): boolean {
  if (typeof parsed === 'object' && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    return (
      obj.deleted === true ||
      obj.suspended === true ||
      obj.resumed === true ||
      obj.restarted === true ||
      obj.cancelled === true ||
      typeof obj.message === 'string'
    );
  }
  return (
    typeof parsed === 'string' &&
    (parsed.includes('✅') ||
      parsed.includes('success') ||
      parsed.includes('Success') ||
      parsed.includes('deleted') ||
      parsed.includes('created') ||
      parsed.includes('updated') ||
      parsed.includes('added'))
  );
}

// Render service/deploy status colors (semantic — reuse DS tokens so they
// never drift from the rest of the renderer system). `deploying` and
// `deactivated` are vendor-specific and have no DS equivalent.
const RENDER_STATUS = {
  live: colors.green,
  deploying: '#46E3B7',
  failed: colors.red,
  deactivated: '#6b7280',
  suspended: colors.orange,
};

export function getDeployStatusColor(status?: DeployStatus): string {
  if (!status) return RENDER_STATUS.deactivated;
  switch (status) {
    case 'live':
      return RENDER_STATUS.live;
    case 'deploying':
    case 'in_progress':
      return RENDER_STATUS.deploying;
    case 'build_failed':
    case 'update_failed':
    case 'pre_deploy_failed':
      return RENDER_STATUS.failed;
    case 'canceled':
    case 'deactivated':
    default:
      return RENDER_STATUS.deactivated;
  }
}

export function getServiceStatusColor(status?: ServiceStatus): string {
  if (!status) return RENDER_STATUS.deactivated;
  switch (status) {
    case 'live':
    case 'not_suspended':
      return RENDER_STATUS.live;
    case 'deploying':
      return RENDER_STATUS.deploying;
    case 'failed':
      return RENDER_STATUS.failed;
    case 'suspended':
      return RENDER_STATUS.suspended;
    default:
      return RENDER_STATUS.deactivated;
  }
}

export function getServiceTypeLabel(type?: ServiceType): string {
  switch (type) {
    case 'web_service':
      return 'web';
    case 'static_site':
      return 'static';
    case 'background_worker':
      return 'worker';
    case 'private_service':
      return 'private';
    case 'cron_job':
      return 'cron';
    default:
      return type || 'service';
  }
}

export function formatDate(dateStr?: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

export function formatRelativeTime(dateStr?: string): string {
  if (!dateStr) return '';
  try {
    const diff = Date.now() - new Date(dateStr).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch {
    return dateStr;
  }
}

// ============================================================================
// Badge — small Render-themed chip (composes on Text+XStack, no primitives dup)
// ============================================================================

interface BadgeProps {
  text: string;
  variant: 'success' | 'error' | 'info' | 'warning' | 'gray' | 'orange';
}

export function Badge({ text, variant }: BadgeProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const styles = {
    success: c.badges.ok,
    error: c.badges.err,
    info: c.badges.info,
    warning: c.badges.warn,
    gray: c.badges.gray,
    orange: colors.badgeOrange,
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

export function DeployStatusBadge({ status }: { status?: DeployStatus }) {
  const color = getDeployStatusColor(status);
  return (
    <XStack
      backgroundColor={`${color}15`}
      paddingHorizontal={4}
      paddingVertical={1}
      borderRadius={3}
      borderWidth={1}
      borderColor={`${color}30`}
      alignItems="center"
      gap={3}
    >
      <Text color={color} fontSize={9} fontFamily="$mono">
        {status || 'unknown'}
      </Text>
    </XStack>
  );
}

export function ServiceTypeBadge({ type }: { type?: ServiceType }) {
  const c = useRenderColors();
  const colors = useRenderColors();
  return (
    <XStack
      backgroundColor={c.badges.info.bg}
      paddingHorizontal={4}
      paddingVertical={1}
      borderRadius={3}
    >
      <Text color={c.badges.info.text} fontSize={9} fontFamily="$mono">
        {getServiceTypeLabel(type)}
      </Text>
    </XStack>
  );
}

// ============================================================================
// KeyValueRow — label/value row used inside ToolCallCard children
// ============================================================================

interface KeyValueRowProps {
  label: string;
  value: string;
  mono?: boolean;
  valueColor?: string;
}

export function KeyValueRow({ label, value, mono = false, valueColor }: KeyValueRowProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  return (
    <XStack gap={8} alignItems="flex-start">
      <Text color={c.text3} fontSize={9} width={70} flexShrink={0}>
        {label}
      </Text>
      <Text
        color={valueColor ?? c.text2}
        fontSize={9}
        fontFamily={mono ? '$mono' : undefined}
        flex={1}
        numberOfLines={1}
      >
        {value}
      </Text>
    </XStack>
  );
}
