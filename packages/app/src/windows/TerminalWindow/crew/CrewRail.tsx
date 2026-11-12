/**
 * CrewRail — the Terminal window's crew: one face per terminal, in creation
 * order (a state change never reorders), each with its seat. Left or right of
 * the terminal (the person's choice), 76 px wide, 56 px narrow (faces only).
 *
 * The selected face is a tab that melts into the canvas. Hovering a face for
 * 350 ms shows a card (who drives since when, who watches, Float / Take the
 * wheel). A face dragged out of the rail floats (tg-crew-float's layer); a
 * floating window dropped on the rail docks again. "+" opens a shell or a
 * Claude Code; the button at the bottom (or dragging the grip ⋮⋮ across, or
 * the menu, or ⌥⌘[ / ]) moves the rail to the other side. A face closes from
 * its × (on hover), its right-click / long-press menu or its hover card.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { type LayoutChangeEvent, Platform, Pressable, ScrollView, Text, View } from "react-native"
import { Ph } from "../../../components/ui/ds"
import { useFaceDrag, useIsFloating, useRailDropZone, useTerminalFloatStore } from "../floating"
import { sessionLabel, type TerminalSession } from "../terminalSessions"
import { CrewMenu, type CrewMenuEntry } from "./CrewMenu"
import { describeSeat, faceState } from "./crewModel"
import { css } from "./crewMotion"
import { Face } from "./Face"
import { HoverCard } from "./HoverCard"
import { Seat } from "./Seat"
import { type CrewTokens, RAIL, SANS, useK } from "./tokens"

export type RailSide = "left" | "right"

interface CrewRailProps {
  side: RailSide
  narrow: boolean
  sessions: TerminalSession[]
  /** Faces of sessions being created (not in the list yet). */
  pending: string[]
  selectedId: string | null
  me?: string
  now: number
  canCreate: boolean
  /** Width the rail can travel when dragged to the other side. */
  travel: number
  onPick: (terminalId: string) => void
  onNew: (preset: "shell" | "claude") => void
  onSwitchSide: () => void
  onPopOut: (terminalId: string) => void
  onTakeWheel: (terminalId: string) => void
  /** Close a terminal by hand (the window decides whether to ask first). */
  onClose: (terminalId: string) => void
  /** The rail is being dragged by its grip: null at rest, else whether it would switch. */
  onRailDrag?: (hot: boolean | null) => void
}

function SwapIcon({ color }: { color: string }) {
  return <Ph name="arrows-left-right" size={15} color={color} />
}

