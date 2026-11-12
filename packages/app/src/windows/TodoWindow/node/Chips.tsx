/**
 * The detail header's chip strip (TODODH-REQ-2): state (allowed transitions
 * only; Block asks for the reason inline), assignee, progress (always
 * editable, purple in review, "from children" when derived), day (today /
 * tomorrow / next days / a date / a time / off the day; "overdue" in red) and
 * the conversation ghost chip. One row that never wraps: it scrolls sideways
 * with a right-edge fade while there is more to the right. The chips' menus
 * are drawn in a layer above the row so the scrolling row doesn't clip them.
 */
import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
// @ts-ignore - react-dom types not available but package is present
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, ScrollView, TextInput, View, type ViewStyle } from "react-native"
import { Ph } from "../../../components/ui/ds"
import { addDays, relativeDay, todayIso, weekdayLong } from "../model/days"
import { STATE_TRANSITIONS } from "../model/states"
import type { NodeDetail, NodeState } from "../model/types"
import { Btn, Dot, Field, MenuBox, MenuHead, MenuItem, MenuSep, Tx, useDismiss } from "../ui/kit"
import { tdx, web } from "../ui/todoFx"
import { F, useTd } from "../ui/tokens"

type Menu = "state" | "block" | "progress" | "day" | null

/** Chip height in the strip (mock v2: 34 px pills). */
const CHIP_H = 34
/** Widest chip menu (assign), to keep a menu inside the pane. */
const MENU_W = 264

// ─── Strip ──────────────────────────────────────────────────────────────────

interface StripLayer {
  host: HTMLElement | null
  scroller: HTMLElement | null
  /** Bumped on scroll / resize so an open menu follows its chip. */
  tick: number
}
const StripCtx = createContext<StripLayer | null>(null)

/** @spec TODODH-REQ-2 The row is wider than its pane; there is more to the right. */
export function stripOverflow(el: { scrollWidth: number; clientWidth: number; scrollLeft: number }) {
  const overflow = el.scrollWidth > el.clientWidth + 1
  return { overflow, more: overflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 1 }
}

/**
 * @spec TODODH-REQ-2 One non-wrapping row of chips. While it is wider than the
 * pane it scrolls horizontally (hidden scrollbar, keyboard reachable) with a
 * 28 px fade at the right edge while there is more to the right; it never
 * pushes the window wider.
 */
export function ChipStrip({ children, label }: { children: React.ReactNode; label?: string }) {
  const scrollerRef = useRef<any>(null)
  const hostRef = useRef<any>(null)
  const [layer, setLayer] = useState<StripLayer>({ host: null, scroller: null, tick: 0 })
  const [fit, setFit] = useState({ overflow: false, more: false })

  const measure = () => {
    const el = scrollerRef.current as HTMLElement | null
    if (!el || Platform.OS !== "web") return
    const next = stripOverflow(el)
    setFit((f) => (f.overflow === next.overflow && f.more === next.more ? f : next))
  }

  useLayoutEffect(() => {
    if (Platform.OS !== "web") return
    const el = scrollerRef.current as HTMLElement | null
    if (!el) return
    setLayer({ host: hostRef.current, scroller: el, tick: 0 })
    const bump = () => {
      measure()
      setLayer((l) => ({ ...l, tick: l.tick + 1 }))
    }
    el.addEventListener("scroll", bump, { passive: true })
    window.addEventListener("resize", bump)
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(bump) : null
    ro?.observe(el)
    if (el.firstElementChild) ro?.observe(el.firstElementChild)
    return () => {
      el.removeEventListener("scroll", bump)
      window.removeEventListener("resize", bump)
      ro?.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // The chips change width with their content (state, assignee, day).
  useLayoutEffect(measure)

  const row = (
    <StripCtx.Provider value={layer}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}>{children}</View>
    </StripCtx.Provider>
  )

  if (Platform.OS !== "web") {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityLabel={label} style={{ flexGrow: 0 }}>
        {row}
      </ScrollView>
    )
  }
  return (
    <View style={{ position: "relative", zIndex: 20, minWidth: 0 }}>
      <View
        ref={scrollerRef}
        accessibilityLabel={label}
        {...tdx(fit.more ? "strip noscroll sfade" : "strip noscroll", { overflow: fit.overflow ? "1" : "0" })}
        {...({ role: "group", tabIndex: 0 } as Record<string, unknown>)}
        style={[
          { flexDirection: "row", minWidth: 0, paddingVertical: 2, paddingHorizontal: 1, marginHorizontal: -1 },
          web({ overflowX: "auto", overflowY: "hidden" }) as ViewStyle,
        ]}
      >
        {row}
      </View>
      <View ref={hostRef} pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }} />
    </View>
  )
}

