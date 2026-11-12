/**
 * Project Window Content — a project dashboard in the OS prototype language
 * (design-testing, Oct 2026): PageHead (eyebrow · serif name · lead), four
 * Stat tiles, the active tasks as an LGroup, and the context editor in a
 * Card with an autosaving textarea.
 */

import React, { useCallback, useEffect, useRef, useState } from "react"
import { View } from "react-native"
import { useTranslation } from "react-i18next"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useTilingStore } from "../../store/tilingStore"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semanticColors } from "../../components/mca/primitives/colors"
import { AppSpinner } from "../../components/ui/AppSpinner"
import {
  Btn,
  Card,
  Dot,
  Field,
  FieldHelp,
  FieldLabel,
  LGroup,
  LRow,
  Page,
  PageHead,
  SectionLabel,
  Stat,
  Stats,
  T,
} from "../../components/ui/ds"

interface Props {
  projectId: string
  projectName?: string
  workspaceId?: string
}

interface Project {
  projectId: string
  name: string
  description?: string
  context?: string
  boardId: string
}

interface Task {
  taskId: string
  title: string
  status: string
  assignedAgentId?: string
}

export function ProjectWindowContent({ projectId, projectName, workspaceId }: Props) {
  const { t } = useTranslation()
  const client = getTerosClient()
  const { openWindow } = useTilingStore()
  const c = useColors()

  const [project, setProject] = useState<Project | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [context, setContext] = useState("")
  const [loading, setLoading] = useState(true)
  const [savingContext, setSavingContext] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [projRes, tasksRes] = await Promise.all([
          client.project.get(projectId),
          client.board.listTasks(projectId),
        ])
        if (cancelled) return
        setProject(projRes.project)
        setContext(projRes.project?.context ?? "")
        setTasks((tasksRes.tasks ?? []) as any)
      } catch (e) {
        console.error("[ProjectWindow] load error", e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [projectId])

  const handleContextSave = useCallback(
    async (next: string) => {
      setSavingContext(true)
      try {
        await client.project.update(projectId, { context: next })
        setProject((prev) => (prev ? { ...prev, context: next } : null))
      } catch (e) {
        console.error("[ProjectWindow] save context error", e)
      } finally {
        setSavingContext(false)
      }
    },
    [projectId, client],
  )

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleContextChange = useCallback(
    (next: string) => {
      setContext(next)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        void handleContextSave(next)
      }, 800)
    },
    [handleContextSave],
  )
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [])

  // Stats
  const total = tasks.length
  const done = tasks.filter((t) => t.status === "done").length
  const inProgress = tasks.filter((t) => t.status === "working" || t.status === "assigned").length
  const blocked = tasks.filter((t) => t.status === "blocked").length
  const activeTasks = tasks.filter((t) => t.status === "working" || t.status === "assigned")

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: c.bgSheet,
        }}
      >
        <AppSpinner size="md" variant="brand" />
      </View>
    )
  }

  const title = project?.name ?? projectName ?? t("project.fallbackTitle")

  return (
    <Page>
      <PageHead
        eyebrow={t("project.eyebrow", { defaultValue: "Project" })}
        title={title}
        lead={project?.description || undefined}
        actions={
          <Btn
            variant="sec"
            icon="kanban"
            onPress={() =>
              openWindow("board", { projectId, projectName: project?.name ?? projectName })
            }
            testID="project-open-board"
          >
            {t("project.boardButton")}
          </Btn>
        }
      />

      {/* Stats */}
      <Stats cols={4}>
        <Stat v={total} label={t("project.total")} />
        <Stat v={done} label={t("project.done")} />
        <Stat v={inProgress} label={t("project.inProgress")} accent />
        <Stat v={blocked} label={t("project.blocked")} />
      </Stats>

      {/* Active tasks */}
      {activeTasks.length > 0 && (
        <View style={{ marginTop: 16 }}>
          <SectionLabel label={t("project.activeTasks")} count={activeTasks.length} />
          <LGroup>
            {activeTasks.map((task) => (
              <LRow key={task.taskId}>
                <Dot color={task.status === "working" ? semanticColors.amber : c.text3} size={8} />
                <T step="sm" ellipsis style={{ flex: 1 }}>
                  {task.title}
                </T>
                <T step="codenote" tone="text3">
                  {task.status}
                </T>
              </LRow>
            ))}
          </LGroup>
        </View>
      )}

      {/* Context */}
      <View style={{ marginTop: 24 }}>
        <SectionLabel
          label={t("project.contextTitle")}
          right={
            savingContext ? (
              <T step="codenote" tone="text3">
                {t("board.settingsSaving")}
              </T>
            ) : undefined
          }
        />
        <Card pad>
          <FieldLabel>{t("project.contextTitle")}</FieldLabel>
          <Field
            area
            mono
            minHeight={140}
            value={context}
            onChangeText={handleContextChange}
            placeholder={t("project.contextPlaceholder")}
            testID="project-context-input"
          />
          <FieldHelp>{t("board.settingsContextHint")}</FieldHelp>
        </Card>
      </View>
    </Page>
  )
}
