/**
 * PTabs (`.ptabs`) — the pill segmented tabs of the OS prototype: a washed
 * track, the active tab lifts to a card with the accent glyph.
 *
 *   <PTabs value={tab} onChange={setTab} items={[{ key:'general', label:'General', icon:'identification-card' }, { key:'apps', label:'Apps', count: 6 }]} />
 *   <PTabs sm …/>   28px tabs (filters)
 */
import React from "react"
import { Platform, Pressable, ScrollView, View, type ViewStyle } from "react-native"
import { useColors } from "../../mca/primitives/useColors"
import { Ph } from "./Icon"
import { T } from "./Text"

export interface PTabItem<K extends string = string> {
  key: K
  label: string
  icon?: string
  count?: number | string
  disabled?: boolean
  /** "Propuesta" style — rendered dimmed. */
  soon?: boolean
}

export interface PTabsProps<K extends string = string> {
  items: PTabItem<K>[]
  value: K
  onChange: (key: K) => void
  sm?: boolean
  /** Stretch the track to the row. */
  full?: boolean
  style?: ViewStyle
}

/**
 * The rubber thumb (prototype `RubberSegment`, used by the agent window's
 * section tabs and the project tabs): one card-coloured pill sits over the
 * track and is CLIPPED to the active slot. It carries a copy of every tab so
 * the label and glyph under it read in the active ink without a colour
 * transition. On change the clip first STRETCHES to cover both the old and
 * the new slot (190ms), rests 150ms, then the trailing edge snaps to the new
 * slot with a small overshoot (300ms). Web only; native keeps the flat
 * active-tab fill.
 */
const RS_EASE = "cubic-bezier(.23,1,.32,1)"
const RS_SNAP = "cubic-bezier(.2,1.08,.3,1)"
const RS_STRETCH_MS = 190
const RS_REST_MS = 150
const RS_SNAP_MS = 300

type Slot = { l: number; r: number }

function clipFor(pad: number, width: number, s: Slot, radius: number) {
  return `inset(${pad}px ${Math.max(0, width - s.r)}px ${pad}px ${Math.max(0, s.l)}px round ${radius}px)`
}

