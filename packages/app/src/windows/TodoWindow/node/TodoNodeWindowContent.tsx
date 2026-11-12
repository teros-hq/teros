/**
 * Task / group detail window (`todo-node`), opened beside the To Do tree as a
 * preview tab. Header (TODODH-REQ-1): breadcrumb, editable title, the chip
 * strip, the blocked / send-back box; then Summary · Output · Log. A task's
 * actions live in the bar fixed at the bottom (TODODH-REQ-3). Groups show
 * context, their state bar and their content. Any edit pins the preview tab.
 * Approved mocks: design-testing/proto-arbol/todo-window; detail header v2.
 */
import { FullscreenLoader } from "../../../components/ui"
import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { type LayoutChangeEvent, Platform, Pressable, ScrollView, TextInput, View, type TextStyle, type ViewStyle } from "react-native"
import { Ph } from "../../../components/ui/ds"
import { TabContext } from "../../../components/workspace/TabContext"
import { useTilingStore } from "../../../store/tilingStore"
import { useWindowTabMeta } from "../../../store/windowTabMetaStore"
import { getSlice, mutate, patchDetail, patchNode, requestFocus, requestTitleEdit, setLastOpened, subscribeApp, useAppSlice, watchNode } from "../data/todoStore"
import { stamp } from "../model/days"
import { toggleInstruction } from "../model/instructions"
import { ancestors, countStates, descendants, isTask, kidsOf } from "../model/tree"
import type { FormFieldDef, NodeState } from "../model/types"
import { ConfirmArchive } from "../ui/ConfirmArchive"
import { ConfirmDelete } from "../ui/ConfirmDelete"
import { ErrorToast } from "../ui/ErrorToast"
import { Btn, EmptyBlock, Eyebrow, IconBtn, MenuBox, MenuItem, MenuSep, PanelTabs, Tx, useDismiss } from "../ui/kit"
import { StateBar } from "../ui/StateBar"
import { installTodoFx, replayAttr, tdx, web } from "../ui/todoFx"
import { F, useTd } from "../ui/tokens"
import { ActionBar, type BarRun } from "./ActionBar"
import { CompleteChildrenPrompt } from "./Actions"
import { BlockedBox } from "./BlockedBox"
import { SendBackBox } from "./SendBackBox"
import { openConversationFromDetail } from "../autoplay/Conversation"
import { StateChips } from "./Chips"
import { AssignChip } from "./AssignChip"
import { DepSections } from "./DepSection"
import { ReviewerChip } from "./ReviewerChip"
import { usePeople } from "../data/usePeople"
import { checklistCount, MAX_FILE_BYTES, pickFile } from "./io"
import { lastAt } from "./logText"
import { LogTab } from "./LogTab"
import { OutputTab } from "./OutputTab"
import { openTodoMarkdown } from "../../MarkdownViewerWindow/todoSource"
import { Children, Description, SummaryTab } from "./SummaryTab"

export interface TodoNodeWindowProps {
  workspaceId?: string
  appId?: string
  nodeId?: string
}

type Tab = "summary" | "output" | "log"

