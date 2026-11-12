/**
 * Por día: day navigation, state summary, "From earlier days" (overdue, with
 * a one-tap "Today" and "Move all to today"), the ordered plan (drag the
 * handle to reorder, × takes a task off the day), and the collapsed Unplanned
 * tray (drag into the plan, or tap Today/Here). Planning goes through
 * plan-node; the day comes from get-day.
 *
 * "Completadas abajo" is the view's setting (Pablo, 31-oct night): OFF by
 * default — done tasks interleave in the plan, as always. ON: they sink to a
 * collapsed "Completed" fold at the very bottom. Both the setting and the
 * fold state persist per user; the setting lives in the ⋮ menu of the plan
 * header (a dropdown, so the header stays clean).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Modal, Platform, Pressable, ScrollView, View, type ViewStyle } from "react-native"
import { Ph } from "../../../components/ui/ds"
import { useTilingStore } from "../../../store/tilingStore"
import { mutate, useAppSlice, watchDay } from "../data/todoStore"
import { addDays, longDay, relativeDay, todayIso } from "../model/days"
import { ancestors } from "../model/tree"
import type { DayTask, NodeState } from "../model/types"
import { armHandles, clearMarks, domOf, handleRowOf, hideTip, rowOf, showTip } from "../ui/dnd"
import { Dot, FilterChip, IconBtn, Lnk, Tx } from "../ui/kit"
import { StateBar } from "../ui/StateBar"
import { tdx, web } from "../ui/todoFx"
import { useTd } from "../ui/tokens"
import { DayRow } from "./DayRow"
import { openRunnerTerminal } from "../autoplay/Terminal"
import { openConversation } from "../autoplay/Conversation"
import { usePeople } from "../data/usePeople"

interface Props {
  appId: string
  workspaceId: string | null
  windowId?: string
  phone: boolean
  narrow: boolean
  onError: (message: string) => void
}

/**
 * "Completed at the bottom" — the day view's setting (Pablo, 31-oct night):
 * OFF by default (done tasks interleave in the plan, as always — seeing them
 * mixed in is part of the motivation); ON sinks them to the collapsed
 * Completed fold at the bottom. Both the setting and the fold's open state
 * persist per user (localStorage, same pattern as the view switch).
 */
const DONE_SINK_KEY = "teros-todo-day-done-sink"
const DONE_FOLD_KEY = "teros-todo-day-done-fold"
function readFlag(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === "1"
  } catch {
    return false
  }
}
function writeFlag(key: string, on: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, on ? "1" : "0")
  } catch {}
}

