/**
 * ActiveCampaign — constants, types, helpers, prop factories, ToolShell.
 *
 * Zero local components. Global primitives + prop factories cover every
 * ActiveCampaign-specific UI need. What lives here:
 *
 *  - Constants: official AC palette + accent + tool labels.
 *  - Types for curated MCA shapes.
 *  - Shape-agnostic getters (deal status, campaign status, tag type).
 *  - Prop factories that feed global primitives:
 *      `dealStatusChipProps(0|1|2) → IconChip props | null`
 *      `campaignStatusChipProps('sent') → IconChip props | null`
 *      `subscriptionChipProps('subscribed') → IconChip props`
 *  - `useActiveCampaignColors()` — Design System theme-aware palette hook.
 *  - `ActiveCampaignToolShell` — compose-only wrapper over `ToolCallCard`.
 */

import { Ban, CheckCircle2, CircleDot, Clock, Send, X } from '@tamagui/lucide-icons';
import type React from 'react';
import { Badge, colors as globalColors, type KeyValueRow, ToolCallCard, useColors } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';

// ============================================================================
// Constants
// ============================================================================

/**
 * ActiveCampaign brand palette. AC's official design guide does not publish
 * raw hex values (uses semantic tokens) — these come from the live web app
 * UI inspection. Validate visually before tweaking.
 *
 * The two brand colors (`blue`, `navy`) remain hardcoded because they are
 * ActiveCampaign's identity. The semantic aliases (`success`, `warning`,
 * `danger`, `muted`) are read from the global semantic palette so they stay
 * consistent with every other MCA renderer.
 */
export const AC_BRAND = {
  /** AC Blue — primary brand accent (CTAs, header, identifiers). */
  blue: '#356AE6',
  /** Deep navy used in the corporate logo lockup. */
  navy: '#1F3F87',
  /** Semantic colors aliased to the global tokens for cross-MCA coherence. */
  success: globalColors.green,
  warning: globalColors.amber,
  danger: globalColors.red,
  /** Muted text color from the global surface tokens. */
  muted: globalColors.text3,
} as const;

export const AC_DEAL_STATUS: Record<number, { label: string; color: string }> = {
  0: { label: 'Open', color: AC_BRAND.blue },
  1: { label: 'Won', color: AC_BRAND.success },
  2: { label: 'Lost', color: AC_BRAND.danger },
};

/**
 * Campaign `status` from the API is a string. Common values observed in v3:
 * `0`=draft, `1`=scheduled, `2`=sending, `5`=sent, `6`=paused. The API
 * sometimes returns plain words instead. Normalize both.
 */
const CAMPAIGN_STATUS_MAP: Record<string, { label: string; color: string }> = {
  '0': { label: 'Draft', color: AC_BRAND.muted },
  '1': { label: 'Scheduled', color: AC_BRAND.warning },
  '2': { label: 'Sending', color: AC_BRAND.blue },
  '5': { label: 'Sent', color: AC_BRAND.success },
  '6': { label: 'Paused', color: AC_BRAND.muted },
  draft: { label: 'Draft', color: AC_BRAND.muted },
  scheduled: { label: 'Scheduled', color: AC_BRAND.warning },
  sending: { label: 'Sending', color: AC_BRAND.blue },
  sent: { label: 'Sent', color: AC_BRAND.success },
  paused: { label: 'Paused', color: AC_BRAND.muted },
};

// ============================================================================
// Types (curated shapes — match backend `_helpers.ts`)
// ============================================================================

export interface AcContact {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  cdate?: string;
  udate?: string;
}

export interface AcList {
  id: string;
  name: string;
  stringid: string;
  subscriberCount: number | null;
  cdate?: string;
}

export interface AcCampaign {
  id: string;
  name: string;
  type: string;
  status: string;
  sendDate: string | null;
  fromName: string;
  fromEmail: string;
  subject: string;
  totalRecipients: number;
  totalOpens: number;
  totalLinks: number;
  uniqueOpens: number;
  uniqueLinks: number;
  cdate?: string;
}

export interface AcDeal {
  id: string;
  title: string;
  description: string;
  value: number;
  currency: string;
  status: number;
  contact: string | null;
  account: string | null;
  pipeline: string | null;
  stage: string | null;
  owner: string | null;
  cdate?: string;
  udate?: string;
}

export interface AcTag {
  id: string;
  name: string;
  description: string;
  tagType: string;
  cdate?: string;
}