export function TodoNodeWindowContent({ windowId, workspaceId, appId, nodeId }: TodoNodeWindowProps & { windowId?: string }) {
  installTodoFx()
  const td = useTd()
  const { t, i18n } = useTranslation()
  const locale = i18n.language || "en-US"
  const tabCtx = useContext(TabContext)
  const [width, setWidth] = useState(0)
  const [tab, setTab] = useState<Tab>("summary")
  const [error, setError] = useState<string | null>(null)
  const [confirmComplete, setConfirmComplete] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Archive (TODODH): archiving a node with non-archived children asks first
  // (the backend rejects it otherwise — HAS_ACTIVE_CHILDREN); unarchiving
  // never asks.
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [editTitle, setEditTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState("")
  const [inputOpen, setInputOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [addSignal, setAddSignal] = useState(0)
  const [inputWriteSignal, setInputWriteSignal] = useState(0)
  const [descriptionSignal, setDescriptionSignal] = useState(0)
  // TODOAP-REQ-21: the note box for sending a review task back is open.
  const [sendingBack, setSendingBack] = useState(false)
  // TODODH-REQ-3: the bar's Block opens the state chip's block-reason menu.
  const [blockSignal, setBlockSignal] = useState(0)
  const scrollRef = useRef<ScrollView>(null)
  const editTitleOnLoad = useRef(false)
  const moreRef = useRef<View>(null)
  useDismiss(moreOpen, () => setMoreOpen(false), moreRef)

  useEffect(() => (appId ? subscribeApp(appId) : undefined), [appId])
  useEffect(() => (appId && nodeId ? watchNode(appId, nodeId) : undefined), [appId, nodeId])

  const node = useAppSlice(appId, (s) => (nodeId ? s.details[nodeId] : undefined))
  const status = useAppSlice(appId, (s) => (nodeId ? s.detailStatus[nodeId] : undefined))
  const index = useAppSlice(appId, (s) => s.index)
  const editTitleFor = useAppSlice(appId, (s) => s.editTitleFor)
  const { people, me, find } = usePeople(workspaceId)

  // A group just created from the tree opens with its title ready to type.
  useEffect(() => {
    if (!appId || !node || editTitleFor !== nodeId) return
    setTitleDraft(node.text)
    setEditTitle(true)
    requestTitleEdit(appId, null)
  }, [appId, node, nodeId, editTitleFor])

  // The tree highlights what the visible detail shows.
  useEffect(() => {
    if (appId && nodeId && (tabCtx?.isTabActive ?? true)) setLastOpened(appId, nodeId)
  }, [appId, nodeId, tabCtx?.isTabActive])

  // Click feedback from the tree: re-clicking this node glows the sheet's edge
  // and pings the tab once — "you already have it open here".
  const ping = useAppSlice(appId, (s) => s.ping)
  const seenPing = useRef(ping.n)
  const rootRef = useRef<any>(null)
  useEffect(() => {
    if (ping.n === seenPing.current) return
    seenPing.current = ping.n
    if (ping.id !== nodeId) return
    replayAttr(rootRef.current, "data-here", "1")
    if (windowId && Platform.OS === "web") replayAttr(document.querySelector(`[data-window-id="${windowId}"]`), "data-ping", "1")
  }, [ping, nodeId, windowId])

  // Reset per-node UI when the window navigates to another node.
  useEffect(() => {
    setConfirmComplete(false)
    setConfirmDelete(false)
    setConfirmArchive(false)
    setEditTitle(editTitleOnLoad.current || (!!appId && getSlice(appId).editTitleFor === nodeId))
    editTitleOnLoad.current = false
    setMoreOpen(false)
    setInputOpen(false)
    setSendingBack(false)
  }, [nodeId])

  // The note box and the complete-children prompt open in the header; the bar is at the bottom.
  useEffect(() => {
    if (sendingBack || confirmComplete || confirmArchive) scrollRef.current?.scrollTo?.({ y: 0, animated: true })
  }, [sendingBack, confirmComplete, confirmArchive])

  const isGroup = node?.kind === "group"
  // Archive (TODODH): the header dims and badges while archived — the detail
  // itself (tabs, log, output) stays fully readable.
  const archived = !!node?.archived
  // The tab dot is the task's own state dot: animated only while running (TODOAP-REQ-20).
  useWindowTabMeta(
    windowId,
    node
      ? isGroup
        ? { title: node.text, phIcon: "folder-simple" }
        : { title: node.text, dotColor: td.st[(node.state ?? "pending") as NodeState], spinner: node.state === "working" && !!node.running }
      : null,
  )

  const onError = useCallback((m: string) => setError(m), [])
  const run = useCallback(
    async <T = any,>(tool: string, input: Record<string, unknown>): Promise<T | null> => {
      if (!appId || !nodeId) return null
      if (windowId) useTilingStore.getState().pinWindow(windowId)
      try {
        return await mutate<T>(appId, tool, { nodeId, ...input })
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err))
        return null
      }
    },
    [appId, nodeId, windowId, onError],
  )

  const navigate = useCallback(
    (id: string) => {
      if (!windowId || !appId) return
      useTilingStore.getState().replaceWindow(windowId, "todo-node", { workspaceId, appId, nodeId: id })
    },
    [windowId, workspaceId, appId],
  )

  // TODODEP: the flat tree (the dependency searcher's pool - any task of the
  // workspace, any group; never cross-workspace).
  const nodes = useAppSlice(appId, (s) => s.nodes)
  const crumbs = useMemo(() => (nodeId && index.byId.has(nodeId) ? ancestors(index, nodeId) : []), [index, nodeId])
  const kids = useMemo(() => (nodeId ? kidsOf(index, nodeId) : []), [index, nodeId])
  const openDesc = useMemo(
    () => (nodeId ? descendants(index, nodeId).filter((d) => isTask(d) && d.state !== "done") : []),
    [index, nodeId],
  )
  const groupCounts = useMemo(() => countStates(nodeId ? descendants(index, nodeId).filter(isTask) : []), [index, nodeId])

  const narrow = width > 0 && width < 520
  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), [])

  // ─── Empty / missing / loading ──────────────────────────────────────────
  if (!appId || !nodeId) {
    return (
      <View style={{ flex: 1, backgroundColor: td.sheet }}>
        <EmptyBlock title={t("todo.empty.detailTitle")} body={t("todo.empty.detailBody")} />
      </View>
    )
  }
  if (status === "missing") {
    return (
      <View style={{ flex: 1, backgroundColor: td.sheet }}>
        <EmptyBlock title={t("todo.empty.missingTitle")} body={t("todo.empty.missingBody")} />
      </View>
    )
  }
  if (!node) {
    return (
      <View style={{ flex: 1, backgroundColor: td.sheet }}>
        <FullscreenLoader />
      </View>
    )
  }

  const state = (node.state ?? "pending") as NodeState
  const yesterday = t("todo.day.yesterday").toLowerCase()
  const blockedTs = lastAt(node.log, /→ blocked|^Blocked: /)
  // Last output write; the "Output delivered" log entry only for older nodes without the field.
  const deliveredTs = node.outputUpdatedAt ?? lastAt(node.log, /^Output delivered/)

  // ─── Handlers ───────────────────────────────────────────────────────────
  const setState = (to: NodeState, reason?: string) => {
    // @spec TODOAP-REQ-21 — every send-back from review asks for a note first.
    if (state === "review" && to === "working") {
      setSendingBack(true)
      return
    }
    if (to === "done" && openDesc.length > 0) {
      setConfirmComplete(true)
      return
    }
    setConfirmComplete(false)
    void run("set-state", { state: to, ...(reason ? { reason } : {}) })
  }
  const completeAll = async () => {
    setConfirmComplete(false)
    if (state !== "done") await run("toggle-complete", {})
  }
  const completeOne = () => {
    setConfirmComplete(false)
    void run("set-state", { state: "done" })
  }
  // TODOAP-REQ-10: the backend logs the reply and, with a conversation, posts it there.
  const reply = (text: string) => void run("set-state", { state: "working", reply: text })
  // TODOAP-REQ-21: the note travels as the reply on review → working.
  const sendBack = (note: string) => {
    setSendingBack(false)
    void run("set-state", { state: "working", reply: note })
  }
  const upload = async (slot: "input" | "output") => {
    const f = await pickFile()
    if (!f) return
    if (f.size > MAX_FILE_BYTES) {
      onError(t("todo.io.tooLarge"))
      return
    }
    setUploading(true)
    // overwrite: true — a human picking a file over an existing output is a
    // deliberate replacement (the backend's OUTPUT_EXISTS guard targets
    // accidental agent overwrites).
    await run(slot === "input" ? "set-input" : "set-output", {
      [slot]: { format: "file", name: f.name, mime: f.mime, data: f.data },
      overwrite: true,
    })
    setUploading(false)
  }
  const onIO = (slot: "input" | "output") => (action: "file" | "markdown" | "remove", markdown?: string) => {
    if (action === "file") return void upload(slot)
    if (action === "remove") return void run(slot === "input" ? "set-input" : "set-output", { [slot]: null })
    // overwrite: true — the markdown editor's save is a deliberate human edit
    // over whatever output is there (identical text is a no-op anyway).
    void run(slot === "input" ? "set-input" : "set-output", { [slot]: { format: "markdown", markdown: markdown ?? "" }, overwrite: true })
  }
  // @spec TODOOV-REQ-6 A markdown io opens in the Markdown viewer as a preview tab beside this detail.
  const openIO = (io: "input" | "output") =>
    workspaceId ? openTodoMarkdown({ workspaceId, appId, nodeId, io }, node.text, windowId) : undefined
  const tick = (i: number) => {
    patchDetail(appId, nodeId, { instructions: toggleInstruction(node.instructions, i) })
    void run("toggle-instruction-item", { index: i })
  }
  const commitTitle = () => {
    const v = titleDraft.trim()
    setEditTitle(false)
    if (v && v !== node.text) void run("update-node", { text: v })
  }
  const addChild = (text: string) =>
    run("add-node", { parentId: nodeId, text, kind: "task", state: "planning", nodeId: undefined })
  const addGroup = async () => {
    setMoreOpen(false)
    const res = await run<{ node: { nodeId: string } }>("add-node", {
      parentId: nodeId,
      text: t("todo.add.newGroup"),
      kind: "group",
      nodeId: undefined,
    })
    if (res?.node?.nodeId) {
      editTitleOnLoad.current = true
      setTitleDraft(t("todo.add.newGroup"))
      navigate(res.node.nodeId)
    }
  }
  const remove = async () => {
    setConfirmDelete(false)
    const res = await run("delete-node", {})
    if (res && windowId) useTilingStore.getState().closeWindow(windowId)
  }
  // Archive (TODODH): optimistic patch (tree row + detail) so the state flips
  // immediately; the set-archived response and the todo_node_changed refresh
  // settle the real values. Archiving a node with non-archived children asks
  // first — the backend would reject it (HAS_ACTIVE_CHILDREN). The detail
  // stays fully readable either way: archive only affects tree/day visibility.
  const setArchived = (archived: boolean) => {
    patchNode(appId, nodeId, { archived, archivedAt: archived ? Date.now() : null })
    patchDetail(appId, nodeId, { archived, archivedAt: archived ? Date.now() : null })
    void run("set-archived", { archived })
  }
  const toggleArchived = (archived: boolean) => {
    setConfirmArchive(false)
    if (archived && kids.some((k) => !k.archived)) {
      setConfirmArchive(true)
      return
    }
    setArchived(archived)
  }
  const onBar = (r: BarRun) => {
    if (r.kind === "start") void run("start-node", {})
    else if (r.kind === "block") setBlockSignal((n) => n + 1)
    else setState(r.to)
  }
  const canBeGroup = !isGroup && !node.output && (state === "planning" || state === "pending")
  const hasGroupKids = kids.some((k) => k.kind === "group")

  // ─── Render ─────────────────────────────────────────────────────────────
  return (
    <View ref={rootRef} style={{ flex: 1, minHeight: 0, backgroundColor: td.sheet }} onLayout={onLayout}>
      <ScrollView
        ref={scrollRef}
        key={nodeId}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: narrow ? 4 : 6, paddingHorizontal: narrow ? 16 : 26, paddingBottom: narrow ? 28 : 32 }}
        {...tdx("scroll in")}
      >
        <View style={{ maxWidth: 880, width: "100%" }}>
          {/* Breadcrumb + eye + more */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 28, zIndex: 40 }}>
            <View
              style={{ flexDirection: "row", alignItems: "center", flexShrink: 1, minWidth: 0, overflow: "hidden" }}
              accessibilityLabel={t("todo.a11y.crumb")}
            >
              {crumbs.length === 0 ? (
                <Tx f="mono" s={10.5} lh={14} c={td.txs} style={{ paddingHorizontal: 6, marginLeft: -6 }}>
                  {t("todo.focus.root")}
                </Tx>
              ) : (
                crumbs.map((c, i) => (
                  <React.Fragment key={c.nodeId}>
                    {i > 0 ? (
                      <Tx f="mono" s={10.5} lh={14} c={td.text3} style={{ paddingHorizontal: 2 }}>
                        ›
                      </Tx>
                    ) : null}
                    <Pressable
                      accessibilityRole="link"
                      onPress={() => navigate(c.nodeId)}
                      style={({ hovered }: any) => [
                        { height: 28, justifyContent: "center", paddingHorizontal: 6, marginLeft: i === 0 ? -6 : 0, borderRadius: 6, backgroundColor: hovered ? td.wash : "transparent", minWidth: 0, flexShrink: 1 },
                        web({ cursor: "pointer" }) as ViewStyle,
                      ]}
                    >
                      {({ hovered }: any) => (
                        <Tx f="mono" s={10.5} lh={14} c={hovered ? td.accent : td.txs} lines={1}>
                          {c.text}
                        </Tx>
                      )}
                    </Pressable>
                  </React.Fragment>
                ))
              )}
            </View>
            <View style={{ flex: 1 }} />
            <IconBtn icon="eye" label={t("todo.more.focus")} color={td.text} iconSize={16} onPress={() => requestFocus(appId, nodeId)} />
            <IconBtn
              icon="archive"
              label={archived ? t("todo.row.unarchive", { title: node.text }) : t("todo.row.archive", { title: node.text })}
              color={td.text}
              active={archived}
              iconSize={16}
              onPress={() => toggleArchived(!archived)}
            />
            <View ref={moreRef} style={{ position: "relative" }}>
              <IconBtn icon="dots-three" label={t("todo.more.label")} color={td.text} iconSize={16} onPress={() => setMoreOpen((v) => !v)} />
              {moreOpen ? (
                <MenuBox right label={t("todo.more.label")}>
                  <MenuItem
                    icon="plus"
                    label={isGroup ? t("todo.more.addTask") : t("todo.more.addChild")}
                    onPress={() => {
                      setMoreOpen(false)
                      setTab("summary")
                      setAddSignal((n) => n + 1)
                    }}
                  />
                  {isGroup ? <MenuItem icon="folder-simple" label={t("todo.more.addGroup")} onPress={addGroup} /> : null}
                  {!node.description ? (
                    <MenuItem
                      icon="text-align-left"
                      label={t("todo.more.writeDescription")}
                      onPress={() => {
                        setMoreOpen(false)
                        setTab("summary")
                        setDescriptionSignal((n) => n + 1)
                      }}
                    />
                  ) : null}
                  {!node.input ? (
                    <>
                      <MenuItem
                        icon="upload-simple"
                        label={`${t("todo.section.input")} · ${t("todo.io.upload").toLowerCase()}`}
                        onPress={() => {
                          setMoreOpen(false)
                          void upload("input")
                        }}
                      />
                      <MenuItem
                        icon="pencil-simple"
                        label={`${t("todo.section.input")} · ${t("todo.io.writeMarkdown").toLowerCase()}`}
                        onPress={() => {
                          setMoreOpen(false)
                          setTab("summary")
                          setInputWriteSignal((n) => n + 1)
                        }}
                      />
                    </>
                  ) : null}
                  {isGroup ? (
                    <MenuItem
                      icon="check-square"
                      label={t("todo.more.toTask")}
                      hint={hasGroupKids ? t("todo.more.hasGroups") : undefined}
                      disabled={hasGroupKids}
                      onPress={() => {
                        setMoreOpen(false)
                        void run("set-kind", { kind: "task" })
                      }}
                    />
                  ) : (
                    <MenuItem
                      icon="folder-simple"
                      label={t("todo.more.toGroup")}
                      hint={node.output ? t("todo.more.hasOutput") : undefined}
                      disabled={!canBeGroup}
                      onPress={() => {
                        setMoreOpen(false)
                        void run("set-kind", { kind: "group" })
                      }}
                    />
                  )}
                  <MenuSep />
                  <MenuItem
                    icon="trash"
                    danger
                    label={t("todo.more.delete")}
                    onPress={() => {
                      setMoreOpen(false)
                      setConfirmDelete(true)
                    }}
                  />
                </MenuBox>
              ) : null}
            </View>
          </View>

          {/* Title */}
          {editTitle ? (
            <TextInput
              autoFocus
              value={titleDraft}
              onChangeText={setTitleDraft}
              onSubmitEditing={commitTitle}
              onBlur={commitTitle}
              onKeyPress={(e: any) => e.nativeEvent.key === "Escape" && setEditTitle(false)}
              accessibilityLabel={t("todo.titleField.label")}
              selectTextOnFocus
              style={[
                { fontFamily: F.serif, fontSize: 24, lineHeight: 29, color: td.text, borderRadius: 8, paddingVertical: 1, paddingHorizontal: 5, marginTop: 4, marginBottom: 12, marginLeft: -5, backgroundColor: td.card },
                web({ outlineStyle: "none", boxShadow: "0 0 0 1px rgba(111,39,255,.35)", width: "calc(100% + 10px)" }) as TextStyle,
              ]}
            />
          ) : (
            <Pressable
              accessibilityRole="header"
              accessibilityHint={t("todo.titleField.edit")}
              onPress={() => {
                setTitleDraft(node.text)
                setEditTitle(true)
              }}
              style={({ hovered }: any) => [
                { alignSelf: "flex-start", maxWidth: "100%", borderRadius: 8, paddingVertical: 1, paddingHorizontal: 5, marginTop: 4, marginBottom: 12, marginLeft: -5, backgroundColor: hovered ? td.wash : "transparent" },
                web({ cursor: "text" }) as ViewStyle,
              ]}
            >
              <Tx f="serif" s={24} lh={29} c={archived ? td.txs : td.text} ls={-0.12}>
                {node.text}
              </Tx>
            </Pressable>
          )}
          {archived ? (
            <View
              accessibilityLabel={t("todo.row.archivedBadge")}
              style={{ flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start", paddingHorizontal: 7, paddingVertical: 2, marginBottom: 10, borderRadius: 6, backgroundColor: td.wash2 }}
            >
              <Ph name="archive" size={11} color={td.txs} />
              <Tx f="mono" s={10} lh={14} c={td.txs}>
                {t("todo.row.archivedBadge")}
              </Tx>
            </View>
          ) : null}

          {/* Chips */}
          {isGroup ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              <ReadChip>
                <Ph name="folder-simple" size={13} color={td.text3} />
                <Tx s={12} lh={14} c={td.text}>
                  {t("todo.chip.group")}
                </Tx>
              </ReadChip>
              <ReadChip>
                <Tx f="mono" s={9.5} lh={12} c={td.txs}>
                  {t("todo.chip.tasks")}
                </Tx>
                <Tx f="mono" s={10.5} lh={12} c={td.text2}>
                  {String(Object.values(groupCounts).reduce((a, b) => a + b, 0))}
                </Tx>
              </ReadChip>
              <ReadChip>
                <Tx f="mono" s={9.5} lh={12} c={td.txs}>
                  {t("todo.chip.open")}
                </Tx>
                <Tx f="mono" s={10.5} lh={12} c={td.text2}>
                  {String(Object.values(groupCounts).reduce((a, b) => a + b, 0) - groupCounts.done)}
                </Tx>
              </ReadChip>
            </View>
          ) : (
            <StateChips
              node={node}
              hasChildTasks={kids.some((k) => k.kind !== "group")}
              onSetState={setState}
              onProgress={(v) => void run("set-progress", { progress: v })}
              onPlan={(day, time) => void run("plan-node", { day, ...(time !== undefined ? { time } : {}) })}
              assignSlot={
                <AssignChip
                  assignee={node.assignee ?? null}
                  people={people}
                  me={me}
                  find={find}
                  onAssign={(assignee) => void run("assign-node", { assignee })}
                />
              }
              reviewerSlot={
                <ReviewerChip
                  reviewer={node.reviewer ?? null}
                  people={people}
                  me={me}
                  find={find}
                  onSetReviewer={(reviewer) => void run("set-reviewer", { reviewer })}
                />
              }
              onOpenConversation={node.channelId ? () => openConversationFromDetail(node.channelId!, windowId) : undefined}
              blockSignal={blockSignal}
            />
          )}

          {/* TODODEP - "Bloqueada por" / "Bloquea a" + the searcher to add a
              blocker. Zero noise: nothing renders without dependencies AND
              dependents. */}
          {!isGroup && node ? (
            <DepSections
              node={node}
              nodes={nodes}
              onOpen={navigate}
              onAdd={(blockerNodeId) => void run("add-dependency", { blockerNodeId })}
              onRemove={(blockerNodeId) => void run("remove-dependency", { blockerNodeId })}
              labels={{
                blockedBy: t("todo.dep.blockedBy"),
                blocks: t("todo.dep.blocks"),
                add: t("todo.dep.add"),
                search: t("todo.dep.search"),
                tasks: t("todo.dep.tasks"),
                noMatch: t("todo.dep.noMatch"),
                remove: t("todo.dep.remove"),
                none: t("todo.dep.none"),
              }}
            />
          ) : null}

          {/* Blocked box / send-back note / complete-children prompt (TODODH-REQ-1) */}
          {!isGroup && state === "blocked" ? (
            <BlockedBox
              reason={node.blockedReason}
              at={blockedTs ? stamp(blockedTs, locale, yesterday) : null}
              onReply={reply}
              onError={onError}
            />
          ) : null}
          {!isGroup && state === "review" && sendingBack ? (
            <SendBackBox onSend={sendBack} onCancel={() => setSendingBack(false)} onError={onError} />
          ) : null}
          {!isGroup && confirmComplete ? (
            <CompleteChildrenPrompt
              open={openDesc.map((d) => d.text)}
              onAll={completeAll}
              onOne={completeOne}
              onCancel={() => setConfirmComplete(false)}
            />
          ) : null}
          {isGroup ? (
            <View style={{ flexDirection: "row", gap: 6, marginTop: 12 }}>
              <Btn sm tone="out" icon="plus" onPress={() => setAddSignal((n) => n + 1)}>
                {t("todo.task")}
              </Btn>
              <Btn sm tone="ghost" icon="plus" onPress={addGroup}>
                {t("todo.group")}
              </Btn>
            </View>
          ) : null}

          {/* Body */}
          {isGroup ? (
            <View>
              <Description value={node.description} onSave={(description) => void run("update-node", { description })} editSignal={descriptionSignal} />
              {Object.values(groupCounts).some((n) => n > 0) ? (
                <>
                  <Eyebrow>{t("todo.section.groupState")}</Eyebrow>
                  <StateBar counts={groupCounts} />
                </>
              ) : null}
              <Children
                kids={kids}
                title={t("todo.section.content")}
                isGroup
                onOpen={navigate}
                onAdd={(text) => void addChild(text)}
                addSignal={addSignal}
              />
            </View>
          ) : (
            <>
              <PanelTabs
                wide={narrow}
                value={tab}
                onChange={setTab}
                items={[
                  { key: "summary", label: t("todo.tabs.summary") },
                  { key: "output", label: t("todo.tabs.output"), count: checklistCount(node.output) ?? (node.output ? 1 : null) },
                  { key: "log", label: t("todo.tabs.log"), count: node.log.length || null },
                ]}
              />
              <View {...({ role: "tabpanel" } as Record<string, unknown>)}>
                {tab === "summary" ? (
                  <SummaryTab
                    node={node}
                    kids={kids}
                    isGroup={false}
                    onUpdate={(fields) => void run("update-node", fields)}
                    onTick={tick}
                    onInput={onIO("input")}
                    onOpenChild={navigate}
                    onAddChild={(text) => void addChild(text)}
                    onSendToReview={() => setState("review")}
                    inputOpen={inputOpen}
                    setInputOpen={setInputOpen}
                    addSignal={addSignal}
                    inputWriteSignal={inputWriteSignal}
                    descriptionSignal={descriptionSignal}
                    onOpenInput={() => openIO("input")}
                  />
                ) : tab === "output" ? (
                  <OutputTab
                    node={node}
                    deliveredAt={deliveredTs ? stamp(deliveredTs, locale, yesterday) : null}
                    wide={width >= 540 + (narrow ? 32 : 52)}
                    uploading={uploading}
                    onOutput={onIO("output")}
                    onExpectedOutput={(expectedOutput) => {
                      patchDetail(appId, nodeId, { expectedOutput })
                      void run("update-node", { expectedOutput })
                    }}
                    onFill={() => {
                      // TODOAP-REQ-16: the definition's fields, empty values; the state is untouched.
                      const output = { format: "form" as const, fields: (node.expectedOutput?.fields ?? []) as unknown as FormFieldDef[], values: {} }
                      patchDetail(appId, nodeId, { output, hasOutput: true })
                      void run("set-output", { output })
                    }}
                    onFormPatch={(output) => patchDetail(appId, nodeId, { output })}
                    onFormSave={(output) => void run("set-output", { output })}
                    onOpen={() => openIO("output")}
                  />
                ) : (
                  <LogTab log={node.log} workspaceId={workspaceId} onNote={(text) => void run("add-log-entry", { text })} />
                )}
              </View>
            </>
          )}
        </View>
      </ScrollView>
      {/* TODODH-REQ-3: outside the scroll, the window's last row. */}
      <ActionBar node={node} sendingBack={sendingBack} onRun={onBar} />
      {confirmArchive ? (
        <ConfirmArchive
          title={node.text}
          childCount={kids.filter((k) => !k.archived).length}
          onCancel={() => setConfirmArchive(false)}
          onConfirm={() => setArchived(true)}
        />
      ) : null}
      {confirmDelete ? (
        <ConfirmDelete
          title={node.text}
          childCount={descendants(index, nodeId).length}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={remove}
        />
      ) : null}
      {error ? <ErrorToast message={t("todo.error", { message: error })} onClose={() => setError(null)} /> : null}
    </View>
  )

}

function ReadChip({ children }: { children: React.ReactNode }) {
  const td = useTd()
  return (
    <View
      style={[
        { flexDirection: "row", alignItems: "center", gap: 7, height: 28, paddingLeft: 11, paddingRight: 10, borderRadius: 100 },
        web({ boxShadow: `0 0 0 1px ${td.borderStrong}` }) as ViewStyle,
      ]}
    >
      {children}
    </View>
  )
}