export function CrewRail(props: CrewRailProps) {
  const K = useK()
  const { side, narrow, sessions, pending, selectedId, me, now, canCreate } = props
  const { t } = useTranslation()
  const dims = narrow ? RAIL.narrow : RAIL.wide
  const drop = useRailDropZone()
  // No hover card while a face is being dragged out (it would follow the pointer around).
  const faceDragging = useTerminalFloatStore((st) => st.drag !== null)
  const [hover, setHover] = useState<{ id: string; y: number } | null>(null)
  const [railHover, setRailHover] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [sideTip, setSideTip] = useState(false)
  const [dragX, setDragX] = useState(0)
  /** A face's right-click / long-press menu. */
  const [context, setContext] = useState<{ id: string; y: number } | null>(null)
  const slotY = useRef(new Map<string, number>())
  const scrollY = useRef(0)
  const listTop = useRef(0)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The face just picked: no card for it until the pointer leaves it. */
  const quiet = useRef<string | null>(null)
  const pick = useCallback(
    (id: string) => {
      quiet.current = id
      if (showTimer.current) clearTimeout(showTimer.current)
      showTimer.current = null
      setHover(null)
      props.onPick(id)
    },
    [props.onPick],
  )

  useEffect(
    () => () => {
      if (showTimer.current) clearTimeout(showTimer.current)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    },
    [],
  )

  const hoverIn = useCallback(
    (id: string) => {
      if (narrow || quiet.current === id) return
      if (hideTimer.current) clearTimeout(hideTimer.current)
      hideTimer.current = null
      if (showTimer.current) clearTimeout(showTimer.current)
      const show = () =>
        setHover({ id, y: listTop.current + (slotY.current.get(id) ?? 0) - scrollY.current })
      // Moving from one face to the next keeps the card up, no new delay.
      if (hover) show()
      else showTimer.current = setTimeout(show, 350)
    },
    [hover, narrow],
  )
  const hoverOut = useCallback(() => {
    quiet.current = null
    if (showTimer.current) clearTimeout(showTimer.current)
    showTimer.current = null
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setHover(null), 160)
  }, [])

  // ── The grip: drag the rail to the other side (web) ──────────────────────
  const gripRef = useRef<any>(null)
  const travelRef = useRef(props.travel)
  travelRef.current = props.travel
  const cbRef = useRef(props)
  cbRef.current = props
  useEffect(() => {
    const el = gripRef.current as HTMLElement | null
    if (Platform.OS !== "web" || !el?.addEventListener) return
    const down = (e: PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const sx = e.clientX
      let hot = false
      el.setPointerCapture?.(e.pointerId)
      cbRef.current.onRailDrag?.(false)
      const move = (ev: PointerEvent) => {
        const max = Math.max(0, travelRef.current)
        const raw = ev.clientX - sx
        const dx =
          cbRef.current.side === "left"
            ? Math.min(max, Math.max(0, raw))
            : Math.max(-max, Math.min(0, raw))
        hot = Math.abs(dx) > max / 2
        setDragX(dx)
        cbRef.current.onRailDrag?.(hot)
      }
      const up = () => {
        el.removeEventListener("pointermove", move)
        el.removeEventListener("pointerup", up)
        el.removeEventListener("pointercancel", up)
        setDragX(0)
        cbRef.current.onRailDrag?.(null)
        if (hot) cbRef.current.onSwitchSide()
      }
      el.addEventListener("pointermove", move)
      el.addEventListener("pointerup", up)
      el.addEventListener("pointercancel", up)
    }
    el.addEventListener("pointerdown", down)
    return () => el.removeEventListener("pointerdown", down)
  }, [])

  const hovered = hover ? sessions.find((s) => s.terminalId === hover.id) : undefined
  const faceMenu = (id: string): CrewMenuEntry[] => {
    const s = sessions.find((x) => x.terminalId === id)
    const view = s ? describeSeat(s, me, now) : null
    return [
      {
        key: "float",
        icon: "picture-in-picture",
        label: t("terminal.crew.float", { defaultValue: "Float" }),
        kbd: "⌘⇧F",
        onPress: () => props.onPopOut(id),
      },
      ...(view && (view.seat === "agent" || view.seat === "need") && !view.mine
        ? [
            {
              key: "take",
              icon: "steering-wheel",
              label: t("terminal.crew.takeWheel", { defaultValue: "Take the wheel" }),
              onPress: () => props.onTakeWheel(id),
            },
          ]
        : []),
      "separator",
      {
        key: "close",
        icon: "x",
        label: t("terminal.crew.close", { defaultValue: "Close terminal" }),
        danger: true,
        onPress: () => props.onClose(id),
      },
    ]
  }
  const dragging = dragX !== 0
  const innerEdge = side === "left" ? "borderRightWidth" : "borderLeftWidth"

  return (
    <View
      ref={drop.ref}
      onPointerEnter={() => setRailHover(true)}
      onPointerLeave={() => setRailHover(false)}
      style={[
        {
          flex: 1,
          width: dims.w,
          zIndex: 4,
          backgroundColor: drop.over ? K.dropOver : K.rail,
          [innerEdge]: 1,
          borderColor: K.line,
          paddingTop: 6,
          paddingBottom: 8,
          paddingHorizontal: 6,
        },
        drop.over ? css({ boxShadow: `inset 0 0 0 2px ${K.text}` }) : null,
        dragging
          ? [
              { transform: [{ translateX: dragX }], borderRadius: 12, opacity: 0.92 },
              css({
                boxShadow: `${K.shadowRail}, 0 0 0 1px ${K.cardLine}`,
                cursor: "grabbing",
              }),
            ]
          : null,
      ]}
      testID="crew-rail"
    >
      {/* grip ⋮⋮ (visible on hover): drag the rail across */}
      <View style={{ alignItems: "center", height: 14, justifyContent: "center", marginBottom: 2 }}>
        <View
          ref={gripRef}
          accessibilityLabel={t("terminal.crew.gripHint", { defaultValue: "Drag to switch sides" })}
          style={[
            {
              flexDirection: "row",
              flexWrap: "wrap",
              width: 21,
              gap: 2,
              columnGap: 3,
              paddingVertical: 2,
              paddingHorizontal: 3,
              borderRadius: 6,
              opacity: railHover || dragging ? 1 : 0,
            },
            css({ cursor: "grab", transition: "opacity .15s", touchAction: "none" }),
          ]}
          testID="crew-rail-grip"
        >
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <View
              key={i}
              style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: K.faint }}
            />
          ))}
        </View>
      </View>

      <ScrollView
        style={{ flexGrow: 0, flexShrink: 1, marginHorizontal: -6 }}
        contentContainerStyle={{ gap: dims.gap, paddingHorizontal: 6 }}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={32}
        onScroll={(e) => {
          scrollY.current = e.nativeEvent.contentOffset.y
          if (hover) setHover(null)
        }}
        onLayout={(e: LayoutChangeEvent) => {
          listTop.current = e.nativeEvent.layout.y
        }}
      >
        {sessions.map((s) => (
          <CrewSlot
            key={s.terminalId}
            session={s}
            side={side}
            narrow={narrow}
            selected={s.terminalId === selectedId}
            me={me}
            now={now}
            onPick={pick}
            onHoverIn={hoverIn}
            onHoverOut={hoverOut}
            onLayoutY={(y) => slotY.current.set(s.terminalId, y)}
            onClose={props.onClose}
            onContext={(id) => {
              setHover(null)
              setContext({
                id,
                y: listTop.current + (slotY.current.get(id) ?? 0) - scrollY.current,
              })
            }}
          />
        ))}
        {pending.map((id) => (
          <PendingSlot
            key={id}
            terminalId={id}
            narrow={narrow}
            selected={id === selectedId}
            side={side}
          />
        ))}

        <View style={{ alignItems: "center", marginTop: 6 }}>
          <Pressable
            disabled={!canCreate}
            onPress={() => setNewOpen((v) => !v)}
            accessibilityLabel={t("terminal.crew.new", { defaultValue: "New terminal" })}
            style={({ hovered }: any) => ({
              width: narrow ? 30 : 32,
              height: narrow ? 30 : 32,
              borderRadius: 10,
              borderWidth: 1.5,
              borderStyle: "dashed",
              borderColor: hovered || newOpen ? K.dim : K.cardLine,
              alignItems: "center",
              justifyContent: "center",
              opacity: canCreate ? 1 : 0.5,
            })}
            testID="crew-new"
          >
            <Ph name="plus" size={15} color={newOpen ? K.text : K.dim2} />
          </Pressable>
        </View>
      </ScrollView>

      <View style={{ flex: 1 }} />

      {/* move the crew to the other side */}
      <View style={{ alignItems: "center" }}>
        <Pressable
          onPress={props.onSwitchSide}
          onHoverIn={() => setSideTip(true)}
          onHoverOut={() => setSideTip(false)}
          accessibilityLabel={t("terminal.crew.switchSide", {
            defaultValue: "Move the crew to the other side",
          })}
          style={{
            width: 30,
            height: 30,
            borderRadius: 9,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: sideTip ? K.card : "transparent",
          }}
          testID="crew-side"
        >
          <SwapIcon color={sideTip ? K.text : K.dim2} />
        </Pressable>
        {sideTip ? (
          <Tip side={side}>
            <Text style={{ fontFamily: SANS, fontSize: 11.5, color: K.ink, fontWeight: "500" }}>
              {side === "left"
                ? t("terminal.crew.toRight", { defaultValue: "Move to the right" })
                : t("terminal.crew.toLeft", { defaultValue: "Move to the left" })}
            </Text>
            <Kbd>{side === "left" ? "⌥⌘]" : "⌥⌘["}</Kbd>
          </Tip>
        ) : null}
      </View>

      {drop.over ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 6,
            right: 6,
            bottom: 52,
            paddingVertical: 6,
            paddingHorizontal: 4,
            borderRadius: 8,
            backgroundColor: K.text,
          }}
        >
          <Text
            style={{
              fontFamily: SANS,
              fontSize: 10.5,
              fontWeight: "600",
              color: K.ink,
              textAlign: "center",
            }}
          >
            {t("terminal.crew.dropBack", { defaultValue: "Drop to dock" })}
          </Text>
        </View>
      ) : null}

      {newOpen ? (
        <NewMenu
          side={side}
          top={
            listTop.current + (sessions.length + pending.length) * ((narrow ? 55 : 81) + dims.gap)
          }
          onPick={(preset) => {
            setNewOpen(false)
            props.onNew(preset)
          }}
          onClose={() => setNewOpen(false)}
        />
      ) : null}

      {hover && hovered && !dragging && !faceDragging ? (
        <HoverCard
          session={hovered}
          side={side}
          top={hover.y}
          me={me}
          now={now}
          onEnter={() => {
            if (hideTimer.current) clearTimeout(hideTimer.current)
            hideTimer.current = null
          }}
          onLeave={hoverOut}
          onPopOut={() => {
            setHover(null)
            props.onPopOut(hovered.terminalId)
          }}
          onTakeWheel={() => {
            setHover(null)
            props.onTakeWheel(hovered.terminalId)
          }}
          onClose={() => {
            setHover(null)
            props.onClose(hovered.terminalId)
          }}
        />
      ) : null}

      {context ? (
        <CrewMenu
          testID="crew-face-menu"
          anchor={{
            top: Math.max(4, context.y),
            [side === "left" ? "left" : "right"]: "100%",
            [side === "left" ? "marginLeft" : "marginRight"]: 8,
            width: 220,
          }}
          entries={faceMenu(context.id)}
          onClose={() => setContext(null)}
        />
      ) : null}
    </View>
  )
}