/**
 * @spec TODODH-REQ-2 A chip's menu, drawn in the strip's layer under its chip
 * (the scrolling row would clip it) and scrolled into view when it opens.
 */
export function StripMenu({
  anchor,
  menuRef,
  children,
}: {
  anchor: React.RefObject<any>
  menuRef: React.MutableRefObject<any>
  children: React.ReactNode
}) {
  const layer = useContext(StripCtx)
  const el = useRef<any>(null)
  useEffect(() => {
    const node = el.current as HTMLElement | null
    if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [])
  const setRef = (n: any) => {
    el.current = n
    menuRef.current = n
  }
  if (Platform.OS !== "web" || !layer?.host) return <View ref={setRef}>{children}</View>
  const a = anchor.current as HTMLElement | null
  const room = Math.max(0, layer.host.clientWidth - MENU_W)
  const x = Math.max(0, Math.min((a?.offsetLeft ?? 0) - (layer.scroller?.scrollLeft ?? 0), room))
  return createPortal(
    <View ref={setRef} pointerEvents="box-none" style={{ position: "absolute", left: x, top: 0, height: "100%", zIndex: 50 }}>
      {children}
    </View>,
    layer.host,
  )
}

/** @spec TODODH-REQ-2 A strip chip: 34 px pill, no field label (the field name lives in `label`). */
export function StripChip({
  children,
  onPress,
  expanded,
  label,
  ghost,
  testID,
}: {
  children: React.ReactNode
  onPress?: () => void
  expanded?: boolean
  label: string
  ghost?: boolean
  testID?: string
}) {
  const td = useTd()
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={onPress}
      style={({ hovered }: any) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          height: CHIP_H,
          paddingVertical: 9,
          paddingHorizontal: 11,
          borderRadius: 100,
          flexShrink: 0,
          backgroundColor: hovered ? td.wash : ghost ? "transparent" : td.card,
        },
        web({
          cursor: "pointer",
          boxShadow: `0 0 0 1px ${expanded ? td.purple200 : ghost ? td.border : td.borderStrong}`,
          whiteSpace: "nowrap",
        }) as ViewStyle,
      ]}
    >
      {children}
    </Pressable>
  )
}

/** A small mono tag inside a chip ("from children", "overdue"). */
const Tag = ({ children, color }: { children: string; color?: string }) => {
  const td = useTd()
  return (
    <Tx f="mono" s={9.5} lh={12} c={color ?? td.txs} ls={0.3}>
      {children}
    </Tx>
  )
}

// ─── Chips ──────────────────────────────────────────────────────────────────

interface Props {
  node: NodeDetail
  /** Task has child tasks (progress can be derived). */
  hasChildTasks: boolean
  onSetState: (to: NodeState, reason?: string) => void
  onProgress: (value: number | null) => void
  onPlan: (day: string | null, time?: string | null) => void
  /** The assignee chip, placed after the state chip. */
  assignSlot?: React.ReactNode
  /** The reviewer chip (TODORV), placed after the assignee chip. */
  reviewerSlot?: React.ReactNode
  /** Opens the task's conversation (TODOAP-REQ-13); the chip shows when the task has a `channelId`. */
  onOpenConversation?: () => void
  /** Bumped by the action bar's Block: opens the block-reason menu (TODODH-REQ-3). */
  blockSignal?: number
}

/**
 * @spec TODODH-REQ-2 The detail header's chips in one strip: state, assignee,
 * progress, day and, with a `channelId`, the conversation ghost chip.
 */
