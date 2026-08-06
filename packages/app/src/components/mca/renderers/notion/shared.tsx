/**
 * Notion Renderer - Shared Components & Utilities
 */

import { Circle, type McaStatusType, statusDotColors, useColors } from '../../primitives';
import type React from 'react';
import { Image, Text, XStack } from 'tamagui';

// ============================================================================
// Constants
// ============================================================================

const NOTION_ICON = `${process.env.EXPO_PUBLIC_BACKEND_URL}/static/notion-icon.png`;

// ============================================================================
// Colors
// ============================================================================

// Renderer UX Guide v2 §5 — theme-adaptive Notion palette.
//
// Notion-specific brand colors (notionBlack/White, statusTodo/Backlog grays)
// are theme-agnostic and kept as literal hex — they don't have DS equivalents.
// All semantic status colors (success/running/pending/failed + glows) and page
// status colors (done/inProgress) are sourced from the DS `statusDotColors`
// tokens so they stay in sync with the rest of the platform.
export function useNotionColors() {
  const c = useColors();
  return {
    // Notion brand (theme-agnostic, no DS equivalent)
    notionBlack: '#000000',
    notionWhite: '#FFFFFF',

    // Status dot — sourced from DS statusDotColors (theme-agnostic semantic)
    success: statusDotColors.completed.fill,
    running: statusDotColors.running.fill,
    pending: statusDotColors.pending.fill,
    failed: statusDotColors.failed.fill,

    glowSuccess: statusDotColors.completed.glow,
    glowRunning: statusDotColors.running.glow,
    glowPending: statusDotColors.pending.glow,
    glowFailed: statusDotColors.failed.glow,

    // Badges (theme-adaptive via useColors)
    badgeSuccess: c.badges.ok,
    badgeError: c.badges.err,
    badgeInfo: c.badges.info,
    badgeWarning: c.badges.warn,
    badgeGray: c.badges.gray,

    // Page status — done/inProgress from DS semantic tokens, todo/backlog are
    // Notion-specific grays with no DS equivalent (kept as literal hex).
    statusDone: statusDotColors.completed.fill,
    statusInProgress: statusDotColors.running.fill,
    statusTodo: '#6b7280',
    statusBacklog: '#52525b',

    // Text (theme-adaptive via useColors)
    primary: c.text,
    secondary: c.text2,
    muted: c.text3,
    bright: c.text,

    // Backgrounds (theme-adaptive via useColors)
    bgFilter: c.bgInner,
    bgDark: c.bgInner,

    // Chevron (theme-adaptive via useColors)
    chevron: c.text3,
    ...c,
  };
}

// ============================================================================
// Types
// ============================================================================
//
// Types cover both the old raw Notion API shape and the new curated shape
// returned by mca.notion ≥1.1.0 (TER-272). Helpers below detect which shape
// they receive and handle both until legacy callers are fully migrated.

/** New curated icon shape (preferred). Old shape kept for back-compat. */
export type NotionIconNew = { type: 'emoji' | 'external' | 'file'; value: string };
export type NotionIconLegacy = {
  type: 'emoji' | 'external' | 'file';
  emoji?: string;
  external?: { url: string };
  file?: { url: string };
};
export type NotionIcon = NotionIconNew | NotionIconLegacy;

export interface NotionRichText {
  type: string;
  text?: { content: string; link?: { url: string } | null };
  plain_text?: string;
  annotations?: Record<string, unknown>;
  href?: string | null;
}

export interface NotionPage {
  id: string;
  object?: 'page' | 'database';
  title?: string | NotionRichText[];
  icon?: NotionIcon | null;
  cover?: NotionIcon | null;
  url?: string | null;
  /**
   * Curated shape: `{ Name: 'X', Status: 'Active' }` (values already resolved).
   * Legacy shape: full Notion property objects (walked by getStatusFromProperties).
   */
  properties?: Record<string, unknown>;
  createdTime?: string | null;
  lastEditedTime?: string | null;
  parentType?: string;
  parentId?: string | null;
  archived?: boolean;
}

