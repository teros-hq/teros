/**
 * HomeWindowContent — the "Inicio" page of the OS prototype (design-testing).
 *
 *   ┌──────────────────────────────┬────────────────┐
 *   │ HERO  date · greeting        │ TE ESPERAN     │
 *   │       pills · ask · chips    │ N · approvals  │
 *   ├──────────┬──────────┬────────┴────────────────┤
 *   │ EQUIPO   │ PROYECTOS│ PULSO                   │
 *   └──────────┴──────────┴─────────────────────────┘
 *
 * Everything is live data: pending permissions (usePendingPermissions) and
 * terminals waiting for an answer (useTerminalNeeds, the chat's needs-you card),
 * agents + channels (navbar/chat stores), projects + board summaries
 * (board API). Narrow panes stack the cards in one column.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react"
import { Platform, Pressable, TextInput, View, useWindowDimensions } from "react-native"
import { useTranslation } from "react-i18next"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semantic } from "../../components/mca/primitives/colors"
import { FONT_SANS, FONT_SERIF } from "../../components/mca/primitives/fonts"
import { Avatar } from "../../components/Avatar"
import { TerosLoading } from "../../components/TerosLoading"
import { Btn, Card, ChipBtn, EmptyHint, IconBtn, Ph, T } from "../../components/ui/ds"
import { usePendingPermissions } from "../../hooks/usePendingPermissions"
import { TerminalNeedCard } from "../../components/needsYou/TerminalNeedCard"
import { useTerminalNeeds } from "../../components/needsYou/useTerminalNeeds"
import { getTerosClient } from "../../services/terosClientSingleton"
import type { BoardSummary, ProjectData } from "../../services/BoardApi"
import { useAuthStore } from "../../store/authStore"
import { useChatStore } from "../../store/chatStore"
import { useNavbarStore } from "../../store/navbarStore"
import { useTilingStore } from "../../store/tilingStore"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { getColumnColor } from "../BoardWindow/board-utils"
import { fx } from "../../styles/fx"
import { HeroDrift } from "./HeroDrift"

interface Props {
  windowId: string
  workspaceId?: string
}

/** Column name → prototype slug, so progress bars take the board tints. */
function slugOf(name: string): string {
  const n = name.trim().toLowerCase()
  if (n.includes("backlog")) return "backlog"
  if (n.includes("progress") || n.includes("curso") || n.includes("doing")) return "in_progress"
  if (n.includes("block")) return "blocked"
  if (n.includes("review") || n.includes("revis")) return "review"
  if (n.includes("done") || n.includes("hech") || n.includes("complet")) return "done"
  if (n.includes("to do") || n === "todo" || n.includes("por hacer")) return "todo"
  return n.replace(/\s+/g, "_")
}

function isToday(iso?: string | null): boolean {
  if (!iso) return false
  const d = new Date(iso)
  const now = new Date()
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  )
}

