/**
 * Árbol: search, filter chips, focus header, rows and the hint footer.
 *
 * - Click opens the node in the detail window as a preview tab; double-click
 *   pins it (docs/specs/ui/preview-tabs.md).
 * - Drag only from the handle: top/bottom third reorders, centre nests;
 *   invalid targets are refused with the tooltip. Alt+↑/↓/←/→ do the same.
 * - Keyboard (F1): ↑/↓ move, ←/→ fold, Enter opens, F focus, Delete deletes
 *   (in-app confirm, F6), Esc leaves focus/search, "/" searches.
 * - ARIA tree roles (F8) and per-row names (F7).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, ScrollView, TextInput, View, type ViewStyle } from "react-native"
import { Ph } from "../../../components/ui/ds"
import { useTilingStore } from "../../../store/tilingStore"
import { mutate, patchNode, pingNode, requestTitleEdit, setAutoArchiveDays, useAppSlice } from "../data/todoStore"
import {
  addTarget,
  ancestors,
  canDrop,
  countStates,
  descendants,
  finishedRows,
  groupTarget,
  isFinished,
  isTask,
  keyboardMove,
  kidsOf,
  moveTarget,
  type DropZone,
  type TreeFilter,
  visibleRows,
} from "../model/tree"
import type { TreeNode } from "../model/types"
import { armHandles, clearMarks, domOf, handleRowOf, hideTip, rowOf, showTip } from "../ui/dnd"
import { AddMenu, Btn, EmptyBlock, FilterChip, MenuBox, MenuHead, MenuItem, MenuSep, Tx, useDismiss } from "../ui/kit"
import { usePeople } from "../data/usePeople"
import { ConfirmDelete } from "../ui/ConfirmDelete"
import { tdx, web } from "../ui/todoFx"
import { F, useTd } from "../ui/tokens"
import { TreeRow, type RowCounts } from "./TreeRow"
import { openConversation } from "../autoplay/Conversation"
import { openRunnerTerminal } from "../autoplay/Terminal"

// ─── Tree settings (per app, localStorage) ─────────────────────────────

export interface TreeSettings {
  /** Hide done/cancelled from the tree body (they move to the Finished section). */
  hideFinished: boolean
  /** Show archived nodes dimmed with the archive badge. */
  showArchived: boolean
  /** Auto-archive finished tasks older than N days (0 = off). */
  autoArchiveDays: number
}

const SETTINGS_KEY = "teros-todo-tree-settings"
const DEFAULT_SETTINGS: TreeSettings = { hideFinished: false, showArchived: false, autoArchiveDays: 0 }

