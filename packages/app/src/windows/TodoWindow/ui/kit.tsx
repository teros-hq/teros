/**
 * To Do UI kit — the mock's small pieces (state dot, buttons, chips,
 * segmented control, panel tabs, eyebrows, menus, inputs, ghost rows), drawn
 * with React Native primitives and the mock tokens (ui/tokens.ts).
 * Weight is always 400; hierarchy comes from size and family.
 */
import React, { useEffect, useRef } from "react"
import {
  Platform,
  Pressable,
  type StyleProp,
  Text,
  TextInput,
  type TextInputProps,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native"
import { Ph, WorkingDot } from "../../../components/ui/ds"
import type { NodeState } from "../model/types"
import { tdx, web } from "./todoFx"
import { F, type TodoTokens, useTd } from "./tokens"

const isWeb = Platform.OS === "web"
export const pointer = web({ cursor: "pointer" }) as ViewStyle

// ─── Text ───────────────────────────────────────────────────────────────────

type Family = "serif" | "sans" | "mono"

export function Tx({
  f = "sans",
  s = 13,
  lh,
  c,
  ls,
  upper,
  style,
  lines,
  children,
  ...rest
}: {
  f?: Family
  s?: number
  lh?: number
  c?: string
  ls?: number
  upper?: boolean
  style?: StyleProp<TextStyle>
  lines?: number
  children?: React.ReactNode
} & Omit<React.ComponentProps<typeof Text>, "style">) {
  const td = useTd()
  return (
    <Text
      numberOfLines={lines}
      {...rest}
      style={[
        {
          fontFamily: F[f],
          fontSize: s,
          lineHeight: lh ?? Math.round(s * 1.4),
          color: c ?? td.text,
          fontWeight: "400",
          letterSpacing: ls,
          textTransform: upper ? "uppercase" : undefined,
        },
        style,
      ]}
    >
      {children}
    </Text>
  )
}

// ─── State dot ──────────────────────────────────────────────────────────────

/**
 * The state dot. Two kinds of working (TODOAP-REQ-20): a `working` task shows
 * the WorkingDot (the TerosThinking point in amber, orbiting in the same 8 px
 * slot, no layout shift) only while `running` — an agent turn is in progress
 * in its linked conversation; otherwise it is the static solid amber dot.
 * `still` keeps a plain dot (category-only places: chips, legends, menus, log).
 * `planning` and `pending` are shape-coded at ≥ 8 px — a dotted gray ring and
 * a hollow blue ring (Pablo, 2026-10-24); smaller dots stay solid.
 */
export function Dot({
  state,
  size = 8,
  running,
  still,
  style,
}: {
  state: NodeState | null | undefined
  size?: number
  /** @spec TODOAP-REQ-20 — an agent turn runs for this task: animate a `working` dot. */
  running?: boolean
  still?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const td = useTd()
  const color = state ? td.st[state] : td.text3
  if (state === "working" && running && !still) {
    return (
      <View {...tdx("dot")} testID="todo-dot-running" style={[{ width: size, height: size, flexShrink: 0 }, style]}>
        <WorkingDot size={size} color={color} />
      </View>
    )
  }
  // Shape-coded states (rows, menus, chips): planning renders as a dotted
  // gray ring and pending as a hollow blue ring; the rest stay solid dots.
  // Below 8 px (legends, log lines, filter chips) every state stays solid —
  // a border that thin smears into mud.
  const ring = size >= 8 && (state === "planning" || state === "pending")
  return (
    <View
      {...tdx("dot")}
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: ring ? "transparent" : color,
          borderWidth: ring ? 1.5 : 0,
          borderColor: color,
          borderStyle: state === "planning" ? "dotted" : "solid",
          flexShrink: 0,
        },
        style,
      ]}
    />
  )
}

// ─── Buttons ────────────────────────────────────────────────────────────────

export type Tone = "pri" | "out" | "ghost" | "mint"