export function StateChips({ node, hasChildTasks, onSetState, onProgress, onPlan, assignSlot, reviewerSlot, onOpenConversation, blockSignal = 0 }: Props) {
  const td = useTd()
  const { t, i18n } = useTranslation()
  const locale = i18n.language || "en-US"
  const [menu, setMenu] = useState<Menu>(null)
  const [reason, setReason] = useState("")
  const stateRef = useRef<View>(null)
  const progRef = useRef<View>(null)
  const dayRef = useRef<View>(null)
  const menuRef = useRef<any>(null)
  useDismiss(menu === "state" || menu === "block", () => setMenu(null), stateRef, menuRef)
  useDismiss(menu === "progress", () => setMenu(null), progRef, menuRef)
  useDismiss(menu === "day", () => setMenu(null), dayRef, menuRef)

  const seenBlock = useRef(blockSignal)
  useEffect(() => {
    if (blockSignal === seenBlock.current) return
    seenBlock.current = blockSignal
    setMenu("block")
  }, [blockSignal])

  const state = node.state ?? "pending"
  const p = Math.max(0, Math.min(100, node.progress ?? 0))
  const derived = node.reportedProgress == null && hasChildTasks && state !== "done" && state !== "review" && state !== "cancelled"
  const today = todayIso()
  const words = { today: t("todo.day.today"), tomorrow: t("todo.day.tomorrow"), yesterday: t("todo.day.yesterday") }
  const overdue = !!node.plannedFor && node.plannedFor < today && state !== "done" && state !== "cancelled"
  const dayOptions = useMemo(() => [0, 1, 2, 3].map((k) => addDays(today, k)), [today])
  const dayText = node.plannedFor ? relativeDay(node.plannedFor, today, locale, words) : t("todo.day.noDay")

  const commitBlock = () => {
    const r = reason.trim()
    if (!r) return
    setMenu(null)
    setReason("")
    onSetState("blocked", r)
  }

  return (
    <ChipStrip label={t("todo.a11y.chips")}>
      {/* State */}
      <View ref={stateRef}>
        <StripChip
          label={`${t("todo.chip.state")}: ${t(`todo.state.${state}`)}`}
          expanded={menu === "state" || menu === "block"}
          onPress={() => setMenu(menu === "state" || menu === "block" ? null : "state")}
        >
          <Dot state={state} running={node.running} />
          <Tx s={12.5} lh={16} c={td.text}>
            {t(`todo.state.${state}`)}
          </Tx>
          <Ph name="caret-down" size={10} color={td.text3} />
        </StripChip>
        {menu === "state" ? (
          <StripMenu anchor={stateRef} menuRef={menuRef}>
            <MenuBox label={t("todo.chip.state")}>
              <MenuHead>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Tx f="mono" s={9.5} lh={14} c={td.txs} ls={1} upper>
                    {t("todo.stateMenu.now")}
                  </Tx>
                  <Dot state={state} size={6} still />
                  <Tx f="mono" s={9.5} lh={14} c={td.txs} ls={1} upper>
                    {t(`todo.state.${state}`).toLowerCase()}
                  </Tx>
                </View>
              </MenuHead>
              {STATE_TRANSITIONS[state].map((to) => (
                <MenuItem
                  key={to}
                  state={to}
                  label={t(`todo.state.${to}`)}
                  hint={t(`todo.transitionHint.${state}_${to}`)}
                  onPress={() => {
                    if (to === "blocked") setMenu("block")
                    else {
                      setMenu(null)
                      onSetState(to)
                    }
                  }}
                />
              ))}
            </MenuBox>
          </StripMenu>
        ) : null}
        {menu === "block" ? (
          <StripMenu anchor={stateRef} menuRef={menuRef}>
            <MenuBox label={t("todo.stateMenu.block")}>
              <MenuHead>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Dot state="blocked" size={6} />
                  <Tx f="mono" s={9.5} lh={14} c={td.txs} ls={1} upper>
                    {t("todo.stateMenu.block")}
                  </Tx>
                </View>
              </MenuHead>
              <View style={{ gap: 8, paddingHorizontal: 6, paddingTop: 6, paddingBottom: 4 }}>
                <Tx f="mono" s={10} lh={14} c={td.txs} style={{ paddingHorizontal: 3 }}>
                  {t("todo.stateMenu.blockQuestion")}
                </Tx>
                <Field
                  autoFocus
                  value={reason}
                  onChangeText={setReason}
                  onSubmitEditing={commitBlock}
                  placeholder={t("todo.stateMenu.blockPlaceholder")}
                  accessibilityLabel={t("todo.stateMenu.blockQuestion")}
                />
                <View style={{ flexDirection: "row", gap: 6, justifyContent: "flex-end" }}>
                  <Btn sm tone="ghost" onPress={() => setMenu("state")}>
                    {t("todo.stateMenu.back")}
                  </Btn>
                  <Btn sm tone="pri" disabled={!reason.trim()} onPress={commitBlock}>
                    {t("todo.stateMenu.block")}
                  </Btn>
                </View>
              </View>
            </MenuBox>
          </StripMenu>
        ) : null}
      </View>

      {assignSlot}
      {reviewerSlot}

      {/* Progress */}
      <View ref={progRef}>
        <StripChip
          label={`${t("todo.chip.progress")}: ${p}%`}
          expanded={menu === "progress"}
          onPress={() => setMenu(menu === "progress" ? null : "progress")}
        >
          <View style={{ width: 52, height: 4, borderRadius: 2, backgroundColor: td.wash2, overflow: "hidden" }}>
            <View
              style={[
                { height: "100%", width: `${p}%`, borderRadius: 2, backgroundColor: state === "review" ? td.purple200 : td.green },
                web({ transition: "width .5s cubic-bezier(.16,1,.3,1)" }) as ViewStyle,
              ]}
            />
          </View>
          <Tx f="mono" s={10.5} lh={12} c={td.text2}>
            {`${p} %`}
          </Tx>
          {derived ? <Tag>{t("todo.chip.fromChildren")}</Tag> : null}
        </StripChip>
        {menu === "progress" ? (
          <StripMenu anchor={progRef} menuRef={menuRef}>
            <ProgressMenu value={p} hasChildTasks={hasChildTasks} onChange={onProgress} onClose={() => setMenu(null)} />
          </StripMenu>
        ) : null}
      </View>

      {/* Day */}
      <View ref={dayRef}>
        <StripChip
          label={`${t("todo.chip.day")}: ${dayText}${node.plannedTime ? ` ${node.plannedTime}` : ""}`}
          expanded={menu === "day"}
          onPress={() => setMenu(menu === "day" ? null : "day")}
        >
          <Tx s={12.5} lh={16} c={node.plannedFor ? td.text : td.text3}>
            {dayText}
          </Tx>
          {node.plannedTime ? (
            <Tx f="mono" s={10.5} lh={12} c={td.text2}>
              {node.plannedTime}
            </Tx>
          ) : null}
          {overdue ? <Tag color={td.rTx}>{t("todo.day.overdue")}</Tag> : null}
          <Ph name="caret-down" size={10} color={td.text3} />
        </StripChip>
        {menu === "day" ? (
          <StripMenu anchor={dayRef} menuRef={menuRef}>
            <MenuBox label={t("todo.day.planFor")}>
              <MenuHead icon="calendar-blank">{t("todo.day.planFor")}</MenuHead>
              {dayOptions.map((d) => (
                <MenuItem
                  key={d}
                  label={relativeDay(d, today, locale, words)}
                  hint={node.plannedFor === d ? t("todo.day.current") : weekdayLong(d, locale)}
                  checked={node.plannedFor === d}
                  onPress={() => {
                    setMenu(null)
                    onPlan(d)
                  }}
                />
              ))}
              <DateTimeInputs
                day={node.plannedFor}
                time={node.plannedTime}
                onDay={(d) => {
                  setMenu(null)
                  onPlan(d)
                }}
                onTime={(tm) => onPlan(node.plannedFor ?? today, tm)}
              />
              {node.plannedFor ? (
                <>
                  <MenuSep />
                  <MenuItem
                    icon="x"
                    label={t("todo.day.removeFromDay")}
                    onPress={() => {
                      setMenu(null)
                      onPlan(null)
                    }}
                  />
                </>
              ) : null}
            </MenuBox>
          </StripMenu>
        ) : null}
      </View>

      {/* Conversation (TODOAP-REQ-13) */}
      {node.channelId && onOpenConversation ? (
        <StripChip ghost testID="todo-detail-conversation" label={t("todo.conversation.chip")} onPress={onOpenConversation}>
          <Ph name="chat-circle" size={14} color={td.text2} />
          <Tx s={12.5} lh={16} c={td.text}>
            {t("todo.conversation.chip")}
          </Tx>
        </StripChip>
      ) : null}
    </ChipStrip>
  )
}

