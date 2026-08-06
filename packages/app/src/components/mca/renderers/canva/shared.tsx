/**
 * Canva — constants, types, helpers, and a compose-only `CanvaToolShell`.
 *
 * Zero components are defined here. The global primitives cover every
 * Canva-specific UI case through props. What lives here:
 *
 *  - Constants: official Canva brand palette + design-type colors + logo url.
 *  - Types for the curated camelCase shapes returned by mca.canva v1.1+.
 *  - Tolerant getters and prop factories for the global primitives.
 *  - `CanvaToolShell` — pre-fills `iconUri={CANVA_ICON}` + description.
 *
 * Identity is conveyed through 3 mechanisms (no local components):
 *  1. Logo:   `iconUri={CANVA_ICON}` on the ToolCallCard header.
 *  2. Palette: `CANVA_BRAND` + `DESIGN_TYPE_COLORS` constants below
 *     (validated against the public Canva brand kit, NOT Tailwind defaults).
 *  3. Backend `.color` fields — passed straight through to `IconChip` accent.
 */

import { Image as ImageIcon, Music2, Type as TypeIcon, Video } from '../../primitives';
import type React from 'react';
import { Image, Text, YStack } from 'tamagui';
import {
  Badge,
  type KeyValueRow,
  ToolCallCard,
  colors,
  useColors,
  useMcaTheme,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';

// ============================================================================
// Constants — brand identity
// ============================================================================

export const CANVA_ICON = `${process.env.EXPO_PUBLIC_BACKEND_URL}/static/canva.png`;

/**
 * Canva official brand palette. Validated against canva.com/brand and the
 * product UI — **NOT** Tailwind defaults. Common LLM mistake: using
 * `#3b82f6` (Tailwind blue) for the primary; Canva primary is teal.
 */
export const CANVA_BRAND = {
  teal: '#00C4CC', // primary
  purple: '#7D2AE8', // secondary (gradient end)
  mint: '#00C4A7',
  coral: '#FF6F61',
  sun: '#FFC700',
  ink: '#1F1F1F',
} as const;

/**
 * Design-type accent palette for known presets. Falls back to teal for
 * unknown / custom types.
 */
export const DESIGN_TYPE_COLORS: Record<string, string> = {
  presentation: CANVA_BRAND.purple,
  doc: CANVA_BRAND.mint,
  whiteboard: CANVA_BRAND.sun,
  email: CANVA_BRAND.coral,
  video: CANVA_BRAND.coral,
  social_media: CANVA_BRAND.teal,
  poster: CANVA_BRAND.purple,
};

/**
 * Asset-type accent palette by Canva asset.type field (image / video / audio /
 * other). Used for IconChip + IconTile leading accents.
 */
export const ASSET_TYPE_ACCENTS: Record<string, string> = {
  image: CANVA_BRAND.teal,
  video: CANVA_BRAND.coral,
  audio: CANVA_BRAND.purple,
};

export const ASSET_TYPE_ICONS: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  image: ImageIcon,
  video: Video,
  audio: Music2,
};

/**
 * Job status accents — uniform across export / import / autofill / resize /
 * asset upload. Canva returns `in_progress | success | failed`.
 */
export const JOB_STATUS_ACCENTS: Record<string, string> = {
  in_progress: CANVA_BRAND.teal,
  success: colors.green,
  failed: colors.red,
};

export const JOB_STATUS_LABELS: Record<string, string> = {
  in_progress: 'Running',
  success: 'Done',
  failed: 'Failed',
};

// ============================================================================
// Theme-aware color hook
// ============================================================================

/**
 * Canva renderer palette. Combines the official Canva brand colors (kept
 * hardcoded per brand guidelines) with the Design System theme-adaptive surface
 * tokens from `useColors()`. The translucent overlays used by the Polaroid
 * frame and web scrollbar switch between dark/light variants so they remain
 * readable in both themes.
 */
export function useCanvaColors() {
  const c = useColors();
  const theme = useMcaTheme();
  const isDark = theme === 'dark';

  return {
    ...c,
    theme,
    isDark,
    brand: CANVA_BRAND,
    // Translucent overlays that must invert between themes.
    scrollbarColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)',
    polaroidBg: isDark ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.05)',
    polaroidPlaceholderBg: isDark ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.08)',
    polaroidBorder: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
  };
}

// ============================================================================
// Web scrollbar helper
// ============================================================================

/**
 * Theme-aware scrollbar style hook. Returns a web-only CSS object suitable for
 * `ScrollView style` on web. Must be called inside a component because it reads
 * the active theme via `useCanvaColors()`.
 */
export function useScrollStyle(maxHeight: number) {
  const { scrollbarColor } = useCanvaColors();
  return {
    maxHeight,
    // biome-ignore lint/suspicious/noExplicitAny: CSS scrollbar props are web-only, not in RN ViewStyle
    scrollbarWidth: 'thin',
    // biome-ignore lint/suspicious/noExplicitAny: idem
    scrollbarColor: `${scrollbarColor} transparent`,
  } as any;
}

