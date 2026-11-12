/**
 * ProjectsWidget — the rail widget of a pinned Projects window (NAV-REQ-20):
 * the workspace's projects with their task count; a row opens the project's
 * board, the card opens the list.
 *
 * @spec NAV-REQ-20
 */
import { useEffect, useState } from "react"
import { Platform, Pressable, Text, View } from "react-native"
import { useTranslation } from "react-i18next"
import type { WindowWidgetProps } from "../../services/windowRegistry"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useTilingStore } from "../../store/tilingStore"
import { useColors } from "../../components/mca/primitives/useColors"
import { FONT_MONO, FONT_SANS } from "../../components/mca/primitives/fonts"
import { Ph } from "../../components/ui/ds"
import type { ProjectsListWindowProps } from "./definition"

const MAX_ROWS = 4
const EVENTS = ["project.created", "project.updated", "project.deleted"]

interface Row {
  projectId: string
  name: string
  tasks: number | null
}

/** @spec NAV-REQ-20 */
export function ProjectsWidget({ props, workspaceId }: WindowWidgetProps<ProjectsListWindowProps>) {
  const { t } = useTranslation()
  const c = useColors()
  const wsId = props.workspaceId ?? workspaceId ?? null
  const [state, setState] = useState<{ rows: Row[]; total: number } | null>(null)

  useEffect(() => {
    if (!wsId) return
    let alive = true
    const client = getTerosClient()
    const load = async () => {
      try {
        const { projects } = await client.board.listProjects(wsId)
        const top = projects.slice(0, MAX_ROWS)
        const counts = await Promise.all(
          top.map((p) => client.board.getBoardSummary(p.projectId).then((s) => s.totalTasks).catch(() => null)),
        )
        if (alive) setState({ rows: top.map((p, i) => ({ projectId: p.projectId, name: p.name, tasks: counts[i] })), total: projects.length })
      } catch (err) {
        console.warn("[ProjectsWidget] load failed:", err)
      }
    }
    void load()
    const refresh = () => void load()
    for (const ev of EVENTS) client.on(ev, refresh)
    return () => {
      alive = false
      for (const ev of EVENTS) client.off(ev, refresh)
    }
  }, [wsId])

  const open = (row: Row) => {
    useTilingStore.getState().openWindow("board", { projectId: row.projectId, projectName: row.name, view: "mission" }, false)
  }

  const dim = { fontFamily: FONT_SANS, fontSize: 11.5, color: c.text3 }
  if (!state) return <Text style={dim}>…</Text>
  if (state.rows.length === 0) return <Text style={dim} testID="widget-projects-empty">{t("nav.widgetNoProjects")}</Text>
  return (
    <View style={{ gap: 2 }} testID="widget-projects">
      {state.rows.map((row) => {
        const inner = (
          <>
            <Ph name="kanban" size={12} color={c.text3} />
            <Text style={{ fontFamily: FONT_SANS, fontSize: 12, color: c.text2, flex: 1 }} numberOfLines={1}>
              {row.name}
            </Text>
            {row.tasks !== null ? (
              <Text style={{ fontFamily: FONT_MONO, fontSize: 11, color: c.text3 }}>{row.tasks}</Text>
            ) : null}
          </>
        )
        const rowStyle = { flexDirection: "row" as const, alignItems: "center" as const, gap: 7, paddingVertical: 3, paddingHorizontal: 4, marginHorizontal: -4, borderRadius: 6 }
        // On web the card is already a <button>: a nested Pressable swallows the click.
        return Platform.OS === "web" ? (
          <View
            key={row.projectId}
            testID={`widget-projects-row-${row.projectId}`}
            style={rowStyle}
            {...({ onClick: (e: any) => { e?.stopPropagation?.(); open(row) }, style: { cursor: "pointer" } } as any)}
          >
            {inner}
          </View>
        ) : (
          <Pressable key={row.projectId} testID={`widget-projects-row-${row.projectId}`} style={rowStyle} onPress={() => open(row)}>
            {inner}
          </Pressable>
        )
      })}
      {state.total > state.rows.length ? <Text style={dim}>{t("nav.widgetMore", { n: state.total - state.rows.length })}</Text> : null}
    </View>
  )
}
