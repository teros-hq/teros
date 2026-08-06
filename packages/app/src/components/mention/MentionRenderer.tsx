/**
 * MentionRenderer
 *
 * Custom renderer for `teros://` links inside Markdown-rendered chat messages.
 *
 * When `react-native-render-html` encounters an `<a>` tag whose `href` starts
 * with `teros://`, instead of rendering a plain hyperlink it renders an inline
 * pill/chip that matches the visual style of `MentionChip` in the composer.
 *
 * URL schema: `teros://{type}/{id}`
 * Supported types: agent | project | app | skill | conversation | workspace
 *
 * On click (web) the chip calls `onMentionPress` if provided, which can open
 * the relevant resource window.
 */

import {
  BookOpen,
  FolderKanban,
  Home,
  MessageSquare,
  Package,
  Users,
} from '@tamagui/lucide-icons';
import React, { useState } from 'react';
import { Platform } from 'react-native';
import type { MentionResourceType } from '../../hooks/useAtMention';

// ── Design tokens (mirrors MentionChip.tsx) ───────────────────────────────────

const CHIP_BG = '#1a1a1a';
const CHIP_BORDER = 'rgba(113, 113, 122, 0.3)';
const CHIP_TEXT = '#e5e5e5';
const CHIP_BORDER_RADIUS = 9999;
const CHIP_HEIGHT = 22;
const CHIP_FONT_SIZE = 12;
const CHIP_FONT_WEIGHT = 500;
const CHIP_PADDING_LEFT = 6;
const CHIP_PADDING_RIGHT = 9;
const CHIP_GAP = 4;
const ICON_SIZE = 13;

// ── Icon / colour map per resource type ───────────────────────────────────────

const TYPE_CONFIG: Record<
  string,
  { Icon: React.ComponentType<any>; color: string }
> = {
  agent:        { Icon: Users,         color: '#4A9E5B' },
  project:      { Icon: FolderKanban,  color: '#F97316' },
  conversation: { Icon: MessageSquare, color: '#4A9BA8' },
  app:          { Icon: Package,       color: '#8B5CF6' },
  skill:        { Icon: BookOpen,      color: '#8B5CF6' },
  workspace:    { Icon: Home,          color: '#F97316' },
};

const FALLBACK_CONFIG = TYPE_CONFIG['agent'];

// Keep a simple emoji fallback for the native renderer
const TYPE_ICON_NATIVE: Record<string, string> = {
  agent: '👤',
  project: '📋',
  app: '📦',
  skill: '📖',
  conversation: '💬',
  workspace: '🏠',
};

// ── Teros URL parser ──────────────────────────────────────────────────────────

export interface ParsedTerosUrl {
  type: MentionResourceType;
  id: string;
}

/**
 * Parses a `teros://{type}/{id}` URL.
 * Returns null if the URL doesn't match the schema.
 */
export function parseTerosUrl(href: string): ParsedTerosUrl | null {
  if (!href.startsWith('teros://')) return null;
  const rest = href.slice('teros://'.length); // e.g. "agent/agent_abc123"
  const slashIdx = rest.indexOf('/');
  if (slashIdx === -1) return null;
  const type = rest.slice(0, slashIdx) as MentionResourceType;
  const id = rest.slice(slashIdx + 1);
  if (!type || !id) return null;
  return { type, id };
}

// ── Agent avatar helper ───────────────────────────────────────────────────────

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

interface AgentAvatarProps {
  name: string;
  avatarUrl?: string;
}

function AgentAvatar({ name, avatarUrl }: AgentAvatarProps) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={name}
        style={{
          width: ICON_SIZE,
          height: ICON_SIZE,
          borderRadius: '50%',
          objectFit: 'cover',
          flexShrink: 0,
        }}
      />
    );
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: ICON_SIZE,
        height: ICON_SIZE,
        borderRadius: '50%',
        backgroundColor: 'rgba(74, 158, 91, 0.15)',
        color: '#4A9E5B',
        fontSize: 7,
        fontWeight: 600,
        flexShrink: 0,
        lineHeight: 1,
      }}
    >
      {getInitials(name)}
    </span>
  );
}

// ── Inline chip (web-only, rendered via react-native-render-html custom renderer) ──

interface MentionChipInlineProps {
  name: string;
  type: MentionResourceType;
  id: string;
  avatarUrl?: string;
  onPress?: (type: MentionResourceType, id: string) => void;
}