export interface NotionDatabase {
  id: string;
  object?: 'database';
  title?: string | NotionRichText[];
  description?: string | NotionRichText[];
  icon?: NotionIcon | null;
  cover?: NotionIcon | null;
  url?: string | null;
  /** Legacy raw properties OR curated schema `{ name: { type, name } }`. */
  properties?: Record<string, unknown>;
  /** Curated shape (TER-272): schema summary `{ Name: { type: 'title', name: 'Name' } }`. */
  schema?: Record<string, { type: string; name?: string }>;
  createdTime?: string | null;
  lastEditedTime?: string | null;
}

export interface NotionUser {
  id: string;
  name?: string | null;
  avatarUrl?: string | null;
  type?: 'person' | 'bot';
  email?: string | null;
  bot?: boolean;
}

export interface NotionBlock {
  id: string;
  type: string;
  hasChildren?: boolean;
  /** New curated shape: plain text already extracted. */
  plainText?: string;
  language?: string;
  checked?: boolean;
  caption?: string;
  url?: string;
  createdTime?: string | null;
  lastEditedTime?: string | null;
  archived?: boolean;
}

export interface NotionComment {
  id: string;
  /** Legacy field name. */
  text?: string;
  /** New curated field (TER-272). */
  plainText?: string;
  createdTime?: string | null;
  createdBy?: NotionUser;
  /** New curated fields (TER-272). */
  authorId?: string | null;
  pageId?: string | null;
  parentBlockId?: string | null;
  discussionId?: string | null;
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Extracts plain text from a Notion field. Accepts:
 *  - curated shape: already a string → passthrough.
 *  - legacy shape: NotionRichText[] → concat plain_text.
 */
export function extractPlainText(field?: string | NotionRichText[] | null): string {
  if (!field) return '';
  if (typeof field === 'string') return field;
  if (Array.isArray(field)) {
    return field.map((rt) => rt.plain_text ?? rt.text?.content ?? '').join('');
  }
  return '';
}

export function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

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

export function getPageTitle(page: NotionPage | NotionDatabase): string {
  const title = (page as NotionPage).title;
  // Curated shape: already a string.
  if (typeof title === 'string') return title || 'Untitled';
  // Legacy raw shape: rich_text array.
  if (Array.isArray(title)) {
    const extracted = extractPlainText(title);
    if (extracted) return extracted;
  }

  // Legacy fallback: walk raw properties for a title field.
  const props = (page as NotionPage).properties;
  if (props) {
    const titleProp = Object.values(props).find(
      (p: any) => p?.type === 'title' && p?.title?.[0]?.plain_text,
    ) as any;
    if (titleProp) return titleProp.title[0].plain_text;
  }

  return 'Untitled';
}

export function getPageIcon(page: NotionPage | NotionDatabase): string {
  const icon = (page as any).icon as NotionIcon | null | undefined;
  if (!icon) return '📄';
  // Curated shape: { type, value }.
  if ('value' in icon && typeof (icon as NotionIconNew).value === 'string') {
    if (icon.type === 'emoji') return (icon as NotionIconNew).value;
    // external/file URLs are not unicode — the caller should render an <Image>
    // instead. Return the default emoji as a placeholder.
    return '📄';
  }
  // Legacy shape.
  const legacy = icon as NotionIconLegacy;
  if (legacy.type === 'emoji' && legacy.emoji) return legacy.emoji;
  return '📄';
}

/**
 * Returns the icon image URL when the icon is external/file, else null.
 * Useful for rendering an <Image> alongside/instead of the emoji fallback.
 */
export function getPageIconUrl(page: NotionPage | NotionDatabase): string | null {
  const icon = (page as any).icon as NotionIcon | null | undefined;
  if (!icon) return null;
  if ('value' in icon) {
    if (icon.type === 'external' || icon.type === 'file') return (icon as NotionIconNew).value;
    return null;
  }
  const legacy = icon as NotionIconLegacy;
  if (legacy.type === 'external' && legacy.external?.url) return legacy.external.url;
  if (legacy.type === 'file' && legacy.file?.url) return legacy.file.url;
  return null;
}

/**
 * Given a page's properties, find a status-like value (string) regardless of
 * shape. Curated properties are flat strings; legacy are Notion property
 * objects with .status.name / .select.name.
 */
export function getStatusFromProperties(
  properties: Record<string, unknown> | undefined,
): string | undefined {
  if (!properties) return undefined;

  for (const [key, value] of Object.entries(properties)) {
    // Curated flat shape: value is a primitive; look for status-like keys.
    if (typeof value === 'string') {
      if (/^status$|^state$/i.test(key) && value.trim()) return value;
    }
    // Legacy raw shape.
    if (value && typeof value === 'object') {
      const v = value as any;
      if (v?.type === 'status' && v.status?.name) return v.status.name;
      if (v?.type === 'select' && v.select?.name) return v.select.name;
    }
  }
  return undefined;
}

/**
 * Given a page's properties, find a date-like ISO string regardless of shape.
 */
export function getDateFromProperties(
  properties: Record<string, unknown> | undefined,
): string | undefined {
  if (!properties) return undefined;
  for (const value of Object.values(properties)) {
    if (value && typeof value === 'object') {
      const v = value as any;
      // Curated date shape: { start, end, timeZone }.
      if (typeof v?.start === 'string') return v.start;
      // Legacy raw shape.
      if (v?.type === 'date' && v.date?.start) return v.date.start;
    }
  }
  return undefined;
}

/**
 * Extract a small, human-readable value from a property entry for a compact
 * pill render. Returns null when nothing sensible is available.
 */
export function formatPropertyPreview(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '✓' : '✗';
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const firstString = value.find((x) => typeof x === 'string');
    if (firstString) return String(firstString);
    return `${value.length} items`;
  }
  if (typeof value === 'object') {
    const v = value as any;
    // Curated date shape.
    if (typeof v.start === 'string') return formatDate(v.start);
    // Legacy property objects.
    if (v.type === 'status' && v.status?.name) return v.status.name;
    if (v.type === 'select' && v.select?.name) return v.select.name;
    if (v.type === 'date' && v.date?.start) return formatDate(v.date.start);
    if (v.type === 'checkbox') return v.checkbox ? '✓' : '✗';
    if (v.type === 'number' && typeof v.number === 'number') return String(v.number);
  }
  return null;
}