export function DayView({ appId, workspaceId, windowId, phone, narrow, onError }: Props) {
  const td = useTd()
  const { t, i18n } = useTranslation()
  const locale = i18n.language || "en-US"
  const today = todayIso()
  const [day, setDay] = useState(today)
  const [trayOpen, setTrayOpen] = useState(false)
  // The setting (OFF = done interleaved, the default) and the fold's open
  // state (only meaningful while the setting is ON).
  const [doneSink, setDoneSink] = useState(() => readFlag(DONE_SINK_KEY))
  const [doneOpen, setDoneOpen] = useState(() => readFlag(DONE_FOLD_KEY))
  // The plan header's ⋮ menu (Pablo, 31-oct night #3): the setting lives in a
  // dropdown instead of a chip — the header stays clean. Anchored Modal,
  // same pattern as the board's more-actions menu.
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number; h: number } | null>(null)
  const menuBtnRef = useRef<View>(null)
  const [flash, setFlash] = useState<string | null>(null)
  // TODODEP (Option A, Pablo 2-nov): reordering the day AGAINST a dependency
  // shows a soft inline warning - never a block. { nodeId, blockerText }.
  const [depWarning, setDepWarning] = useState<{ nodeId: string; blockerText: string } | null>(null)
  const data = useAppSlice(appId, (s) => s.days[day])
  const lastOpened = useAppSlice(appId, (s) => s.lastOpened)
  const index = useAppSlice(appId, (s) => s.index)
  const { find } = usePeople(workspaceId)
  const lastClick = useRef<{ id: string; t: number } | null>(null)
  const rootRef = useRef<View>(null)

  useEffect(() => watchDay(appId, day, today), [appId, day, today])

  useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => setFlash(null), 1300)
    return () => clearTimeout(timer)
  }, [flash])

  // The dependency warning stays a few seconds - it is advice, not a flash.
  useEffect(() => {
    if (!depWarning) return
    const timer = setTimeout(() => setDepWarning(null), 4200)
    return () => clearTimeout(timer)
  }, [depWarning])

  const words = useMemo(
    () => ({ today: t("todo.day.today"), tomorrow: t("todo.day.tomorrow"), yesterday: t("todo.day.yesterday") }),
    [t],
  )
  const label = (d: string) => relativeDay(d, today, locale, words)

  // Archive (defensive): get-day already hides archived tasks (backend
  // cascade over the whole subtree), but a day snapshot cached before the
  // archive write can still carry one — the day view never shows archived
  // work, whatever it is handed.
  const notArchived = (list: DayTask[]) => list.filter((x) => !x.archived)
  const tasks = notArchived(data?.tasks ?? [])
  const overdue = day === today ? notArchived(data?.overdue ?? []) : []
  const unplanned = notArchived(data?.unplanned ?? [])
  // Setting OFF (default): done tasks interleave in the plan, as always.
  // Setting ON: the plan lists only OPEN tasks (in their dayOrder) and done
  // tasks sink to the collapsed Completed fold at the bottom. `tasks` stays
  // the full backend list — the drag/keyboard index math below maps through
  // it to plan-node's dayOrder coordinates either way.
  const active = useMemo(() => (doneSink ? tasks.filter((x) => x.state !== "done") : tasks), [tasks, doneSink])
  const doneTasks = useMemo(() => (doneSink ? tasks.filter((x) => x.state === "done") : []), [tasks, doneSink])
  const counts = useMemo(() => {
    const c: Record<NodeState, number> = { planning: 0, pending: 0, working: 0, blocked: 0, review: 0, done: 0, cancelled: 0 }
    for (const x of tasks) c[x.state]++
    return c
  }, [tasks])

  const fail = useCallback((err: unknown) => onError(err instanceof Error ? err.message : String(err)), [onError])

  const open = useCallback(
    (id: string) => {
      const now = Date.now()
      const dbl = lastClick.current?.id === id && now - lastClick.current.t < 420
      lastClick.current = { id, t: now }
      useTilingStore
        .getState()
        .openWindow(
          "todo-node",
          { workspaceId: workspaceId ?? undefined, appId, nodeId: id },
          { preview: true, pin: dbl, sourceWindowId: windowId },
        )
    },
    [appId, workspaceId, windowId],
  )

  const openChat = useCallback((channelId: string) => openConversation(channelId, windowId), [windowId])
  // CCR-REQ-8: the runner terminal bubble — the backend reveals (or recreates
  // with --resume) the session; the Terminal window shows it. A failure
  // surfaces through the window's error toast (fail), never a silent console
  // warning — the click must never look dead.
  const openTerminal = useCallback(
    (nodeId: string) => void openRunnerTerminal(appId, workspaceId, nodeId, fail),
    [appId, workspaceId, fail],
  )

  // TODODEP (Option A): does placing `id` at `index` of day `d` put it BEFORE
  // (above) one of its unresolved blockers in that day's plan? A soft inline
  // warning - the reorder itself always goes through (never a block).
  const depWarningFor = useCallback(
    (id: string, d: string | null, index?: number): { nodeId: string; blockerText: string } | null => {
      if (d === null || index === undefined) return null
      const task = tasks.find((x) => x.nodeId === id)
      if (!task?.dependencies?.length) return null
      const others = tasks.filter((x) => x.nodeId !== id)
      // The plan AFTER the move, in dayOrder coordinates (plan-node renumbers
      // around the insert - the same math onDrop uses).
      const after = [...others]
      after.splice(Math.min(index, others.length), 0, task)
      const posOf = (nodeId: string) => after.findIndex((x) => x.nodeId === nodeId)
      const myPos = posOf(id)
      const pending = (task.blockers ?? []).filter(
        (b) => b.state !== "done" && b.state !== "cancelled" && posOf(b.nodeId) >= 0,
      )
      const above = pending.find((b) => posOf(b.nodeId) > myPos)
      return above ? { nodeId: id, blockerText: above.text } : null
    },
    [tasks],
  )

  const plan = useCallback(
    (id: string, d: string | null, index?: number) => {
      setFlash(id)
      const warn = depWarningFor(id, d, index)
      if (warn) setDepWarning(warn)
      mutate(appId, "plan-node", { nodeId: id, day: d, ...(index !== undefined ? { index } : {}) }).catch(fail)
    },
    [appId, fail, depWarningFor],
  )

  const planAllToday = useCallback(async () => {
    for (const x of overdue) {
      try {
        await mutate(appId, "plan-node", { nodeId: x.nodeId, day: today })
      } catch (err) {
        fail(err)
        return
      }
    }
  }, [appId, fail, overdue, today])

  // ─── Web drag: reorder the plan, drop from the tray / earlier days ──────
  const pin = useCallback(
    (id: string) =>
      useTilingStore
        .getState()
        .openWindow(
          "todo-node",
          { workspaceId: workspaceId ?? undefined, appId, nodeId: id },
          { preview: true, pin: true, sourceWindowId: windowId },
        ),
    [appId, workspaceId, windowId],
  )
  const latest = useRef({ tasks, plan, day, label, t, pin, doneSink })
  latest.current = { tasks, plan, day, label, t, pin, doneSink }

  useEffect(() => {
    const root = domOf(rootRef)
    if (root) armHandles(root)
  })

  useEffect(() => {
    if (Platform.OS !== "web") return
    const root = domOf(rootRef)
    if (!root) return
    let drag: { id: string; target?: string | null; zone?: "before" | "after" } | null = null
    const list = () => root.querySelector<HTMLElement>('[data-tdx~="dlist"]')
    const onStart = (e: DragEvent) => {
      const row = handleRowOf(e.target)
      if (!row) {
        e.preventDefault()
        return
      }
      drag = { id: row.dataset.tdid! }
      row.setAttribute("data-dragging", "1")
      try {
        e.dataTransfer?.setDragImage(row, 24, 16)
        e.dataTransfer?.setData("text/plain", drag.id)
      } catch {}
    }
    const onOver = (e: DragEvent) => {
      if (!drag) return
      const { t: tt, label: lb, day: d, tasks: ts } = latest.current
      root.querySelectorAll("[data-dz]").forEach((r) => r.removeAttribute("data-dz"))
      list()?.removeAttribute("data-over")
      const row = rowOf(e.target)
      const inList = row && row.closest('[data-tdx~="dlist"]')
      if (row && inList) {
        if (row.dataset.tdid === drag.id) {
          hideTip()
          return
        }
        const r = row.getBoundingClientRect()
        const zone = e.clientY < r.top + r.height / 2 ? "before" : "after"
        e.preventDefault()
        row.setAttribute("data-dz", zone === "before" ? "b" : "a")
        drag.target = row.dataset.tdid!
        drag.zone = zone
        const title = ts.find((x) => x.nodeId === drag!.target)?.text ?? ""
        showTip(tt(`todo.drop.${zone}`, { title }), e.clientX, e.clientY)
      } else if (e.target instanceof Element && e.target.closest('[data-tdx~="dlist"]')) {
        e.preventDefault()
        list()?.setAttribute("data-over", "1")
        drag.target = null
        drag.zone = undefined
        showTip(tt("todo.drop.endOf", { day: lb(d).toLowerCase() }), e.clientX, e.clientY)
      } else {
        drag.target = undefined
        hideTip()
      }
    }
    const end = () => {
      drag = null
      clearMarks(root)
      hideTip()
    }
    const onDrop = (e: DragEvent) => {
      if (!drag || drag.target === undefined) return end()
      e.preventDefault()
      const { tasks: ts, plan: pl, day: d } = latest.current
      const id = drag.id
      const others = ts.filter((x) => x.nodeId !== id)
      let index = others.length
      if (drag.target) {
        const k = others.findIndex((x) => x.nodeId === drag!.target)
        if (k >= 0) index = k + (drag.zone === "after" ? 1 : 0)
      }
      end()
      pl(id, d, index)
    }
    const onKey = (e: KeyboardEvent) => {
      const row = rowOf(e.target)
      if (!row || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return
      if (!row.closest('[data-tdx~="dlist"]')) return
      e.preventDefault()
      const { tasks: ts, plan: pl, day: d, doneSink: sink } = latest.current
      const id = row.dataset.tdid!
      // The rows in the list: all tasks with the setting OFF, only open ones
      // with it ON. The move lands at the neighbor's FULL-list (dayOrder)
      // slot — done tasks between keep theirs, and plan-node renumbers around
      // the insert.
      const list = sink ? ts.filter((x) => x.state !== "done") : ts
      const k = list.findIndex((x) => x.nodeId === id)
      if (k < 0) return
      const j = k + (e.key === "ArrowUp" ? -1 : 1)
      if (j < 0 || j >= list.length) return
      const at = ts.findIndex((x) => x.nodeId === list[j].nodeId)
      if (at < 0) return
      pl(id, d, at)
      requestAnimationFrame(() => root.querySelector<HTMLElement>(`[data-tdid="${CSS.escape(id)}"]`)?.focus())
    }
    const onMouseDown = (e: MouseEvent) => {
      if (e.detail > 1 && rowOf(e.target)) e.preventDefault()
    }
    root.addEventListener("mousedown", onMouseDown)
    // Pin on the browser's dblclick: robust even when the first click re-mounts this view.
    const onDblClick = (e: MouseEvent) => {
      const row = rowOf(e.target)
      if (!row || (e.target instanceof Element && e.target.closest('[role="button"]') !== row && e.target.closest('[role="button"]'))) return
      const id = row.dataset.tdid
      if (id) latest.current.pin(id)
    }
    root.addEventListener("dblclick", onDblClick)
    root.addEventListener("dragstart", onStart)
    root.addEventListener("dragover", onOver)
    root.addEventListener("drop", onDrop)
    root.addEventListener("dragend", end)
    root.addEventListener("keydown", onKey)
    return () => {
      root.removeEventListener("mousedown", onMouseDown)
      root.removeEventListener("dblclick", onDblClick)
      root.removeEventListener("dragstart", onStart)
      root.removeEventListener("dragover", onOver)
      root.removeEventListener("drop", onDrop)
      root.removeEventListener("dragend", end)
      root.removeEventListener("keydown", onKey)
    }
  }, [])

  // The last two GROUP ancestors ("Teros › Lanzamiento"); the path as a fallback.
  // Spotlight: while the selected row is on screen, the other titles dim.
  const selVisible =
    !!lastOpened &&
    (active.some((x) => x.nodeId === lastOpened) ||
      (doneSink && doneOpen && doneTasks.some((x) => x.nodeId === lastOpened)) ||
      overdue.some((x) => x.nodeId === lastOpened) ||
      (trayOpen && unplanned.some((x) => x.nodeId === lastOpened)))
  const crumb = (x: DayTask) => {
    if (index.byId.has(x.nodeId)) {
      const groups = ancestors(index, x.nodeId).filter((a) => a.kind === "group")
      return groups.slice(-2).map((g) => g.text).join(" › ")
    }
    return x.path.slice(-2).join(" › ")
  }

  return (
    <View ref={rootRef} style={{ flex: 1, minHeight: 0, paddingLeft: 10, paddingRight: 8 }}>
      {/* Day navigation */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: 4, paddingRight: 2, paddingBottom: 8, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", flex: 1, minWidth: 0, marginRight: "auto" }}>
          <Tx f="serif" s={24} lh={28} c={td.text} lines={1} style={{ flexShrink: 0 }}>
            {label(day)}
          </Tx>
          {!narrow ? (
            <Tx f="mono" s={10.5} lh={14} c={td.txs} ls={0.2} lines={1} style={{ marginLeft: 10, flexShrink: 1 }}>
              {longDay(day, locale)}
            </Tx>
          ) : null}
        </View>
        <IconBtn icon="caret-left" label={t("todo.day.prev")} size={30} iconSize={14} onPress={() => setDay(addDays(day, -1))} />
        <FilterChip height={28} on={day === today} onPress={() => setDay(today)} label={t("todo.day.today")} />
        <FilterChip height={28} on={day === addDays(today, 1)} onPress={() => setDay(addDays(today, 1))} label={t("todo.day.tomorrow")} />
        <IconBtn icon="caret-right" label={t("todo.day.next")} size={30} iconSize={14} onPress={() => setDay(addDays(day, 1))} />
      </View>

      {tasks.length > 0 ? (
        <View style={{ gap: 8, paddingHorizontal: 6, paddingTop: 2, paddingBottom: 6 }}>
          <StateBar counts={counts} tasks={tasks} />
        </View>
      ) : null}

      <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: 2, paddingBottom: 14 }} {...tdx("scroll")}>
        {overdue.length > 0 ? (
          <View style={{ backgroundColor: td.step, borderRadius: 14, paddingHorizontal: 4, paddingBottom: 4, marginTop: 2, marginBottom: 4 }}>
            <SectionHead
              first
              dot="pending"
              label={t("todo.day.fromEarlier")}
              count={String(overdue.length)}
              right={<Lnk onPress={planAllToday}>{t("todo.day.moveAllToday")}</Lnk>}
            />
            {overdue.map((x) => (
              <DayRow
                key={x.nodeId}
                task={x}
                assignee={find(x.assignee)}
                kind="late"
                right={x.plannedFor ? label(x.plannedFor).toLowerCase() : ""}
                actionLabel={t("todo.day.today")}
                selected={lastOpened === x.nodeId}
                dimmed={selVisible && lastOpened !== x.nodeId}
                flashing={flash === x.nodeId}
                phone={phone}
                onPress={open}
                onAction={() => plan(x.nodeId, today)}
                onOpenConversation={openChat}
                onOpenTerminal={openTerminal}
              />
            ))}
          </View>
        ) : null}

        <SectionHead
          label={t("todo.day.plan")}
          count={`${counts.done}/${tasks.length}`}
          right={
            <>
              <Tx f="mono" s={10} lh={12} c={td.txs}>
                {t("todo.day.dragToOrder")}
              </Tx>
              {/* The view's settings live behind ⋮ (Pablo, 31-oct night #3) —
                  the header stays clean; the menu carries "Completadas
                  abajo". */}
              <View ref={menuBtnRef} collapsable={false}>
                <IconBtn
                  icon="dots-three-vertical"
                  label={t("todo.day.viewMenu")}
                  size={24}
                  iconSize={13}
                  onPress={() => {
                    setMenuOpen(true)
                    const el = menuBtnRef.current as unknown as { measure?: (cb: (fx: number, fy: number, w: number, h: number, px: number, py: number) => void) => void } | null
                    if (el?.measure) {
                      el.measure((_fx, _fy, _w, h, px, py) => {
                        setMenuAnchor({ x: px, y: py, h })
                      })
                    }
                  }}
                />
              </View>
            </>
          }
        />
        {/* TODODEP: the soft reorder warning - advice, never a block. */}
        {depWarning ? (
          <View
            testID="todo-dep-reorder-warning"
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 7,
              borderRadius: 10,
              paddingHorizontal: 10,
              paddingVertical: 7,
              marginBottom: 6,
              backgroundColor: "rgba(249,115,22,0.12)",
            }}
          >
            <Ph name="warning" size={13} color="#F97316" />
            <Tx s={12} lh={16} c={td.text} style={{ flexShrink: 1 }}>
              {t("todo.dep.reorderWarning", { blocker: depWarning.blockerText })}
            </Tx>
          </View>
        ) : null}
        <View
          {...tdx("dlist")}
          {...({ role: "list", "aria-label": t("todo.a11y.dayPlan") } as Record<string, unknown>)}
          style={{ borderRadius: 12, minHeight: 40 }}
        >
          {active.length ? (
            active.map((x) => (
              <DayRow
                key={x.nodeId}
                task={x}
                assignee={find(x.assignee)}
                kind="day"
                time={x.plannedTime}
                right={crumb(x)}
                frozen={doneSink && x.state === "done"}
                selected={lastOpened === x.nodeId}
                dimmed={selVisible && lastOpened !== x.nodeId}
                flashing={flash === x.nodeId}
                phone={phone}
                hideCrumb={narrow}
                onPress={open}
                onAction={() => plan(x.nodeId, null)}
                onOpenConversation={openChat}
                onOpenTerminal={openTerminal}
                actionLabel={t("todo.day.removeFromDay")}
              />
            ))
          ) : doneSink && doneTasks.length ? (
            // Everything planned is already done: keep the plan's empty slot
            // honest instead of pretending the day is empty.
            <View style={[{ borderRadius: 14, padding: 20, margin: 2, alignItems: "center" }, web({ border: `1.5px dashed ${td.borderStrong}` }) as ViewStyle]}>
              <Tx s={12.5} lh={18} c={td.txs} style={{ textAlign: "center" }}>
                {t("todo.day.allDone")}
              </Tx>
            </View>
          ) : (
            <View style={[{ borderRadius: 14, padding: 20, margin: 2, alignItems: "center" }, web({ border: `1.5px dashed ${td.borderStrong}` }) as ViewStyle]}>
              <Tx s={12.5} lh={18} c={td.txs} style={{ textAlign: "center" }}>
                {`${t("todo.day.nothingPlanned", { day: label(day).toLowerCase() })}\n${t("todo.day.nothingPlannedHint")}`}
              </Tx>
            </View>
          )}
        </View>

        <Fold
          open={trayOpen}
          onToggle={() => setTrayOpen((v) => !v)}
          label={t("todo.day.unplanned")}
          summary={t("todo.day.unplannedSummary", { count: unplanned.length })}
        >
          {unplanned.length ? (
            unplanned.map((x) => (
              <DayRow
                key={x.nodeId}
                task={x}
                assignee={find(x.assignee)}
                kind="tray"
                right={crumb(x)}
                hideCrumb={narrow}
                actionLabel={day === today ? t("todo.day.today") : t("todo.day.here")}
                selected={lastOpened === x.nodeId}
                dimmed={selVisible && lastOpened !== x.nodeId}
                flashing={flash === x.nodeId}
                phone={phone}
                onPress={open}
                onAction={() => plan(x.nodeId, day)}
                onOpenConversation={openChat}
                onOpenTerminal={openTerminal}
              />
            ))
          ) : (
            <View style={[{ borderRadius: 14, padding: 20, margin: 2, alignItems: "center" }, web({ border: `1.5px dashed ${td.borderStrong}` }) as ViewStyle]}>
              <Tx s={12.5} lh={18} c={td.txs}>
                {t("todo.day.allPlanned")}
              </Tx>
            </View>
          )}
        </Fold>

        {/* Completed — only with the setting ON; always last, collapsed by
            default: done tasks never mix with the open plan while it is on. */}
        {doneSink && doneTasks.length > 0 ? (
          <Fold
            open={doneOpen}
            onToggle={() =>
              setDoneOpen((v) => {
                writeFlag(DONE_FOLD_KEY, !v)
                return !v
              })
            }
            label={t("todo.day.completed")}
            summary={t("todo.day.completedSummary", { count: doneTasks.length })}
          >
            {doneTasks.map((x) => (
              <DayRow
                key={x.nodeId}
                task={x}
                assignee={find(x.assignee)}
                kind="day"
                time={x.plannedTime}
                right={crumb(x)}
                frozen
                selected={lastOpened === x.nodeId}
                dimmed={selVisible && lastOpened !== x.nodeId}
                flashing={flash === x.nodeId}
                phone={phone}
                hideCrumb={narrow}
                onPress={open}
                onAction={() => plan(x.nodeId, null)}
                onOpenConversation={openChat}
                onOpenTerminal={openTerminal}
                actionLabel={t("todo.day.removeFromDay")}
              />
            ))}
          </Fold>
        ) : null}

        {/* Plan view settings (⋮ in the plan header). Anchored Modal, same
            pattern as the board's more-actions menu. The row toggles the
            setting and stays open — the check shows the state live, and a
            second tap un-marks it (Pablo, 31-oct night #3). */}
        <Modal
          visible={menuOpen}
          transparent
          animationType="none"
          onRequestClose={() => setMenuOpen(false)}
        >
          <Pressable style={{ flex: 1 }} testID="day-view-menu-backdrop" onPress={() => setMenuOpen(false)}>
            <View
              testID="day-view-menu"
              style={[
                {
                  position: "absolute",
                  top: menuAnchor ? menuAnchor.y + menuAnchor.h + 6 : 60,
                  right: 14,
                  backgroundColor: td.step,
                  borderRadius: 12,
                  padding: 6,
                  minWidth: 220,
                },
                Platform.OS === "web" ? ({ boxShadow: td.elevRaised } as ViewStyle) : { elevation: 20 },
              ]}
            >
              <Pressable
                testID="day-view-menu-done-sink"
                accessibilityRole="menuitem"
                accessibilityState={{ checked: doneSink }}
                onPress={() =>
                  setDoneSink((v) => {
                    writeFlag(DONE_SINK_KEY, !v)
                    return !v
                  })
                }
                style={({ pressed, hovered }: any) => [
                  {
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingHorizontal: 10,
                    paddingVertical: 8,
                    borderRadius: 8,
                    backgroundColor: pressed || hovered ? td.wash2 : "transparent",
                  },
                  web({ cursor: "pointer" }) as ViewStyle,
                ]}
              >
                <Tx s={13} lh={16} c={td.text}>
                  {t("todo.day.doneSink")}
                </Tx>
                <View style={{ marginLeft: "auto" }} testID="day-view-menu-check-slot">
                  {doneSink ? (
                    <View testID="day-view-menu-check">
                      <Ph name="check" size={14} color={td.accent} />
                    </View>
                  ) : null}
                </View>
              </Pressable>
            </View>
          </Pressable>
        </Modal>
      </ScrollView>
    </View>
  )
}

