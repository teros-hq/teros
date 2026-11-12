/**
 * WhatsNewModal — Carousel modal for showing changelog entries
 *
 * Features:
 * - One card at a time, swipe/drag right for next, left for previous
 * - Progress dots + "N de M" indicator
 * - Category-toned icon tile, mono "CATEGORY · DATE" note, serif title
 * - Markdown body rendered via ChangelogMarkdownRenderer (supports images)
 * - When several entries are pending, an index list (LGroup) with mono dates
 *   sits above the body so the whole batch is visible at a glance
 * - "Entendido" button on last card, "Siguiente" on others, X to close anytime
 * - Close (X) button updates tracking (marks latest entry as seen)
 * - Responsive: web (drag/click arrows/keyboard) + mobile (swipe gestures)
 * - Overlay/modal — not part of the tiling window system
 *
 * Visual: the OS prototype's hero card (radius 24, no border, raised lift)
 * on a blurred scrim; pills for the actions; Phosphor glyphs; 400 weight.
 */

import React, { useCallback, useEffect, useRef, useState } from "react"
import {
  Animated,
  Dimensions,
  Modal as RNModal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
} from "react-native"

import { useColors, useMcaTheme } from "../mca/primitives/useColors"
import {
  type ChangelogEntry,
  CATEGORY_META,
  type CategoryMeta,
  getLocalizedEntry,
} from "../../changelog"
import i18n from "../../i18n"
import { useAuthStore } from "../../store"
import { Btn, IconBtn, Ph, T, Tile, type TileTone } from "../ui/ds"
import { ChangelogMarkdownRenderer } from "./ChangelogMarkdownRenderer"

// ─── Category → tile tone / text tint ─────────────────────────────────────────
// Maps changelog category colorKey → the theme's status tints.
//   green → mint tile · orange (fix) → amber · blue → violet · red → pink
function getCategoryTone(colorKey: CategoryMeta["colorKey"]): {
  tile: TileTone
  tint: "g" | "a" | "i" | "r"
} {
  switch (colorKey) {
    case "green":
      return { tile: "mint", tint: "g" }
    case "orange":
      return { tile: "amber", tint: "a" }
    case "red":
      return { tile: "pink", tint: "r" }
    case "blue":
    default:
      return { tile: "accent", tint: "i" }
  }
}

// Maps icon key → Phosphor glyph
const ICON_NAMES: Record<string, string> = {
  rocket: "rocket-launch",
  "trending-up": "trend-up",
  wrench: "wrench",
  "alert-triangle": "warning",
}

function formatDate(date: string): string {
  try {
    const d = new Date(date)
    return d.toLocaleDateString(i18n.language || "en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
  } catch {
    return date
  }
}

// ─── Progress dots ────────────────────────────────────────────────────────────

function ProgressDots({ current, total }: { current: number; total: number }) {
  const c = useColors()
  return (
    <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
      {Array.from({ length: total }).map((_, i) => (
        <View
          key={i}
          style={[
            {
              width: i === current ? 22 : 6,
              height: 6,
              borderRadius: 3,
              backgroundColor:
                i === current ? c.accent : i < current ? c.borderAccent : c.borderStrong,
              opacity: i < current ? 0.5 : 1,
            },
            Platform.OS === "web"
              ? ({ transition: "width 0.25s, background-color 0.25s" } as any)
              : null,
          ]}
        />
      ))}
    </View>
  )
}

// ─── Single card ──────────────────────────────────────────────────────────────

type LocalizedEntry = Omit<ChangelogEntry, "title" | "content"> & { title: string; content: string }

function ChangelogCard({ entry }: { entry: LocalizedEntry }) {
  const c = useColors()
  const meta = CATEGORY_META[entry.category] ?? CATEGORY_META.feature
  const tone = getCategoryTone(meta.colorKey)
  const icon = ICON_NAMES[entry.icon ?? meta.icon] ?? "rocket-launch"

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      {/* Header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 14,
          paddingTop: 24,
          paddingHorizontal: 28,
          paddingBottom: 16,
          paddingRight: 64,
        }}
      >
        <Tile icon={icon} tone={tone.tile} size="md" />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <T step="codenote" color={c.tint[tone.tint].tx}>
              {i18n.t(`whatsNew.category.${entry.category}`)}
            </T>
            <T step="codenote" tone="text3">
              · {formatDate(entry.date)}
            </T>
          </View>
          <T step="xl" style={{ marginTop: 4 }}>
            {entry.title}
          </T>
        </View>
      </View>

      {/* Markdown body — scrollable */}
      <ScrollView
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ paddingHorizontal: 28, paddingBottom: 20 }}
        showsVerticalScrollIndicator={false}
        {...(Platform.OS === "web" ? ({ className: "chat-scroll" } as any) : {})}
      >
        <ChangelogMarkdownRenderer content={entry.content} />
      </ScrollView>
    </View>
  )
}

