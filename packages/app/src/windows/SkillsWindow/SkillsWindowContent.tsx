/**
 * Skills Window Content
 *
 * CRUD UI for workspace-level skills (reusable instruction blocks for agents),
 * in the OS prototype's language: page head + "New skill" pill, a 3-column
 * grid of skill Cards (Tile · serif name · load-mode badge · description ·
 * mono preview · edit/delete), and inline create/edit forms built from the
 * `ui/ds` Field primitives. Uses the same transport.request pattern as
 * AgentWindowContent for skill API calls.
 */

import { useCallback, useEffect, useState } from "react"
import { Platform, Pressable, View } from "react-native"
import { useTranslation } from "react-i18next"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useToast } from "../../components/Toast"
import { useWorkspaceStore } from "../../store/workspaceStore"
import { FullscreenLoader } from "../../components/ui"
import type { SkillsWindowProps } from "./definition"
import { useColors } from "../../components/mca/primitives/useColors"
import {
  Badge,
  Btn,
  Card,
  EmptyState,
  Field,
  FieldGroup,
  FieldLabel,
  Grid,
  IconBtn,
  OptionRow,
  Page,
  PageHead,
  T,
  Tile,
} from "../../components/ui/ds"

interface Skill {
  skillId: string
  name: string
  description?: string
  content: string
  category?: string
  tags?: string[]
  loadMode?: "always" | "on-demand"
  createdAt: string
  updatedAt: string
}

interface SkillsWindowContentProps extends SkillsWindowProps {
  windowId: string
}

interface SkillFormState {
  name: string
  description: string
  content: string
  loadMode: "always" | "on-demand"
}

const EMPTY_FORM: SkillFormState = { name: "", description: "", content: "", loadMode: "on-demand" }

type Translate = (key: string, opts?: Record<string, unknown>) => string