// ── One face ─────────────────────────────────────────────────────────────────

interface SlotProps {
  session: TerminalSession
  side: RailSide
  narrow: boolean
  selected: boolean
  me?: string
  now: number
  onPick: (id: string) => void
  onHoverIn: (id: string) => void
  onHoverOut: () => void
  onLayoutY: (y: number) => void
  onClose: (id: string) => void
  onContext: (id: string) => void
}

function slotFrame(
  K: CrewTokens,
  side: RailSide,
  narrow: boolean,
  selected: boolean,
  hovered: boolean,
): object {
  const base = {
    alignItems: "center" as const,
    paddingTop: 10,
    paddingBottom: 9,
    borderRadius: 12,
    backgroundColor: selected ? K.canvas : hovered ? K.slotHover : "transparent",
  }
  if (!selected) return base
  // The selected face is a tab that melts into the canvas: it sticks out 7 px toward it.
  return side === "left"
    ? {
        ...base,
        marginRight: -7,
        paddingRight: 7,
        borderTopRightRadius: 0,
        borderBottomRightRadius: 0,
        borderLeftWidth: 1,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: K.line2,
        marginVertical: -1,
      }
    : {
        ...base,
        marginLeft: -7,
        paddingLeft: 7,
        borderTopLeftRadius: 0,
        borderBottomLeftRadius: 0,
        borderRightWidth: 1,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: K.line2,
        marginVertical: -1,
      }
}

