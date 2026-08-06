/**
 * Google Analytics 4 — constants, types, helpers, and `GoogleAnalyticsToolShell`.
 *
 * Zero components defined here. Global primitives (`IconChip`, `IconTile`,
 * `ResourceCard`, `EntityRow`, `ToolCallCard`, `KeyValueGrid`, ...) cover
 * every GA4-specific UI case via props. What lives here:
 *
 *  - Constants: official Google Analytics palette + brand accent + logo url.
 *  - Types for curated GA4 shapes (accounts, properties, streams, reports).
 *  - Shape-agnostic getters and prop factories for primitives.
 *  - `GoogleAnalyticsToolShell` — compose-only wrapper over `ToolCallCard`.
 */

import type React from 'react';
import { ToolCallCard, useColors, useMcaTheme } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';

// ============================================================================
// Constants
// ============================================================================

export const GA_ICON = `${process.env.EXPO_PUBLIC_BACKEND_URL}/static/mcas/mca.google.analytics/icon.png`;

/**
 * Official Google Analytics brand palette (validated against GA4 product UI).
 *  - `orange`: dark orange logo primary.
 *  - `amber`: yellow-amber logo secondary.
 *  - `text`: ink for primary text on neutral backgrounds.
 */
export const GA_BRAND = {
  orange: '#E37400',
  amber: '#F9AB00',
  text: '#202124',
} as const;

/** Stream-type colors (signal only — used to differentiate web/android/ios). */
export const STREAM_TYPE_COLORS: Record<string, string> = {
  WEB_DATA_STREAM: '#1A73E8', // Google blue
  ANDROID_APP_DATA_STREAM: '#3DDC84', // Android green
  IOS_APP_DATA_STREAM: '#A2AAAD', // iOS silver
};

export const STREAM_TYPE_LABELS: Record<string, string> = {
  WEB_DATA_STREAM: 'Web',
  ANDROID_APP_DATA_STREAM: 'Android',
  IOS_APP_DATA_STREAM: 'iOS',
};

/**
 * Theme-aware scrollbar style hook. Returns a web-only CSS object suitable for
 * `ScrollView style` on web. Must be called inside a component because it reads
 * the active theme via `useColors()`.
 */
// biome-ignore lint/suspicious/noExplicitAny: web-only scrollbar props
export function useScrollStyle(maxHeight: number): any {
  const c = useColors();
  const theme = useMcaTheme();
  const isDark = theme === 'dark';
  return {
    maxHeight,
    scrollbarWidth: 'thin',
    scrollbarColor: `${isDark ? 'rgba(255,255,255,0.2)' : c.borderStrong} transparent`,
  };
}

/** @deprecated Use `useScrollStyle(maxHeight)` inside a component for theme-aware scrollbars. */
export function scrollStyle(maxHeight: number) {
  return {
    maxHeight,
    scrollbarWidth: 'thin',
    scrollbarColor: 'rgba(255,255,255,0.2) transparent',
    // biome-ignore lint/suspicious/noExplicitAny: web-only style merge
  } as any;
}

// ============================================================================
// Types (curated GA4 shapes)
// ============================================================================

export interface GAAccount {
  accountId?: string;
  name?: string;
  displayName?: string;
  regionCode?: string;
  createTime?: string;
  updateTime?: string;
}

export interface GAProperty {
  propertyId?: string;
  name?: string;
  displayName?: string;
  parent?: string;
  propertyType?: string;
  timeZone?: string;
  currencyCode?: string;
  industryCategory?: string;
  serviceLevel?: string;
  account?: string;
  createTime?: string;
  updateTime?: string;
  deleteTime?: string;
}

export interface GAStream {
  streamId?: string;
  name?: string;
  displayName?: string;
  type?: string;
  webStreamData?: { measurementId?: string; firebaseAppId?: string; defaultUri?: string };
  androidAppStreamData?: { firebaseAppId?: string; packageName?: string };
  iosAppStreamData?: { firebaseAppId?: string; bundleId?: string };
  createTime?: string;
  updateTime?: string;
}

export interface GAReportRow {
  dimensionValues: string[];
  metricValues: string[];
}

export interface GAReport {
  account?: string;
  propertyId?: string;
  dimensionHeaders: Array<{ name: string }>;
  metricHeaders: Array<{ name: string; type?: string }>;
  rows: GAReportRow[];
  rowCount?: number;
  totals?: string[][];
  minimums?: string[][];
  maximums?: string[][];
  metadata?: { currencyCode?: string; timeZone?: string };
  propertyQuota?: any;
}

// ============================================================================
// Tool labels
// ============================================================================

export const TOOL_LABELS: Record<string, string> = {
  '-health-check': 'Health check',
  'analytics-list-accounts': 'Accounts',
  'analytics-list-properties': 'Properties',
  'analytics-get-property': 'Property detail',
  'analytics-list-data-streams': 'Data streams',
  'analytics-get-data-stream': 'Data stream detail',
  'analytics-run-report': 'Report',
  'analytics-batch-run-reports': 'Batch reports',
  'analytics-run-realtime-report': 'Realtime report',
  'analytics-get-metadata': 'Metadata',
  'analytics-create-property': 'Create property',
  'analytics-update-property': 'Update property',
  'analytics-delete-property': 'Delete property',
  'analytics-create-data-stream': 'Create data stream',
};

