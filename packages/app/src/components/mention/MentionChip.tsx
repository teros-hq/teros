/**
 * MentionChip
 *
 * A pill/chip component that represents a @mentioned resource inside the
 * InputComposer. Renders inline with the text and has a remove (×) button.
 */

import {
  BookOpen,
  FolderKanban,
  Home,
  MessageSquare,
  Package,
  Users,
  X,
} from '@tamagui/lucide-icons';
import React, { useState } from 'react';
import type { MentionChip as MentionChipType } from '../../hooks/useAtMention';
import { useImageWithFallback } from '../../hooks/useImageWithFallback';

// ── Design tokens ─────────────────────────────────────────────────────────────

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

// Fallback for unknown types
const FALLBACK_CONFIG = TYPE_CONFIG['agent'];

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
  // Fall back to initials when the image 404s instead of the broken-image glyph.
  const { showImage, onError } = useImageWithFallback(avatarUrl);

  if (showImage) {
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
        onError={onError}
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

// ── Component ─────────────────────────────────────────────────────────────────

interface MentionChipProps {
  chip: MentionChipType;
  onRemove: (chipId: string) => void;
}

export function MentionChip({ chip, onRemove }: MentionChipProps) {
  const [hovered, setHovered] = useState(false);
  const { resource } = chip;
  const config = TYPE_CONFIG[resource.type] ?? FALLBACK_CONFIG;
  const { Icon, color } = config;

  return (
    <span
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
        cursor: 'default',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        maxWidth: 220,
        flexShrink: 0,
        verticalAlign: 'middle',
        lineHeight: `${CHIP_HEIGHT}px`,
        transition: 'background-color 0.15s',
        boxSizing: 'border-box',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={`${resource.type}: ${resource.name} [${resource.id}]`}
    >
      {/* Icon / Avatar */}
      {resource.type === 'agent' ? (
        <AgentAvatar name={resource.name} avatarUrl={resource.avatarUrl} />
      ) : (
        <Icon size={ICON_SIZE} color={color} strokeWidth={2} style={{ flexShrink: 0 }} />
      )}

      {/* Name */}
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: 150,
        }}
      >
        {resource.name}
      </span>

      {/* Remove button */}
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRemove(chip.id);
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 14,
          height: 14,
          borderRadius: '50%',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          padding: 0,
          color: CHIP_TEXT,
          opacity: 0.5,
          flexShrink: 0,
          marginLeft: 1,
        }}
        onMouseEnter={(e) => {
          const btn = e.currentTarget as HTMLButtonElement;
          btn.style.opacity = '1';
          btn.style.backgroundColor = 'rgba(113, 113, 122, 0.25)';
        }}
        onMouseLeave={(e) => {
          const btn = e.currentTarget as HTMLButtonElement;
          btn.style.opacity = '0.5';
          btn.style.backgroundColor = 'transparent';
        }}
        aria-label={`Remove mention of ${resource.name}`}
      >
        <X size={9} color={CHIP_TEXT} />
      </button>
    </span>
  );
}