function CrewSlot({
  session: s,
  side,
  narrow,
  selected,
  me,
  now,
  onPick,
  onHoverIn,
  onHoverOut,
  onLayoutY,
  onClose,
  onContext,
}: SlotProps) {
  const K = useK()
  const { t } = useTranslation()
  const dims = narrow ? RAIL.narrow : RAIL.wide
  const id = s.terminalId
  const floating = useIsFloating(id)
  const drag = useFaceDrag(id, { onClick: () => onPick(id) })
  const [hovered, setHovered] = useState(false)
  // The × stays mounted: entering it may end the face's own hover.
  const [xHover, setXHover] = useState(false)
  const view = describeSeat(s, me, now)
  const state = faceState(s, now)
  const gap = selected ? K.canvas : hovered ? K.slotHover : K.rail
  const nameColor = floating
    ? K.dim2
    : view.seat === "need"
      ? K.amberText
      : selected
        ? K.textHi
        : K.text3
  const label = sessionLabel(s)

  // Right-click on the face: its menu (web; a long press does it on touch).
  const node = useRef<HTMLElement | null>(null)
  const ctxRef = useRef(() => onContext(id))
  ctxRef.current = () => onContext(id)
  // One listener per slot (stable), so swapping nodes never leaves one behind.
  const onContextMenu = useRef((e: Event) => {
    e.preventDefault()
    ctxRef.current()
  }).current
  const setRef = useCallback(
    (el: unknown) => {
      drag.ref(el)
      if (Platform.OS !== "web") return
      node.current?.removeEventListener("contextmenu", onContextMenu)
      node.current = el instanceof HTMLElement ? el : null
      node.current?.addEventListener("contextmenu", onContextMenu)
    },
    [drag.ref, onContextMenu],
  )

  return (
    <Pressable
      ref={setRef}
      onPress={Platform.OS === "web" ? undefined : () => onPick(id)}
      onLongPress={Platform.OS === "web" ? undefined : () => onContext(id)}
      onHoverIn={() => {
        setHovered(true)
        onHoverIn(id)
      }}
      onHoverOut={() => {
        setHovered(false)
        onHoverOut()
      }}
      onLayout={(e) => onLayoutY(e.nativeEvent.layout.y)}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      style={[
        slotFrame(K, side, narrow, selected, hovered),
        { opacity: drag.dragging ? 0.35 : 1 },
        css({ cursor: "pointer", userSelect: "none", touchAction: "none" }),
      ]}
      testID={`crew-slot-${id}`}
    >
      {/* Narrow: the face leans left a little so its seat stays inside the rail. */}
      <View style={{ width: dims.face, height: dims.face, marginLeft: narrow ? -3 : 0 }}>
        {floating ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: -4,
              top: -4,
              right: -4,
              bottom: -4,
              borderRadius: 16,
              borderWidth: 1.5,
              borderStyle: "dashed",
              borderColor: K.dim,
            }}
          />
        ) : null}
        <Face session={s} state={state} size={dims.face} dim={floating} shadow />
        <Seat view={view} size={dims.seat} corner gap={gap} />
        {narrow ? null : (
          <CloseDot
            visible={(hovered || xHover) && !drag.dragging}
            onHover={setXHover}
            label={t("terminal.crew.close", { defaultValue: "Close terminal" })}
            onPress={() => onClose(id)}
            testID={`crew-close-${id}`}
          />
        )}
        {floating ? (
          <View
            style={{
              position: "absolute",
              left: -7,
              top: -7,
              width: 16,
              height: 16,
              borderRadius: 5,
              backgroundColor: K.text,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 2,
              borderColor: K.rail,
            }}
            accessibilityLabel={t("terminal.crew.floating", { defaultValue: "Floating" })}
          >
            <Ph name="arrow-up-right" size={9} color={K.ink} weight="bold" />
          </View>
        ) : null}
      </View>
      {narrow ? null : (
        <Text
          numberOfLines={1}
          style={{
            fontFamily: SANS,
            fontSize: 11,
            lineHeight: 13,
            fontWeight: "600",
            marginTop: 9,
            maxWidth: 62,
            color: nameColor,
          }}
        >
          {label}
        </Text>
      )}
    </Pressable>
  )
}

