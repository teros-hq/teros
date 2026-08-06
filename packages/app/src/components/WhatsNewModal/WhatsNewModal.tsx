/**
 * WhatsNewModal — Carousel modal for showing changelog entries
 *
 * Features:
 * - One card at a time, swipe/drag right for next, left for previous
 * - Progress dots + "N de M" indicator
 * - Category-colored header with icon, date, title
 * - Markdown body rendered via ChangelogMarkdownRenderer (supports images)
 * - "Entendido" button on last card, "Siguiente" on others, X to close anytime
 * - Close (X) button updates tracking (marks latest entry as seen)
 * - Responsive: web (drag/click arrows) + mobile (swipe gestures)
 * - Overlay/modal — not part of the tiling window system
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Platform,
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Dimensions,
  Animated,
  PanResponder,
  Modal as RNModal,
} from 'react-native';
import { XStack, YStack } from 'tamagui';
import { Rocket, TrendingUp, Wrench, AlertTriangle, X } from '@tamagui/lucide-icons';

import { useColors, useMcaTheme } from '../mca/primitives/useColors';
import { colors as semanticColors } from '../mca/primitives/colors';
import {
  type ChangelogEntry,
  CATEGORY_META,
  type CategoryMeta,
  getLocalizedEntry,
} from '../../changelog';
import i18n from '../../i18n';
import { useAuthStore } from '../../store';
import { ChangelogMarkdownRenderer } from './ChangelogMarkdownRenderer';

// ─── Design system constants ──────────────────────────────────────────────────
// Font stacks aligned with tamagui.config.ts and tokens.css.
//   DM Sans       → UI / body text
//   Newsreader    → display / card titles
//   JetBrains Mono → code / data (used by ChangelogMarkdownRenderer)
const FONT_SANS = "'DM Sans', system-ui, -apple-system, sans-serif";
const FONT_SERIF = "'Newsreader', Georgia, serif";

// Radius tokens (from tokens.css --radius-xl / --radius / --radius-sm)
const RADIUS_XL = 20;   // modal container
const RADIUS = 10;       // icon badge, buttons
const RADIUS_SM = 6;     // close button

// ─── Category SVG icons (no emojis) ───────────────────────────────────────────
// Lucide-style stroke icons, rendered with currentColor.

// ─── Category color mapping ───────────────────────────────────────────────────
// Maps changelog category colorKey → design system semantic color.
// 'orange' (fix) maps to amber (#F59E0B) — the DS warm/warning accent.
function getCategoryColor(colorKey: CategoryMeta['colorKey']): string {
  switch (colorKey) {
    case 'green': return semanticColors.green;
    case 'orange': return semanticColors.amber;
    case 'blue': return semanticColors.indigo;
    case 'red': return semanticColors.red;
    default: return semanticColors.indigo;
  }
}

// ─── Progress dots ────────────────────────────────────────────────────────────

interface ProgressDotsProps {
  current: number;
  total: number;
  color: string;
  /** Inactive dot color — design system border-strong token */
  inactiveColor: string;
}