/** First human-readable string in a tool input — the "→ marta@acme.com" of the prototype. */
function targetOf(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined
  for (const k of [
    "to",
    "recipient",
    "email",
    "title",
    "name",
    "path",
    "query",
    "url",
    "channel",
    "subject",
  ]) {
    const v = input[k]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  const first = Object.values(input).find((v) => typeof v === "string" && (v as string).trim())
  return typeof first === "string" ? first.trim() : undefined
}

export function HomeWindowContent({ windowId, workspaceId: propWorkspaceId }: Props) {
  const { t, i18n } = useTranslation()
  const c = useColors()
  const { width: windowWidth } = useWindowDimensions()
  const [paneWidth, setPaneWidth] = useState(0)
  const w = paneWidth || windowWidth
  const stacked = w < 900
  const narrow = w < 620

  const { openWindow } = useTilingStore()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const workspaceId = propWorkspaceId ?? activeWorkspaceId ?? undefined
  const user = useAuthStore((s) => s.user)
  const agents = useNavbarStore((s) => s.agents)
  const channels = useChatStore((s) => s.channels)
  const { pendingPermissions, handleApprove, handleDeny } = usePendingPermissions()
  const terminalNeeds = useTerminalNeeds()

  // ── Agents: superagent first, then the workspace's ───────────────────────
  const teamAgents = useMemo(() => {
    const supers = agents.filter((a) => !a.workspaceId)
    const own = agents.filter((a) => a.workspaceId && a.workspaceId === workspaceId)
    return [...supers, ...own]
  }, [agents, workspaceId])

  // ── Live channel signals: who is working, what waits for review ──────────
  const channelList = useMemo(() => Object.values(channels), [channels])
  const workingByAgent = useMemo(() => {
    const m = new Map<string, string>()
    for (const ch of channelList) {
      if (ch.isTyping && ch.agentId && !m.has(ch.agentId)) m.set(ch.agentId, ch.title)
    }
    return m
  }, [channelList])
  const reviewCount = useMemo(
    () => channelList.filter((ch) => ch.externalActionRequested).length,
    [channelList],
  )
  const chatsToday = useMemo(
    () => channelList.filter((ch) => isToday(ch.lastMessageAt)).length,
    [channelList],
  )

  // ── Projects + summaries ──────────────────────────────────────────────────
  const [projects, setProjects] = useState<ProjectData[]>([])
  const [summaries, setSummaries] = useState<Record<string, BoardSummary>>({})
  const [projectsLoaded, setProjectsLoaded] = useState(false)
  useEffect(() => {
    let cancelled = false
    if (!workspaceId) {
      setProjects([])
      setProjectsLoaded(true)
      return
    }
    ;(async () => {
      try {
        const client = getTerosClient()
        const { projects: list } = await client.board.listProjects(workspaceId)
        if (cancelled) return
        const active = (list ?? []).filter((p) => p.status !== "archived")
        setProjects(active)
        const pairs = await Promise.all(
          active.slice(0, 6).map(async (p) => {
            try {
              const raw = (await client.board.getBoardSummary(p.projectId)) as any
              // The backend answers `{ board, columnSummaries: [{ columnId, name, count }], totalTasks }`;
              // normalise to the client's BoardSummary (`columns[].taskCount`).
              const cols: BoardSummary["columns"] = Array.isArray(raw?.columns)
                ? raw.columns
                : (raw?.columnSummaries ?? []).map((col: any) => ({
                    columnId: col.columnId,
                    name: col.name,
                    taskCount: col.taskCount ?? col.count ?? 0,
                  }))
              const s: BoardSummary = {
                boardId: raw?.boardId ?? raw?.board?.boardId ?? p.boardId,
                columns: cols,
                totalTasks: raw?.totalTasks ?? cols.reduce((a, col) => a + (col.taskCount ?? 0), 0),
              }
              return [p.projectId, s] as const
            } catch {
              return null
            }
          }),
        )
        if (cancelled) return
        const next: Record<string, BoardSummary> = {}
        for (const pair of pairs) if (pair) next[pair[0]] = pair[1]
        setSummaries(next)
      } catch {
        if (!cancelled) setProjects([])
      } finally {
        if (!cancelled) setProjectsLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const openTasks = useMemo(
    () =>
      Object.values(summaries).reduce(
        (acc, s) =>
          acc +
          (s?.columns ?? [])
            .filter((col) => slugOf(col.name) !== "done")
            .reduce((a, col) => a + (col.taskCount ?? 0), 0),
        0,
      ),
    [summaries],
  )

  // ── Ask box ───────────────────────────────────────────────────────────────
  const [askAgentId, setAskAgentId] = useState<string | null>(null)
  const askAgent = teamAgents.find((a) => a.agentId === askAgentId) ?? teamAgents[0]
  const [ask, setAsk] = useState("")
  const submitAsk = useCallback(() => {
    if (!askAgent) return
    const text = ask.trim()
    openWindow(
      "chat",
      {
        agentId: askAgent.agentId,
        agentName: askAgent.name,
        workspaceId,
        initialDraft: text || undefined,
      },
      false,
      windowId,
    )
    setAsk("")
  }, [ask, askAgent, openWindow, windowId, workspaceId])
  const cycleAgent = useCallback(() => {
    if (teamAgents.length < 2) return
    const i = teamAgents.findIndex((a) => a.agentId === askAgent?.agentId)
    setAskAgentId(teamAgents[(i + 1) % teamAgents.length].agentId)
  }, [askAgent, teamAgents])

  // ── Greeting ──────────────────────────────────────────────────────────────
  const hour = new Date().getHours()
  const greeting =
    hour < 6
      ? t("home.greetingNight", { defaultValue: "Buenas noches" })
      : hour < 13
        ? t("home.greetingMorning", { defaultValue: "Buenos días" })
        : hour < 20
          ? t("home.greetingAfternoon", { defaultValue: "Buenas tardes" })
          : t("home.greetingNight", { defaultValue: "Buenas noches" })
  const firstName = (user?.name ?? "").trim().split(/\s+/)[0] || ""
  const dateLabel = new Date().toLocaleDateString(i18n.language || undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  })

  // Terminals first (an answer unblocks a running agent), then approvals: three at most.
  const approvalsCount = pendingPermissions.length + terminalNeeds.length
  const shownNeeds = terminalNeeds.slice(0, 3)
  const shownPermissions = pendingPermissions.slice(0, 3 - shownNeeds.length)
  const workingCount = teamAgents.filter((a) => workingByAgent.has(a.agentId)).length

  const openApprovals = () => openWindow("pending-approvals", { workspaceId }, false)
  const openConversations = () => openWindow("conversations", { workspaceId }, false)
  const openAgent = (agentId: string) => openWindow("agent", { agentId, workspaceId }, false)
  const openBoard = (p: ProjectData) =>
    openWindow("board", { projectId: p.projectId, projectName: p.name, view: "kanban" }, false)

  const suggestions = [
    t("home.sugInbox", { defaultValue: "Resume mi bandeja de entrada" }),
    t("home.sugWeek", { defaultValue: "Prepara mi semana" }),
    t("home.sugBlocked", { defaultValue: "¿Qué está bloqueado?" }),
  ]

  // ── Cards ─────────────────────────────────────────────────────────────────
  const hero = (
    <Card
      xl
      {...fx("hc", { d: "0" })}
      style={{
        flex: stacked ? undefined : 8,
        minHeight: narrow ? 300 : 340,
        padding: 0,
      }}
    >
      {/* Drifting colour at the right edge, veiled towards the text */}
      {Platform.OS === "web" ? (
        <>
          {/* `.hero-bg[data-kind="drift"]`: the prototype's drift canvas */}
          <HeroDrift bg={c.bgFrame} size={380} wander={0.8} />
          <View
            pointerEvents="none"
            style={[
              { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
              {
                // `.hero-bg:after` — the veil towards the text
                background: `linear-gradient(100deg, ${c.bgStep} 14%, ${c.bgStep}8c 46%, transparent 78%)`,
              } as any,
            ]}
          />
        </>
      ) : null}

      <View
        style={{
          flex: 1,
          padding: narrow ? 18 : 28,
          paddingBottom: narrow ? 16 : 22,
          gap: 16,
          minHeight: narrow ? 300 : 340,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <T step="codenote" tone="text3">
            {dateLabel.toUpperCase()}
          </T>
        </View>
        <View style={{ flex: 1 }} />
        <T
          style={{
            fontFamily: FONT_SERIF,
            fontSize: narrow ? 34 : 52,
            lineHeight: narrow ? 38 : 54,
            letterSpacing: narrow ? -0.3 : -0.8,
            color: c.text,
          }}
        >
          {greeting}
          {firstName ? `, ${firstName}.` : "."}
        </T>

        {/* Status pills */}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <HeroPill
            dot={semantic.amber}
            n={approvalsCount}
            label={t("home.pillApprovals", { defaultValue: "esperan tu permiso" })}
            on={approvalsCount > 0}
            tone="a"
            onPress={openApprovals}
          />
          <HeroPill
            dot={semantic.purple200}
            n={reviewCount}
            label={t("home.pillReview", { defaultValue: "para revisar" })}
            tone="i"
            onPress={openConversations}
          />
          <HeroPill
            dot={semantic.mint300}
            n={workingCount}
            label={t("home.pillWorking", { defaultValue: "agentes trabajando" })}
            tone="m"
            onPress={openConversations}
          />
        </View>

        {/* Ask */}
        <View
          style={[
            {
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              maxWidth: 620,
              padding: 5,
              paddingLeft: 6,
              borderRadius: 100,
              backgroundColor: c.bgStep,
              borderWidth: 1,
              borderColor: c.border,
            },
            Platform.OS === "web" ? ({ boxShadow: c.elevHover } as any) : null,
          ]}
        >
          {askAgent ? (
            <Pressable
              onPress={cycleAgent}
              accessibilityRole="button"
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 7,
                height: 38,
                paddingLeft: 5,
                paddingRight: 10,
                borderRadius: 100,
                backgroundColor: c.wash,
              }}
            >
              <Avatar name={askAgent.name} imageUrl={askAgent.avatarUrl} size={28} isAgent />
              {!narrow ? <T step="sm">{askAgent.name.split(" ")[0]}</T> : null}
              {teamAgents.length > 1 ? <Ph name="caret-up-down" size={12} color={c.text3} /> : null}
            </Pressable>
          ) : null}
          <TextInput
            value={ask}
            onChangeText={setAsk}
            onSubmitEditing={submitAsk}
            placeholder={
              askAgent
                ? t("home.askPlaceholder", {
                    defaultValue: "Pídele algo a {{name}}…",
                    name: askAgent.name.split(" ")[0],
                  })
                : t("home.askPlaceholderNoAgent", { defaultValue: "Crea un agente para empezar" })
            }
            placeholderTextColor={c.text3}
            editable={!!askAgent}
            style={[
              {
                flex: 1,
                minWidth: 0,
                fontFamily: FONT_SANS,
                fontSize: 15,
                color: c.text,
                paddingVertical: 0,
              },
              Platform.OS === "web" ? ({ outlineStyle: "none" } as any) : null,
            ]}
            returnKeyType="send"
          />
          <Pressable
            onPress={submitAsk}
            disabled={!askAgent}
            accessibilityRole="button"
            accessibilityLabel={t("home.ask", { defaultValue: "Empezar chat" })}
            style={{
              width: 38,
              height: 38,
              borderRadius: 19,
              backgroundColor: ask.trim() ? semantic.mint200 : c.wash2,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ph name="arrow-up" size={17} color={ask.trim() ? semantic.mint500 : c.text3} />
          </Pressable>
        </View>
        <View
          style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, maxWidth: 620, marginTop: -6 }}
        >
          {suggestions.map((s) => (
            <ChipBtn key={s} onPress={() => setAsk(s)}>
              {s}
            </ChipBtn>
          ))}
        </View>
      </View>
    </Card>
  )

  const approvals = (
    <Card
      xl
      style={{
        flex: stacked ? undefined : 4,
        minHeight: stacked ? undefined : 340,
        padding: narrow ? 16 : 20,
        gap: 14,
      }}
      {...fx(approvalsCount > 0 ? "hc cloud" : "hc", { d: "1" })}
    >
      <CardHead
        icon="shield-check"
        title={t("home.waiting", { defaultValue: "Te esperan" })}
        onGo={openApprovals}
      />
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
        <T
          style={{
            fontFamily: FONT_SERIF,
            fontSize: 56,
            lineHeight: 52,
            letterSpacing: -1.5,
            color: c.text,
          }}
        >
          {approvalsCount}
        </T>
        <T step="sm" tone="text2" style={{ flexShrink: 1 }}>
          {terminalNeeds.length
            ? t("home.waitingLeadAny", {
                defaultValue: "things waiting for your answer",
                count: approvalsCount,
              })
            : t("home.waitingLead", {
                defaultValue: "acciones pendientes de tu permiso",
                count: approvalsCount,
              })}
        </T>
      </View>
      <View style={{ flex: 1 }} />
      {approvalsCount === 0 ? (
        <T step="sm" color={c.tint.g.tx} style={{ paddingVertical: 8 }}>
          {t("home.waitingEmpty", { defaultValue: "Nada pendiente. Tus agentes van solos." })}
        </T>
      ) : (
        <View style={{ gap: 8 }}>
          {shownNeeds.map((need) => (
            <TerminalNeedCard key={need.session.terminalId} need={need} />
          ))}
          {shownPermissions.map((p) => {
            const target = targetOf(p.input)
            return (
              <View
                key={p.requestId}
                style={{ borderRadius: 16, backgroundColor: c.nest, padding: 12, gap: 10 }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 }}>
                  {p.agentAvatarUrl || p.agentName ? (
                    <Avatar
                      name={p.agentName ?? "A"}
                      imageUrl={p.agentAvatarUrl}
                      size={20}
                      isAgent
                    />
                  ) : null}
                  <T step="12" tone="text3" ellipsis style={{ flex: 1 }}>
                    <T step="12" tone="text">
                      {p.agentName ?? t("home.anAgent", { defaultValue: "Un agente" })}
                    </T>{" "}
                    {t("home.wants", { defaultValue: "quiere" })}{" "}
                    <T step="code" tone="text">
                      {p.toolName}
                    </T>
                    {target ? ` → ${target}` : ""}
                  </T>
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Btn
                    variant="primary"
                    size="sm"
                    icon="check"
                    onPress={() => handleApprove(p.requestId)}
                  >
                    {t("permissions.allow", { defaultValue: "Permitir" })}
                  </Btn>
                  <Btn variant="sec" size="sm" onPress={() => handleDeny(p.requestId)}>
                    {t("permissions.deny", { defaultValue: "Denegar" })}
                  </Btn>
                  <View style={{ flex: 1 }} />
                  <IconBtn
                    icon="arrow-up-right"
                    plain
                    sm
                    onPress={() =>
                      openWindow(
                        "chat",
                        { channelId: p.channelId, agentName: p.agentName, workspaceId },
                        false,
                      )
                    }
                    title={t("home.openInChat", { defaultValue: "Ver en el chat" })}
                  />
                </View>
              </View>
            )
          })}
          {approvalsCount > 3 ? (
            <Btn
              variant="ghost"
              size="sm"
              iconRight="arrow-right"
              onPress={openApprovals}
              style={{ alignSelf: "flex-end" }}
            >
              {t("home.moreApprovals", { defaultValue: "+{{n}} más", n: approvalsCount - 3 })}
            </Btn>
          ) : null}
        </View>
      )}
    </Card>
  )

  const team = (
    <Card xl {...fx("hc", { d: "1" })} style={{ flex: 1, padding: narrow ? 16 : 20, gap: 10 }}>
      <CardHead
        icon="users-three"
        title={t("home.team", { defaultValue: "Tu equipo ahora" })}
        meta={`${workingCount}/${teamAgents.length} ${t("home.active", { defaultValue: "activos" })}`}
        onGo={teamAgents[0] ? () => openAgent(teamAgents[0].agentId) : undefined}
      />
      {teamAgents.length === 0 ? (
        <EmptyHint>{t("home.noAgents", { defaultValue: "Aún no tienes agentes." })}</EmptyHint>
      ) : (
        <View style={{ marginHorizontal: -8, gap: 2 }}>
          {teamAgents.slice(0, 6).map((a) => {
            const working = workingByAgent.get(a.agentId)
            return (
              <Pressable
                key={a.agentId}
                onPress={() => openAgent(a.agentId)}
                accessibilityRole="button"
                style={({ hovered }: any) => [
                  {
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    padding: 8,
                    paddingRight: 13,
                    borderRadius: 16,
                  },
                  hovered ? { backgroundColor: c.wash } : null,
                ]}
              >
                <Avatar
                  name={a.name}
                  imageUrl={a.avatarUrl}
                  size={36}
                  isAgent
                  status={working ? "busy" : "idle"}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T step="sm" numberOfLines={1}>
                    {a.name}
                    {a.role ? <T step="12" tone="text3">{` · ${a.role}`}</T> : null}
                  </T>
                  <T step="12" color={working ? c.accent : c.text3} numberOfLines={1}>
                    {working
                      ? t("home.workingOn", {
                          defaultValue: "Trabajando en «{{title}}»",
                          title: working,
                        })
                      : t("home.idle", { defaultValue: "Sin tareas asignadas" })}
                  </T>
                </View>
                {working ? (
                  <TerosLoading size={16} color={c.accent} />
                ) : (
                  <Ph name="circle-dashed" size={16} color={c.text3} />
                )}
              </Pressable>
            )
          })}
        </View>
      )}
    </Card>
  )

  const projectsCard = (
    <Card xl {...fx("hc", { d: "2" })} style={{ flex: 1, padding: narrow ? 16 : 20, gap: 10 }}>
      <CardHead
        icon="kanban"
        title={t("home.projects", { defaultValue: "Proyectos" })}
        meta={projects.length ? String(projects.length) : undefined}
        onGo={projects[0] ? () => openBoard(projects[0]) : undefined}
      />
      {!projectsLoaded ? null : projects.length === 0 ? (
        <EmptyHint>{t("home.noProjects", { defaultValue: "Sin proyectos todavía." })}</EmptyHint>
      ) : (
        <View style={{ marginHorizontal: -6 }}>
          {projects.slice(0, 4).map((p, i) => {
            const s = summaries[p.projectId]
            const total = s?.totalTasks ?? 0
            const done = s?.columns.find((col) => slugOf(col.name) === "done")?.taskCount ?? 0
            const pct = total ? Math.round((done / total) * 100) : 0
            return (
              <Pressable
                key={p.projectId}
                onPress={() => openBoard(p)}
                accessibilityRole="button"
                style={({ hovered }: any) => [
                  { padding: 14, borderRadius: 16, gap: 10 },
                  i > 0 ? { borderTopWidth: 1, borderTopColor: c.border } : null,
                  hovered ? { backgroundColor: c.wash } : null,
                ]}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <T step="sm" ellipsis style={{ flex: 1 }}>
                    {p.name}
                  </T>
                  <T step="codenote" tone="text3">
                    {total ? `${pct}%` : "—"}
                  </T>
                </View>
                <View
                  style={{
                    flexDirection: "row",
                    gap: 2,
                    height: 6,
                    borderRadius: 3,
                    overflow: "hidden",
                    backgroundColor: c.wash2,
                  }}
                >
                  {(s?.columns ?? [])
                    .filter((col) => col.taskCount > 0)
                    .map((col) => (
                      <View
                        key={col.columnId}
                        style={{
                          flex: col.taskCount,
                          backgroundColor: getColumnColor(slugOf(col.name)),
                        }}
                      />
                    ))}
                </View>
                {p.description ? (
                  <T step="12" tone="text3" numberOfLines={1}>
                    {p.description}
                  </T>
                ) : null}
              </Pressable>
            )
          })}
        </View>
      )}
    </Card>
  )

  const pulse = (
    <Card xl {...fx("hc", { d: "3" })} style={{ flex: 1, padding: narrow ? 16 : 20, gap: 10 }}>
      <CardHead icon="pulse" title={t("home.pulse", { defaultValue: "Pulso" })} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <Kpi v={chatsToday} label={t("home.kpiChatsToday", { defaultValue: "chats hoy" })} />
        <Kpi v={openTasks} label={t("home.kpiOpenTasks", { defaultValue: "tareas abiertas" })} />
        <Kpi v={workingCount} label={t("home.kpiWorking", { defaultValue: "agentes activos" })} />
        <Kpi
          v={pendingPermissions.length}
          label={t("home.kpiApprovals", { defaultValue: "aprobaciones" })}
          tone={pendingPermissions.length > 0 ? "warn" : undefined}
        />
      </View>
    </Card>
  )

  return (
    <View
      style={{ flex: 1, backgroundColor: c.bgSheet }}
      onLayout={(e) => setPaneWidth(e.nativeEvent.layout.width)}
    >
      <HomeScroll padH={narrow ? 12 : 20} padV={narrow ? 12 : 18}>
        <View style={{ flexDirection: stacked ? "column" : "row", gap: 10 }}>
          {hero}
          {approvals}
        </View>
        <View style={{ flexDirection: stacked ? "column" : "row", gap: 10 }}>
          {team}
          {projectsCard}
          {pulse}
        </View>
      </HomeScroll>
    </View>
  )
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function HomeScroll({
  children,
  padH,
  padV,
}: {
  children: React.ReactNode
  padH: number
  padV: number
}) {
  const { ScrollView } = require("react-native") as typeof import("react-native")
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingHorizontal: padH, paddingVertical: padV, gap: 10 }}
      {...(Platform.OS === "web" ? ({ className: "chat-scroll" } as any) : {})}
    >
      {children}
    </ScrollView>
  )
}

function CardHead({
  icon,
  title,
  meta,
  onGo,
}: {
  icon: string
  title: string
  meta?: string
  onGo?: () => void
}) {
  const c = useColors()
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 26 }}>
      <Ph name={icon} size={16} color={c.text3} />
      <T step="sm" tone="text2" style={{ flex: 1 }} numberOfLines={1}>
        {title}
      </T>
      {meta ? (
        <T step="codenote" tone="text3">
          {meta}
        </T>
      ) : null}
      {onGo ? <IconBtn icon="arrow-up-right" plain sm onPress={onGo} /> : null}
    </View>
  )
}