function PendingSlot({
  terminalId,
  narrow,
  selected,
  side,
}: {
  terminalId: string
  narrow: boolean
  selected: boolean
  side: RailSide
}) {
  const K = useK()
  const { t } = useTranslation()
  const dims = narrow ? RAIL.narrow : RAIL.wide
  return (
    <View
      style={[slotFrame(K, side, narrow, selected, false), { opacity: 0.7 }]}
      testID={`crew-slot-pending-${terminalId}`}
    >
      <Face terminalId={terminalId} state="idle" size={dims.face} dim shadow />
      {narrow ? null : (
        <Text
          numberOfLines={1}
          style={{
            fontFamily: SANS,
            fontSize: 11,
            lineHeight: 13,
            fontWeight: "600",
            marginTop: 9,
            maxWidth: 62,
            color: K.dim2,
          }}
        >
          {t("terminal.opening", { defaultValue: "Opening…" })}
        </Text>
      )}
    </View>
  )
}

// ── Small pieces ─────────────────────────────────────────────────────────────

export function Kbd({ children, light = true }: { children: string; light?: boolean }) {
  const K = useK()
  return (
    <Text
      style={{
        fontFamily: "Reddit Mono",
        fontSize: 10,
        color: light ? "#4F4960" : K.text3,
        backgroundColor: light ? "#E4DEEE" : "transparent",
        borderRadius: 4,
        paddingHorizontal: light ? 4 : 0,
      }}
    >
      {children}
    </Text>
  )
}

/** A light tooltip beside the rail, toward the canvas. */
function Tip({ side, children }: { side: RailSide; children: React.ReactNode }) {
  const K = useK()
  return (
    <View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          bottom: 3,
          [side === "left" ? "left" : "right"]: 38,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingVertical: 5,
          paddingHorizontal: 9,
          borderRadius: 8,
          backgroundColor: K.textHi,
          zIndex: 30,
        },
        css({ whiteSpace: "nowrap", boxShadow: K.shadowTip }),
      ]}
    >
      {children}
    </View>
  )
}

