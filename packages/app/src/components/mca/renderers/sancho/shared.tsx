/**
 * Sancho — constants, types, helpers, and a compose-only `SanchoToolShell`.
 *
 * Zero local identity components (TER-281): the logo reaches the header via
 * `iconUri={SANCHO_ICON}` on the global `ToolCallCard`; status / preview
 * badges are DS `Badge` variants — never loose colors. What lives here:
 *
 *  - Constants: icon URL + provisional brand accent (SanchoCMO/Growth4U
 *    publishes no official palette; the MCA icon is a currentColor quill nib).
 *  - Types for the curated shapes returned by mca.sancho v1.1 tools.
 *  - Tolerant getters and prop factories for the global primitives.
 *  - `SanchoToolShell` — pre-fills `iconUri` + label + status badge.
 */

import type React from 'react';
import {
  Badge,
  getShortToolName,
  humanizeLabel,
  parseOutput,
  ToolCallCard,
  useColors,
  useMcaTheme,
} from '../../primitives';
import type { KeyValueRow } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { backendUrl } from '../../../../config/runtime';

// ============================================================================
// Constants — brand identity
// ============================================================================

export const SANCHO_ICON = `${backendUrl()}/static/mcas/mca.sancho/icon.png`;

/**
 * Provisional Sancho accent. SanchoCMO/Growth4U publishes no official brand
 * palette and the MCA icon is a currentColor quill nib, so identity leans on
 * the icon + this single warm parchment tone, tuned per theme for contrast.
 * Replace with the real vendor hexes when SanchoCMO publishes them.
 */
export const SANCHO_BRAND = {
  quillDark: '#D9A45B',
  quillLight: '#8C6239',
} as const;

/** Sancho renderer palette — DS surface tokens + the provisional accent. */
export function useSanchoColors() {
  const c = useColors();
  const theme = useMcaTheme();
  const isDark = theme === 'dark';

  return {
    ...c,
    theme,
    isDark,
    accent: isDark ? SANCHO_BRAND.quillDark : SANCHO_BRAND.quillLight,
    scrollbarColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)',
  };
}

/** Web-only thin scrollbar style for `<ScrollView style={…}/>`. */
export function useScrollStyle(maxHeight: number) {
  const { scrollbarColor } = useSanchoColors();
  return {
    maxHeight,
    // biome-ignore lint/suspicious/noExplicitAny: CSS scrollbar props are web-only, not in RN ViewStyle
    scrollbarWidth: 'thin',
    // biome-ignore lint/suspicious/noExplicitAny: idem
    scrollbarColor: `${scrollbarColor} transparent`,
  } as any;
}

// ============================================================================
// Curated output types (mca.sancho v1.1 — see mcas/mca.sancho/src/tools/*)
// ============================================================================

export interface SanchoClient {
  slug: string;
  name?: string;
  missionControlUrl?: string;
}

export type SanchoTaskStatus = string;

export interface SanchoTaskListItem {
  id: string;
  name: string;
  status?: SanchoTaskStatus;
  type?: string;
  owner?: string;
  agent?: string;
  skill?: string;
  parent_id?: string;
  brief?: string;
  deliverable?: string;
}

export interface SanchoIce {
  impact?: number;
  confidence?: number;
  ease?: number;
  score?: number;
  band?: string;
}

export interface SanchoTaskDetail extends SanchoTaskListItem {
  description?: string;
  completion?: string;
  ice?: SanchoIce;
  taskRevision?: string;
}

export interface SanchoDocumentListItem {
  path: string;
  title?: string;
  extension?: string;
  size?: number;
  updatedAt?: string;
  missionControlUrl?: string;
}

export interface SanchoOutlineHeading {
  number?: string;
  text?: string;
  level?: number;
}

export interface SanchoDocumentDetail {
  path?: string;
  title?: string;
  content?: string;
  outline?: Array<SanchoOutlineHeading | string>;
  nextOffset?: number;
  totalChars?: number;
}

export interface SanchoPassage {
  quote?: string;
  text?: string;
  passage?: string;
  docPath?: string;
  path?: string;
  score?: number;
}

export interface SanchoMcpStatus {
  ok?: boolean;
  server?: string;
  version?: string;
  principal?: {
    id?: string;
    role?: string;
    scopes?: string[];
    clients?: string[];
    brands?: string[];
  };
  runtime?: Record<string, unknown>;
  serverInstructions?: string;
}

export interface SanchoMcpToolEntry {
  name: string;
  description?: string;
}

// ============================================================================
// Tool labels
// ============================================================================

export const TOOL_LABELS: Record<string, string> = {
  '-health-check': 'Health check',
  'mcp-status': 'MCP server status',
  'mcp-list-tools': 'MCP tools',
  'mcp-call': 'MCP tool call',
  'list-clients': 'Clients',
  'get-client-context': 'Client context',
  'list-tasks': 'Tasks',
  'get-task': 'Task details',
  'update-task': 'Update task',
  'create-task': 'Create task',
  'list-documents': 'Brand documents',
  'get-document': 'Document',
  recall: 'Recall',
};

export function getToolLabel(toolName: string): string {
  const short = getShortToolName(toolName);
  return TOOL_LABELS[short] ?? humanizeLabel(short);
}

// ============================================================================
// Output parsing — tolerates the legacy MCP { content, structuredContent } envelope
// ============================================================================

/**
 * Parse a Sancho tool output: plain JSON, the raw MCP envelope
 * (`{ content: [{type:'text',text}], structuredContent }`), or the text
 * payload inside `content` — whichever carries an object.
 */