function ProgressMenu({
  value,
  hasChildTasks,
  onChange,
  onClose,
}: {
  value: number
  hasChildTasks: boolean
  onChange: (v: number | null) => void
  onClose: () => void
}) {
  const td = useTd()
  const { t } = useTranslation()
  const [v, setV] = useState(value)
  return (
    <MenuBox label={t("todo.progressMenu.label")} minWidth={244}>
      <View style={{ gap: 10, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" }}>
          <Tx f="serif" s={28} lh={30} c={td.text}>
            {`${v} %`}
          </Tx>
          <Tx f="mono" s={10} lh={14} c={td.txs}>
            {t("todo.progressMenu.reported")}
          </Tx>
        </View>
        {Platform.OS === "web"
          ? React.createElement("input", {
              type: "range",
              min: 0,
              max: 100,
              step: 5,
              value: v,
              "aria-label": t("todo.progressMenu.label"),
              style: { width: "100%", accentColor: td.green },
              onChange: (e: any) => setV(Number(e.target.value)),
              onMouseUp: (e: any) => onChange(Number(e.target.value)),
              onTouchEnd: (e: any) => onChange(Number(e.target.value)),
              onKeyUp: (e: any) => onChange(Number(e.target.value)),
            })
          : null}
        <View style={{ flexDirection: "row", gap: 4 }}>
          {[0, 25, 50, 75, 100].map((q) => (
            <Pressable
              key={q}
              onPress={() => {
                setV(q)
                onChange(q)
                onClose()
              }}
              style={({ hovered }: any) => [
                { flex: 1, height: 26, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: hovered ? td.controlBg : td.wash2 },
                web({ cursor: "pointer" }) as ViewStyle,
              ]}
            >
              <Tx f="mono" s={10.5} lh={12} c={td.text2}>
                {String(q)}
              </Tx>
            </Pressable>
          ))}
        </View>
        {hasChildTasks ? (
          <View style={{ alignSelf: "flex-start", marginLeft: -8 }}>
            <Btn
              sm
              tone="ghost"
              onPress={() => {
                onChange(null)
                onClose()
              }}
            >
              {t("todo.progressMenu.fromChildren")}
            </Btn>
          </View>
        ) : null}
      </View>
    </MenuBox>
  )
}

/** "Other date" + time inputs (native browser pickers on web; plain fields elsewhere). */
function DateTimeInputs({
  day,
  time,
  onDay,
  onTime,
}: {
  day: string | null
  time: string | null
  onDay: (d: string) => void
  onTime: (t: string | null) => void
}) {
  const td = useTd()
  const { t } = useTranslation()
  const style = {
    width: "100%",
    height: 32,
    borderRadius: 100,
    border: "none",
    background: td.sheet,
    boxShadow: `0 0 0 1px ${td.borderStrong}`,
    padding: "0 12px",
    font: `400 12.5px ${F.sans}`,
    color: td.text,
    colorScheme: td.dark ? "dark" : "light",
    outline: "none",
    boxSizing: "border-box",
  }
  const label = (s: string) => (
    <Tx f="mono" s={10} lh={14} c={td.txs} style={{ paddingHorizontal: 3 }}>
      {s}
    </Tx>
  )
  if (Platform.OS !== "web") {
    return (
      <View style={{ gap: 8, paddingHorizontal: 6, paddingTop: 6, paddingBottom: 4 }}>
        {label(t("todo.day.otherDate"))}
        <TextInput defaultValue={day ?? ""} placeholder="YYYY-MM-DD" onSubmitEditing={(e) => onDay(e.nativeEvent.text)} />
      </View>
    )
  }
  return (
    <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: 6, paddingTop: 6, paddingBottom: 4 }}>
      <View style={{ flex: 1.4, gap: 6 }}>
        {label(t("todo.day.otherDate"))}
        {React.createElement("input", {
          type: "date",
          defaultValue: day ?? "",
          "aria-label": t("todo.day.otherDate"),
          style,
          onChange: (e: any) => e.target.value && onDay(e.target.value),
        })}
      </View>
      <View style={{ flex: 1, gap: 6 }}>
        {label(t("todo.day.time"))}
        {React.createElement("input", {
          type: "time",
          defaultValue: time ?? "",
          "aria-label": t("todo.day.time"),
          style,
          onBlur: (e: any) => {
            const v = e.target.value || null
            if (v !== time) onTime(v)
          },
        })}
      </View>
    </View>
  )
}