export function Btn({
  tone = "out",
  sm,
  icon,
  onPress,
  disabled,
  children,
  label,
  style,
  height,
}: {
  tone?: Tone
  sm?: boolean
  icon?: string
  onPress?: () => void
  disabled?: boolean
  children?: React.ReactNode
  label?: string
  style?: StyleProp<ViewStyle>
  height?: number
}) {
  const td = useTd()
  const fg = tone === "pri" ? "#FFFFFF" : tone === "mint" ? td.mintInk : tone === "ghost" ? td.text2 : td.text
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ hovered, pressed }: any) => [
        {
          height: height ?? (sm ? 26 : 32),
          paddingHorizontal: tone === "ghost" ? (sm ? 11 : 12) : sm ? 11 : 16,
          borderRadius: 100,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          flexShrink: 0,
          opacity: disabled ? 0.4 : 1,
          backgroundColor:
            tone === "pri"
              ? td.priBg
              : tone === "mint"
                ? td.mint
                : tone === "out"
                  ? hovered
                    ? td.wash
                    : td.card
                  : hovered
                    ? td.wash2
                    : "transparent",
        },
        web({
          cursor: disabled ? "default" : "pointer",
          transition: "background .2s, filter .2s, transform .3s cubic-bezier(.16,1,.3,1)",
          boxShadow: tone === "pri" ? td.liftSm : tone === "out" ? `0 0 0 1px ${td.borderStrong}` : undefined,
          filter: (tone === "pri" || tone === "mint") && hovered && !disabled ? "brightness(1.07)" : undefined,
          transform: (tone === "pri" || tone === "mint") && hovered && !disabled && !pressed ? "translateY(-1px)" : undefined,
        }) as ViewStyle,
        style,
      ]}
    >
      {icon ? <Ph name={icon} size={sm ? 12 : 13} color={fg} /> : null}
      {typeof children === "string" ? (
        <Tx s={sm ? 11.5 : 12.5} lh={sm ? 14 : 16} c={fg} lines={1}>
          {children}
        </Tx>
      ) : (
        children
      )}
    </Pressable>
  )
}

export function IconBtn({
  icon,
  onPress,
  label,
  size = 28,
  iconSize = 15,
  color,
  active,
  round = true,
}: {
  icon: string
  onPress?: () => void
  label: string
  size?: number
  iconSize?: number
  color?: string
  active?: boolean
  round?: boolean
}) {
  const td = useTd()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ hovered }: any) => [
        {
          width: size,
          height: size,
          borderRadius: round ? size / 2 : 6,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: hovered ? td.wash2 : "transparent",
        },
        pointer,
      ]}
    >
      {({ hovered }: any) => (
        <Ph name={icon} size={iconSize} color={active ? td.accent : hovered ? td.text : (color ?? td.text3)} />
      )}
    </Pressable>
  )
}

/** Small text link (`.lnk`). */
export function Lnk({ icon, children, onPress, color }: { icon?: string; children: string; onPress?: () => void; color?: string }) {
  const td = useTd()
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ hovered }: any) => [
        {
          height: 24,
          paddingHorizontal: 9,
          borderRadius: 100,
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          backgroundColor: hovered ? td.wash2 : "transparent",
        },
        pointer,
      ]}
    >
      {({ hovered }: any) => (
        <>
          {icon ? <Ph name={icon} size={13} color={hovered ? td.text : (color ?? td.text2)} /> : null}
          <Tx s={11.5} lh={14} c={hovered ? td.text : (color ?? td.text2)} style={{ letterSpacing: 0 }}>
            {children}
          </Tx>
        </>
      )}
    </Pressable>
  )
}

// ─── Chips / segmented / tabs ───────────────────────────────────────────────

export function FilterChip({
  on,
  onPress,
  label,
  count,
  state,
  height = 26,
}: {
  on: boolean
  onPress: () => void
  label: string
  count?: number
  state?: NodeState
  height?: number
}) {
  const td = useTd()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={({ hovered }: any) => [
        {
          height,
          paddingHorizontal: 10,
          borderRadius: 100,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          flexShrink: 0,
          backgroundColor: on ? td.card : hovered ? td.wash2 : "transparent",
        },
        web({ cursor: "pointer", boxShadow: on ? td.cardShadow : undefined }) as ViewStyle,
      ]}
    >
      {state ? <Dot state={state} size={6} still /> : null}
      <Tx s={11.5} lh={14} c={on ? td.text : td.text2}>
        {label}
      </Tx>
      {count != null ? (
        <Tx f="mono" s={10} lh={12} c={td.txs}>
          {count}
        </Tx>
      ) : null}
    </Pressable>
  )
}

export function Seg<K extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: Array<{ key: K; label: string }>
  value: K
  onChange: (k: K) => void
  label: string
}) {
  const td = useTd()
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={label}
      style={{ flexDirection: "row", backgroundColor: td.wash2, borderRadius: 10, padding: 3, gap: 3, flexShrink: 0 }}
    >
      {items.map((it) => {
        const on = it.key === value
        return (
          <Pressable
            key={it.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(it.key)}
            style={[
              {
                height: 28,
                paddingHorizontal: 14,
                borderRadius: 7,
                justifyContent: "center",
                backgroundColor: on ? td.card : "transparent",
              },
              web({ cursor: "pointer", boxShadow: on ? td.cardShadow : undefined }) as ViewStyle,
            ]}
          >
            <Tx s={12} lh={14} c={on ? td.text : td.text2}>
              {it.label}
            </Tx>
          </Pressable>
        )
      })}
    </View>
  )
}