// ============================================================================
// Curated shape types (mca.canva v1.1+ — see lib/_canva-helpers.ts backend)
// ============================================================================

export interface CanvaDesign {
  id: string | null;
  title: string | null;
  ownerUserId?: string | null;
  ownerTeamId?: string | null;
  thumbnailUrl: string | null;
  thumbnailWidth?: number | null;
  thumbnailHeight?: number | null;
  editUrl?: string | null;
  viewUrl?: string | null;
  pageCount?: number | null;
  createdAt?: number | null;
  updatedAt?: number | null;
}

export interface CanvaFolder {
  id: string | null;
  name: string | null;
  thumbnailUrl?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
}

export interface CanvaFolderItem {
  type: string | null;
  id: string | null;
  name: string | null;
  thumbnailUrl?: string | null;
  pinStatus?: string | null;
}

export interface CanvaAsset {
  id: string | null;
  name: string | null;
  type: string | null;
  tags?: string[];
  thumbnailUrl: string | null;
  thumbnailWidth?: number | null;
  thumbnailHeight?: number | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: number | null;
  updatedAt?: number | null;
}

export interface CanvaBrandTemplate {
  id: string | null;
  title: string | null;
  thumbnailUrl: string | null;
  viewUrl?: string | null;
  createUrl?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
}

export interface CanvaJob<TResult = unknown> {
  id: string | null;
  status: string | null;
  error: { code: string | null; message: string | null } | null;
  result: TResult | null;
}

export interface CanvaThread {
  id: string | null;
  designId: string | null;
  authorUserId: string | null;
  messagePlaintext: string | null;
  resolved: boolean | null;
  createdAt?: number | null;
  updatedAt?: number | null;
}

export interface CanvaReply {
  id: string | null;
  threadId: string | null;
  authorUserId: string | null;
  messagePlaintext: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
}

// ============================================================================
// Tool labels
// ============================================================================

export const TOOL_LABELS: Record<string, string> = {
  // Users
  'get-user': 'Current user',
  'get-user-profile': 'User profile',
  'get-user-capabilities': 'User capabilities',
  // Designs
  'list-designs': 'Designs',
  'get-design': 'Design details',
  'create-design': 'Create design',
  'get-design-pages': 'Design pages',
  'get-design-export-formats': 'Supported export formats',
  // Exports + resizes
  'export-design': 'Export design',
  'get-export-job': 'Export job',
  'create-resize-job': 'Resize design',
  'get-resize-job': 'Resize job',
  // Imports
  'import-design': 'Import design',
  'get-import-job': 'Import job',
  // Folders
  'list-folders': 'Folder items',
  'get-folder': 'Folder details',
  'create-folder': 'Create folder',
  'update-folder': 'Rename folder',
  'delete-folder': 'Delete folder',
  'move-item': 'Move item',
  // Assets
  'upload-asset': 'Upload asset',
  'get-asset-upload-job': 'Upload job',
  'get-asset': 'Asset details',
  'update-asset': 'Update asset',
  'delete-asset': 'Delete asset',
  // Brand templates + autofill
  'list-brand-templates': 'Brand templates',
  'get-brand-template': 'Brand template',
  'get-brand-template-dataset': 'Template dataset',
  'autofill-design': 'Autofill template',
  'get-autofill-job': 'Autofill job',
  // Comments
  'create-thread': 'Create thread',
  'get-thread': 'Thread',
  'list-replies': 'Replies',
  'create-reply': 'Reply',
  'get-reply': 'Reply',
};

export function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