/**
 * Inline chip rendered inside a chat message for `teros://` links.
 * Web-only — uses plain HTML elements for inline rendering within RenderHtml.
 */
export function MentionChipInline({ name, type, id, avatarUrl, onPress }: MentionChipInlineProps) {
  const [hovered, setHovered] = useState(false);
  const config = TYPE_CONFIG[type] ?? FALLBACK_CONFIG;
  const { Icon, color } = config;

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onPress?.(type, id);
  };

  return (
    <span
      onClick={onPress ? handleClick : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={`${type}: ${name} [${id}]`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: CHIP_GAP,
        paddingLeft: CHIP_PADDING_LEFT,
        paddingRight: CHIP_PADDING_RIGHT,
        height: CHIP_HEIGHT,
        borderRadius: CHIP_BORDER_RADIUS,
        backgroundColor: hovered ? '#222222' : CHIP_BG,
        border: `1px solid ${CHIP_BORDER}`,
        fontSize: CHIP_FONT_SIZE,
        fontWeight: CHIP_FONT_WEIGHT,
        color: CHIP_TEXT,
        cursor: onPress ? 'pointer' : 'default',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        maxWidth: 220,
        verticalAlign: 'middle',
        lineHeight: `${CHIP_HEIGHT}px`,
        transition: 'background-color 0.15s',
        textDecoration: 'none',
        boxSizing: 'border-box',
      }}
    >
      {/* Icon / Avatar */}
      {type === 'agent' ? (
        <AgentAvatar name={name} avatarUrl={avatarUrl} />
      ) : (
        <Icon size={ICON_SIZE} color={color} strokeWidth={2} style={{ flexShrink: 0 }} />
      )}

      {/* Name */}
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: 160,
        }}
      >
        {name}
      </span>
    </span>
  );
}

// ── react-native-render-html custom anchor renderer ───────────────────────────

/**
 * Custom renderer for `<a>` tags in react-native-render-html.
 *
 * If the href is a `teros://` URL, renders a `MentionChipInline`.
 * Otherwise falls back to the default link rendering (returns undefined).
 *
 * Usage:
 * ```tsx
 * import { buildMentionAnchorRenderer } from './MentionRenderer';
 *
 * const renderers = {
 *   a: buildMentionAnchorRenderer(onMentionPress),
 * };
 * ```
 */
export function buildMentionAnchorRenderer(
  onMentionPress?: (type: MentionResourceType, id: string) => void,
) {
  // react-native-render-html passes { tnode, TDefaultRenderer, ...rest }
  return function MentionAnchorRenderer({ tnode, TDefaultRenderer, ...rest }: any) {
    const href: string = tnode?.attributes?.href ?? '';
    const parsed = parseTerosUrl(href);

    if (!parsed) {
      // Not a teros:// link — render normally
      return <TDefaultRenderer tnode={tnode} {...rest} />;
    }

    // Extract the display name from the link text content
    const name = extractTnodeText(tnode) || parsed.id;

    if (Platform.OS === 'web') {
      // On web: render inline HTML chip
      return (
        <MentionChipInline
          name={name}
          type={parsed.type}
          id={parsed.id}
          onPress={onMentionPress}
        />
      );
    }

    // On native: render as styled text (chips are harder inline on native)
    const nativeIcon = TYPE_ICON_NATIVE[parsed.type] ?? '📌';
    return (
      <TDefaultRenderer
        tnode={tnode}
        {...rest}
        style={{
          color: CHIP_TEXT,
          backgroundColor: CHIP_BG,
          borderRadius: 4,
          paddingHorizontal: 4,
          overflow: 'hidden',
        }}
      >
        {nativeIcon} {name}
      </TDefaultRenderer>
    );
  };
}

// ── Utility: extract text from a tnode tree ───────────────────────────────────

function extractTnodeText(tnode: any): string {
  if (!tnode) return '';
  if (tnode.type === 'text') return tnode.data ?? '';
  if (tnode.children?.length) {
    return tnode.children.map(extractTnodeText).join('');
  }
  // react-native-render-html v6 stores children in domNode
  if (tnode.domNode) {
    return extractDomText(tnode.domNode);
  }
  return '';
}

function extractDomText(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return node.data ?? '';
  if (node.children?.length) {
    return node.children.map(extractDomText).join('');
  }
  return '';
}
