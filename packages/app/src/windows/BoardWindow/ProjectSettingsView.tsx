/**
 * Project Settings View — the "Ajustes" tab of the board (OS prototype,
 * design-testing 22-project-settings): a narrow Page with one form Card
 * (name / description / context) and a second Card listing the fixed board
 * columns as nested rows. Saved explicitly with the primary pill.
 */

import React, { useCallback, useEffect, useState } from "react"
import { View } from "react-native"
import { useTranslation } from "react-i18next"
import type { Board, Project } from "../../store/boardStore"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useToast } from "../../components/Toast"
import { useColors } from "../../components/mca/primitives/useColors"
import {
  Btn,
  Card,
  Dot,
  EmptyState,
  Field,
  FieldGroup,
  FieldHelp,
  FieldLabel,
  Page,
  Ph,
  SectionLabel,
  T,
} from "../../components/ui/ds"
import { getColumnColor } from "./board-utils"

interface ProjectSettingsViewProps {
  project: Project | null
  board: Board | null
}

export function ProjectSettingsView({ project, board }: ProjectSettingsViewProps) {
  const { t } = useTranslation()
  const c = useColors()
  const client = getTerosClient()
  const toast = useToast()

  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [context, setContext] = useState("")
  const [saving, setSaving] = useState(false)

  // Sync form when project changes
  useEffect(() => {
    if (project) {
      setName(project.name ?? "")
      setDescription(project.description ?? "")
      setContext((project as any).context ?? "")
    }
  }, [project])

  const handleSave = useCallback(async () => {
    if (!project) return
    setSaving(true)
    try {
      await client.project.update(project.projectId, {
        name: name.trim() || undefined,
        description: description.trim() || undefined,
        context: context || undefined,
      })
      toast.show(t("board.settingsSaved"), { type: "success" })
    } catch (e) {
      console.error("[ProjectSettings] save error", e)
      toast.show(t("board.settingsSaveError"), { type: "error" })
    } finally {
      setSaving(false)
    }
  }, [project, client, name, description, context, toast, t])

  if (!project) {
    return (
      <Page narrow>
        <EmptyState icon="gear-six" title={t("board.selectProject")} />
      </Page>
    )
  }

  return (
    <Page narrow>
      <View style={{ gap: 16 }}>
        {/* Form card */}
        <Card pad={24}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              marginBottom: 20,
              flexWrap: "wrap",
            }}
          >
            <Ph name="gear-six" size={20} color={c.accent} />
            <T step="xl" style={{ flex: 1, minWidth: 160 }}>
              {t("board.settingsTitle")}
            </T>
            <Btn
              variant="primary"
              size="sm"
              onPress={handleSave}
              disabled={saving}
              loading={saving}
              testID="project-settings-save"
            >
              {saving ? t("board.settingsSaving") : t("board.settingsSave")}
            </Btn>
          </View>

          <FieldLabel required>{t("board.settingsName")}</FieldLabel>
          <Field
            lg
            value={name}
            onChangeText={setName}
            placeholder={t("board.settingsNamePlaceholder")}
            testID="project-settings-name"
          />

          <FieldGroup>
            <FieldLabel>{t("board.settingsDescription")}</FieldLabel>
            <Field
              value={description}
              onChangeText={setDescription}
              placeholder={t("board.settingsDescriptionPlaceholder")}
              testID="project-settings-description"
            />
          </FieldGroup>

          <FieldGroup>
            <FieldLabel>{t("board.settingsContext")}</FieldLabel>
            <Field
              area
              mono
              minHeight={140}
              value={context}
              onChangeText={setContext}
              placeholder={t("board.settingsContextPlaceholder")}
              testID="project-settings-context"
            />
            <FieldHelp>{t("board.settingsContextHint")}</FieldHelp>
          </FieldGroup>
        </Card>

        {/* Board columns (read-only) */}
        {board && board.columns.length > 0 && (
          <Card pad={24}>
            <SectionLabel
              label={t("board.settingsColumns")}
              count={board.columns.length}
              style={{ marginTop: 0 }}
            />
            <View style={{ gap: 8 }}>
              {board.columns.map((col, idx) => (
                <View
                  key={col.columnId}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    paddingVertical: 12,
                    paddingHorizontal: 14,
                    borderRadius: 12,
                    backgroundColor: c.nest,
                  }}
                >
                  <T step="codenote" tone="text3" style={{ width: 14 }}>
                    {String(idx + 1)}
                  </T>
                  <Dot color={getColumnColor(col.slug)} size={8} />
                  <T step="sm" style={{ flex: 1 }}>
                    {col.name}
                  </T>
                  <T step="codenote" tone="text3">
                    {col.slug}
                  </T>
                  <Ph name="lock-simple" size={13} color={c.text3} />
                </View>
              ))}
            </View>
            <FieldHelp>
              {t("board.settingsColumnsFixed", {
                defaultValue: "Columns are fixed: they cannot be renamed or reordered.",
              })}
            </FieldHelp>
          </Card>
        )}
      </View>
    </Page>
  )
}
