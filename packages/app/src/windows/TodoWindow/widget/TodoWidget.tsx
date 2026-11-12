/**
 * TodoWidget — the rail widget of a pinned Tasks window (NAV-REQ-20). Two
 * faces, chosen by the view the pin captured: "day" is today's plan (open,
 * overdue, done, the first tasks); "tree" is the state mix of the whole tree
 * or of the branch that was in focus when the tab was pinned.
 *
 * @spec NAV-REQ-20
 */
import { useEffect } from "react"
import { Text, View } from "react-native"
import { useTranslation } from "react-i18next"
import type { WindowWidgetProps } from "../../../services/windowRegistry"
import { useColors } from "../../../components/mca/primitives/useColors"
import { FONT_MONO, FONT_SANS } from "../../../components/mca/primitives/fonts"
import { subscribeApp, useAppSlice, watchDay } from "../data/todoStore"
import { useTodoApp } from "../data/useTodoApp"
import { todayIso } from "../model/days"
import type { NodeState } from "../model/types"
import { useTd } from "../ui/tokens"
import type { TodoWindowProps } from "../definition"
import { daySummary, STATE_BAR, treeSummary } from "./summary"

const Dim = ({ children, testID }: { children: React.ReactNode; testID?: string }) => {
  const c = useColors()
  return (
    <Text testID={testID} style={{ fontFamily: FONT_SANS, fontSize: 11.5, color: c.text3 }} numberOfLines={1}>
      {children}
    </Text>
  )
}

/** @spec NAV-REQ-20 */
export function TodoWidget({ props, workspaceId }: WindowWidgetProps<TodoWindowProps>) {
  const { t } = useTranslation()
  const app = useTodoApp({ workspaceId: props.workspaceId ?? workspaceId ?? undefined, appId: props.appId })
  const appId = app.status === "ready" ? app.appId : null
  useEffect(() => (appId ? subscribeApp(appId) : undefined), [appId])

  if (app.status === "resolving") return <Dim>…</Dim>
  if (!appId) return <Dim testID="widget-todo-unavailable">{t("nav.widgetUnavailable")}</Dim>
  return props.view === "day" ? <DayFace appId={appId} /> : <TreeFace appId={appId} focusId={props.focusId} />
}

function StateDot({ state, size = 7 }: { state: NodeState; size?: number }) {
  const td = useTd()
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: td.st[state] }} />
}

function TreeFace({ appId, focusId }: { appId: string; focusId?: string | null }) {
  const { t } = useTranslation()
  const c = useColors()
  const td = useTd()
  const nodes = useAppSlice(appId, (s) => s.nodes)
  const status = useAppSlice(appId, (s) => s.treeStatus)
  if (status === "error") return <Dim testID="widget-todo-unavailable">{t("nav.widgetUnavailable")}</Dim>
  if (status === "loading" && nodes.length === 0) return <Dim>…</Dim>
  const s = treeSummary(nodes, focusId)
  const chips = (["working", "review", "blocked"] as NodeState[]).filter((k) => s.counts[k] > 0)
  return (
    <View style={{ gap: 7 }} testID="widget-todo-tree">
      <Dim>{s.focusText ?? t("nav.widgetAllTasks")}</Dim>
      <View style={{ flexDirection: "row", height: 5, borderRadius: 3, overflow: "hidden", backgroundColor: c.wash2 }}>
        {STATE_BAR.filter((k) => s.counts[k] > 0).map((k) => (
          <View key={k} style={{ flex: s.counts[k], backgroundColor: td.st[k] }} />
        ))}
      </View>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <Text style={{ fontFamily: FONT_MONO, fontSize: 15, color: c.text }} testID="widget-todo-open">
          {s.open}
        </Text>
        <Dim>{t("nav.widgetOpenLabel")}</Dim>
        {chips.map((k) => (
          <View key={k} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <StateDot state={k} size={6} />
            <Text style={{ fontFamily: FONT_MONO, fontSize: 11, color: c.text2 }}>{s.counts[k]}</Text>
          </View>
        ))}
      </View>
    </View>
  )
}

function DayFace({ appId }: { appId: string }) {
  const { t } = useTranslation()
  const c = useColors()
  const td = useTd()
  const today = todayIso()
  const data = useAppSlice(appId, (s) => s.days[today])
  const status = useAppSlice(appId, (s) => s.treeStatus)
  useEffect(() => watchDay(appId, today, today), [appId, today])
  if (status === "error") return <Dim testID="widget-todo-unavailable">{t("nav.widgetUnavailable")}</Dim>
  if (!data) return <Dim>…</Dim>
  const s = daySummary(data)
  return (
    <View style={{ gap: 6 }} testID="widget-todo-day">
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <Text style={{ fontFamily: FONT_MONO, fontSize: 15, color: c.text }} testID="widget-todo-open">
          {s.open}
        </Text>
        <Dim>{t("nav.widgetToday")}</Dim>
        {s.overdue > 0 ? (
          <Text style={{ fontFamily: FONT_SANS, fontSize: 11, color: td.st.blocked }} testID="widget-todo-overdue">
            {t("nav.widgetOverdue", { n: s.overdue })}
          </Text>
        ) : null}
        {s.done > 0 ? <Dim>{t("nav.widgetDone", { n: s.done })}</Dim> : null}
      </View>
      {s.top.length === 0 ? (
        <Dim>{t("nav.widgetNoTasks")}</Dim>
      ) : (
        s.top.map((task) => (
          <View key={task.nodeId} style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
            <StateDot state={task.overdue ? "blocked" : task.state} />
            <Text style={{ fontFamily: FONT_SANS, fontSize: 12, color: c.text2, flex: 1 }} numberOfLines={1}>
              {task.text}
            </Text>
          </View>
        ))
      )}
      {s.open + s.overdue > s.top.length ? <Dim>{t("nav.widgetMore", { n: s.open + s.overdue - s.top.length })}</Dim> : null}
    </View>
  )
}
