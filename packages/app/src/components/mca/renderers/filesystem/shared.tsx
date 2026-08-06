/**
 * Filesystem MCA — Shared (compose-only)
 *
 * Pattern TER-281: zero local components, only constants + helpers (data &amp;
 * props for the global primitives) + a single compose-only wrapper around
 * `ToolCallCard`. If the API of a primitive changes, only this file is touched.
 */

import {
  File as FileIcon,
  FileBox as FileBinaryIcon,
  Folder as FolderIcon,
  Image as ImageIcon,
  Link as LinkIcon,
} from '../../primitives';
import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { Badge, Empty, IconTile, ToolCallCard, colors, useColors } from '../../primitives';
import type { McaStatusType } from '../../primitives/colors';
import { parseOutput } from '../../primitives';
import type { ToolCallRendererProps, ToolStatus } from '../../types';
import {
  type FilesystemPermissionInput,
  getFilesystemPermissionDescription,
} from '../filesystem-permission-description';

// ============================================================================
// Constants
// ============================================================================

/**
 * Cap visual for collections in the chat. The backend already paginates with
 * `cursor`/`limit`, but if a single response carries more than this, the
 * renderer truncates display and shows a `paginationFooter`.
 */
export const LIST_RENDER_CAP = 50;

/** Max height for any code/diff block before scroll kicks in. */
export const CODE_BLOCK_MAX_HEIGHT = 360;

/** Tools that auto-expand on first render — all collapsed by default. */
export const DEFAULT_EXPANDED_TOOLS = new Set<string>([]);

/**
 * Border-left accent per tool — REMOVED.
 *
 * Earlier iteration painted indigo/red 3px borders on mutation/destructive
 * tools, but it produced a noisy "rainbow" of stripes when the chat had
 * multiple tool calls. The verb badge in the header (`deleted`,
 * `created`, `updated`, etc.) and the trash/folder icons already carry
 * that semantics. Less is more.
 *
 * Kept as an empty map for future opt-in; `FilesystemToolShell` reads it
 * via `TOOL_ACCENTS[toolName]` (returns undefined → no accent).
 */
export const TOOL_ACCENTS: Record<string, string> = {};

/**
 * Human-readable label per tool. The shell composes the final card description
 * using this + (optional) extra context (filename, count) provided by each
 * sub-renderer through the `description` override.
 */
export const TOOL_LABELS: Record<string, string> = {
  '-health-check': 'Health check',
  'list-roots': 'Workspace roots',
  read: 'Read file',
  'read-batch': 'Read files (batch)',
  'read-media': 'Read media',
  write: 'Write file',
  append: 'Append to file',
  edit: 'Edit file',
  patch: 'Apply patch',
  list: 'List directory',
  tree: 'Tree directory',
  stat: 'Stat path',
  hash: 'Hash file',
  glob: 'Glob files',
  grep: 'Grep contents',
  delete: 'Delete path',
  copy: 'Copy',
  move: 'Move',
  mkdir: 'Make directory',
};

/**
 * Colors per filesystem `kind` — RESTRAINED.
 *
 * Earlier iteration used saturated purple/amber/cyan to "tag" image vs
 * binary vs text files. On a dense chat with many tool calls, that
 * looked like a color soup. Now everything is monochrome muted —
 * the file extension label inside `IconTile` is enough disambiguation.
 *
 * `image` is the only mild accent kept because image preview cards
 * benefit from a tiny visual cue when the renderer wants to highlight
 * a real image (rare). Even that is desaturated.
 */
// Filesystem kind tints — restrained monochrome muted. File extension
// inside `IconTile` is the real disambiguator. Hardcoded as theme-
// agnostic semantic muted hex; in light mode the IconTile background
// still contrasts because IconTile applies its own accent alpha.
export const KIND_COLORS = {
  image: '#A1A1AA',
  binary: '#A1A1AA',
  text: '#A1A1AA',
  default: '#A1A1AA',
} as const;

// ============================================================================
// Data helpers
// ============================================================================

export function statusType(status: ToolStatus): McaStatusType {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'pending_permission') return 'pending_permission';
  return 'running';
}

export function asObject(output: string | undefined): Record<string, any> | null {
  if (!output) return null;
  const parsed = parseOutput(output);
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : null;
}