/** Create / edit form — one Card with the four fields and the action row. */
function SkillForm({
  title,
  form,
  setForm,
  busy,
  busyLabel,
  submitLabel,
  onCancel,
  onSubmit,
  autoFocus,
  t,
}: {
  title: string
  form: SkillFormState
  setForm: (updater: (f: SkillFormState) => SkillFormState) => void
  busy: boolean
  busyLabel: string
  submitLabel: string
  onCancel: () => void
  onSubmit: () => void
  autoFocus?: boolean
  t: Translate
}) {
  return (
    <Card pad={20} accent style={{ width: "100%" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <Tile sm icon="book-open" />
        <T step="hsm" style={{ flex: 1 }}>
          {title}
        </T>
      </View>

      <FieldGroup>
        <FieldLabel required>{t("skills.labelName")}</FieldLabel>
        <Field
          value={form.name}
          onChangeText={(v) => setForm((f) => ({ ...f, name: v }))}
          placeholder={t("skills.namePlaceholder")}
          autoFocus={autoFocus}
        />
      </FieldGroup>

      <FieldGroup>
        <FieldLabel>{t("skills.labelDescription")}</FieldLabel>
        <Field
          value={form.description}
          onChangeText={(v) => setForm((f) => ({ ...f, description: v }))}
          placeholder={t("skills.descriptionPlaceholder")}
        />
      </FieldGroup>

      <FieldGroup>
        <FieldLabel required>{t("skills.labelContent")}</FieldLabel>
        <Field
          area
          mono
          minHeight={160}
          value={form.content}
          onChangeText={(v) => setForm((f) => ({ ...f, content: v }))}
          placeholder={t("skills.contentPlaceholder")}
        />
      </FieldGroup>

      <FieldGroup>
        <FieldLabel>{t("skills.labelLoadMode")}</FieldLabel>
        <View style={{ gap: 2 }}>
          <OptionRow
            on={form.loadMode === "always"}
            title={t("skills.loadModeAlways")}
            sub={t("skills.loadModeAlwaysHint", {
              defaultValue: "Injected into every turn of the agents that have it.",
            })}
            onPress={() => setForm((f) => ({ ...f, loadMode: "always" }))}
          />
          <OptionRow
            on={form.loadMode === "on-demand"}
            title={t("skills.loadModeOnDemand")}
            sub={t("skills.loadModeOnDemandHint", {
              defaultValue: "Loaded only when the agent asks for it.",
            })}
            onPress={() => setForm((f) => ({ ...f, loadMode: "on-demand" }))}
          />
        </View>
      </FieldGroup>

      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
        <Btn variant="ghost" icon="x" onPress={onCancel} disabled={busy}>
          {t("common.cancel")}
        </Btn>
        <Btn variant="primary" icon="check" onPress={onSubmit} loading={busy}>
          {busy ? busyLabel : submitLabel}
        </Btn>
      </View>
    </Card>
  )
}

export function SkillsWindowContent({
  windowId,
  workspaceId: propWorkspaceId,
}: SkillsWindowContentProps) {
  const { t } = useTranslation()
  const c = useColors()

  const [skills, setSkills] = useState<Skill[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // Create form
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState<SkillFormState>(EMPTY_FORM)
  const [isCreating, setIsCreating] = useState(false)

  // Edit state — one skill at a time
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<SkillFormState>(EMPTY_FORM)
  const [isSaving, setIsSaving] = useState(false)

  // Delete confirmation
  const [deletingSkillId, setDeletingSkillId] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Expanded content view
  const [expandedSkillId, setExpandedSkillId] = useState<string | null>(null)

  const client = getTerosClient()
  const toast = useToast()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const workspaceId = propWorkspaceId ?? activeWorkspaceId ?? ""

  const loadSkills = useCallback(async () => {
    if (!workspaceId) return
    setIsLoading(true)
    try {
      const result = await client.skillRequest("skill.list", { workspaceId })
      setSkills((result as any)?.skills ?? [])
    } catch (err: any) {
      console.error("[SkillsWindow] Error loading skills:", err)
      toast.error(t("skills.error"), t("skills.loadError"))
    } finally {
      setIsLoading(false)
    }
  }, [workspaceId, client])

  useEffect(() => {
    const tryLoad = async () => {
      if (client.isConnected()) {
        loadSkills()
      } else {
        const onConnected = () => {
          client.off("connected", onConnected)
          loadSkills()
        }
        client.on("connected", onConnected)
        return () => client.off("connected", onConnected)
      }
    }
    tryLoad()
  }, [loadSkills])

  // ── CREATE ──────────────────────────────────────────────────────────────────
  const handleCreate = async () => {
    if (!createForm.name.trim()) {
      toast.error(t("skills.error"), t("skills.nameRequired"))
      return
    }
    if (!createForm.content.trim()) {
      toast.error(t("skills.error"), t("skills.contentRequired"))
      return
    }
    setIsCreating(true)
    try {
      const result = await client.skillRequest("skill.create", {
        workspaceId,
        name: createForm.name.trim(),
        description: createForm.description.trim() || undefined,
        content: createForm.content.trim(),
        loadMode: createForm.loadMode,
      })
      const newSkill = (result as any)?.skill as Skill
      setSkills((prev) => [...prev, newSkill])
      setCreateForm(EMPTY_FORM)
      setShowCreate(false)
      toast.success(t("skills.created"), t("skills.createdMessage", { name: newSkill.name }))
    } catch (err: any) {
      console.error("[SkillsWindow] Error creating skill:", err)
      toast.error(t("skills.error"), t("skills.createError"))
    } finally {
      setIsCreating(false)
    }
  }

  // ── EDIT ────────────────────────────────────────────────────────────────────
  const startEdit = (skill: Skill) => {
    setEditingSkillId(skill.skillId)
    setEditForm({
      name: skill.name,
      description: skill.description ?? "",
      content: skill.content,
      loadMode: skill.loadMode ?? "on-demand",
    })
    setDeletingSkillId(null)
  }

  const cancelEdit = () => {
    setEditingSkillId(null)
    setEditForm(EMPTY_FORM)
  }

  const handleSave = async (skillId: string) => {
    if (!editForm.name.trim()) {
      toast.error(t("skills.error"), t("skills.nameRequired"))
      return
    }
    if (!editForm.content.trim()) {
      toast.error(t("skills.error"), t("skills.contentRequired"))
      return
    }
    setIsSaving(true)
    try {
      const result = await client.skillRequest("skill.update", {
        skillId,
        name: editForm.name.trim(),
        description: editForm.description.trim() || undefined,
        content: editForm.content.trim(),
        loadMode: editForm.loadMode,
      })
      const updated = (result as any)?.skill as Skill
      setSkills((prev) => prev.map((s) => (s.skillId === skillId ? updated : s)))
      setEditingSkillId(null)
      toast.success(t("skills.saved"), t("skills.updatedMessage", { name: updated.name }))
    } catch (err: any) {
      console.error("[SkillsWindow] Error updating skill:", err)
      toast.error(t("skills.error"), t("skills.saveError"))
    } finally {
      setIsSaving(false)
    }
  }

  // ── DELETE ───────────────────────────────────────────────────────────────────
  const handleDelete = async (skillId: string) => {
    setIsDeleting(true)
    try {
      await client.skillRequest("skill.delete", { skillId })
      setSkills((prev) => prev.filter((s) => s.skillId !== skillId))
      setDeletingSkillId(null)
      toast.success(t("skills.deleted"), t("skills.deletedMessage"))
    } catch (err: any) {
      console.error("[SkillsWindow] Error deleting skill:", err)
      toast.error(t("skills.error"), t("skills.deleteError"))
    } finally {
      setIsDeleting(false)
    }
  }

  const openCreate = () => {
    setShowCreate(true)
    setEditingSkillId(null)
    setDeletingSkillId(null)
  }

  // ── RENDER ───────────────────────────────────────────────────────────────────
  const renderSkillCard = (skill: Skill) => {
    const isEditing = editingSkillId === skill.skillId
    const isConfirmingDelete = deletingSkillId === skill.skillId
    const isExpanded = expandedSkillId === skill.skillId

    if (isEditing) {
      return (
        <SkillForm
          key={skill.skillId}
          title={t("common.edit")}
          form={editForm}
          setForm={setEditForm}
          busy={isSaving}
          busyLabel={t("common.saving")}
          submitLabel={t("common.save")}
          onCancel={cancelEdit}
          onSubmit={() => handleSave(skill.skillId)}
          t={t}
        />
      )
    }

    return (
      <Card key={skill.skillId} pad={20} style={{ width: "100%" }}>
        {/* Header row: tile · name + load-mode badge · actions */}
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 14 }}>
          <Tile icon="book-open" />
          <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
            <T step="hsm">{skill.name}</T>
            {skill.loadMode ? (
              <Badge mono tone={skill.loadMode === "always" ? "m" : "i"}>
                {skill.loadMode === "always"
                  ? t("skills.loadModeAlways")
                  : t("skills.loadModeOnDemand")}
              </Badge>
            ) : null}
          </View>
          {!isConfirmingDelete ? (
            <View style={{ flexDirection: "row", gap: 2, marginTop: -4, marginRight: -6 }}>
              <IconBtn
                icon="pencil-simple"
                plain
                sm
                title={t("common.edit")}
                onPress={() => startEdit(skill)}
              />
              <IconBtn
                icon="trash"
                plain
                sm
                danger
                title={t("common.delete")}
                onPress={() => {
                  setDeletingSkillId(skill.skillId)
                  setEditingSkillId(null)
                }}
              />
            </View>
          ) : null}
        </View>

        {skill.description ? (
          <T
            step="sm"
            tone="text2"
            numberOfLines={isExpanded ? undefined : 2}
            style={{ marginTop: 10 }}
          >
            {skill.description}
          </T>
        ) : null}

        {/* Mono preview of the instructions — press to expand / collapse */}
        <Pressable
          accessibilityRole="button"
          onPress={() => setExpandedSkillId(isExpanded ? null : skill.skillId)}
          style={[
            { marginTop: 12, padding: 12, borderRadius: 10, backgroundColor: c.wash },
            Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
          ]}
        >
          <T
            step="code"
            tone={isExpanded ? "text2" : "text3"}
            numberOfLines={isExpanded ? undefined : 3}
            style={{ lineHeight: 17 }}
          >
            {skill.content}
          </T>
        </Pressable>
        <T step="12" tone="text3" style={{ marginTop: 12 }}>
          {t("skills.assignHint", { defaultValue: "Assigned in each agent’s editor." })}
        </T>

        {isConfirmingDelete ? (
          <View
            style={{
              marginTop: 14,
              padding: 12,
              borderRadius: 10,
              backgroundColor: c.tint.r.bg,
              borderWidth: 1,
              borderColor: c.tint.r.bd,
              gap: 10,
            }}
          >
            <T step="12" color={c.tint.r.tx}>
              {t("skills.deleteConfirm", { name: skill.name })}
            </T>
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 6 }}>
              <Btn
                variant="ghost"
                size="sm"
                onPress={() => setDeletingSkillId(null)}
                disabled={isDeleting}
              >
                {t("common.cancel")}
              </Btn>
              <Btn
                variant="danger"
                size="sm"
                icon="trash"
                onPress={() => handleDelete(skill.skillId)}
                loading={isDeleting}
              >
                {isDeleting ? t("skills.deleting") : t("common.delete")}
              </Btn>
            </View>
          </View>
        ) : null}
      </Card>
    )
  }

  if (isLoading) {
    return <FullscreenLoader variant="default" label={t("skills.loadingSkills")} />
  }

  return (
    <Page>
      <PageHead
        eyebrow={t("skills.title")}
        title={t("skills.headline", { defaultValue: "What your agents know how to do." })}
        accent={t("skills.headlineAccent", { defaultValue: "know how to do." })}
        lead={t("skills.lead", {
          defaultValue:
            "Reusable instructions. Write them once and assign them to the agents that need them.",
        })}
        actions={
          <Btn variant="primary" icon="plus" onPress={openCreate}>
            {t("skills.newSkill")}
          </Btn>
        }
      />

      {showCreate ? (
        <View style={{ marginBottom: 20 }}>
          <SkillForm
            title={t("skills.newSkill")}
            form={createForm}
            setForm={setCreateForm}
            busy={isCreating}
            busyLabel={t("skills.creating")}
            submitLabel={t("common.create")}
            onCancel={() => {
              setShowCreate(false)
              setCreateForm(EMPTY_FORM)
            }}
            onSubmit={handleCreate}
            autoFocus
            t={t}
          />
        </View>
      ) : null}

      {skills.length === 0 && !showCreate ? (
        <EmptyState
          icon="books"
          title={t("skills.noSkills")}
          text={t("skills.noSkillsHint")}
          action={
            <Btn variant="primary" icon="plus" onPress={openCreate}>
              {t("skills.newSkill")}
            </Btn>
          }
        />
      ) : (
        <Grid cols={3} min={280}>
          {skills.map(renderSkillCard)}
        </Grid>
      )}
    </Page>
  )
}