export function PanelTabs<K extends string>({
  items,
  value,
  onChange,
  wide,
}: {
  items: Array<{ key: K; label: string; count?: number | string | null }>
  value: K
  onChange: (k: K) => void
  wide?: boolean
}) {
  const td = useTd()
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        backgroundColor: td.wash2,
        borderRadius: 12,
        padding: 3,
        gap: 4,
        marginTop: 18,
        marginBottom: 6,
        maxWidth: wide ? undefined : 420,
      }}
    >
      {items.map((it) => {
        const on = it.key === value
        return (
          <Pressable
            key={it.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(it.key)}
            style={[
              {
                flex: 1,
                height: 30,
                borderRadius: 9,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                backgroundColor: on ? td.card : "transparent",
              },
              web({ cursor: "pointer", boxShadow: on ? td.cardShadow : undefined }) as ViewStyle,
            ]}
          >
            <Tx s={12.5} lh={16} c={on ? td.text : td.text2}>
              {it.label}
            </Tx>
            {it.count ? (
              <Tx f="mono" s={10} lh={12} c={td.txs}>
                {String(it.count)}
              </Tx>
            ) : null}
          </Pressable>
        )
      })}
    </View>
  )
}

// ─── Section labels ─────────────────────────────────────────────────────────

export function Eyebrow({
  children,
  count,
  right,
  first,
  style,
}: {
  children: string
  count?: string | null
  right?: React.ReactNode
  first?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const td = useTd()
  return (
    <View
      style={[
        { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 24, marginTop: first ? 4 : 20, marginBottom: 8 },
        style,
      ]}
    >
      <Tx s={10} lh={12} c={td.txs} ls={1.7} upper>
        {children}
      </Tx>
      {count ? (
        <Tx f="mono" s={10} lh={12} c={td.text2} ls={0.3}>
          {count}
        </Tx>
      ) : null}
      <View style={{ flex: 1 }} />
      {right}
    </View>
  )
}

// ─── Menus ──────────────────────────────────────────────────────────────────

/** Close an open popover on an outside pointer-down or Esc (web). */
export function useDismiss(open: boolean, onClose: () => void, ...refs: Array<React.RefObject<any>>) {
  const cb = useRef(onClose)
  cb.current = onClose
  useEffect(() => {
    if (!open || !isWeb || typeof document === "undefined") return
    const inside = (t: EventTarget | null) =>
      refs.some((r) => {
        const el = r.current as HTMLElement | null
        return !!el && t instanceof Node && el.contains(t)
      })
    const down = (e: MouseEvent) => {
      if (!inside(e.target)) cb.current()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        cb.current()
      }
    }
    document.addEventListener("mousedown", down, true)
    document.addEventListener("keydown", key, true)
    return () => {
      document.removeEventListener("mousedown", down, true)
      document.removeEventListener("keydown", key, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
}

export const MenuBox = React.forwardRef<
  View,
  { children: React.ReactNode; right?: boolean; minWidth?: number; style?: StyleProp<ViewStyle>; label?: string }
>(function MenuBox({ children, right, minWidth = 244, style, label }, ref) {
  const td = useTd()
  return (
    <View
      ref={ref}
      accessibilityRole="menu"
      accessibilityLabel={label}
      {...tdx("pop")}
      style={[
        {
          position: "absolute",
          top: "100%",
          marginTop: 6,
          ...(right ? { right: 0 } : { left: 0 }),
          zIndex: 50,
          backgroundColor: td.card,
          borderRadius: 14,
          padding: 4,
          minWidth,
          maxWidth: 320,
        },
        web({ boxShadow: `${td.elevRaised}, 0 0 0 1px ${td.borderStrong}` }) as ViewStyle,
        style,
      ]}
    >
      {children}
    </View>
  )
})

export function MenuHead({ children, icon }: { children: React.ReactNode; icon?: string }) {
  const td = useTd()
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 7, paddingHorizontal: 9, paddingBottom: 4 }}>
      {icon ? <Ph name={icon} size={13} color={td.txs} /> : null}
      {typeof children === "string" ? (
        <Tx f="mono" s={9.5} lh={14} c={td.txs} ls={1} upper>
          {children}
        </Tx>
      ) : (
        children
      )}
    </View>
  )
}

export function MenuItem({
  label,
  hint,
  icon,
  state,
  onPress,
  checked,
  danger,
  disabled,
}: {
  label: string
  hint?: string
  icon?: string
  state?: NodeState
  onPress?: () => void
  checked?: boolean
  danger?: boolean
  disabled?: boolean
}) {
  const td = useTd()
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ hovered, focused }: any) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 9,
          minHeight: 34,
          paddingHorizontal: 9,
          borderRadius: 9,
          opacity: disabled ? 0.45 : 1,
          backgroundColor: (hovered || focused) && !disabled ? td.wash2 : checked ? td.navActive : "transparent",
        },
        web({ cursor: disabled ? "default" : "pointer", outlineStyle: "none" }) as ViewStyle,
      ]}
    >
      {state ? <Dot state={state} still /> : null}
      {icon ? <Ph name={icon} size={14} color={danger ? td.rTx : td.text3} /> : null}
      <Tx s={12.5} lh={16} c={danger ? td.rTx : td.text} style={{ flexShrink: 1 }}>
        {label}
      </Tx>
      {hint ? (
        <Tx f="mono" s={10} lh={14} c={td.txs} style={{ marginLeft: "auto", paddingLeft: 12 }}>
          {hint}
        </Tx>
      ) : null}
    </Pressable>
  )
}