export function PTabs<K extends string = string>({
  items,
  value,
  onChange,
  sm,
  full,
  style,
}: PTabsProps<K>) {
  const c = useColors()
  const h = sm ? 28 : 36
  const pad = 3
  const thumbRadius = 7
  const rubber = Platform.OS === "web"

  // Slot geometry from the real items (track coordinates, incl. the inset).
  // On web every slot is re-read from the DOM whenever ANY item or the track
  // lays out: RN-web's onLayout only watches an element's own size, so a tab
  // that merely SHIFTS because a sibling grew (a count arriving, a label
  // translated, a font swapping in) would otherwise keep a stale slot and
  // the thumb would sit beside it.
  const slotsRef = React.useRef<Map<K, Slot>>(new Map())
  const itemElsRef = React.useRef<Map<K, HTMLElement>>(new Map())
  const [trackW, setTrackW] = React.useState(0)
  const [slotsVersion, bumpSlots] = React.useReducer((n: number) => n + 1, 0)
  const thumbRef = React.useRef<any>(null)
  const shownRef = React.useRef<K | null>(null)
  const runRef = React.useRef(0)

  const measureAll = React.useCallback(() => {
    let changed = false
    itemElsRef.current.forEach((el, key) => {
      if (!el.isConnected) return
      const l = el.offsetLeft
      const r = l + el.offsetWidth
      const prev = slotsRef.current.get(key)
      if (!prev || prev.l !== l || prev.r !== r) {
        slotsRef.current.set(key, { l, r })
        changed = true
      }
    })
    if (changed) bumpSlots()
  }, [])

  // Fonts landing after mount reflow the labels without any layout event.
  React.useEffect(() => {
    if (!rubber || typeof document === "undefined" || !document.fonts?.ready) return
    let alive = true
    document.fonts.ready.then(() => {
      if (alive) measureAll()
    })
    return () => {
      alive = false
    }
  }, [rubber, measureAll])

  // Move the thumb: stretch → rest → snap. Jumps when nothing is known yet,
  // or when the slots moved under a resting thumb.
  React.useEffect(() => {
    if (!rubber) return
    const el = thumbRef.current as HTMLElement | null
    const to = slotsRef.current.get(value)
    if (!el || !to || !trackW) return
    const from = shownRef.current != null ? slotsRef.current.get(shownRef.current) : undefined
    const run = ++runRef.current
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches
    const target = clipFor(pad, trackW, to, thumbRadius)
    if (!from || from === to || still || typeof el.animate !== "function") {
      if (typeof el.getAnimations === "function") {
        for (const a of el.getAnimations()) a.cancel()
      }
      el.style.clipPath = target
      shownRef.current = value
      return
    }
    shownRef.current = value
    const union = { l: Math.min(from.l, to.l), r: Math.max(from.r, to.r) }
    const stretch = el.animate(
      [
        { clipPath: clipFor(pad, trackW, from, thumbRadius) },
        { clipPath: clipFor(pad, trackW, union, thumbRadius) },
      ],
      { duration: RS_STRETCH_MS, easing: RS_EASE, fill: "forwards" },
    )
    stretch.finished
      .then(() => new Promise((r) => setTimeout(r, RS_REST_MS)))
      .then(() => {
        if (runRef.current !== run) return
        const snap = el.animate(
          [{ clipPath: clipFor(pad, trackW, union, thumbRadius) }, { clipPath: target }],
          { duration: RS_SNAP_MS, easing: RS_SNAP, fill: "forwards" },
        )
        return snap.finished.then(() => {
          if (runRef.current !== run) return
          el.style.clipPath = target
          stretch.cancel()
          snap.cancel()
        })
      })
      .catch(() => {})
  }, [value, trackW, slotsVersion, rubber, pad, thumbRadius])

  const renderItem = (it: PTabItem<K>, copy: boolean) => {
    const on = it.key === value
    const ink = copy ? c.text : on && !rubber ? c.text : c.text2
    const glyph = copy ? c.accent : on && !rubber ? c.accent : c.text2
    const body = (
      <>
        {it.icon ? <Ph name={it.icon} size={sm ? 13 : 15} color={glyph} /> : null}
        <T step={sm ? "12" : "sm"} color={ink} numberOfLines={1}>
          {it.label}
        </T>
        {it.count != null ? (
          <T step="codenote" tone="text3">
            {String(it.count)}
          </T>
        ) : null}
        {it.soon ? (
          <T step="codenote" tone="text3">
            · pronto
          </T>
        ) : null}
      </>
    )
    const base = {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
      height: h - pad * 2,
      paddingHorizontal: sm ? 10 : 14,
      borderRadius: thumbRadius,
      flex: full ? 1 : undefined,
      justifyContent: "center" as const,
    }
    if (copy) {
      return (
        <View key={it.key} style={[base, { opacity: it.disabled || it.soon ? 0.5 : 1 }]}>
          {body}
        </View>
      )
    }
    return (
      <Pressable
        key={it.key}
        accessibilityRole="tab"
        accessibilityState={{ selected: on, disabled: it.disabled }}
        disabled={it.disabled}
        onPress={() => onChange(it.key)}
        ref={(node: any) => {
          if (!rubber) return
          if (node) itemElsRef.current.set(it.key, node as HTMLElement)
          else itemElsRef.current.delete(it.key)
        }}
        onLayout={(e) => {
          if (rubber) {
            measureAll()
            return
          }
          const { x, width } = e.nativeEvent.layout
          slotsRef.current.set(it.key, { l: x, r: x + width })
          bumpSlots()
        }}
        style={({ pressed, hovered }: any) => [
          base,
          {
            backgroundColor: on && !rubber ? c.bgStep : "transparent",
            opacity: it.disabled || it.soon ? 0.5 : rubber ? (hovered && !on ? 0.9 : 0.7) : 1,
            transform: pressed ? [{ scale: 0.96 }] : undefined,
          },
          Platform.OS === "web"
            ? ({
                cursor: it.disabled ? "default" : on ? "default" : "pointer",
                transition:
                  "opacity 0.16s ease, transform 0.16s cubic-bezier(.23,1,.32,1), background 0.25s",
                boxShadow: on && !rubber ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
                whiteSpace: "nowrap",
                userSelect: "none",
              } as any)
            : null,
        ]}
      >
        {body}
      </Pressable>
    )
  }

  const track = (
    <View
      onLayout={(e) => {
        setTrackW(e.nativeEvent.layout.width)
        if (rubber) measureAll()
      }}
      style={[
        {
          flexDirection: "row",
          gap: 4,
          padding: pad,
          borderRadius: 10,
          backgroundColor: c.wash2,
          alignSelf: full ? "stretch" : "flex-start",
          position: "relative",
        },
        style,
      ]}
    >
      {items.map((it) => renderItem(it, false))}
      {rubber ? (
        <View
          ref={thumbRef}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            {
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              flexDirection: "row",
              gap: 4,
              padding: pad,
              backgroundColor: c.bgStep,
            },
            {
              clipPath: "inset(0 100% 0 0)",
              boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
            } as any,
          ]}
        >
          {items.map((it) => renderItem(it, true))}
        </View>
      ) : null}
    </View>
  )
  if (full) return track
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, flexShrink: 1 }}
      contentContainerStyle={{ flexDirection: "row" }}
    >
      {track}
    </ScrollView>
  )
}

/** `.layout-seg` — the two-way segmented control (Ventanas | Focus). */
export function Segmented<K extends string = string>({
  items,
  value,
  onChange,
  style,
}: {
  items: PTabItem<K>[]
  value: K
  onChange: (k: K) => void
  style?: ViewStyle
}) {
  const c = useColors()
  return (
    <View
      style={[
        { flexDirection: "row", gap: 2, padding: 3, borderRadius: 10, backgroundColor: c.wash2 },
        style,
      ]}
    >
      {items.map((it) => {
        const on = it.key === value
        return (
          <Pressable
            key={it.key}
            accessibilityRole="tab"
            disabled={it.disabled}
            onPress={() => onChange(it.key)}
            style={[
              {
                flex: 1,
                height: 30,
                borderRadius: 7,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 7,
                paddingHorizontal: 10,
                backgroundColor: on ? c.bgStep : "transparent",
                opacity: it.disabled ? 0.5 : 1,
              },
              Platform.OS === "web"
                ? ({
                    cursor: "pointer",
                    transition: "background 0.25s",
                    boxShadow: on ? `0 0 0 1px ${c.border}, 0 1px 3px rgba(52,47,61,0.1)` : "none",
                  } as any)
                : null,
            ]}
          >
            {it.icon ? <Ph name={it.icon} size={14} color={on ? c.accent : c.text3} /> : null}
            <T step="12" color={on ? c.text : c.text3}>
              {it.label}
            </T>
          </Pressable>
        )
      })}
    </View>
  )
}