export function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function humanSize(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function shortTime(iso: string | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export function kindAccent(kind: string | undefined): string {
  switch (kind) {
    case 'image':
      return KIND_COLORS.image;
    case 'binary':
      return KIND_COLORS.binary;
    case 'text':
      return KIND_COLORS.text;
    default:
      return KIND_COLORS.default;
  }
}

// ============================================================================
// Props helpers for shared primitives
// ============================================================================

/**
 * Leading icon tile — monochrome. Type wins (semantics: symlink > dir),
 * kind only differentiates the icon shape (image/binary/file glyph), not
 * its color. The file extension label inside the tile carries the kind
 * info textually — that's enough.
 */
export function kindIconLeading(opts: {
  name: string;
  kind?: string | undefined;
  type?: string | undefined; // 'file' | 'directory' | 'symlink' | 'other' | undefined
}): React.ReactNode {
  const { name, kind, type } = opts;
  const ext = name.split('.').pop()?.toUpperCase().slice(0, 3);
  const symlinkColor = '#A1A1AA'; // muted gray, theme-agnostic for monochrome IconTile

  if (type === 'symlink') {
    return <IconTile icon={<LinkIcon size={16} color={symlinkColor} />} size={28} />;
  }
  if (type === 'directory') {
    return <IconTile icon={<FolderIcon size={16} color="#A1A1AA" />} size={28} />;
  }
  if (kind === 'image') {
    return (
      <IconTile icon={<ImageIcon size={16} color="#A1A1AA" />} size={28} label={ext} />
    );
  }
  if (kind === 'binary') {
    return (
      <IconTile icon={<FileBinaryIcon size={16} color="#A1A1AA" />} size={28} label={ext} />
    );
  }
  // text / unknown — generic file
  return (
    <IconTile icon={<FileIcon size={16} color="#A1A1AA" />} size={28} label={ext} />
  );
}

/**
 * Build the badge text + variant for a `read` response. Shows truncation,
 * empty state, or the displayed/total ratio.
 */
export function readBadgeProps(data: Record<string, any>): { text: string; variant: 'info' | 'warning' | 'gray' } {
  const total = Number(data.totalLines ?? 0);
  const displayed = Number(data.displayedLines ?? 0);
  const truncated = Boolean(data.truncated);

  if (total === 0 && displayed === 0) {
    return { text: 'empty file', variant: 'gray' };
  }
  if (truncated) {
    return { text: `${displayed}/${total} lines (truncated)`, variant: 'warning' };
  }
  return { text: `${displayed}/${total} lines`, variant: 'info' };
}

// ============================================================================
// JSX helpers
// ============================================================================

/**
 * Build connector prefixes for a flattened tree. For each row we need to
 * know `depth` and `isLast` (last sibling at that depth) plus the
 * "ancestral lasts" so we know whether to draw `│` or empty padding for
 * each preceding level. Returns an array of `Connector` segments per row;
 * the renderer composes them as monospace columns separate from the name
 * (so copy-paste of the name stays clean).
 */
export interface FlatTreeRow<T> {
  depth: number;
  isLast: boolean;
  /** For each ancestor depth, was that ancestor the last sibling? */
  ancestorIsLast: boolean[];
  payload: T;
}

export function treeConnectors(row: FlatTreeRow<unknown>): string {
  if (row.depth <= 0) return '';
  let prefix = '';
  for (let i = 0; i < row.depth - 1; i++) {
    prefix += row.ancestorIsLast[i] ? '   ' : '│  ';
  }
  prefix += row.isLast ? '└─ ' : '├─ ';
  return prefix;
}

/**
 * Highlight a literal pattern inside a string. Returns alternating
 * `<Text>` segments (match in bold + accent, rest neutral). If the pattern
 * cannot be compiled or is empty, returns the text untouched.
 */
export function highlightMatch(
  text: string,
  pattern: string,
  opts?: { caseInsensitive?: boolean; accent?: string },
): React.ReactNode {
  if (!pattern || !text) return text;
  let regex: RegExp;
  try {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(escaped, opts?.caseInsensitive ? 'gi' : 'g');
  } catch {
    return text;
  }
  const accent = opts?.accent ?? colors.green; // semantic green (theme-agnostic)
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let counter = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <Text key={`m-${counter++}`} fontWeight="bold" color={accent}>
        {match[0]}
      </Text>,
    );
    lastIndex = match.index + match[0].length;
    if (match.index === regex.lastIndex) regex.lastIndex++;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return <>{parts}</>;
}

/**
 * Pagination footer: shows "Showing N of M" if collection got truncated.
 * Returns `null` if no truncation. Compose this inline at the bottom of any
 * list-style renderer.
 *
 * Now a React component so it can call `useColors()` for theme-adaptive
 * surface tokens (bgInner + text2) instead of hardcoded dark-only hex.
 */
export function PaginationFooter(opts: {
  total?: number;
  returned: number;
  truncated?: boolean;
  cursor?: string | null | undefined;
}): React.ReactNode {
  const { total, returned, truncated, cursor } = opts;
  const c = useColors();
  if (returned === 0) return null;
  if (!truncated && (total === undefined || total <= returned)) return null;
  const totalLabel = total !== undefined ? ` of ${total}` : '';
  const cursorHint = cursor ? ' — pass `cursor` to fetch the next page' : '';
  return (
    <XStack
      paddingHorizontal="$2"
      paddingVertical="$1.5"
      backgroundColor={c.bgInner}
      borderRadius="$2"
      alignItems="center"
      gap="$2"
    >
      <Text color={c.text2} fontSize={11}>
        Showing {returned}
        {totalLabel}
        {cursorHint}
      </Text>
    </XStack>
  );
}

/**
 * Empty-state when there is nothing to render but the call succeeded.
 * Tiny wrapper that defers visual to the global `Empty` primitive so we
 * keep zero local components.
 */
export function emptyState(message: string, hint?: string): React.ReactNode {
  return <Empty message={message} hint={hint} />;
}

// ============================================================================
// FilesystemToolShell — single compose-only wrapper around ToolCallCard
// ============================================================================

interface FilesystemToolShellProps {
  toolName: string;
  status: ToolStatus;
  duration?: number;
  /** Override the default label from TOOL_LABELS (e.g. add filename). */
  description?: string;
  badge?: React.ReactNode;
  /** Forwarded so the renderer doesn't need to know about it. */
  appIcon?: string;
  /** Force expand override; otherwise uses DEFAULT_EXPANDED_TOOLS. */
  defaultExpanded?: boolean;
  /** Override the auto-derived accent (TOOL_ACCENTS). */
  accent?: string;
  /**
   * Tool input. Used during `status === 'pending_permission'` to surface
   * a stronger natural-language warning ("Wants to permanently delete X.
   * This action is irreversible") via `getFilesystemPermissionDescription`.
   * Optional — if omitted, falls back to the regular `description` /
   * `TOOL_LABELS` chain.
   */
  input?: FilesystemPermissionInput;
  children?: React.ReactNode;
}

export function FilesystemToolShell({
  toolName,
  status,
  duration,
  description,
  badge,
  appIcon,
  defaultExpanded,
  accent,
  input,
  children,
}: FilesystemToolShellProps): React.ReactNode {
  // Permission flow override: use the rich filesystem permission helper
  // when the user is being asked to grant access. Falls through cleanly
  // for tools the helper doesn't recognise.
  const permissionDescription =
    status === 'pending_permission'
      ? getFilesystemPermissionDescription(getShortToolNameFs(toolName), input)
      : null;
  // Permission-flow description is a full sentence ("Read /tmp/foo") that
  // doesn't fit the tense scheme — pass it as a literal `description`. The
  // default tool-call path passes `verb` so the primitive composes tense.
  const verbLabel = description ?? TOOL_LABELS[toolName] ?? toolName;
  const expanded = defaultExpanded ?? DEFAULT_EXPANDED_TOOLS.has(toolName);
  const resolvedAccent = accent ?? TOOL_ACCENTS[toolName];
  return (
    <ToolCallCard
      status={statusType(status)}
      description={permissionDescription ?? undefined}
      verb={permissionDescription ? undefined : verbLabel}
      iconUri={appIcon}
      badge={badge}
      defaultExpanded={expanded}
      accent={resolvedAccent}
      animateExpand
    >
      {children}
    </ToolCallCard>
  );
}

function getShortToolNameFs(fullToolName: string): string {
  const parts = fullToolName.split('_');
  return parts[parts.length - 1] || fullToolName;
}

// Re-export helpers that downstream renderers will want, so each only
// imports from this single file. `colors` is intentionally not re-
// exported (commit III) — consumers that need theme tokens should
// import `useColors` from '../../primitives' directly.
export { Badge };
export type { ToolCallRendererProps };