function SectionHead({
  label,
  count,
  right,
  dot,
  first,
}: {
  label: string
  count?: string
  right?: React.ReactNode
  dot?: NodeState
  first?: boolean
}) {
  const td = useTd()
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: first ? 8 : 14, paddingHorizontal: 6, paddingBottom: 6, minHeight: 36 }}>
      {dot ? <Dot state={dot} /> : null}
      <Tx s={10} lh={12} c={td.txs} ls={1.6} upper>
        {label}
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

function Fold({
  open,
  onToggle,
  label,
  summary,
  children,
}: {
  open: boolean
  onToggle: () => void
  label: string
  summary: string
  children: React.ReactNode
}) {
  const td = useTd()
  return (
    <View style={{ borderRadius: 14, backgroundColor: td.step, marginTop: 10 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={[{ flexDirection: "row", alignItems: "center", gap: 8, height: 40, paddingHorizontal: 12, borderRadius: 14 }, web({ cursor: "pointer" }) as ViewStyle]}
      >
        {({ hovered }: any) => (
          <>
            <View style={web({ transform: open ? "rotate(90deg)" : "none", transition: "transform .2s cubic-bezier(.16,1,.3,1)" }) as ViewStyle}>
              <Ph name="caret-right" size={10} color={td.text3} />
            </View>
            <Tx s={10} lh={12} c={hovered ? td.text2 : td.txs} ls={1.6} upper>
              {label}
            </Tx>
            <Tx f="mono" s={10} lh={12} c={td.txs} ls={0.3} style={{ marginLeft: "auto" }}>
              {summary}
            </Tx>
          </>
        )}
      </Pressable>
      {open ? <View style={{ paddingHorizontal: 4, paddingBottom: 6 }}>{children}</View> : null}
    </View>
  )
}