function NewMenu({
  side,
  top,
  onPick,
  onClose,
}: {
  side: RailSide
  top: number
  onPick: (preset: "shell" | "claude") => void
  onClose: () => void
}) {
  const K = useK()
  const { t } = useTranslation()
  useEffect(() => {
    if (Platform.OS !== "web") return
    const close = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", close)
    return () => window.removeEventListener("keydown", close)
  }, [onClose])
  const item = (preset: "shell" | "claude", icon: string, label: string, hint: string) => (
    <Pressable
      key={preset}
      onPress={() => onPick(preset)}
      style={({ hovered }: any) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 9,
        paddingVertical: 7,
        paddingHorizontal: 8,
        borderRadius: 7,
        backgroundColor: hovered ? K.menuHover : "transparent",
      })}
      testID={`crew-new-${preset}`}
    >
      <Ph name={icon} size={15} color={K.text2} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontFamily: SANS, fontSize: 12.5, color: K.text }}>{label}</Text>
        <Text style={{ fontFamily: SANS, fontSize: 11, color: K.dim }}>{hint}</Text>
      </View>
    </Pressable>
  )
  return (
    <>
      <Pressable
        onPress={onClose}
        style={[
          { position: "fixed" as any, left: 0, top: 0, right: 0, bottom: 0, zIndex: 39 },
          css({ cursor: "default" }),
        ]}
      />
      <View
        style={[
          {
            position: "absolute",
            top: Math.max(6, top - 8),
            [side === "left" ? "left" : "right"]: "100%",
            [side === "left" ? "marginLeft" : "marginRight"]: 8,
            width: 224,
            padding: 6,
            borderRadius: 12,
            backgroundColor: K.card,
            zIndex: 40,
          },
          css({ boxShadow: `${K.shadowCard}, inset 0 0 0 1px ${K.cardLine}` }),
        ]}
        testID="crew-new-menu"
      >
        {item(
          "shell",
          "terminal-window",
          t("terminal.newShell", { defaultValue: "Shell" }),
          t("terminal.crew.newShellHint", { defaultValue: "bash in this workspace" }),
        )}
        {item(
          "claude",
          "sparkle",
          "Claude Code",
          t("terminal.crew.newClaudeHint", { defaultValue: "with your sign-in" }),
        )}
      </View>
    </>
  )
}

/** The × on a hovered face: closes it without starting a drag or picking it. */
function CloseDot({
  visible,
  onHover,
  label,
  onPress,
  testID,
}: {
  visible: boolean
  onHover: (on: boolean) => void
  label: string
  onPress: () => void
  testID: string
}) {
  const K = useK()
  const ref = useRef<any>(null)
  const pressRef = useRef(onPress)
  pressRef.current = onPress
  useEffect(() => {
    const el = ref.current as HTMLElement | null
    if (Platform.OS !== "web" || !el?.addEventListener) return
    // The face listens to pointer events on its own node (drag-out, pick):
    // they stop here, and the × answers the native click itself.
    const stop = (e: Event) => e.stopPropagation()
    const click = (e: Event) => {
      e.stopPropagation()
      e.preventDefault()
      pressRef.current()
    }
    el.addEventListener("pointerdown", stop)
    el.addEventListener("pointerup", stop)
    el.addEventListener("click", click)
    return () => {
      el.removeEventListener("pointerdown", stop)
      el.removeEventListener("pointerup", stop)
      el.removeEventListener("click", click)
    }
  }, [])
  return (
    <Pressable
      ref={ref}
      onPress={Platform.OS === "web" ? undefined : onPress}
      onHoverIn={() => onHover(true)}
      onHoverOut={() => onHover(false)}
      pointerEvents={visible ? "auto" : "none"}
      accessibilityRole="button"
      accessibilityLabel={label}
      // @ts-expect-error web-only title tooltip
      title={label}
      style={({ hovered }: any) => [
        {
          position: "absolute",
          right: -7,
          top: -7,
          width: 18,
          height: 18,
          borderRadius: 9,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: hovered ? K.danger : K.card,
          borderWidth: 1.5,
          borderColor: hovered ? K.danger : K.cardLine,
          zIndex: 3,
          opacity: visible ? 1 : 0,
        },
        css({ boxShadow: `0 0 0 2px ${K.rail}`, cursor: "pointer" }),
      ]}
      testID={testID}
    >
      {({ hovered }: any) => (
        <Ph name="x" size={10} color={hovered ? K.onDanger : K.text} weight="bold" />
      )}
    </Pressable>
  )
}
