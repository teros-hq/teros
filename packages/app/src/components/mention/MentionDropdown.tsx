/**
 * MentionDropdown
 *
 * Renders the grouped @mention dropdown above the input composer.
 * Groups are shown in the order: Agentes, Proyectos, Apps, Skills,
 * Conversaciones, Ficheros, Workspaces.
 * Only groups with matching results are shown.
 *
 * Positioning: position:absolute, bottom:100% of the nearest position:relative
 * ancestor (the InputComposer container). The container must have
 * position:relative set — InputComposer.web.tsx wraps everything in a <div>
 * with position:relative for exactly this reason.
 */

import React, { useEffect, useRef } from 'react';
import type { MentionGroup, MentionResource } from '../../hooks/useAtMention';

// ── Icon map per resource type ────────────────────────────────────────────────

const TYPE_ICON: Record<string, string> = {
  agent: '🤖',
  project: '📋',
  app: '🔧',
  skill: '⚡',
  conversation: '💬',
  file: '📁',
  workspace: '🏢',
};

// ── Shared style constants ────────────────────────────────────────────────────

const DROPDOWN_BG = '#111113';
const DROPDOWN_BORDER = 'rgba(63, 63, 70, 0.7)';
const DROPDOWN_SHADOW = '0 -12px 32px rgba(0,0,0,0.55), 0 -2px 8px rgba(0,0,0,0.3)';
const GROUP_HEADER_BG = '#111113';
const ITEM_HOVER_BG = 'rgba(255,255,255,0.05)';
const ITEM_SELECTED_BG = 'rgba(255,255,255,0.06)';
const ITEM_SELECTED_BORDER = '#06B6D4';
const TEXT_PRIMARY = '#E4E4E7';
const TEXT_SECONDARY = '#71717A';
const TEXT_LABEL = '#52525B';
const FONT_FAMILY = "$body";

// ── Component ─────────────────────────────────────────────────────────────────

interface MentionDropdownProps {
  groups: MentionGroup[];
  selectedIndex: number;
  onSelect: (resource: MentionResource) => void;
  onClose: () => void;
  /** Whether resources are still loading */
  isLoading?: boolean;
}