// Notion page status colors (semantic enum, theme-agnostic).
// Single source of truth — referenced by both useNotionColors() and
// getStatusColor(). done/inProgress sourced from DS statusDotColors;
// todo/backlog are Notion-specific grays with no DS equivalent.
const NOTION_PAGE_STATUS = {
  done: statusDotColors.completed.fill,
  inProgress: statusDotColors.running.fill,
  todo: '#6b7280',
  backlog: '#52525b',
} as const;

export function getStatusColor(status?: string): string {
  if (!status) return NOTION_PAGE_STATUS.backlog;
  const lower = status.toLowerCase();
  if (lower.includes('done') || lower.includes('complete')) return NOTION_PAGE_STATUS.done;
  if (lower.includes('progress') || lower.includes('started') || lower.includes('doing')) return NOTION_PAGE_STATUS.inProgress;
  if (lower.includes('todo') || lower.includes('not started')) return NOTION_PAGE_STATUS.todo;
  return NOTION_PAGE_STATUS.backlog;
}

export function isSuccessMessage(parsed: unknown): boolean {
  return (
    typeof parsed === 'string' &&
    (parsed.includes('✅') ||
      parsed.includes('success') ||
      parsed.includes('Success') ||
      parsed.includes('created') ||
      parsed.includes('updated') ||
      parsed.includes('deleted'))
  );
}