function HeroPill({
  dot,
  n,
  label,
  on,
  tone,
  onPress,
}: {
  dot: string
  n: number
  label: string
  on?: boolean
  tone: "a" | "i" | "m"
  onPress: () => void
}) {
  const c = useColors()
  const strong = tone === "a" ? c.tint.a.tx : tone === "i" ? c.accent : c.tint.m.tx
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ hovered }: any) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          height: 30,
          paddingLeft: 10,
          paddingRight: 8,
          borderRadius: 100,
          backgroundColor: on ? c.wash2 : c.wash,
          borderWidth: 1,
          borderColor: hovered ? c.borderStrong : "transparent",
        },
        Platform.OS === "web" ? ({ cursor: "pointer", transition: "all 0.25s" } as any) : null,
      ]}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dot }} />
      <T step="sm" color={strong}>
        {n}
      </T>
      <T step="sm" tone="text2">
        {label}
      </T>
      <Ph name="arrow-right" size={11} color={c.text3} />
    </Pressable>
  )
}

function Kpi({ v, label, tone }: { v: number; label: string; tone?: "warn" }) {
  const c = useColors()
  return (
    <View
      style={{
        flexBasis: "46%",
        flexGrow: 1,
        borderRadius: 16,
        backgroundColor: c.wash,
        padding: 12,
        gap: 4,
        minWidth: 110,
      }}
    >
      <T
        style={{
          fontFamily: FONT_SERIF,
          fontSize: 34,
          lineHeight: 36,
          letterSpacing: -0.7,
          color: tone === "warn" ? c.tint.a.tx : c.text,
        }}
      >
        {v}
      </T>
      <T step="12" tone="text3">
        {label}
      </T>
    </View>
  )
}