export function MenuSep() {
  const td = useTd()
  return <View style={{ height: 1, backgroundColor: td.borderStrong, marginVertical: 4, marginHorizontal: 6 }} />
}

/**
 * "+" menu: New task / New group. Opens focused on its first item; ↑/↓ move,
 * Enter picks (the items are buttons), Esc or a click outside closes.
 */
export function AddMenu({
  onTask,
  onGroup,
  onClose,
  labels,
  right = true,
}: {
  onTask: () => void
  onGroup: () => void
  onClose: () => void
  labels: { task: string; group: string; menu: string }
  right?: boolean
}) {
  const ref = useRef<View>(null)
  useDismiss(true, onClose, ref)
  useEffect(() => {
    if (!isWeb) return
    const el = ref.current as unknown as HTMLElement | null
    if (!el) return
    const items = () => Array.from(el.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    requestAnimationFrame(() => items()[0]?.focus())
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
      e.preventDefault()
      e.stopPropagation()
      const list = items()
      const i = list.indexOf(document.activeElement as HTMLElement)
      const j = (i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length
      list[j]?.focus()
    }
    el.addEventListener("keydown", onKey)
    return () => el.removeEventListener("keydown", onKey)
  }, [])
  return (
    <MenuBox ref={ref} right={right} minWidth={190} label={labels.menu}>
      <MenuItem icon="check-square" label={labels.task} onPress={onTask} />
      <MenuItem icon="folder-simple" label={labels.group} onPress={onGroup} />
    </MenuBox>
  )
}

// ─── Inputs ─────────────────────────────────────────────────────────────────

export const Field = React.forwardRef<TextInput, TextInputProps & { height?: number; bg?: string }>(function Field(
  { height = 32, bg, style, ...rest },
  ref,
) {
  const td = useTd()
  return (
    <TextInput
      ref={ref}
      placeholderTextColor={td.text3}
      {...rest}
      style={[
        {
          height,
          borderRadius: 100,
          backgroundColor: bg ?? td.sheet,
          paddingHorizontal: 12,
          fontFamily: F.sans,
          fontSize: 12.5,
          color: td.text,
          minWidth: 0,
        },
        web({ outlineStyle: "none", boxShadow: `0 0 0 1px ${td.borderStrong}` }) as TextStyle,
        style,
      ]}
    />
  )
})

// ─── Empty-state ghost rows ─────────────────────────────────────────────────

export function GhostRows() {
  const td = useTd()
  const row = (bg: string, dot: string, ml: number, w: string | number) => (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        height: 30,
        paddingHorizontal: 12,
        borderRadius: 9,
        backgroundColor: bg,
        marginLeft: ml,
        width: w as any,
      }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
      <View style={{ height: 6, borderRadius: 3, backgroundColor: td.wash2, flex: 1 }} />
    </View>
  )
  return (
    <View style={{ width: 240, maxWidth: "100%", gap: 6, marginBottom: 10 }} aria-hidden>
      {row(td.wash, td.controlBg, 0, "100%")}
      {row(td.navActive, td.purple200, 16, 224)}
      {row(td.wash, td.green, 16, "80%")}
    </View>
  )
}

export function EmptyBlock({
  title,
  body,
  children,
}: {
  title: string
  body?: string
  children?: React.ReactNode
}) {
  const td = useTd()
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 40, paddingHorizontal: 24 }}>
      <GhostRows />
      <Tx f="serif" s={24} lh={28} c={td.text} style={{ textAlign: "center" }}>
        {title}
      </Tx>
      {body ? (
        <Tx s={13} lh={19} c={td.text2} style={{ textAlign: "center", maxWidth: 300 }}>
          {body}
        </Tx>
      ) : null}
      {children ? <View style={{ flexDirection: "row", gap: 6, marginTop: 6 }}>{children}</View> : null}
    </View>
  )
}

export type { TodoTokens }