export function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

function humanize(name: string): string {
  const cleaned = name.startsWith('analytics-') ? name.slice('analytics-'.length) : name;
  const joined = cleaned.replace(/-/g, ' ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

export function getToolLabel(toolName: string): string {
  const short = getShortToolName(toolName);
  return TOOL_LABELS[short] ?? humanize(short);
}

/**
 * Imperative verb phrases for the canonical §2.3 auto-tense header. The
 * `ToolCallCard` composes `Will list… / Listing… / Listed / Failed to list /
 * Wants to list` from these, so the shell never hand-rolls a status badge.
 * A renderer that has contextual data (a count, a name) passes `description=`
 * instead, which wins over the verb.
 */
export const TOOL_VERBS: Record<string, string> = {
  '-health-check': 'Check health',
  'analytics-list-accounts': 'List accounts',
  'analytics-list-properties': 'List properties',
  'analytics-get-property': 'Get property',
  'analytics-list-data-streams': 'List data streams',
  'analytics-get-data-stream': 'Get data stream',
  'analytics-run-report': 'Run report',
  'analytics-batch-run-reports': 'Run batch reports',
  'analytics-run-realtime-report': 'Run realtime report',
  'analytics-get-metadata': 'Get metadata',
  'analytics-create-property': 'Create property',
  'analytics-update-property': 'Update property',
  'analytics-delete-property': 'Delete property',
  'analytics-create-data-stream': 'Create data stream',
};

export function getToolVerb(toolName: string): string {
  const short = getShortToolName(toolName);
  return TOOL_VERBS[short] ?? getToolLabel(toolName);
}

// ============================================================================
// Helpers
// ============================================================================

export function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

/** Format a numeric metric value for compact display: 1234567 → 1.2M. */
export function formatMetric(value: string | undefined, type?: string): string {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (type === 'TYPE_SECONDS') {
    if (n < 60) return `${n.toFixed(1)}s`;
    if (n < 3600) return `${(n / 60).toFixed(1)}m`;
    return `${(n / 3600).toFixed(1)}h`;
  }
  if (type === 'TYPE_FLOAT' || type === 'TYPE_CURRENCY') {
    return n.toFixed(2);
  }
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

export function unwrap<T extends object>(parsed: unknown): T | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as T;
}

export function toolStatusForPrimitive(
  status: ToolCallRendererProps['status'],
): Exclude<ToolCallRendererProps['status'], 'pending'> {
  if (status === 'pending') return 'running';
  return status;
}

// ============================================================================
// Prop factories — fed to global primitives. Return null when no signal.
// ============================================================================

export function streamTypeChipProps(
  type?: string | null,
): { accent: string; text: string } | null {
  if (!type) return null;
  const accent = STREAM_TYPE_COLORS[type] ?? GA_BRAND.orange;
  const text = STREAM_TYPE_LABELS[type] ?? type;
  return { accent, text };
}

export function propertyTypeChipProps(
  type?: string | null,
): { accent: string; text: string } | null {
  if (!type) return null;
  const cleaned = type.replace(/^PROPERTY_TYPE_/, '').replace(/_/g, ' ').toLowerCase();
  if (!cleaned || cleaned === 'ordinary') return null;
  return { accent: GA_BRAND.amber, text: cleaned };
}

export function serviceLevelChipProps(
  level?: string | null,
): { accent: string; text: string } | null {
  if (!level) return null;
  if (level === 'GOOGLE_ANALYTICS_360') return { accent: GA_BRAND.orange, text: 'GA360' };
  return null; // Standard tier — no chip (signal-over-noise)
}

// ============================================================================
// GoogleAnalyticsToolShell — compose-only wrapper
// ============================================================================

interface ToolShellProps {
  toolName: string;
  status: ToolCallRendererProps['status'];
  duration?: number;
  /**
   * Imperative override (e.g. `"Run report"`). Defaults to the tool's
   * canonical verb so the card auto-tenses the header. A renderer rarely
   * needs to set this.
   */
  verb?: string;
  /**
   * Fully-composed contextual description (e.g. `"5 accounts"`). Wins over
   * `verb` when set — pass it ONLY when there is real data to surface;
   * otherwise leave it `undefined` and let the verb auto-tense.
   */
  description?: string;
  children?: React.ReactNode;
  defaultExpanded?: boolean;
  /**
   * Optional extra signal badge. The shell does NOT synthesize a
   * status badge — status is conveyed by the StatusDot + the auto-tensed
   * verb (Renderer UX Guide v2 §2.3/§7).
   */
  badge?: React.ReactNode;
}

export function GoogleAnalyticsToolShell({
  toolName,
  status,
  duration,
  verb,
  description,
  children,
  defaultExpanded,
  badge,
}: ToolShellProps) {
  return (
    <ToolCallCard
      status={toolStatusForPrimitive(status)}
      verb={verb ?? getToolVerb(toolName)}
      description={description}
      duration={duration}
      iconUri={GA_ICON}
      badge={badge}
      defaultExpanded={defaultExpanded}
    >
      {children}
    </ToolCallCard>
  );
}