function readSettings(appId: string): TreeSettings {
  try {
    const raw = globalThis.localStorage?.getItem(`${SETTINGS_KEY}:${appId}`)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const p = JSON.parse(raw) as Partial<TreeSettings>
    return {
      hideFinished: p.hideFinished === true,
      showArchived: p.showArchived === true,
      autoArchiveDays: typeof p.autoArchiveDays === "number" && p.autoArchiveDays > 0 ? p.autoArchiveDays : 0,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function writeSettings(appId: string, s: TreeSettings): void {
  try {
    globalThis.localStorage?.setItem(`${SETTINGS_KEY}:${appId}`, JSON.stringify(s))
  } catch {}
}

/**
 * Per-window UI memory. Opening the first preview turns the tree's pane into a
 * split, which re-mounts it (tiling shell); search, filter, focus mode and the
 * row to re-focus survive through this map.
 */
const uiMemory = new Map<
  string,
  { query: string; filter: TreeFilter; focusId: string | null; refocus: string | null; lastClick: { id: string; t: number } | null }
>()

interface Props {
  appId: string
  workspaceId: string | null
  windowId?: string
  /** Focus captured by a pin of this window (NAV-REQ-20); the per-window memory wins once it exists. */
  initialFocusId?: string | null
  phone: boolean
  narrow: boolean
  onError: (message: string) => void
}

export function TreeView({ appId, workspaceId, windowId, initialFocusId, phone, narrow, onError }: Props) {
  const td = useTd()
  const { t } = useTranslation()
  const nodes = useAppSlice(appId, (s) => s.nodes)
  const index = useAppSlice(appId, (s) => s.index)
  const lastOpened = useAppSlice(appId, (s) => s.lastOpened)
  const focusRequest = useAppSlice(appId, (s) => s.focusRequest)

  const memKey = `${windowId ?? ""}:${appId}`
  const mem = uiMemory.get(memKey)
  const [query, setQuery] = useState(mem?.query ?? "")
  const [filter, setFilter] = useState<TreeFilter>(mem?.filter ?? "all")
  const [focusId, setFocusId] = useState<string | null>(mem?.focusId ?? initialFocusId ?? null)
  // The window's props carry the focus so a pin of this tab captures it (NAV-REQ-20).
  useEffect(() => {
    if (windowId) useTilingStore.getState().updateWindowProps(windowId, { focusId: focusId ?? undefined })
  }, [windowId, focusId])
  const [selectedId, setSelectedId] = useState<string | null>(lastOpened)
  /** Click feedback for the row last clicked (the handle beats; strong when it was already open). */
  const [beat, setBeat] = useState<{ id: string; n: number; strong: boolean } | null>(null)
  useEffect(() => {
    const cur = uiMemory.get(memKey)
    uiMemory.set(memKey, { query, filter, focusId, refocus: cur?.refocus ?? null, lastClick: cur?.lastClick ?? null })
  }, [memKey, query, filter, focusId])
  // Tree settings zone (gear in the header): persisted per app in localStorage.
  const [settings, setSettings] = useState<TreeSettings>(() => readSettings(appId))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsBtnRef = useRef<View>(null)
  const settingsMenuRef = useRef<View>(null)
  useDismiss(settingsOpen, () => setSettingsOpen(false), settingsBtnRef, settingsMenuRef)
  const changeSettings = useCallback(
    (partial: Partial<TreeSettings>) => {
      setSettings((cur) => {
        const next = { ...cur, ...partial }
        writeSettings(appId, next)
        if (partial.autoArchiveDays !== undefined) setAutoArchiveDays(appId, next.autoArchiveDays)
        return next
      })
    },
    [appId],
  )
  // Arm the auto-archive horizon of this app as soon as the tree mounts.
  useEffect(() => {
    if (settings.autoArchiveDays > 0) setAutoArchiveDays(appId, settings.autoArchiveDays)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId])

  const [adding, setAdding] = useState<string | null>(null) // parent id, "" = root
  const [draft, setDraft] = useState("")
  const [cele, setCele] = useState<Set<string>>(new Set())
  const [flash, setFlash] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<TreeNode | null>(null)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  // "+" menu: the node it was opened on, "" for the search-row "+", null closed.
  const [addMenuFor, setAddMenuFor] = useState<string | null>(null)
  const rowsRef = useRef<View>(null)
  const searchRef = useRef<TextInput>(null)
  const lastClick = useRef<{ id: string; t: number } | null>(null)

  // The detail window tells which node it shows; the tree follows.
  useEffect(() => {
    if (lastOpened) setSelectedId(lastOpened)
  }, [lastOpened])

  // Focus requests from the detail window's eye.
  const seenFocus = useRef(focusRequest.n)
  useEffect(() => {
    if (focusRequest.n === seenFocus.current) return
    seenFocus.current = focusRequest.n
    setFocusId((cur) => (cur === focusRequest.id ? null : focusRequest.id))
  }, [focusRequest])

  // Celebrate tasks that just became done (crisp fill + mint sweep).
  const prevStates = useRef<Map<string, string | null> | null>(null)
  useEffect(() => {
    const prev = prevStates.current
    const next = new Map(nodes.map((n) => [n.nodeId, n.state] as const))
    prevStates.current = next
    if (!prev) return
    const fresh = nodes.filter((n) => n.state === "done" && prev.has(n.nodeId) && prev.get(n.nodeId) !== "done")
    if (fresh.length === 0) return
    setCele((s) => new Set([...s, ...fresh.map((n) => n.nodeId)]))
    const timer = setTimeout(() => {
      setCele((s) => {
        const c = new Set(s)
        for (const n of fresh) c.delete(n.nodeId)
        return c
      })
    }, 1500)
    return () => clearTimeout(timer)
  }, [nodes])

  useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => setFlash(null), 1300)
    return () => clearTimeout(timer)
  }, [flash])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (focusId && !index.byId.has(focusId)) setFocusId(null)
  }, [focusId, index])

  const { me, find } = usePeople(workspaceId)
  const rows = useMemo(
    () =>
      visibleRows(index, {
        query,
        filter,
        focusId,
        me,
        hideFinished: settings.hideFinished,
        showArchived: settings.showArchived,
        collapsed: (n) => n.collapsed && adding !== n.nodeId,
      }),
    [index, query, filter, focusId, adding, me, settings.hideFinished, settings.showArchived],
  )
  // Finished section (Byday pattern): when "Hide finished" is on, the
  // done/cancelled tasks that left the body gather here, pinned at the bottom.
  const finished = useMemo(
    () => (settings.hideFinished ? finishedRows(index, { query, focusId, collapsed: (n) => n.collapsed }) : []),
    [settings.hideFinished, index, query, focusId],
  )
  const [finishedOpen, setFinishedOpen] = useState(false)
  const mineCount = useMemo(
    () => (me ? nodes.filter((n) => isTask(n) && n.state !== "done" && n.assignee?.kind === "user" && n.assignee.id === me).length : 0),
    [nodes, me],
  )

  const tasks = useMemo(() => nodes.filter(isTask), [nodes])
  const stateCounts = useMemo(() => countStates(tasks), [tasks])

  const counts = useMemo(() => {
    const out = new Map<string, RowCounts>()
    for (const r of rows) {
      const n = r.node
      const desc = descendants(index, n.nodeId).filter(isTask)
      const blocked = desc.filter((d) => d.state === "blocked").length
      const review = desc.filter((d) => d.state === "review").length
      let right: string | null = null
      if (!isTask(n)) {
        const open = desc.filter((d) => d.state !== "done").length
        right = open ? String(open) : null
      } else {
        const kids = kidsOf(index, n.nodeId).filter(isTask)
        right = kids.length ? `${kids.filter((k) => k.state === "done").length}/${kids.length}` : null
      }
      out.set(n.nodeId, { blocked, review, right })
    }
    return out
  }, [rows, index])

  // ─── Actions ────────────────────────────────────────────────────────────

  const fail = useCallback((err: unknown) => onError(err instanceof Error ? err.message : String(err)), [onError])

  const openNode = useCallback(
    (id: string, pin: boolean) => {
      setSelectedId(id)
      useTilingStore
        .getState()
        .openWindow(
          "todo-node",
          { workspaceId: workspaceId ?? undefined, appId, nodeId: id },
          { preview: true, pin, sourceWindowId: windowId },
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

  const onRowPress = useCallback(
    (id: string) => {
      const now = Date.now()
      // The click timer lives in uiMemory: the first open may re-mount this view.
      const mem0 = uiMemory.get(memKey)
      const prev = mem0?.lastClick ?? lastClick.current
      const dbl = prev?.id === id && now - prev.t < 420
      lastClick.current = { id, t: now }
      if (mem0) mem0.lastClick = { id, t: now }
      // Keep the keyboard on the tree: arrows / Enter / Alt+arrows act on the
      // clicked row (re-focused after a possible re-mount, see uiMemory).
      const cur = uiMemory.get(memKey)
      if (cur) cur.refocus = id
      // Feedback: the handle beats; clicking the node already open beats harder
      // and pings its detail window ("you already have it here").
      const again = id === selectedId
      setBeat((b) => ({ id, n: (b?.n ?? 0) + 1, strong: again }))
      if (again) pingNode(appId, id)
      openNode(id, dbl)
      if (Platform.OS === "web") {
        requestAnimationFrame(() => {
          const root = domOf(rowsRef)
          root?.querySelector<HTMLElement>(`[data-tdid="${CSS.escape(id)}"]`)?.focus({ preventScroll: true })
        })
      }
    },
    [openNode, memKey, selectedId, appId],
  )

  const onToggle = useCallback(
    (id: string) => {
      const n = index.byId.get(id)
      if (!n) return
      patchNode(appId, id, { collapsed: !n.collapsed })
      mutate(appId, "toggle-collapse", { nodeId: id }).catch(fail)
    },
    [appId, index, fail],
  )

  const onFocus = useCallback((id: string) => {
    setFocusId((cur) => (cur === id ? null : id))
    setSelectedId(id)
  }, [])

  const startAdd = useCallback(
    (parentId: string | null) => {
      setAdding(parentId ?? "")
      setDraft("")
      if (parentId) {
        const n = index.byId.get(parentId)
        if (n?.collapsed) {
          patchNode(appId, parentId, { collapsed: false })
          mutate(appId, "toggle-collapse", { nodeId: parentId }).catch(() => {})
        }
      }
    },
    [appId, index],
  )

  const commitAdd = useCallback(
    async (kind: "task" | "group" = "task") => {
      const text = draft.trim()
      const parentId = adding || null
      setAdding(null)
      setDraft("")
      if (!text) return
      try {
        const res = await mutate<{ node: { nodeId: string } }>(appId, "add-node", {
          parentId,
          text,
          kind,
          ...(kind === "task" ? { state: "planning" } : {}),
        })
        setFlash(res.node.nodeId)
        openNode(res.node.nodeId, false)
      } catch (err) {
        fail(err)
      }
    },
    [adding, appId, draft, fail, openNode],
  )

  /** New group under `target` (climbing out of tasks), opened with its title in edit mode. */
  const addGroup = useCallback(
    async (target: string | null) => {
      setAddMenuFor(null)
      try {
        const parentId = groupTarget(index, target)
        if (parentId) {
          const p = index.byId.get(parentId)
          if (p?.collapsed) {
            patchNode(appId, parentId, { collapsed: false })
            mutate(appId, "toggle-collapse", { nodeId: parentId }).catch(() => {})
          }
        }
        const res = await mutate<{ node: { nodeId: string } }>(appId, "add-node", {
          parentId,
          text: t("todo.add.newGroup"),
          kind: "group",
        })
        setFlash(res.node.nodeId)
        requestTitleEdit(appId, res.node.nodeId)
        openNode(res.node.nodeId, false)
      } catch (err) {
        fail(err)
      }
    },
    [appId, fail, index, openNode, t],
  )
  const addGroupAtRoot = useCallback(() => addGroup(null), [addGroup])

  /** Row "+": a group offers New task / New group; a task adds a child task directly. */
  const onRowAdd = useCallback(
    (id: string) => {
      const n = index.byId.get(id)
      if (n && n.kind === "group") setAddMenuFor((cur) => (cur === id ? null : id))
      else startAdd(id)
    },
    [index, startAdd],
  )

  const addMenuLabels = { task: t("todo.add.menuTask"), group: t("todo.add.menuGroup"), menu: t("todo.newTask") }
  const menuFor = (target: string | null) => (
    <AddMenu
      labels={addMenuLabels}
      onClose={() => setAddMenuFor(null)}
      onTask={() => {
        setAddMenuFor(null)
        startAdd(target)
      }}
      onGroup={() => addGroup(target)}
    />
  )

  const move = useCallback(
    (dragId: string, targetId: string, zone: DropZone) => {
      if (!canDrop(index, dragId, targetId, zone).ok) return
      const { newParentId, newPosition } = moveTarget(index, dragId, targetId, zone)
      setFlash(dragId)
      mutate(appId, "move-node", { nodeId: dragId, newParentId, newPosition }).catch(fail)
      if (zone === "inside") {
        const tn = index.byId.get(targetId)
        if (tn?.collapsed) {
          patchNode(appId, targetId, { collapsed: false })
          mutate(appId, "toggle-collapse", { nodeId: targetId }).catch(() => {})
        }
      }
    },
    [appId, index, fail],
  )

  const doDelete = useCallback(
    async (n: TreeNode) => {
      setConfirm(null)
      try {
        await mutate(appId, "delete-node", { nodeId: n.nodeId })
        if (selectedId === n.nodeId) setSelectedId(null)
      } catch (err) {
        fail(err)
      }
    },
    [appId, fail, selectedId],
  )

  // ─── Archive (settings zone) ──────────────────────────────────────────

  const onArchive = useCallback(
    (id: string, archived: boolean) => {
      mutate(appId, "set-archived", { nodeId: id, archived }).catch(fail)
    },
    [appId, fail],
  )

  /** Archive finished: in-app confirm (same pattern as delete, F6), then a toast with the count. */
  const doArchiveFinished = useCallback(async () => {
    setConfirmArchive(false)
    try {
      const res = await mutate<{ archived: number; skipped: number }>(appId, "archive-finished", {})
      if (res.archived > 0) setToast(t("todo.archive.done", { count: res.archived }))
    } catch (err) {
      fail(err)
    }
  }, [appId, fail, t])

  // How many finished, unarchived tasks the action would touch (for the confirm).
  const archiveCandidates = useMemo(
    () => nodes.filter((n) => !n.archived && isFinished(n) && !descendants(index, n.nodeId).some((d) => !d.archived && !isFinished(d))).length,
    [nodes, index],
  )

  // ─── Web: drag and drop + keyboard ──────────────────────────────────────

  const latest = useRef({ index, rows, move, openNode, onToggle, onFocus, focusId, query, t })
  latest.current = { index, rows, move, openNode, onToggle, onFocus, focusId, query, t }

  useEffect(() => {
    const root = domOf(rowsRef)
    if (root) armHandles(root)
  })

  // Restore the keyboard focus on the clicked row after a re-mount.
  useEffect(() => {
    if (Platform.OS !== "web") return
    const id = uiMemory.get(memKey)?.refocus
    if (!id) return
    const timer = setTimeout(() => {
      const el = domOf(rowsRef)?.querySelector<HTMLElement>(`[data-tdid="${CSS.escape(id)}"]`)
      if (el && document.activeElement !== el && !(document.activeElement instanceof HTMLInputElement)) el.focus({ preventScroll: true })
      const cur = uiMemory.get(memKey)
      if (cur) cur.refocus = null
    }, 60)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (Platform.OS !== "web") return
    const root = domOf(rowsRef)
    if (!root) return
    let drag: { id: string; target?: string; zone?: DropZone } | null = null
    const zoneOf = (row: HTMLElement, y: number): DropZone => {
      const r = row.getBoundingClientRect()
      const f = (y - r.top) / r.height
      return f < 1 / 3 ? "before" : f > 2 / 3 ? "after" : "inside"
    }
    const onDragStart = (e: DragEvent) => {
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
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"
    }
    const onDragOver = (e: DragEvent) => {
      if (!drag) return
      const { index: idx, t: tt } = latest.current
      const row = rowOf(e.target)
      root.querySelectorAll("[data-dz]").forEach((r) => r.removeAttribute("data-dz"))
      if (!row) {
        hideTip()
        return
      }
      const targetId = row.dataset.tdid!
      const zone = zoneOf(row, e.clientY)
      const target = idx.byId.get(targetId)
      const ok = canDrop(idx, drag.id, targetId, zone)
      if (!ok.ok) {
        if (targetId !== drag.id) row.setAttribute("data-dz", "no")
        if (e.dataTransfer) e.dataTransfer.dropEffect = "none"
        drag.target = undefined
        showTip(ok.reason === "groupInTask" ? tt("todo.drop.groupInTask") : tt("todo.drop.invalid"), e.clientX, e.clientY)
        return
      }
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
      row.setAttribute("data-dz", zone === "before" ? "b" : zone === "after" ? "a" : "in")
      drag.target = targetId
      drag.zone = zone
      showTip(tt(`todo.drop.${zone}`, { title: target?.text ?? "" }), e.clientX, e.clientY)
    }
    const end = () => {
      drag = null
      clearMarks(root)
      hideTip()
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      const d = drag
      end()
      if (d?.target && d.zone) latest.current.move(d.id, d.target, d.zone)
    }
    const onDragLeave = (e: DragEvent) => {
      if (!e.relatedTarget || !root.contains(e.relatedTarget as Node)) {
        root.querySelectorAll("[data-dz]").forEach((r) => r.removeAttribute("data-dz"))
        hideTip()
      }
    }
    const focusRow = (id: string) => {
      requestAnimationFrame(() => {
        const el = root.querySelector<HTMLElement>(`[data-tdid="${CSS.escape(id)}"]`)
        el?.focus({ preventScroll: false })
      })
    }
    const onKey = (e: KeyboardEvent) => {
      const row = rowOf(e.target)
      if (!row || (e.target as HTMLElement).tagName === "INPUT") return
      const { index: idx, rows: rs, move: mv, openNode: open, onToggle: toggle, onFocus: focus } = latest.current
      const id = row.dataset.tdid!
      const n = idx.byId.get(id)
      if (!n) return
      const i = rs.findIndex((r) => r.node.nodeId === id)
      const go = (k: number) => {
        const r = rs[k]
        if (r) {
          setSelectedId(r.node.nodeId)
          focusRow(r.node.nodeId)
        }
      }
      if (e.altKey && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        e.preventDefault()
        const key = e.key === "ArrowUp" ? "up" : e.key === "ArrowDown" ? "down" : e.key === "ArrowLeft" ? "left" : "right"
        const m = keyboardMove(idx, id, key)
        if (m) {
          mv(id, m.targetId, m.zone)
          focusRow(id)
        }
        return
      }
      if (e.key === "ArrowDown") {
        e.preventDefault()
        go(i + 1)
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        go(i - 1)
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        const r = rs[i]
        if (r?.hasKids && r.closed) toggle(id)
        else if (rs[i + 1]?.node.parentId === id) go(i + 1)
      } else if (e.key === "ArrowLeft") {
        e.preventDefault()
        const r = rs[i]
        if (r?.hasKids && !r.closed) toggle(id)
        else if (n.parentId) {
          const k = rs.findIndex((x) => x.node.nodeId === n.parentId)
          if (k >= 0) go(k)
        }
      } else if (e.key === "Enter") {
        e.preventDefault()
        open(id, e.metaKey || e.ctrlKey)
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault()
        focus(id)
        focusRow(id)
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault()
        setConfirm(n)
      }
    }
    // A double-click pins the row: never let it select text across the windows.
    const onMouseDown = (e: MouseEvent) => {
      if (e.detail > 1 && rowOf(e.target)) e.preventDefault()
    }
    root.addEventListener("mousedown", onMouseDown)
    // Pin on the browser's dblclick: robust even when the first click re-mounts this view.
    const onDblClick = (e: MouseEvent) => {
      const row = rowOf(e.target)
      if (!row || (e.target instanceof Element && e.target.closest('[role="button"]') !== row && e.target.closest('[role="button"]'))) return
      const id = row.dataset.tdid
      if (id) latest.current.openNode(id, true)
    }
    root.addEventListener("dblclick", onDblClick)
    root.addEventListener("dragstart", onDragStart)
    root.addEventListener("dragover", onDragOver)
    root.addEventListener("dragleave", onDragLeave)
    root.addEventListener("drop", onDrop)
    root.addEventListener("dragend", end)
    root.addEventListener("keydown", onKey)
    return () => {
      root.removeEventListener("mousedown", onMouseDown)
      root.removeEventListener("dblclick", onDblClick)
      root.removeEventListener("dragstart", onDragStart)
      root.removeEventListener("dragover", onDragOver)
      root.removeEventListener("dragleave", onDragLeave)
      root.removeEventListener("drop", onDrop)
      root.removeEventListener("dragend", end)
      root.removeEventListener("keydown", onKey)
    }
  }, [])

  // Esc leaves focus / clears the search; "/" jumps to the search box.
  const shellRef = useRef<View>(null)
  useEffect(() => {
    if (Platform.OS !== "web") return
    const el = domOf(shellRef)
    if (!el) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (e.key !== "Escape") return
      if (latest.current.focusId) {
        setFocusId(null)
        e.stopPropagation()
      } else if (latest.current.query) {
        setQuery("")
        e.stopPropagation()
      }
    }
    el.addEventListener("keydown", onKey)
    return () => el.removeEventListener("keydown", onKey)
  }, [])

  // ─── Render ─────────────────────────────────────────────────────────────

  const focusNode = focusId ? index.byId.get(focusId) : undefined
  const addInput = (depth: number, parent: TreeNode | null) => (
    <View key="__add" style={{ paddingTop: 2, paddingBottom: 4, paddingRight: 6, paddingLeft: 26 + Math.min(depth, 7) * 16 }}>
      <TextInput
        autoFocus
        value={draft}
        onChangeText={setDraft}
        onSubmitEditing={() => commitAdd()}
        onKeyPress={(e: any) => {
          if (e.nativeEvent.key === "Escape") {
            setAdding(null)
            setDraft("")
          }
        }}
        onBlur={() => {
          if (!draft.trim()) setAdding(null)
        }}
        placeholder={
          parent ? (parent.kind !== "group" ? t("todo.add.child") : t("todo.add.inGroup", { title: parent.text })) : t("todo.add.placeholder")
        }
        placeholderTextColor={td.text3}
        accessibilityLabel={t("todo.newTask")}
        style={[
          { height: 30, borderRadius: 100, backgroundColor: td.card, paddingHorizontal: 12, fontFamily: F.sans, fontSize: 12.5, color: td.text },
          web({ outlineStyle: "none", boxShadow: `0 0 0 1px rgba(111,39,255,.3)` }) as ViewStyle,
        ]}
      />
    </View>
  )

  // Spotlight: while the selected row is on screen, the other titles dim.
  const selVisible = !!selectedId && rows.some((r) => r.node.nodeId === selectedId)
  const list: React.ReactNode[] = []
  if (adding === "" && !focusId) list.push(addInput(0, null))
  for (const r of rows) {
    list.push(
      <TreeRow
        key={r.node.nodeId}
        row={r}
        counts={counts.get(r.node.nodeId)!}
        selected={selectedId === r.node.nodeId}
        focused={focusId === r.node.nodeId}
        celebrating={cele.has(r.node.nodeId)}
        dimmed={selVisible && selectedId !== r.node.nodeId}
        flashing={flash === r.node.nodeId}
        phone={phone}
        onPress={onRowPress}
        onToggle={onToggle}
        onFocus={onFocus}
        onAdd={onRowAdd}
        addMenu={addMenuFor === r.node.nodeId ? menuFor(r.node.nodeId) : undefined}
        assignee={find(r.node.assignee)}
        onOpenConversation={openChat}
        onOpenTerminal={openTerminal}
        beat={beat?.id === r.node.nodeId ? beat : undefined}
        onArchive={onArchive}
      />,
    )
    if (adding === r.node.nodeId) list.push(addInput(r.depth + 1, r.node))
  }

  return (
    <View ref={shellRef} style={{ flex: 1, minHeight: 0, minWidth: 0, paddingLeft: 10, paddingRight: 8 }}>
      {/* Search + new */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 2, paddingBottom: 8, zIndex: addMenuFor === "" || settingsOpen ? 50 : undefined }}>
        <View
          style={[
            {
              flex: 1,
              minWidth: 0,
              height: 34,
              borderRadius: 100,
              backgroundColor: td.card,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingLeft: 12,
              paddingRight: 6,
            },
            web({ boxShadow: td.sheetShadow }) as ViewStyle,
          ]}
        >
          <Ph name="magnifying-glass" size={14} color={td.text3} />
          <TextInput
            ref={searchRef}
            value={query}
            onChangeText={setQuery}
            placeholder={t("todo.search.placeholder")}
            placeholderTextColor={td.text3}
            accessibilityLabel={t("todo.search.placeholder")}
            style={[
              { flex: 1, minWidth: 0, height: 34, fontFamily: F.sans, fontSize: 12.5, color: td.text },
              web({ outlineStyle: "none" }) as ViewStyle,
            ]}
          />
          <View style={{ paddingHorizontal: 6, borderRadius: 6, backgroundColor: td.wash2 }}>
            <Tx f="mono" s={10} lh={18} c={td.txs}>
              /
            </Tx>
          </View>
        </View>
        <View style={{ position: "relative", zIndex: addMenuFor === "" ? 50 : undefined }}>
          <AddCircle label={t("todo.newTask")} onPress={() => setAddMenuFor((cur) => (cur === "" ? null : ""))} />
          {addMenuFor === "" ? menuFor(nodes.length === 0 ? null : addTarget(index, focusId, selectedId)) : null}
        </View>
        <View ref={settingsBtnRef} style={{ position: "relative", zIndex: settingsOpen ? 50 : undefined }}>
          <AddCircle label={t("todo.settings.label")} icon="gear-six" onPress={() => setSettingsOpen((cur) => !cur)} />
          {settingsOpen ? <SettingsMenu settings={settings} onChange={changeSettings} onArchiveFinished={() => setConfirmArchive(true)} archiveCandidates={archiveCandidates} menuRef={settingsMenuRef} /> : null}
        </View>
      </View>

      {/* Filters */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, marginRight: -6 }}
        contentContainerStyle={{ gap: 2, paddingBottom: 8 }}
        {...tdx("noscroll")}
      >
        <FilterChip on={filter === "all"} onPress={() => setFilter("all")} label={t("todo.filter.all")} />
        <FilterChip on={filter === "mine"} onPress={() => setFilter("mine")} label={t("todo.filter.mine")} count={mineCount} />
        <FilterChip on={filter === "working"} onPress={() => setFilter("working")} label={t("todo.filter.working")} count={stateCounts.working} state="working" />
        <FilterChip on={filter === "review"} onPress={() => setFilter("review")} label={t("todo.filter.review")} count={stateCounts.review} state="review" />
        <FilterChip on={filter === "blocked"} onPress={() => setFilter("blocked")} label={t("todo.filter.blocked")} count={stateCounts.blocked} state="blocked" />
      </ScrollView>

      {/* Focus header */}
      {focusNode ? (
        <View style={{ paddingHorizontal: 6, paddingBottom: 10, gap: 6 }}>
          <Tx f="mono" s={10} lh={14} c={td.txs} lines={1}>
            {`${ancestors(index, focusNode.nodeId).map((a) => a.text).join(" › ") || t("todo.focus.root")} · ${t("todo.focus.suffix")}`}
          </Tx>
          <Tx f="serif" s={22} lh={26} c={td.text}>
            {focusNode.text}
          </Tx>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Btn sm tone="out" icon="eye-slash" onPress={() => setFocusId(null)}>
              {t("todo.focus.exit")}
            </Btn>
            <View style={{ paddingHorizontal: 5, borderRadius: 5, backgroundColor: td.wash2 }}>
              <Tx f="mono" s={9.5} lh={16} c={td.txs}>
                Esc
              </Tx>
            </View>
          </View>
        </View>
      ) : null}

      {/* Rows */}
      <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: 2, paddingTop: 2, paddingBottom: 12 }} {...tdx("scroll")}>
        {nodes.length === 0 && adding === null ? (
          <EmptyBlock title={t("todo.empty.treeTitle")} body={t("todo.empty.treeBody")}>
            <Btn sm tone="pri" icon="plus" onPress={() => startAdd(null)}>
              {t("todo.empty.task")}
            </Btn>
            <Btn sm tone="out" icon="plus" onPress={addGroupAtRoot}>
              {t("todo.empty.group")}
            </Btn>
          </EmptyBlock>
        ) : (
          <View ref={rowsRef} {...({ role: "tree", "aria-label": t("todo.a11y.tree") } as Record<string, unknown>)}>
            {list}
            {/* Finished section (Byday pattern): done/cancelled gather here when "Hide finished" is on. */}
            {finished.length > 0 ? (
              <View style={{ marginTop: 10 }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("todo.finished.section")}
                  accessibilityState={{ expanded: finishedOpen }}
                  onPress={() => setFinishedOpen((cur) => !cur)}
                  style={({ hovered }: any) => [
                    {
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      height: 30,
                      paddingHorizontal: 8,
                      borderRadius: 9,
                      backgroundColor: hovered ? td.wash2 : "transparent",
                    },
                    web({ cursor: "pointer" }) as ViewStyle,
                  ]}
                >
                  <View style={web({ transform: finishedOpen ? "none" : "rotate(-90deg)", transition: "transform .2s cubic-bezier(.16,1,.3,1)" }) as ViewStyle}>
                    <Ph name="caret-down" size={10} color={td.text3} />
                  </View>
                  <Tx s={10.5} lh={14} c={td.txs} ls={1.5} upper>
                    {t("todo.finished.title", { count: finished.length })}
                  </Tx>
                </Pressable>
                {finishedOpen
                  ? finished.map((r) => (
                      <TreeRow
                        key={r.node.nodeId}
                        row={r}
                        counts={counts.get(r.node.nodeId) ?? { blocked: 0, review: 0, right: null }}
                        selected={selectedId === r.node.nodeId}
                        focused={false}
                        celebrating={cele.has(r.node.nodeId)}
                        dimmed={false}
                        flashing={flash === r.node.nodeId}
                        phone={phone}
                        onPress={onRowPress}
                        onToggle={onToggle}
                        onFocus={onFocus}
                        onAdd={onRowAdd}
                        addMenu={addMenuFor === r.node.nodeId ? menuFor(r.node.nodeId) : undefined}
                        assignee={find(r.node.assignee)}
                        onOpenConversation={openChat}
                        onOpenTerminal={openTerminal}
                        beat={beat?.id === r.node.nodeId ? beat : undefined}
                        onArchive={onArchive}
                      />
                    ))
                  : null}
              </View>
            ) : null}
            {rows.length === 0 && adding === null ? (
              <View style={{ alignItems: "center", gap: 10, paddingVertical: 40 }}>
                <Tx f="serif" s={22} lh={26} c={td.text}>
                  {t("todo.empty.noMatchTitle")}
                </Tx>
                <Tx s={13} lh={18} c={td.txs}>
                  {t("todo.empty.noMatchBody")}
                </Tx>
              </View>
            ) : null}
          </View>
        )}
      </ScrollView>

      {/* Hint footer */}
      {!phone && !narrow ? (
        <View style={{ flexDirection: "row", gap: 8, paddingTop: 8, paddingBottom: 12, paddingHorizontal: 6, overflow: "hidden" }}>
          <Tx f="mono" s={9.5} lh={14} c={td.txs} lines={1}>
            <Tx f="mono" s={9.5} lh={14} c={td.text2}>
              ⠿
            </Tx>
            {` ${t("todo.hint.drag")} · `}
            <Tx f="mono" s={9.5} lh={14} c={td.text2}>
              {t("todo.hint.edge")}
            </Tx>
            {` ${t("todo.hint.reorders")} · `}
            <Tx f="mono" s={9.5} lh={14} c={td.text2}>
              {t("todo.hint.centre")}
            </Tx>
            {` ${t("todo.hint.nests")}`}
          </Tx>
          <Tx f="mono" s={9.5} lh={14} c={td.txs} lines={1}>
            <Tx f="mono" s={9.5} lh={14} c={td.text2}>
              Alt
            </Tx>
            {`+${t("todo.hint.arrows")}`}
          </Tx>
        </View>
      ) : null}

      {confirm ? (
        <ConfirmDelete
          title={confirm.text}
          childCount={descendants(index, confirm.nodeId).length}
          onCancel={() => setConfirm(null)}
          onConfirm={() => doDelete(confirm)}
        />
      ) : null}

      {confirmArchive ? (
        <ConfirmArchiveFinished count={archiveCandidates} onCancel={() => setConfirmArchive(false)} onConfirm={() => void doArchiveFinished()} />
      ) : null}

      {toast ? (
        <View style={{ position: "absolute", left: 12, right: 12, bottom: 12, alignItems: "center", zIndex: 90 }} pointerEvents="box-none">
          <View
            accessibilityRole="alert"
            style={[
              { flexDirection: "row", alignItems: "center", gap: 8, maxWidth: 520, paddingVertical: 8, paddingLeft: 12, paddingRight: 14, borderRadius: 12, backgroundColor: td.card },
              web({ boxShadow: `${td.elevRaised}, 0 0 0 1px ${td.borderStrong}` }) as ViewStyle,
            ]}
          >
            <Ph name="archive" size={14} color={td.mintInk} />
            <Tx s={12.5} lh={18} c={td.text}>
              {toast}
            </Tx>
          </View>
        </View>
      ) : null}
    </View>
  )
}

