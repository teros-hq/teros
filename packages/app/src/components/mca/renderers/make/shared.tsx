/**
 * mca.make — shared building blocks (TER-281 zero-local-components).
 *
 * This module exports ONLY constants, types, data helpers, prop-helpers for
 * global primitives, and a single compose-only `MakeToolShell` wrapper over
 * `ToolCallCard`. No bespoke JSX visuals live here — if a visual is needed it
 * either belongs in `primitives/` (cross-MCA) or inline in the sub-renderer.
 *
 * Brand identity comes from three mechanisms (renderer guide):
 *   - the official Make logo via `iconUri` (appIcon),
 *   - the official Make purple `#6D00CC` in `MAKE_BRAND` (NOT a Tailwind hue),
 *   - semantic tokens (green/gray/amber) for status — never the brand color.
 */

import type React from 'react';
import type { BadgeVariant } from '../../primitives';
import { colors, parseOutput, ToolCallCard, useColors } from '../../primitives';
import type { ToolStatus } from '../../types';

// ─── Brand ──────────────────────────────────────────────────────────────────

/** Official Make purple (make.com brand), used for the scenario tile accent. NOT Tailwind. */
export const MAKE_BRAND = '#6D00CC';

// ─── Theme-adaptive palette hook ─────────────────────────────────────────────
//
// Wraps `useColors()` and exposes the Make brand color + semantic state colors
// alongside the full v2 adaptive surface set (bgPage, bgCard, text, text2,
// text3, border, borderStrong, shadow, …) plus badges. Sub-renderers call this
// instead of importing the legacy static `colors` object so surface tokens adapt
// to light/dark theme.
//
// Semantic colors (green/amber/red) are theme-agnostic and are re-exported here
// for convenience so sub-renderers have a single import for all their colors.

export function useMakeColors() {
  const c = useColors();
  return {
    // Full v2 adaptive surface set + badges
    ...c,

    // Make brand (theme-agnostic vendor identity)
    brand: MAKE_BRAND,

    // Semantic state colors (theme-agnostic)
    green: colors.green,
    amber: colors.amber,
    red: colors.red,
  };
}

// ─── Output types (mirror the plain backend returns) ────────────────────────

export interface WebhookResultOutput {
  delivered: boolean;
  statusCode: number;
  webhookHost: string;
  region: string | null;
  responseType: 'json' | 'text';
  response: unknown;
}

export interface ScenarioItem {
  id: string;
  name: string;
  isActive: boolean | null;
  isPaused: boolean | null;
  teamId: string | null;
  description?: string;
  folderId?: string;
}

export interface ListScenariosOutput {
  scenarios: ScenarioItem[];
  /** Count on this page. */
  returned: number;
  /** Real upstream total when known, else a lower bound (`offset + returned`). */
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
  teamId: string | null;
  region: string;
}

export interface RunScenarioOutput {
  scenarioId: string;
  executionId: string | null;
  status: string | null;
  responsive: boolean;
  outputs: unknown;
}

export type HealthStatus = 'ready' | 'not_ready' | 'degraded';

export interface HealthIssue {
  code: string;
  message: string;
  action?: { type: 'user_action' | 'admin_action' | 'auto_retry'; description: string; url?: string };
}

export interface HealthCheckResult {
  status: HealthStatus;
  issues?: HealthIssue[];
  version?: string;
  uptime?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Imperative verb per short tool name — fed to `ToolCallCard.verb` for §2.3 tense. */
export const TOOL_VERBS: Record<string, string> = {
  'trigger-webhook': 'Trigger webhook',
  'list-scenarios': 'List scenarios',
  'run-scenario': 'Run scenario',
};

// ─── Data helpers ───────────────────────────────────────────────────────────

export function statusType(status: ToolStatus): ToolStatus {
  return status === 'pending' ? 'running' : status;
}

/** Parse the plain backend JSON output (handlers return data, not {content,…}). */
export function parseMakeOutput<T>(output?: string): T | null {
  if (!output) return null;
  // parseOutput returns the raw string on parse failure — treat non-objects as null.
  const parsed = parseOutput<T>(output);
  return parsed && typeof parsed === 'object' ? (parsed as T) : null;
}

/** Two-letter initials for the scenario IconTile. */
export function scenarioInitials(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?';
}

/**
 * Host-only display for a webhook URL. NEVER surface the full tokenized URL in
 * the UI — the token lives in the path. Returns '' if unparseable.
 */
export function hostFromWebhookUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

// ─── Prop helpers for global primitives ──────────────────────────────────────

/**
 * Badge props for a scenario's run state, or `null` when the upstream didn't
 * populate the flags (omit the badge — no noise, color-signal-over-noise).
 */
export function scenarioStateChip(s: ScenarioItem): { text: string; variant: BadgeVariant } | null {
  if (s.isActive === true) return { text: 'active', variant: 'success' };
  if (s.isPaused === true) return { text: 'paused', variant: 'gray' };
  if (s.isActive === false) return { text: 'inactive', variant: 'gray' };
  return null;
}

// ─── MakeToolShell — compose-only wrapper over ToolCallCard ──────────────────

interface MakeToolShellProps {
  toolName: string;
  status: ToolStatus;
  appIcon?: string;
  /** Imperative verb override; defaults to TOOL_VERBS[toolName]. */
  verb?: string;
  /** Fully-composed description (wins over verb) — for contextual headers. */
  description?: string;
  badge?: React.ReactNode;
  defaultExpanded?: boolean;
  children?: React.ReactNode;
}

/**
 * Pre-fills Make defaults (logo via iconUri, verb→tense via TOOL_VERBS, motion
 * signature). Compose-only — introduces no visuals of its own.
 */
export function MakeToolShell({
  toolName,
  status,
  appIcon,
  verb,
  description,
  badge,
  defaultExpanded,
  children,
}: MakeToolShellProps): React.ReactNode {
  const resolvedVerb = verb ?? TOOL_VERBS[toolName] ?? toolName;
  return (
    <ToolCallCard
      status={statusType(status)}
      {...(description ? { description } : { verb: resolvedVerb })}
      iconUri={appIcon}
      badge={badge}
      defaultExpanded={defaultExpanded ?? false}
      animateExpand
    >
      {children}
    </ToolCallCard>
  );
}