export function parseSanchoOutput<T = unknown>(output?: string): T | string | null {
  if (!output) return null;
  const parsed = parseOutput<T>(output);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    if (o.structuredContent && typeof o.structuredContent === 'object') {
      return o.structuredContent as T;
    }
    if (Array.isArray(o.content)) {
      const first = o.content.find(
        (c) => c && typeof c === 'object' && (c as { type?: string }).type === 'text',
      ) as { text?: string } | undefined;
      if (first?.text) {
        const inner = parseOutput<T>(first.text);
        if (inner && typeof inner === 'object') return inner;
      }
    }
  }
  return parsed;
}

// ============================================================================
// Tolerant shape helpers
// ============================================================================

/** Narrow an unknown to a non-array object, or null. */
export function narrowObject<T>(value: unknown): T | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as T;
}

/** `parsed.<key>` when present, else the whole object (detail payloads). */
export function unwrap<T>(parsed: unknown, key: string): T | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (o[key] && typeof o[key] === 'object') return o[key] as T;
  return parsed as T;
}

/** List payload with the pagination counters Sancho returns. */
export function unwrapList<T>(
  parsed: unknown,
  key: string,
): { items: T[]; matched?: number; count?: number; total?: number; hasMore?: boolean } {
  if (!parsed) return { items: [] };
  if (Array.isArray(parsed)) return { items: parsed as T[] };
  if (typeof parsed !== 'object') return { items: [] };
  const o = parsed as Record<string, unknown>;
  const list = o[key];
  return {
    items: Array.isArray(list) ? (list as T[]) : [],
    matched: typeof o.matched === 'number' ? o.matched : undefined,
    count: typeof o.count === 'number' ? o.count : undefined,
    total: typeof o.total === 'number' ? o.total : undefined,
    hasMore: typeof o.hasMore === 'boolean' ? o.hasMore : undefined,
  };
}

/** First array found under any of the candidate keys (recall passages). */
export function pickArray(parsed: unknown, keys: string[]): unknown[] {
  const o = narrowObject<Record<string, unknown>>(parsed);
  if (!o) return Array.isArray(parsed) ? parsed : [];
  for (const k of keys) {
    if (Array.isArray(o[k])) return o[k] as unknown[];
  }
  return [];
}

/** Best-effort scalar rendering for loosely-typed server fields. */
export function scalarText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** First non-empty scalar among an object's candidate keys. */
export function pickText(obj: unknown, keys: string[]): string | null {
  const o = narrowObject<Record<string, unknown>>(obj);
  if (!o) return null;
  for (const k of keys) {
    const t = scalarText(o[k]);
    if (t) return t;
  }
  return null;
}

/** Update-style diff rows for the whitelisted write fields. */
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

// ============================================================================
// Chip prop factories — feed the DS Badge, never loose colors
// ============================================================================

export type ChipVariant = 'success' | 'error' | 'info' | 'warning' | 'gray';

const TASK_STATUS_VARIANT: Record<string, ChipVariant> = {
  proposed: 'gray',
  todo: 'gray',
  'in-progress': 'info',
  'pending-review': 'warning',
  completed: 'success',
  blocked: 'error',
  cancelled: 'gray',
  archived: 'gray',
};

/** DS Badge props for a Sancho task status — unknown statuses fall to gray. */
export function taskStatusChipProps(status?: string): { text: string; variant: ChipVariant } {
  const s = (status ?? '').toLowerCase();
  return { text: s || 'unknown', variant: TASK_STATUS_VARIANT[s] ?? 'gray' };
}

const SEVERITY_VARIANT: Record<string, ChipVariant> = {
  high: 'error',
  critical: 'error',
  medium: 'warning',
  low: 'gray',
};

/** DS Badge props for a blocker severity — unknown severities are omitted. */
export function severityChipProps(severity?: string): { text: string; variant: ChipVariant } | null {
  if (!severity) return null;
  const s = String(severity).toLowerCase();
  if (!(s in SEVERITY_VARIANT)) return null;
  return { text: s, variant: SEVERITY_VARIANT[s] };
}

/**
 * PREVIEW vs WRITTEN for the dry-run-by-default write tools (update-task,
 * create-task). The server only writes when confirm:true AND dryRun:false —
 * anything else is a preview.
 */
export function writeModeChipProps(
  input?: Record<string, unknown>,
): { text: string; variant: ChipVariant; written: boolean } {
  const written = input?.confirm === true && input?.dryRun === false;
  return written
    ? { text: 'WRITTEN', variant: 'success', written: true }
    : { text: 'PREVIEW — NOT WRITTEN', variant: 'warning', written: false };
}

// ============================================================================
// Formatters
// ============================================================================

export function formatBytes(bytes?: number): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(iso?: string): string | null {
  if (!iso || typeof iso !== 'string') return null;
  const s = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export function shortId(id: string | undefined | null, head = 10, tail = 4): string {
  if (!id) return '—';
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export function truncate(text: string, maxLength = 50): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

// ============================================================================
// SanchoToolShell — compose-only wrapper
// ============================================================================

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

interface SanchoToolShellProps {
  toolName: string;
  status: ToolCallRendererProps['status'];
  description?: string;
  children?: React.ReactNode;
  badge?: React.ReactNode;
}

export function SanchoToolShell({
  toolName,
  status,
  description,
  children,
  badge,
}: SanchoToolShellProps) {
  return (
    <ToolCallCard
      status={toolStatusForPrimitive(status)}
      description={description ?? getToolLabel(toolName)}
      iconUri={SANCHO_ICON}
      badge={badge ?? statusBadge(status)}
    >
      {children}
    </ToolCallCard>
  );
}
