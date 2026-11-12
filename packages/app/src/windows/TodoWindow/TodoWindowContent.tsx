/**
 * To Do window — the tree of groups and tasks (Árbol) and the day plan
 * (Por día). Task details open in their own `todo-node` window beside it as a
 * preview tab (docs/specs/ui/preview-tabs.md). Approved mock:
 * design-testing/proto-arbol/todo-window (v3).
 *
 * Data: data/todoStore.ts (shared with the detail windows, live through
 * todo_node_changed). Pieces: tree/TreeView, day/DayView, ui/kit.
 */
import { FullscreenLoader } from "../../components/ui"
import React, { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { View, type LayoutChangeEvent } from "react-native"
import { useTilingStore } from "../../store/tilingStore"
import { loadTree, subscribeApp, useAppSlice } from "./data/todoStore"
import { useTodoApp } from "./data/useTodoApp"
import { DayView } from "./day/DayView"
import { isTask } from "./model/tree"
import { TreeView } from "./tree/TreeView"
import type { TodoWindowProps } from "./definition"
import { Btn, EmptyBlock, Seg, Tx } from "./ui/kit"
import { installTodoFx } from "./ui/todoFx"
import { useTd } from "./ui/tokens"
import { ErrorToast } from "./ui/ErrorToast"
import { AutoplayChip, AutoplayPanelHost } from "./autoplay/AutoplayPanel"

type View_ = "tree" | "day"

interface Props extends TodoWindowProps {
  windowId?: string
}

const VIEW_KEY = "teros-todo-view"
function readView(windowId?: string): View_ {
  try {
    const v = globalThis.localStorage?.getItem(`${VIEW_KEY}:${windowId ?? ""}`)
    return v === "day" ? "day" : "tree"
  } catch {
    return "tree"
  }
}
function writeView(windowId: string | undefined, v: View_) {
  try {
    globalThis.localStorage?.setItem(`${VIEW_KEY}:${windowId ?? ""}`, v)
  } catch {}
}

export function TodoWindowContent({ windowId, workspaceId: propWs, appId: propApp, view: propView, focusId: propFocus }: Props) {
  installTodoFx()
  const td = useTd()
  const { t } = useTranslation()
  const app = useTodoApp({ workspaceId: propWs, appId: propApp })
  const appId = app.status === "ready" ? app.appId : null
  const [view, setView] = useState<View_>(() => propView ?? readView(windowId))
  // The window's props carry the view so a pin of this tab captures it (NAV-REQ-20).
  useEffect(() => {
    if (windowId && propView !== view) useTilingStore.getState().updateWindowProps(windowId, { view })
  }, [windowId, view]) // eslint-disable-line react-hooks/exhaustive-deps
  const [width, setWidth] = useState(0)
  const [headerBottom, setHeaderBottom] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const phone = useTilingStore((s) => s.compactShell)

  useEffect(() => {
    if (!appId) return
    return subscribeApp(appId)
  }, [appId])

  const nodes = useAppSlice(appId, (s) => s.nodes)
  const status = useAppSlice(appId, (s) => s.treeStatus)
  const tasks = useMemo(() => nodes.filter(isTask), [nodes])
  const open = tasks.filter((n) => n.state !== "done").length

  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), [])
  const onHeaderLayout = useCallback((e: LayoutChangeEvent) => setHeaderBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height), [])
  const narrow = width > 0 && width < 340
  // Below this the full "Autoplay · n" label would truncate the summary: icon + count only.
  const tight = width > 0 && width < 440
  const onError = useCallback((m: string) => setError(m), [])

  const changeView = (v: View_) => {
    setView(v)
    writeView(windowId, v)
  }

  let body: React.ReactNode
  if (app.status === "noWorkspace") body = <EmptyBlock title={t("todo.noWorkspace")} />
  else if (app.status === "notInstalled") body = <EmptyBlock title={t("todo.notInstalled")} body={t("todo.notInstalledHint")} />
  else if (app.status === "error" || (appId && status === "error"))
    body = (
      <EmptyBlock title={t("todo.loadError")}>
        <Btn sm tone="out" icon="arrow-clockwise" onPress={() => appId && loadTree(appId)}>
          {t("todo.retry")}
        </Btn>
      </EmptyBlock>
    )
  else if (!appId || status === "loading")
    body = (
      <FullscreenLoader />
    )
  else if (view === "day")
    body = <DayView appId={appId} workspaceId={app.workspaceId} windowId={windowId} phone={phone} narrow={width > 0 && width < 380} onError={onError} />
  else body = <TreeView appId={appId} workspaceId={app.workspaceId} windowId={windowId} initialFocusId={propFocus} phone={phone} narrow={narrow} onError={onError} />

  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: td.sheet }} onLayout={onLayout}>
      <View
        style={{
          flex: 1,
          minHeight: 0,
          width: "100%",
          maxWidth: phone ? undefined : 760,
          alignSelf: "center",
        }}
      >
        {/* View switch · summary · Autoplay chip (TODOAP-REQ-12: right end, both views) */}
        <View
          onLayout={onHeaderLayout}
          style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingTop: 2, paddingRight: 8, paddingBottom: 10, paddingLeft: 14 }}
        >
          <Seg
            label={t("todo.view.label")}
            value={view}
            onChange={changeView}
            items={[
              { key: "tree", label: t("todo.view.tree") },
              { key: "day", label: t("todo.view.day") },
            ]}
          />
          {!narrow && appId && status === "ready" ? (
            <Tx f="mono" s={10} lh={14} c={td.txs} lines={1} style={{ marginLeft: "auto" }}>
              {t("todo.summary", { tasks: tasks.length, open })}
            </Tx>
          ) : null}
          {appId && status === "ready" ? (
            <View style={{ marginLeft: narrow ? "auto" : undefined }}>
              <AutoplayChip appId={appId} workspaceId={app.workspaceId} windowId={windowId} compact={tight || phone} />
            </View>
          ) : null}
        </View>
        {body}
      </View>
      {appId && status === "ready" ? (
        <AutoplayPanelHost appId={appId} workspaceId={app.workspaceId} windowId={windowId} top={headerBottom} onError={onError} />
      ) : null}
      {error ? <ErrorToast message={t("todo.error", { message: error })} onClose={() => setError(null)} /> : null}
    </View>
  )
}