/** The tree settings popover: toggles, archive action and the auto-archive horizon. */
function SettingsMenu({
  settings,
  onChange,
  onArchiveFinished,
  archiveCandidates,
  menuRef,
}: {
  settings: TreeSettings
  onChange: (partial: Partial<TreeSettings>) => void
  onArchiveFinished: () => void
  archiveCandidates: number
  menuRef: React.RefObject<any>
}) {
  const td = useTd()
  const { t } = useTranslation()
  const days: Array<{ key: string; value: number }> = [
    { key: "off", value: 0 },
    { key: "d1", value: 1 },
    { key: "d3", value: 3 },
    { key: "d5", value: 5 },
    { key: "d7", value: 7 },
    { key: "d14", value: 14 },
    { key: "d30", value: 30 },
  ]
  return (
    <MenuBox ref={menuRef} right minWidth={252} label={t("todo.settings.label")}>
      <MenuHead icon="sliders">{t("todo.settings.title")}</MenuHead>
      <MenuItem
        icon="check-square"
        label={t("todo.settings.hideFinished")}
        checked={settings.hideFinished}
        onPress={() => onChange({ hideFinished: !settings.hideFinished })}
      />
      <MenuItem
        icon="archive"
        label={t("todo.settings.showArchived")}
        checked={settings.showArchived}
        onPress={() => onChange({ showArchived: !settings.showArchived })}
      />
      <MenuSep />
      <MenuItem
        icon="archive-box"
        label={t("todo.settings.archiveFinished")}
        hint={archiveCandidates > 0 ? String(archiveCandidates) : undefined}
        disabled={archiveCandidates === 0}
        onPress={onArchiveFinished}
      />
      <MenuHead icon="clock-clockwise">{t("todo.settings.autoArchive")}</MenuHead>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, paddingHorizontal: 9, paddingBottom: 8 }}>
        {days.map((d) => {
          const on = settings.autoArchiveDays === d.value
          return (
            <Pressable
              key={d.key}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={d.value === 0 ? t("todo.settings.autoOff") : t("todo.settings.autoDays", { count: d.value })}
              onPress={() => onChange({ autoArchiveDays: d.value })}
              style={[
                {
                  height: 22,
                  minWidth: 30,
                  paddingHorizontal: 7,
                  borderRadius: 100,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: on ? td.card : "transparent",
                },
                web({ cursor: "pointer", boxShadow: on ? td.cardShadow : undefined }) as ViewStyle,
              ]}
            >
              <Tx f="mono" s={10} lh={12} c={on ? td.text : td.text2}>
                {d.value === 0 ? t("todo.settings.autoOff") : String(d.value)}
              </Tx>
            </Pressable>
          )
        })}
      </View>
    </MenuBox>
  )
}