function humanize(name: string): string {
  return name
    .replace(/-/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

export function getToolLabel(toolName: string): string {
  const short = getShortToolName(toolName);
  return TOOL_LABELS[short] ?? humanize(short);
}

// ============================================================================
// Helpers
// ============================================================================

export function formatTimestamp(epochSec?: number | null): string {
  if (!epochSec || !Number.isFinite(epochSec)) return '—';
  try {
    return new Date(epochSec * 1000).toISOString().slice(0, 10);
  } catch {
    return '—';
  }
}

export function shortId(id: string | undefined | null, head = 8, tail = 4): string {
  if (!id) return '—';
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

/**
 * Narrow an unknown to a non-array object (the only shape our shape builders
 * can read). Returns null when the input is missing, a string (parseOutput
 * fallback), an array, or any other primitive.
 */
export function narrowObject<T>(value: unknown): T | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as T;
}

export function unwrap<T>(parsed: unknown, key: string): T | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (o[key] && typeof o[key] === 'object') return o[key] as T;
  return parsed as T;
}

export function unwrapList<T>(
  parsed: unknown,
  key: string,
): { items: T[]; nextCursor?: string | null; total?: number; hasMore?: boolean } {
  if (!parsed) return { items: [] };
  if (Array.isArray(parsed)) return { items: parsed as T[] };
  if (typeof parsed !== 'object') return { items: [] };
  const o = parsed as Record<string, unknown>;
  const list = o[key];
  return {
    items: Array.isArray(list) ? (list as T[]) : [],
    nextCursor: typeof o.nextCursor === 'string' ? o.nextCursor : null,
    total: typeof o.total === 'number' ? o.total : undefined,
    hasMore: typeof o.hasMore === 'boolean' ? o.hasMore : undefined,
  };
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
        : Array.isArray(v)
          ? `(${v.length} item${v.length !== 1 ? 's' : ''})`
          : typeof v === 'object'
            ? '(updated)'
            : String(v);
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
  if (status === 'running' || status === 'pending')
    return <Badge text="running" variant="info" />;
  return null;
}

// ============================================================================
// Polaroid — inline thumbnail preview (read-media pattern, TER-270)
// ============================================================================

export interface PolaroidProps {
  url: string | null | undefined;
  /** Frame width. Always honored. */
  width?: number;
  /** Fallback height when no thumbnail dims are provided. */
  height?: number;
  /**
   * Original asset dimensions. When both are passed (and both > 0), the
   * frame height is derived from `width * (thumbnailHeight / thumbnailWidth)`
   * clamped to [minHeight, maxHeight]. This keeps panoramic logos and
   * portrait designs visible without distortion.
   */
  thumbnailWidth?: number | null;
  thumbnailHeight?: number | null;
  /** Lower bound for derived height. Default 60. */
  minHeight?: number;
  /** Upper bound for derived height. Default 200. */
  maxHeight?: number;
  alt?: string | null;
  /** Caption rendered below the image (e.g. design title). */
  caption?: string;
  /** Sub-caption rendered in muted color (e.g. dimensions or page count). */
  subCaption?: string;
}

/**
 * Polaroid is a tiny composition over `<Image/>` with a dark frame that
 * matches the Canva renderer cards. Uses `resizeMode="contain"` so the
 * asset is always fully visible (panoramic logos and portrait designs
 * don't get cropped). Falls back to a placeholder block when the URL is
 * missing.
 *
 * Not a "primitive" — local to the canva renderer because it has no other
 * consumers. Will graduate to `primitives/` when Figma / Higgsfield need it.
 */
export function Polaroid({
  url,
  width = 160,
  height = 120,
  thumbnailWidth,
  thumbnailHeight,
  minHeight = 60,
  maxHeight = 200,
  alt,
  caption,
  subCaption,
}: PolaroidProps) {
  const c = useCanvaColors();
  const w = width;
  const derivedH =
    thumbnailWidth && thumbnailHeight && thumbnailWidth > 0
      ? Math.min(maxHeight, Math.max(minHeight, Math.round(w * (thumbnailHeight / thumbnailWidth))))
      : height;

  return (
    <YStack
      backgroundColor={c.polaroidBg}
      borderRadius={6}
      padding={6}
      gap={4}
      borderWidth={1}
      borderColor={c.polaroidBorder}
    >
      {url ? (
        <Image
          source={{ uri: url }}
          width={w}
          height={derivedH}
          borderRadius={3}
          backgroundColor={c.polaroidPlaceholderBg}
          // biome-ignore lint/suspicious/noExplicitAny: resizeMode is RN Image prop, not in Tamagui Image typings
          {...({ resizeMode: 'contain' } as any)}
          alt={alt ?? caption ?? 'preview'}
        />
      ) : (
        <YStack
          width={w}
          height={derivedH}
          borderRadius={3}
          backgroundColor={c.polaroidPlaceholderBg}
          alignItems="center"
          justifyContent="center"
        >
          <TypeIcon size={20} color={c.text3} />
        </YStack>
      )}
      {caption ? (
        <Text color={c.text} fontSize={10} numberOfLines={1}>
          {caption}
        </Text>
      ) : null}
      {subCaption ? (
        <Text color={c.text3} fontSize={9} fontFamily="$mono">
          {subCaption}
        </Text>
      ) : null}
    </YStack>
  );
}

// ============================================================================
// CanvaToolShell — compose-only wrapper
// ============================================================================

interface CanvaToolShellProps {
  toolName: string;
  status: ToolCallRendererProps['status'];
  duration?: number;
  description?: string;
  children?: React.ReactNode;
  defaultExpanded?: boolean;
  badge?: React.ReactNode;
}

export function CanvaToolShell({
  toolName,
  status,
  duration,
  description,
  children,
  defaultExpanded,
  badge,
}: CanvaToolShellProps) {
  return (
    <ToolCallCard
      status={toolStatusForPrimitive(status)}
      description={description}
      verb={getToolLabel(toolName)}
      iconUri={CANVA_ICON}
      badge={badge ?? statusBadge(status)}
      defaultExpanded={defaultExpanded}
    >
      {children}
    </ToolCallCard>
  );
}