export interface AcContactList {
  id: string;
  contact: string;
  list: string;
  status: string;
}

export interface AcContactTag {
  id: string;
  contact: string;
  tag: string;
}

// ============================================================================
// Tool labels
// ============================================================================

/**
 * Imperative verb phrases (verb-first) so `ToolCallCard` can compose the §2.3
 * tense automatically (`Will list… / Listing… / Listed / Failed to list /
 * Wants to list`). Nominal labels ("Contacts") would break `inferTenseForms`.
 */
export const TOOL_LABELS: Record<string, string> = {
  '-health-check': 'Check health',
  'list-contacts': 'List contacts',
  'get-contact': 'Get contact',
  'create-contact': 'Create contact',
  'update-contact': 'Update contact',
  'delete-contact': 'Delete contact',
  'list-lists': 'List lists',
  'subscribe-contact-to-list': 'Subscribe to list',
  'list-campaigns': 'List campaigns',
  'get-campaign': 'Get campaign',
  'list-deals': 'List deals',
  'get-deal': 'Get deal',
  'create-deal': 'Create deal',
  'list-tags': 'List tags',
  'add-tag-to-contact': 'Tag contact',
};

export function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

function humanize(name: string): string {
  return name
    .split('-')
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

export function getToolLabel(toolName: string): string {
  const short = getShortToolName(toolName);
  return TOOL_LABELS[short] ?? humanize(short);
}

// ============================================================================
// Display helpers
// ============================================================================

export function fullName(c: AcContact): string {
  const parts = [c.firstName, c.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : c.email || '—';
}

export function formatMoney(value: number, currency: string): string {
  if (!Number.isFinite(value)) return '—';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: (currency || 'USD').toUpperCase(),
      maximumFractionDigits: value % 1 === 0 ? 0 : 2,
    }).format(value);
  } catch {
    return `${(currency || 'USD').toUpperCase()} ${value.toFixed(2)}`;
  }
}

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

export function shortId(id: string | undefined | null, head = 6, tail = 3): string {
  if (!id) return '—';
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export function openRate(c: AcCampaign): string | null {
  if (!c.totalRecipients || c.totalRecipients <= 0) return null;
  const pct = (c.uniqueOpens / c.totalRecipients) * 100;
  if (!Number.isFinite(pct)) return null;
  return `${pct.toFixed(1)}%`;
}

export function clickRate(c: AcCampaign): string | null {
  if (!c.totalRecipients || c.totalRecipients <= 0) return null;
  const pct = (c.uniqueLinks / c.totalRecipients) * 100;
  if (!Number.isFinite(pct)) return null;
  return `${pct.toFixed(1)}%`;
}

// ============================================================================
// Prop factories — feed global primitives, no new components
// ============================================================================

export function dealStatusChipProps(status: number): {
  icon: React.ReactNode;
  accent: string;
  text: string;
} {
  const meta = AC_DEAL_STATUS[status] ?? { label: 'Unknown', color: AC_BRAND.muted };
  const Icon = status === 1 ? CheckCircle2 : status === 2 ? X : CircleDot;
  return {
    icon: <Icon size={9} color={meta.color} />,
    accent: meta.color,
    text: meta.label.toUpperCase(),
  };
}

/**
 * Returns props for a campaign status `<IconChip/>`. `null` means the
 * upstream value is unrecognisable — caller drops the chip (signal-over-noise).
 */
export function campaignStatusChipProps(
  status: string,
): { icon: React.ReactNode; accent: string; text: string } | null {
  if (!status) return null;
  const key = status.toLowerCase();
  const meta = CAMPAIGN_STATUS_MAP[key] ?? CAMPAIGN_STATUS_MAP[status];
  if (!meta) return null;
  const Icon = meta.label === 'Sent' ? Send : meta.label === 'Sending' ? Send : Clock;
  return {
    icon: <Icon size={9} color={meta.color} />,
    accent: meta.color,
    text: meta.label.toUpperCase(),
  };
}

export function subscriptionChipProps(status: 'subscribed' | 'unsubscribed' | string): {
  icon: React.ReactNode;
  accent: string;
  text: string;
} {
  if (status === 'unsubscribed') {
    return {
      icon: <Ban size={9} color={AC_BRAND.danger} />,
      accent: AC_BRAND.danger,
      text: 'UNSUBSCRIBED',
    };
  }
  return {
    icon: <CheckCircle2 size={9} color={AC_BRAND.success} />,
    accent: AC_BRAND.success,
    text: 'SUBSCRIBED',
  };
}

// ============================================================================
// Generic helpers
// ============================================================================

export function unwrap<T extends object>(parsed: unknown, key: string): T | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const wrapped = obj[key];
  if (wrapped && typeof wrapped === 'object') return wrapped as T;
  return obj as T;
}