/** In-app confirmation for "Archive finished" (same pattern as ConfirmDelete). */
function ConfirmArchiveFinished({ count, onCancel, onConfirm }: { count: number; onCancel: () => void; onConfirm: () => void }) {
  const td = useTd()
  const { t } = useTranslation()
  useEffect(() => {
    if (Platform.OS !== "web") return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onCancel()
      }
    }
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [onCancel])
  return (
    <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, zIndex: 80, alignItems: "center", justifyContent: "center", padding: 16 }}>
      <Pressable
        accessibilityLabel={t("todo.cancel")}
        onPress={onCancel}
        style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: td.dark ? "rgba(13,11,17,0.5)" : "rgba(52,47,61,0.18)" }}
      />
      <View
        accessibilityRole="alert"
        {...tdx("pop")}
        style={[
          { width: 340, maxWidth: "100%", backgroundColor: td.card, borderRadius: 16, padding: 18, gap: 10 },
          web({ boxShadow: `${td.elevRaised}, 0 0 0 1px ${td.borderStrong}` }) as ViewStyle,
        ]}
      >
        <Tx f="serif" s={18} lh={24} c={td.text}>
          {t("todo.archive.confirmTitle")}
        </Tx>
        <Tx s={12.5} lh={18} c={td.text2}>
          {t("todo.archive.confirmBody", { count })}
        </Tx>
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 6, marginTop: 4 }}>
          <Btn sm tone="ghost" onPress={onCancel}>
            {t("todo.cancel")}
          </Btn>
          <Btn sm tone="pri" icon="archive-box" onPress={onConfirm}>
            {t("todo.archive.confirmGo")}
          </Btn>
        </View>
      </View>
    </View>
  )
}

function AddCircle({ label, onPress, icon = "plus" }: { label: string; onPress: () => void; icon?: string }) {
  const td = useTd()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ hovered }: any) => [
        {
          width: 34,
          height: 34,
          borderRadius: 17,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: hovered ? td.controlBg : td.wash2,
          flexShrink: 0,
        },
        web({
          cursor: "pointer",
          transition: "background .2s, transform .35s cubic-bezier(.16,1,.3,1)",
          transform: hovered ? "translateY(-1px)" : "none",
        }) as ViewStyle,
      ]}
    >
      <Ph name={icon} size={13} color={td.text} />
    </Pressable>
  )
}
