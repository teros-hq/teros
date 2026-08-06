/**
 * Linear — constants, types, helpers, and a compose-only `LinearToolShell`.
 *
 * Zero components are defined here. The global primitives
 * (`IconChip`, `IconTile`, `PillList`, `ResourceCard`, `EntityRow`,
 * `ActionBadge`, `ToolCallCard`, `Avatar`, `KeyValueGrid`, ...) cover every
 * Linear-specific UI case through props. What lives here:
 *
 *  - Constants: official Linear priority palette + brand accent + logo url.
 *  - Types for curated + legacy Linear shapes (tolerant unions).
 *  - Shape-agnostic getters (`getPriorityNumber`, `getAssigneeName`, …).
 *  - **Prop factories** that feed the global primitives:
 *      `priorityChipProps(p) → { icon, accent, text }` fed to `<IconChip/>`.
 *      `workflowStateChipProps(state)`, `labelChipProps(label)`,
 *      `teamKeyChipProps(team)`, `projectTileProps(project)`.
 *  - Tiny JSX helper `identifierText(id)` (inline `<Text>` in Linear purple).
 *  - Generic local helpers (`unwrap`, `unwrapList`, `diffFields`, …).
 *  - `LinearToolShell` — compose-only wrapper over `ToolCallCard` that
 *    pre-fills `iconUri={LINEAR_ICON}` and the description label.
 */

import { Circle, Zap } from '../../primitives';
import type React from 'react';
import { Text } from 'tamagui';
import { Badge, type KeyValueRow, ToolCallCard, useColors, useMcaTheme } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';

// ============================================================================
// Constants
// ============================================================================

export const LINEAR_ICON = `${process.env.EXPO_PUBLIC_BACKEND_URL}/static/linear-icon.png`;

export const LINEAR_BRAND = {
  /** Linear's official primary brand color. Used for `StatusDot running`,
   * identifier pills, and as fallback accent when the backend does not
   * provide one (e.g. labelIds array without the full label object). */
  purple: '#5E6AD2',
  blue: '#4EA8DE',
} as const;

/**
 * Linear renderer palette. Combines the official Linear brand colors (kept
 * hardcoded per brand guidelines) with the Design System theme-adaptive surface
 * tokens from `useColors()`. The web scrollbar color switches between dark and
 * light variants so it remains visible on both card backgrounds.
 */
export function useLinearColors() {
  const c = useColors();
  const theme = useMcaTheme();
  const isDark = theme === 'dark';

  return {
    ...c,
    theme,
    isDark,
    brand: LINEAR_BRAND,
    // Scrollbar thumb must invert between themes to stay visible against the card surface.
    scrollbarColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)',
  };
}

/**
 * Theme-aware scrollbar style hook. Returns a web-only CSS object suitable for
 * `ScrollView style` on web. Must be called inside a component because it reads
 * the active theme via `useLinearColors()`.
 */
export function useScrollStyle(maxHeight: number) {
  const { scrollbarColor } = useLinearColors();
  return {
    maxHeight,
    // biome-ignore lint/suspicious/noExplicitAny: CSS scrollbar props are web-only, not in RN ViewStyle
    scrollbarWidth: 'thin',
    // biome-ignore lint/suspicious/noExplicitAny: idem
    scrollbarColor: `${scrollbarColor} transparent`,
  } as any;
}

/**
 * Linear's official priority palette. Matches the product UI (documented in
 * community guides since Linear does not publish the palette publicly).
 * IMPORTANT: medium is yellow, not blue — a common mistake when using
 * Tailwind defaults.
 *
 * Enum contract: 0=none, 1=urgent, 2=high, 3=medium, 4=low (SDK graphql).
 */
export const PRIORITY_COLORS: Record<number, string> = {
  0: '#6B7280', // None
  1: '#EB5757', // Urgent
  2: '#F2994A', // High
  3: '#F2C94C', // Medium (yellow, not blue)
  4: '#95A2B3', // Low
};