function ProgressDots({ current, total, color, inactiveColor }: ProgressDotsProps) {
  if (Platform.OS === 'web') {
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontFamily: FONT_SANS }}>
        {Array.from({ length: total }).map((_, i) => (
          <div
            key={i}
            style={{
              width: i === current ? 24 : 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: i === current ? color : inactiveColor,
              transition: 'width 0.2s, background-color 0.2s',
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <XStack gap={6} alignItems="center">
      {Array.from({ length: total }).map((_, i) => (
        <View
          key={i}
          style={{
            width: i === current ? 24 : 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: i === current ? color : inactiveColor,
          }}
        />
      ))}
    </XStack>
  );
}

// ─── Single card ──────────────────────────────────────────────────────────────

interface ChangelogCardProps {
  entry: Omit<ChangelogEntry, 'title' | 'content'> & { title: string; content: string };
  c: ReturnType<typeof useColors>;
}


// Maps icon key → lucide icon component
const ICON_COMPONENTS: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  'rocket': Rocket,
  'trending-up': TrendingUp,
  'wrench': Wrench,
  'alert-triangle': AlertTriangle,
};


function ChangelogCard({ entry, c }: ChangelogCardProps) {
  const meta = CATEGORY_META[entry.category] ?? CATEGORY_META.feature;
  const color = getCategoryColor(meta.colorKey);
  const icon = entry.icon ?? meta.icon;

  // Format date: "Jul 19, 2026"
  const formattedDate = (() => {
    try {
      const d = new Date(entry.date);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
      return entry.date;
    }
  })();

  if (Platform.OS === 'web') {
    return (
      <div
        className="changelog-card-inner"
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          width: '100%',
          boxSizing: 'border-box',
          fontFamily: FONT_SANS,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '20px 24px 16px',
            borderBottom: `1px solid ${c.border}`,
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: RADIUS,
              backgroundColor: `${color}22`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            {(() => { const Icon = ICON_COMPONENTS[icon] ?? Rocket; return <Icon size={20} color={color} />; })()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  color,
                }}
              >
                {i18n.t(`whatsNew.category.${entry.category}`)}
              </span>
              <span style={{ fontSize: 11, color: c.text3 }}>·</span>
              <span style={{ fontSize: 11, color: c.text3 }}>{formattedDate}</span>
            </div>
            <h2
              style={{
                fontFamily: FONT_SERIF,
                fontSize: 20,
                fontWeight: 400,
                color: c.text,
                margin: '4px 0 0',
                lineHeight: 1.3,
                letterSpacing: '-0.01em',
              }}
            >
              {entry.title}
            </h2>
          </div>
        </div>

        {/* Markdown body — scrollable */}
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '16px 24px 20px',
            minHeight: 0,
          }}
        >
          <ChangelogMarkdownRenderer content={entry.content} />
        </div>
      </div>
    );
  }

  // Native
  return (
    <View style={{ flex: 1, height: '100%' }}>
      {/* Header */}
      <XStack
        alignItems="center"
        gap={12}
        padding={20}
        borderBottomWidth={1}
        borderBottomColor={c.border}
      >
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: RADIUS,
            backgroundColor: `${color}22`,
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          {(() => { const Icon = ICON_COMPONENTS[icon] ?? Rocket; return <Icon size={20} color={color} />; })()}
        </View>
        <YStack flex={1} gap={2}>
          <XStack alignItems="center" gap={6}>
            <Text style={{ fontSize: 11, fontWeight: '600', textTransform: 'uppercase', color }}>
              {i18n.t(`whatsNew.category.${entry.category}`)}
            </Text>
            <Text style={{ fontSize: 11, color: c.text3 }}>·</Text>
            <Text style={{ fontSize: 11, color: c.text3 }}>{formattedDate}</Text>
          </XStack>
          <Text style={{ fontSize: 20, fontWeight: '400', color: c.text, lineHeight: 26, fontFamily: FONT_SERIF }}>
            {entry.title}
          </Text>
        </YStack>
      </XStack>

      {/* Markdown body — scrollable */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16 }}
        showsVerticalScrollIndicator={false}
      >
        <ChangelogMarkdownRenderer content={entry.content} />
      </ScrollView>
    </View>
  );
}

// ─── Main modal ───────────────────────────────────────────────────────────────

export interface WhatsNewModalProps {
  /** Entries to show (already filtered to unseen ones) */
  entries: ChangelogEntry[];
  /** Called when the user dismisses the modal (X, "Entendido") */
  onDismiss: (lastSeenEntryId: string) => void;
  /** Whether this is a manual re-open (shows all entries, not just unseen) */
  isManualReopen?: boolean;
}