// ─── Entry index (several pending entries) ────────────────────────────────────

function EntryIndex({
  entries,
  current,
  onPick,
}: {
  entries: ChangelogEntry[]
  current: number
  onPick: (i: number) => void
}) {
  const c = useColors()
  const locale = useAuthStore.getState().user?.locale || i18n.language
  return (
    <View
      style={{
        marginHorizontal: 28,
        marginBottom: 14,
        borderRadius: 12,
        backgroundColor: c.nest,
        overflow: "hidden",
      }}
    >
      {entries.map((e, i) => {
        const l = getLocalizedEntry(e, locale)
        const on = i === current
        return (
          <Pressable
            key={e.id}
            onPress={() => onPick(i)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            style={({ pressed }) => [
              {
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingVertical: 8,
                paddingHorizontal: 12,
                borderTopWidth: i > 0 ? 1 : 0,
                borderTopColor: c.border,
                backgroundColor: on ? c.navActive : pressed ? c.nestHover : "transparent",
              },
              Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
            ]}
          >
            <Ph name={on ? "caret-right" : "dot"} size={12} color={on ? c.accent : c.text3} />
            <T step="12" color={on ? c.text : c.text2} ellipsis style={{ flex: 1 }}>
              {l.title}
            </T>
            <T step="codenote" tone="text3">
              {formatDate(e.date)}
            </T>
          </Pressable>
        )
      })}
    </View>
  )
}

// ─── Main modal ───────────────────────────────────────────────────────────────

export interface WhatsNewModalProps {
  /** Entries to show (already filtered to unseen ones) */
  entries: ChangelogEntry[]
  /** Called when the user dismisses the modal (X, "Entendido") */
  onDismiss: (lastSeenEntryId: string) => void
  /** Whether this is a manual re-open (shows all entries, not just unseen) */
  isManualReopen?: boolean
}

export function WhatsNewModal({ entries, onDismiss, isManualReopen = false }: WhatsNewModalProps) {
  const c = useColors()
  const theme = useMcaTheme()
  const isDark = theme === "dark"
  const { width: winW, height: winH } = useWindowDimensions()
  const [currentIndex, setCurrentIndex] = useState(0)
  const pan = useRef(new Animated.Value(0)).current
  const screenWidth = Dimensions.get("window").width

  const total = entries.length
  const currentEntry = entries[currentIndex]
    ? getLocalizedEntry(
        entries[currentIndex],
        useAuthStore.getState().user?.locale || i18n.language,
      )
    : undefined
  const isLast = currentIndex === total - 1

  // The ID to mark as seen when dismissing = the LAST entry in the list
  // (not the current one — if the user dismisses from card 2 of 5, we still
  // mark all as seen so the modal doesn't reappear)
  const lastEntryId = entries[total - 1]?.id ?? ""

  const handleDismiss = useCallback(() => {
    onDismiss(lastEntryId)
  }, [onDismiss, lastEntryId])

  const goNext = useCallback(() => {
    if (currentIndex < total - 1) {
      setCurrentIndex(currentIndex + 1)
    }
  }, [currentIndex, total])

  const goPrev = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1)
    }
  }, [currentIndex])

  // Pan responder for swipe/drag gestures
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) => {
        return Math.abs(gestureState.dx) > 10 && Math.abs(gestureState.dy) < 40
      },
      onPanResponderMove: (_, gestureState) => {
        pan.setValue(gestureState.dx)
      },
      onPanResponderRelease: (_, gestureState) => {
        const threshold = screenWidth * 0.2
        if (gestureState.dx < -threshold && currentIndex < total - 1) {
          // Swipe left → next
          goNext()
        } else if (gestureState.dx > threshold && currentIndex > 0) {
          // Swipe right → prev
          goPrev()
        }
        Animated.spring(pan, { toValue: 0, useNativeDriver: false }).start()
      },
      onPanResponderTerminate: () => {
        Animated.spring(pan, { toValue: 0, useNativeDriver: false }).start()
      },
    }),
  ).current

  // Keyboard navigation (web only)
  useEffect(() => {
    if (Platform.OS !== "web") return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleDismiss()
      } else if (e.key === "ArrowRight" && currentIndex < total - 1) {
        goNext()
      } else if (e.key === "ArrowLeft" && currentIndex > 0) {
        goPrev()
      }
    }
    window.addEventListener("keydown", handleKey)
    return () => window.removeEventListener("keydown", handleKey)
  }, [currentIndex, total, handleDismiss, goNext, goPrev])

  if (!currentEntry) return null

  const phone = winW <= 620
  const cardW = Math.min(560, winW - (phone ? 24 : 48))
  const cardH = Math.min(Platform.OS === "web" ? 640 : winH * 0.78, winH - (phone ? 48 : 96))

  const card = (
    <Animated.View
      {...panResponder.panHandlers}
      testID="whats-new-modal"
      style={[
        {
          width: cardW,
          height: cardH,
          backgroundColor: c.bgStep,
          borderRadius: 24,
          overflow: "hidden",
          transform: [{ translateX: pan }],
        },
        Platform.OS === "web" ? ({ boxShadow: c.elevRaised } as any) : null,
      ]}
    >
      {/* Close button */}
      <View style={{ position: "absolute", top: 14, right: 14, zIndex: 10 }}>
        <IconBtn icon="x" plain onPress={handleDismiss} title={i18n.t("whatsNew.actions.close")} />
      </View>

      {/* Card content */}
      <View style={{ flex: 1, minHeight: 0 }}>
        {total > 1 && !phone ? (
          <View style={{ paddingTop: 24 }}>
            <View style={{ paddingHorizontal: 28, marginBottom: 8 }}>
              <T step="xs" tone="accent">
                {i18n.t("whatsNew.title", { defaultValue: "What's new" })}
              </T>
            </View>
            <EntryIndex entries={entries} current={currentIndex} onPick={setCurrentIndex} />
          </View>
        ) : null}
        <ChangelogCard entry={currentEntry} />
      </View>

      {/* Footer */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          paddingHorizontal: 20,
          paddingVertical: 14,
          borderTopWidth: 1,
          borderTopColor: c.border,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <ProgressDots current={currentIndex} total={total} />
          <T step="codenote" tone="text3">
            {i18n.t("whatsNew.actions.progress", { current: currentIndex + 1, total })}
          </T>
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {currentIndex > 0 && (
            <Btn variant="ghost" size="md" icon="caret-left" onPress={goPrev}>
              {i18n.t("whatsNew.actions.prev")}
            </Btn>
          )}
          {isLast ? (
            <Btn variant="primary" size="md" icon="check" onPress={handleDismiss}>
              {isManualReopen
                ? i18n.t("whatsNew.actions.close")
                : i18n.t("whatsNew.actions.dismiss")}
            </Btn>
          ) : (
            <Btn variant="primary" size="md" iconRight="caret-right" onPress={goNext}>
              {i18n.t("whatsNew.actions.next")}
            </Btn>
          )}
        </View>
      </View>
    </Animated.View>
  )

  const scrim = isDark ? "rgba(10,8,14,0.7)" : "rgba(32,28,39,0.35)"

  // ─── Web render ──────────────────────────────────────────────────────────────

  if (Platform.OS === "web") {
    return (
      <Pressable
        onPress={handleDismiss}
        style={{
          position: "fixed" as any,
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 10000,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: scrim,
          ...({
            backdropFilter: "blur(6px)",
            WebkitBackdropFilter: "blur(6px)",
            cursor: "default",
          } as any),
        }}
      >
        <Pressable onPress={(e) => e.stopPropagation()} style={{ cursor: "default" } as any}>
          {card}
        </Pressable>
      </Pressable>
    )
  }

  // ─── Native render ───────────────────────────────────────────────────────────

  return (
    <RNModal visible transparent animationType="fade" onRequestClose={handleDismiss}>
      <Pressable
        onPress={handleDismiss}
        style={{ flex: 1, backgroundColor: scrim, justifyContent: "center", alignItems: "center" }}
      >
        <Pressable onPress={(e) => e.stopPropagation()}>{card}</Pressable>
      </Pressable>
    </RNModal>
  )
}