export const PRIORITY_LABELS: Record<number, string> = {
  0: 'None',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

// ============================================================================
// Types (tolerant to curated post-TER-280 + legacy shapes)
// ============================================================================

export interface LinearUserRef {
  id: string;
  name: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string | null;
  active?: boolean;
  admin?: boolean;
}

export interface LinearTeamRef {
  id: string;
  name: string;
  key?: string;
  icon?: string | null;
  color?: string | null;
  description?: string | null;
  private?: boolean;
}

export interface LinearProjectRef {
  id: string;
  name: string;
  state?: string | null;
  icon?: string | null;
  color?: string | null;
  description?: string | null;
  progress?: number | null;
  startDate?: string | null;
  targetDate?: string | null;
  lead?: LinearUserRef | null;
  teams?: Array<{ id: string; name: string }>;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface LinearCycleRef {
  id: string;
  name?: string | null;
  number?: number | null;
}

export interface LinearPriorityRef {
  number: number;
  name: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  status?: string | null;
  priority?: number | LinearPriorityRef;
  assignee?: string | LinearUserRef | null;
  creator?: LinearUserRef | null;
  team?: string | LinearTeamRef | null;
  project?: LinearProjectRef | null;
  cycle?: LinearCycleRef | null;
  labels?: string[];
  parentId?: string | null;
  dueDate?: string | null;
  estimate?: number | null;
  archivedAt?: string | null;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type LinearProject = LinearProjectRef;
export type LinearUser = LinearUserRef;
export type LinearTeam = LinearTeamRef;

export interface LinearLabel {
  id: string;
  name: string;
  color?: string | null;
  description?: string | null;
  isGroup?: boolean;
  parentId?: string | null;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type?: string;
  color?: string | null;
  position?: number;
  description?: string | null;
}

export interface LinearComment {
  id: string;
  body: string;
  authorId?: string | null;
  authorName?: string | null;
  issueId?: string | null;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
}

// ============================================================================
// Tool labels
// ============================================================================

export const TOOL_LABELS: Record<string, string> = {
  // Issues
  'linear-list-issues': 'Issues',
  'linear-get-issue': 'Issue details',
  'linear-create-issue': 'Create issue',
  'linear-update-issue': 'Update issue',
  'linear-delete-issue': 'Delete issue',
  'linear-archive-issue': 'Archive issue',
  'linear-add-comment': 'Add comment',
  // Projects
  'linear-list-projects': 'Projects',
  'linear-create-project': 'Create project',
  'linear-add-issues-to-project': 'Attach issues to project',
  'linear-remove-issues-from-project': 'Detach issues from project',
  // Labels
  'linear-list-labels': 'Labels',
  'linear-create-label': 'Create label',
  'linear-update-label': 'Update label',
  'linear-delete-label': 'Delete label',
  'linear-add-labels-to-issue': 'Add labels to issue',
  'linear-remove-labels-from-issue': 'Remove labels from issue',
  // Teams / Users / Workflow
  'linear-list-teams': 'Teams',
  'linear-list-users': 'Users',
  'linear-list-workflow-states': 'Workflow states',
};

export function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

function humanize(name: string): string {
  const cleaned = name.startsWith('linear-') ? name.slice('linear-'.length) : name;
  const joined = cleaned.replace(/-/g, ' ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

export function getToolLabel(toolName: string): string {
  const short = getShortToolName(toolName);
  return TOOL_LABELS[short] ?? humanize(short);
}

// ============================================================================
// Shape-agnostic getters
// ============================================================================

export function getAssigneeName(
  assignee: string | LinearUserRef | null | undefined,
): string | null {
  if (assignee == null) return null;
  if (typeof assignee === 'string') return assignee || null;
  return assignee.name || assignee.displayName || null;
}

export function getAssigneeAvatarUrl(
  assignee: string | LinearUserRef | null | undefined,
): string | null {
  if (assignee == null || typeof assignee === 'string') return null;
  return assignee.avatarUrl ?? null;
}

export function getTeamName(team: string | LinearTeamRef | null | undefined): string | null {
  if (team == null) return null;
  if (typeof team === 'string') return team || null;
  return team.name || team.key || null;
}

export function getTeamKey(team: string | LinearTeamRef | null | undefined): string | null {
  if (team == null || typeof team === 'string') return null;
  return team.key ?? null;
}

export function getTeamColor(team: string | LinearTeamRef | null | undefined): string | null {
  if (team == null || typeof team === 'string') return null;
  return team.color ?? null;
}

export function getPriorityNumber(priority?: number | LinearPriorityRef | null): number {
  if (priority == null) return 0;
  if (typeof priority === 'number') return priority;
  return typeof priority.number === 'number' ? priority.number : 0;
}

export function getPriorityLabel(priority?: number | LinearPriorityRef | null): string {
  if (priority && typeof priority !== 'number' && typeof priority.name === 'string') {
    const capitalised = priority.name.charAt(0).toUpperCase() + priority.name.slice(1);
    return capitalised;
  }
  return PRIORITY_LABELS[getPriorityNumber(priority)] ?? 'None';
}

export function getPriorityColor(priority?: number | LinearPriorityRef | null): string {
  return PRIORITY_COLORS[getPriorityNumber(priority)] ?? PRIORITY_COLORS[0];
}

// ============================================================================
// Prop factories for global primitives — no new components.
// ============================================================================

/**
 * Returns props for an `<IconChip/>` showing the issue's priority.
 * Callers render `{props && <IconChip {...props}/>}` — `null` means
 * "priority is None, skip the chip".
 */
export function priorityChipProps(
  priority?: number | LinearPriorityRef | null,
): { icon: React.ReactNode; accent: string; text: string } | null {
  const n = getPriorityNumber(priority);
  if (n === 0) return null;
  const color = PRIORITY_COLORS[n];
  return {
    icon: <Zap size={9} color={color} />,
    accent: color,
    text: PRIORITY_LABELS[n].toUpperCase(),
  };
}

/**
 * Returns props for an `<IconChip/>` showing a workflow state. The color
 * comes from the backend (`state.color`) — we never hardcode.
 * String fallback (legacy `issue.status: string`) uses the Linear purple
 * as accent.
 */
export function workflowStateChipProps(
  state: string | LinearWorkflowState | null | undefined,
): { icon: React.ReactNode; accent: string; text: string } | null {
  if (state == null) return null;
  if (typeof state === 'string') {
    if (!state) return null;
    return {
      icon: <Circle size={8} color={LINEAR_BRAND.purple} weight="fill" />,
      accent: LINEAR_BRAND.purple,
      text: state,
    };
  }
  if (!state.name) return null;
  const color = state.color ?? LINEAR_BRAND.purple;
  return {
    icon: <Circle size={8} color={color} weight="fill" />,
    accent: color,
    text: state.name,
  };
}

/**
 * Returns props for an `<IconChip/>` for a label. No icon — the chip's
 * accent IS the label color.
 */
export function labelChipProps(
  label: LinearLabel | { id?: string; name: string; color?: string | null },
): { accent: string; text: string } {
  return {
    accent: label.color ?? LINEAR_BRAND.purple,
    text: label.name,
  };
}

/**
 * Returns props for an `<IconChip/>` showing the team's key (TER, ENG, …)
 * over the team's brand color.
 */
export function teamKeyChipProps(team: LinearTeamRef): { accent: string; text: string } {
  return {
    accent: team.color ?? LINEAR_BRAND.purple,
    text: team.key ?? team.name ?? '?',
  };
}

/**
 * Returns props for an `<IconTile/>` representing a project. Uses the
 * project's color as accent and the first character of the name as label.
 */
export function projectTileProps(project: LinearProjectRef): { accent: string; label: string } {
  return {
    accent: project.color ?? LINEAR_BRAND.purple,
    label: (project.name?.[0] ?? '?').toUpperCase(),
  };
}

// ============================================================================
// Helper JSX (not a component — inline `<Text>` with Linear styling)
// ============================================================================

/**
 * Renders an identifier like `TER-123` in monospace + Linear purple. Use
 * where the identifier needs visual emphasis (EntityRow subtitle, detail
 * header). NOT exported as a React component because there is nothing to
 * customize — pure inline JSX.
 */
export function identifierText(id: string | null | undefined): React.ReactNode {
  if (!id) return null;
  return (
    <Text color={LINEAR_BRAND.purple} fontSize={9} fontFamily="$mono" fontWeight="600">
      {id}
    </Text>
  );
}

// ============================================================================
// Generic helpers (local — do not pollute the primitives barrel)
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

export function shortId(id: string | undefined | null, head = 8, tail = 4): string {
  if (!id) return '—';
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

/** Extracts an object shape tolerant to `{ <key>: {...} }` or direct object. */
export function unwrap<T extends object>(
  parsed: unknown,
  wrapperKey: string,
  identifierField: keyof T,
): T | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const wrapped = obj[wrapperKey];
  if (wrapped && typeof wrapped === 'object' && (identifierField as string) in wrapped) {
    return wrapped as T;
  }
  if ((identifierField as string) in obj) return obj as T;
  return null;
}

/** Extracts a list tolerant to `{ <key>: [...] }`, `{ <key>: [...], nextCursor }` or direct array. */
export function unwrapList<T>(
  parsed: unknown,
  wrapperKey: string,
): { items: T[]; nextCursor?: string | null; total?: number; hasMore?: boolean } {
  if (!parsed) return { items: [] };
  if (Array.isArray(parsed)) return { items: parsed as T[] };
  if (typeof parsed !== 'object') return { items: [] };
  const obj = parsed as Record<string, unknown>;
  const list = obj[wrapperKey];
  const items = Array.isArray(list) ? (list as T[]) : [];
  const nextCursor = typeof obj.nextCursor === 'string' ? (obj.nextCursor as string) : null;
  const total = typeof obj.total === 'number' ? (obj.total as number) : undefined;
  const hasMore = typeof obj.hasMore === 'boolean' ? (obj.hasMore as boolean) : undefined;
  return { items, nextCursor, total, hasMore };
}

/**
 * Derives a KeyValueGrid diff-like from the input arguments of an update.
 * Skips undefined/null/empty; truncates long strings for display.
 */
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
        : Array.isArray(v)
          ? `(${v.length} item${v.length !== 1 ? 's' : ''})`
          : typeof v === 'object'
            ? '(updated)'
            : String(v);
    out.push({ key: k, value: str });
  }
  return out;
}

/**
 * Adapts the parent's ToolCallRendererProps status (`pending | running |
 * completed | failed | pending_permission`) to the primitives' McaStatusType
 * (without `pending`).
 */
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
  if (status === 'running' || status === 'pending')
    return <Badge text="running" variant="info" />;
  return null;
}

// ============================================================================
// LinearToolShell — compose-only wrapper (no duplication)
// ============================================================================

interface LinearToolShellProps {
  toolName: string;
  status: ToolCallRendererProps['status'];
  duration?: number;
  /** Custom description; overrides the default TOOL_LABELS lookup. */
  description?: string;
  /** Rendered only when `status === 'completed'` and no error. */
  children?: React.ReactNode;
  /** Whether the card is expanded by default. */
  defaultExpanded?: boolean;
  /** Optional badge override (defaults to status-derived badge). */
  badge?: React.ReactNode;
}

/**
 * Pre-fills `iconUri={LINEAR_ICON}`, the description label and the status
 * badge on top of the global `<ToolCallCard/>`. No new styling here — the
 * global primitive does the visual work; this wrapper just saves boilerplate.
 */
export function LinearToolShell({
  toolName,
  status,
  duration,
  description,
  children,
  defaultExpanded,
  badge,
}: LinearToolShellProps) {
  return (
    <ToolCallCard
      status={toolStatusForPrimitive(status)}
      description={description}
      verb={getToolLabel(toolName)}
      iconUri={LINEAR_ICON}
      badge={badge ?? statusBadge(status)}
      defaultExpanded={defaultExpanded}
    >
      {children}
    </ToolCallCard>
  );
}