export function formatDate(dateString?: string): string {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ============================================================================
// Components
// ============================================================================

export function NotionLogo({ size = 14 }: { size?: number }) {
  return <Image source={{ uri: NOTION_ICON }} width={size} height={size} borderRadius={2} />;
}

export type ToolStatusType = McaStatusType;

// StatusDot lives in `../../primitives`; ToolCallCard mounts it.
// Badge re-exports the global theme-adaptive primitive.
export {
  Badge,
  colors,
  countBadgeVariant,
  Empty,
  ErrorBlock,
  ExpandedBody,
  ExpandedContainer,
  formatCountBadge,
  HeaderRow,
  SuccessBlock,
  ToolCallCard,
} from '../../primitives';

interface PageStatusBadgeProps {
  status?: string;
}

export function PageStatusBadge({ status }: PageStatusBadgeProps) {
  const colors = useNotionColors();
  const color = getStatusColor(status);

  return (
    <XStack
      backgroundColor={`${color}15`}
      paddingHorizontal={5}
      paddingVertical={2}
      borderRadius={3}
      alignItems="center"
      gap={4}
    >
      <Circle size={5} color={color} weight="fill" />
      <Text color={color} fontSize={8} fontFamily="$mono">
        {status || 'Backlog'}
      </Text>
    </XStack>
  );
}

// HeaderRow / ExpandedContainer / ExpandedBody / ErrorBlock / SuccessBlock
// live in `../../primitives`. Sub-renderers compose directly via
// `<ToolCallCard>`.

export function WarningBlock({ message }: { message: string }) {
  const c = useNotionColors();
  const colors = useNotionColors();
  return (
    <XStack
      backgroundColor={c.badges.warn.bg}
      borderRadius={5}
      paddingVertical={6}
      paddingHorizontal={8}
      alignItems="center"
      gap={6}
    >
      <Text color={c.badges.warn.text} fontSize={10}>
        ⚠️ {message}
      </Text>
    </XStack>
  );
}

interface FilterBlockProps {
  filter?: Record<string, unknown>;
  sorts?: Array<{ property?: string; direction?: string; timestamp?: string }>;
}

export function FilterBlock({ filter, sorts }: FilterBlockProps) {
  const c = useNotionColors();
  const colors = useNotionColors();
  const filterTags: string[] = [];
  const sortInfo: string[] = [];

  // Parse filter to extract readable tags
  if (filter) {
    const extractFilters = (f: any, depth = 0): void => {
      if (depth > 3) return; // Prevent infinite recursion
      
      if (f.property && f.status) {
        const statusVal = f.status.equals || f.status.does_not_equal;
        const op = f.status.equals ? '=' : '≠';
        if (statusVal) filterTags.push(`Status ${op} ${statusVal}`);
      }
      if (f.property && f.select) {
        const selectVal = f.select.equals || f.select.does_not_equal;
        const op = f.select.equals ? '=' : '≠';
        if (selectVal) filterTags.push(`${f.property} ${op} ${selectVal}`);
      }
      if (f.property && f.checkbox !== undefined) {
        filterTags.push(`${f.property} = ${f.checkbox.equals ? '✓' : '✗'}`);
      }
      if (f.and && Array.isArray(f.and)) {
        f.and.forEach((subF: any) => extractFilters(subF, depth + 1));
      }
      if (f.or && Array.isArray(f.or)) {
        f.or.forEach((subF: any) => extractFilters(subF, depth + 1));
      }
    };
    extractFilters(filter);
  }

  // Parse sorts
  if (sorts && Array.isArray(sorts)) {
    sorts.forEach((s) => {
      const prop = s.property || s.timestamp || 'Unknown';
      const dir = s.direction === 'ascending' ? '↑' : '↓';
      sortInfo.push(`${prop} ${dir}`);
    });
  }

  if (filterTags.length === 0 && sortInfo.length === 0) return null;

  return (
    <XStack
      backgroundColor={colors.bgFilter}
      borderRadius={5}
      paddingVertical={6}
      paddingHorizontal={8}
      alignItems="center"
      gap={8}
      flexWrap="wrap"
    >
      {filterTags.length > 0 && (
        <>
          <Text fontSize={9} color={c.text3} textTransform="uppercase" letterSpacing={0.5}>
            Filter
          </Text>
          {filterTags.map((tag, idx) => (
            <XStack
              key={idx}
              backgroundColor={c.badges.info.bg}
              paddingHorizontal={6}
              paddingVertical={2}
              borderRadius={3}
            >
              <Text fontSize={9} color={c.badges.info.text}>
                {tag}
              </Text>
            </XStack>
          ))}
        </>
      )}
      {sortInfo.length > 0 && (
        <>
          <XStack flex={1} />
          <Text fontSize={9} color={c.text3} textTransform="uppercase" letterSpacing={0.5}>
            Sort
          </Text>
          <Text fontSize={10} color={c.text2} fontFamily="$mono">
            {sortInfo.join(', ')}
          </Text>
        </>
      )}
    </XStack>
  );
}