export function MentionDropdown({
  groups,
  selectedIndex,
  onSelect,
  onClose,
  isLoading = false,
}: MentionDropdownProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedItemRef = useRef<HTMLButtonElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  // Flatten items to compute global index
  const flatItems: MentionResource[] = groups.flatMap((g) => g.items);
  const totalItems = flatItems.length;

  // ── Shared container style ─────────────────────────────────────────────────
  const containerStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    right: 0,
    marginBottom: 4,
    backgroundColor: DROPDOWN_BG,
    border: `1px solid ${DROPDOWN_BORDER}`,
    borderRadius: 12,
    boxShadow: DROPDOWN_SHADOW,
    zIndex: 9999,
    fontFamily: FONT_FAMILY,
    overflow: 'hidden',
  };

  // ── Loading state ──────────────────────────────────────────────────────────
  if (isLoading && totalItems === 0) {
    return (
      <div ref={containerRef} style={containerStyle}>
        <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, color: TEXT_SECONDARY }}>Cargando recursos…</span>
        </div>
      </div>
    );
  }

  // ── Empty state ────────────────────────────────────────────────────────────
  if (!isLoading && totalItems === 0) {
    return (
      <div ref={containerRef} style={containerStyle}>
        <div style={{ padding: '12px 14px' }}>
          <span style={{ fontSize: 13, color: TEXT_SECONDARY }}>No se encontraron recursos</span>
        </div>
      </div>
    );
  }

  let globalIndex = 0;

  return (
    <div
      ref={containerRef}
      style={{
        ...containerStyle,
        maxHeight: 280,
        overflowY: 'auto',
        // Custom scrollbar
        scrollbarWidth: 'thin',
        scrollbarColor: 'rgba(63,63,70,0.5) transparent',
      } as React.CSSProperties}
    >
      {/* Groups */}
      {groups.map((group) => (
        <div key={group.type}>
          {/* Group header */}
          <div
            style={{
              paddingLeft: 12,
              paddingRight: 12,
              paddingTop: 10,
              paddingBottom: 4,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.09em',
              textTransform: 'uppercase',
              color: TEXT_LABEL,
              position: 'sticky',
              top: 0,
              backgroundColor: GROUP_HEADER_BG,
              fontFamily: FONT_FAMILY,
              userSelect: 'none',
            }}
          >
            <span style={{ marginRight: 5 }}>{TYPE_ICON[group.type]}</span>
            {group.label}
          </div>

          {/* Items */}
          {group.items.map((item) => {
            const itemIndex = globalIndex++;
            const isSelected = itemIndex === selectedIndex;

            return (
              <button
                key={`${item.type}_${item.id}`}
                ref={isSelected ? selectedItemRef : undefined}
                onMouseDown={(e) => {
                  // Use mousedown (not click) so we don't lose input focus
                  e.preventDefault();
                  onSelect(item);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  padding: '7px 12px',
                  border: 'none',
                  background: isSelected ? ITEM_SELECTED_BG : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                  outline: 'none',
                  borderLeft: isSelected
                    ? `2px solid ${ITEM_SELECTED_BORDER}`
                    : '2px solid transparent',
                  fontFamily: FONT_FAMILY,
                  transition: 'background 0.08s',
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) {
                    (e.currentTarget as HTMLButtonElement).style.background = ITEM_HOVER_BG;
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) {
                    (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                  }
                }}
              >
                {/* Avatar or icon */}
                {item.avatarUrl ? (
                  <img
                    src={item.avatarUrl}
                    alt={item.name}
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: '50%',
                      objectFit: 'cover',
                      flexShrink: 0,
                      border: '1px solid rgba(63,63,70,0.5)',
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 7,
                      backgroundColor: 'rgba(39,39,42,0.9)',
                      border: '1px solid rgba(63,63,70,0.6)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 13,
                      flexShrink: 0,
                    }}
                  >
                    {TYPE_ICON[item.type]}
                  </div>
                )}

                {/* Name + subtitle */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: TEXT_PRIMARY,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      fontFamily: FONT_FAMILY,
                    }}
                  >
                    {item.name}
                  </div>
                  {item.subtitle && (
                    <div
                      style={{
                        fontSize: 11,
                        color: TEXT_SECONDARY,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        marginTop: 1,
                        fontFamily: FONT_FAMILY,
                      }}
                    >
                      {item.subtitle}
                    </div>
                  )}
                </div>

                {/* ID badge */}
                <span
                  style={{
                    fontSize: 10,
                    color: 'rgba(63,63,70,0.8)',
                    fontFamily: "$mono",
                    flexShrink: 0,
                    maxWidth: 80,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {item.id.slice(0, 12)}…
                </span>
              </button>
            );
          })}
        </div>
      ))}

      {/* Footer hint */}
      {totalItems > 0 && (
        <div
          style={{
            padding: '6px 12px',
            borderTop: '1px solid rgba(63,63,70,0.35)',
            display: 'flex',
            gap: 14,
            alignItems: 'center',
            backgroundColor: 'rgba(24,24,27,0.6)',
          }}
        >
          {[
            { keys: '↑↓', label: 'navegar' },
            { keys: '↵ Tab', label: 'seleccionar' },
            { keys: 'Esc', label: 'cerrar' },
          ].map(({ keys, label }) => (
            <span key={label} style={{ fontSize: 10, color: TEXT_LABEL, fontFamily: FONT_FAMILY }}>
              <kbd
                style={{
                  background: 'rgba(39,39,42,0.9)',
                  border: '1px solid rgba(63,63,70,0.7)',
                  borderRadius: 3,
                  padding: '1px 5px',
                  fontSize: 9,
                  color: TEXT_SECONDARY,
                  marginRight: 4,
                  fontFamily: FONT_FAMILY,
                }}
              >
                {keys}
              </kbd>
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