export function unwrapList<T>(
  parsed: unknown,
  key: string,
): { items: T[]; total: number | null; nextOffset: number | null } {
  if (!parsed || typeof parsed !== 'object') return { items: [], total: null, nextOffset: null };
  const obj = parsed as Record<string, unknown>;
  const list = obj[key];
  const items = Array.isArray(list) ? (list as T[]) : [];
  const total = typeof obj.total === 'number' ? obj.total : null;
  const nextOffset = typeof obj.nextOffset === 'number' ? obj.nextOffset : null;
  return { items, total, nextOffset };
}

export function diffFields(
  input: Record<string, unknown> | undefined,
  keys: string[],
): KeyValueRow[] {
  if (!input) return [];
  const out: KeyValueRow[] = [];
  for (const k of keys) {
    const v = input[k];
    if (v === undefined || v === null || v === '') continue;
    const str =
      typeof v === 'string'
        ? v.length > 80
          ? `${v.slice(0, 80)}…`
          : v
        : typeof v === 'number'
          ? String(v)
          : '(updated)';
    out.push({ key: k, value: str });
  }
  return out;
}

export function toolStatusForPrimitive(
  status: ToolCallRendererProps['status'],
): Exclude<ToolCallRendererProps['status'], 'pending'> {
  if (status === 'pending') return 'running';
  return status;
}

export function statusBadge(status: ToolCallRendererProps['status']): React.ReactNode {
  if (status === 'completed') return <Badge text="done" variant="success" />;
  if (status === 'failed') return <Badge text="failed" variant="error" />;
  if (status === 'pending_permission') return <Badge text="awaiting" variant="warning" />;
  if (status === 'running' || status === 'pending') return <Badge text="running" variant="info" />;
  return null;
}

// ============================================================================
// Theme-aware color hook
// ============================================================================

/**
 * ActiveCampaign renderer palette. Combines the official AC brand colors
 * (kept hardcoded per brand guidelines) with the Design System theme-adaptive
 * surface tokens from `useColors()`. This is the same pattern used by the
 * Runn and Notion renderers.
 */
export function useActiveCampaignColors() {
  const c = useColors();
  return {
    ...c,
    brand: AC_BRAND,
  };
}

// ============================================================================
// ActiveCampaignToolShell — compose-only wrapper
// ============================================================================

interface ToolShellProps {
  toolName: string;
  status: ToolCallRendererProps['status'];
  duration?: number;
  description?: string;
  iconUri?: string;
  children?: React.ReactNode;
  defaultExpanded?: boolean;
  badge?: React.ReactNode;
}

export function ActiveCampaignToolShell({
  toolName,
  status,
  duration,
  description,
  iconUri,
  children,
  defaultExpanded,
  badge,
}: ToolShellProps) {
  return (
    <ToolCallCard
      status={toolStatusForPrimitive(status)}
      // Canonical v2/v2.1 header: pass `verb` so the card composes tense from
      // status. A renderer that already has contextual text passes `description`
      // (it wins); otherwise `verb` drives `Will… / Listing… / Listed`.
      description={description}
      verb={getToolLabel(toolName)}
      duration={duration}
      iconUri={iconUri}
      badge={badge ?? statusBadge(status)}
      defaultExpanded={defaultExpanded}
    >
      {children}
    </ToolCallCard>
  );
}

/**
 * Maps an ActiveCampaignError code prefix in `[CODE] message` form to a
 * human-friendly hint. Used in `<ErrorBlock>`.
 */
export function activeCampaignErrorHint(error?: string): string | null {
  if (!error) return null;
  const match = /^\[([A-Z_]+)\]/.exec(error);
  const code = match?.[1];
  switch (code) {
    case 'AUTH_INVALID':
      return 'API token rejected. Generate a new one under Settings → Developer.';
    case 'NOT_FOUND':
      return 'The requested record does not exist or was deleted.';
    case 'RATE_LIMITED':
      return 'ActiveCampaign limits 5 requests/sec. Try again shortly.';
    case 'BAD_REQUEST':
      return 'Request rejected — check field formats (email, currency, ids).';
    default:
      return null;
  }
}