export function WhatsNewModal({ entries, onDismiss, isManualReopen = false }: WhatsNewModalProps) {
  const c = useColors();
  const theme = useMcaTheme();
  const isDark = theme === 'dark';
  const [currentIndex, setCurrentIndex] = useState(0);
  const pan = useRef(new Animated.Value(0)).current;
  const screenWidth = Dimensions.get('window').width;

  const total = entries.length;
  const currentEntry = entries[currentIndex]
    ? getLocalizedEntry(entries[currentIndex], useAuthStore.getState().user?.locale || i18n.language)
    : undefined;
  const isLast = currentIndex === total - 1;

  // The ID to mark as seen when dismissing = the LAST entry in the list
  // (not the current one — if the user dismisses from card 2 of 5, we still
  // mark all as seen so the modal doesn't reappear)
  const lastEntryId = entries[total - 1]?.id ?? '';

  const handleDismiss = useCallback(() => {
    onDismiss(lastEntryId);
  }, [onDismiss, lastEntryId]);

  const goNext = useCallback(() => {
    if (currentIndex < total - 1) {
      setCurrentIndex(currentIndex + 1);
    }
  }, [currentIndex, total]);

  const goPrev = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
  }, [currentIndex]);

  // Pan responder for swipe/drag gestures
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) => {
        return Math.abs(gestureState.dx) > 10 && Math.abs(gestureState.dy) < 40;
      },
      onPanResponderMove: (_, gestureState) => {
        pan.setValue(gestureState.dx);
      },
      onPanResponderRelease: (_, gestureState) => {
        const threshold = screenWidth * 0.2;
        if (gestureState.dx < -threshold && currentIndex < total - 1) {
          // Swipe left → next
          goNext();
        } else if (gestureState.dx > threshold && currentIndex > 0) {
          // Swipe right → prev
          goPrev();
        }
        Animated.spring(pan, { toValue: 0, useNativeDriver: false }).start();
      },
      onPanResponderTerminate: () => {
        Animated.spring(pan, { toValue: 0, useNativeDriver: false }).start();
      },
    }),
  ).current;

  // Keyboard navigation (web only)
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleDismiss();
      } else if (e.key === 'ArrowRight' && currentIndex < total - 1) {
        goNext();
      } else if (e.key === 'ArrowLeft' && currentIndex > 0) {
        goPrev();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [currentIndex, total, handleDismiss, goNext, goPrev]);

  if (!currentEntry) return null;

  const meta = CATEGORY_META[currentEntry.category] ?? CATEGORY_META.feature;
  const color = getCategoryColor(meta.colorKey);

  // ─── Web render ──────────────────────────────────────────────────────────────

  if (Platform.OS === 'web') {
    return (
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 10000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          // Theme-aware overlay: darker in dark mode, lighter in light mode
          backgroundColor: isDark ? 'rgba(0,0,0,0.65)' : 'rgba(10,10,15,0.35)',
          backdropFilter: 'blur(4px)',
          fontFamily: FONT_SANS,
        }}
        onClick={handleDismiss}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            width: '90%',
            maxWidth: 560,
            height: '80vh',
            maxHeight: 640,
            backgroundColor: c.bgCard,
            borderRadius: RADIUS_XL,
            border: `1px solid ${c.borderStrong}`,
            boxShadow: c.shadow,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            position: 'relative',
            fontFamily: FONT_SANS,
          }}
        >
          {/* Close button */}
          <button
            onClick={handleDismiss}
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              width: 32,
              height: 32,
              borderRadius: RADIUS_SM,
              border: 'none',
              backgroundColor: 'transparent',
              color: c.text3,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 10,
              fontFamily: FONT_SANS,
            }}
            aria-label="Close"
          >
            <X size={14} color={c.text3} />
          </button>

          {/* Card content */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <ChangelogCard entry={currentEntry} c={c} />
          </div>

          {/* Footer: navigation + progress */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 24px 16px',
              borderTop: `1px solid ${c.border}`,
              fontFamily: FONT_SANS,
            }}
          >
            {/* Left: progress dots */}
            <ProgressDots current={currentIndex} total={total} color={color} inactiveColor={c.borderStrong} />

            {/* Right: navigation buttons */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: FONT_SANS }}>
              {/* Previous */}
              {currentIndex > 0 && (
                <button
                  onClick={goPrev}
                  style={{
                    padding: '8px 16px',
                    borderRadius: RADIUS_SM,
                    border: `1px solid ${c.borderStrong}`,
                    backgroundColor: 'transparent',
                    color: c.text2,
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: 'pointer',
                    fontFamily: FONT_SANS,
                  }}
                >
                  ← {i18n.t('whatsNew.actions.prev')}
                </button>
              )}

              {/* Next / Entendido */}
              {isLast ? (
                <button
                  onClick={handleDismiss}
                  style={{
                    padding: '8px 20px',
                    borderRadius: RADIUS_SM,
                    border: 'none',
                    backgroundColor: semanticColors.indigo,
                    color: '#fff',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: FONT_SANS,
                  }}
                >
                  {isManualReopen ? i18n.t('whatsNew.actions.close') : i18n.t('whatsNew.actions.dismiss')}
                </button>
              ) : (
                <button
                  onClick={goNext}
                  style={{
                    padding: '8px 20px',
                    borderRadius: RADIUS_SM,
                    border: 'none',
                    backgroundColor: semanticColors.indigo,
                    color: '#fff',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: FONT_SANS,
                  }}
                >
                  {i18n.t('whatsNew.actions.next')} →
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Native render ───────────────────────────────────────────────────────────

  return (
    <RNModal
      visible={true}
      transparent
      animationType="fade"
      onRequestClose={handleDismiss}
    >
      <TouchableWithoutFeedback onPress={handleDismiss}>
        <View
          style={{
            flex: 1,
            // Theme-aware overlay: darker in dark mode, lighter in light mode
            backgroundColor: isDark ? 'rgba(0,0,0,0.65)' : 'rgba(10,10,15,0.35)',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <TouchableWithoutFeedback onPress={(e) => e.stopPropagation()}>
            <Animated.View
              {...panResponder.panHandlers}
              style={{
                width: '90%',
                maxWidth: 560,
                height: '75%',
                backgroundColor: c.bgCard,
                borderRadius: RADIUS_XL,
                borderWidth: 1,
                borderColor: c.borderStrong,
                overflow: 'hidden',
                transform: [{ translateX: pan }],
              }}
            >
              {/* Close button */}
              <TouchableOpacity
                onPress={handleDismiss}
                style={{
                  position: 'absolute',
                  top: 12,
                  right: 12,
                  width: 32,
                  height: 32,
                  borderRadius: RADIUS_SM,
                  zIndex: 10,
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
              >
                <X size={14} color={c.text3} />
              </TouchableOpacity>

              {/* Card content */}
              <ChangelogCard entry={currentEntry} c={c} />

              {/* Footer */}
              <YStack
                padding={12}
                borderTopWidth={1}
                borderTopColor={c.border}
                gap={10}
              >
                <XStack alignItems="center" justifyContent="space-between">
                  <ProgressDots current={currentIndex} total={total} color={color} inactiveColor={c.borderStrong} />
                  <Text style={{ fontSize: 12, color: c.text3 }}>
                    {i18n.t('whatsNew.actions.progress', { current: currentIndex + 1, total })}
                  </Text>
                </XStack>

                <XStack gap={8} justifyContent="flex-end">
                  {currentIndex > 0 && (
                    <TouchableOpacity onPress={goPrev}>
                      <Text style={{ padding: 8, color: c.text2, fontSize: 13 }}>← {i18n.t('whatsNew.actions.prev')}</Text>
                    </TouchableOpacity>
                  )}
                  {isLast ? (
                    <TouchableOpacity onPress={handleDismiss}>
                      <Text
                        style={{
                          padding: 8,
                          color: '#fff',
                          fontSize: 13,
                          fontWeight: '600',
                          backgroundColor: semanticColors.indigo,
                          borderRadius: RADIUS_SM,
                          paddingHorizontal: 16,
                        }}
                      >
                        {isManualReopen ? i18n.t('whatsNew.actions.close') : i18n.t('whatsNew.actions.dismiss')}
                      </Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity onPress={goNext}>
                      <Text
                        style={{
                          padding: 8,
                          color: '#fff',
                          fontSize: 13,
                          fontWeight: '600',
                          backgroundColor: semanticColors.indigo,
                          borderRadius: RADIUS_SM,
                          paddingHorizontal: 16,
                        }}
                      >
                        {i18n.t('whatsNew.actions.next')} →
                      </Text>
                    </TouchableOpacity>
                  )}
                </XStack>
              </YStack>
            </Animated.View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </RNModal>
  );
}
