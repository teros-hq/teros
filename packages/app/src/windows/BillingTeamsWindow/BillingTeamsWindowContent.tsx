/**
 * BillingTeamsWindow — admin management for billing teams (TER-596 T1). Lists
 * teams (admin.list-billing-teams) and drills into one (admin.get-team-members):
 * the roster with each member's plan + live usage, plus full management of the
 * team's plan, seat-price override (F11) and membership (admin.update-billing-team).
 *
 * Leaves the team/company terrain arable: the "Company settings" section is a
 * marked placeholder (the company-admin role is product-TBD). The requester→owner
 * routing seam lives in the backend (request-access).
 *
 * Backend returns DATA (resolved names + numbers); this window composes the UI.
 * Search/filter + the update payload builder live in teams.ts so they are
 * unit-testable (the harness stubs this *WindowContent module). Each card owns
 * its own state + mutation so no single function grows past the lint limit.
 *
 * Presentation follows the OS prototype (design-testing): Page + PageHead, Stats,
 * LGroup/LRow lists, Card forms with FieldLabel/Field, pill buttons.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, View } from "react-native"
import { useToast } from "../../components/Toast"
import { AppSpinner } from "../../components/ui"
import { Avatar } from "../../components/Avatar"
import {
  Badge,
  type BadgeTone,
  Btn,
  Card,
  ChipBtn,
  EmptyState,
  Field,
  FieldGroup,
  FieldHelp,
  FieldLabel,
  IconBtn,
  LGroup,
  LRow,
  Page,
  PageHead,
  Ph,
  SectionLabel,
  Stat,
  Stats,
  T,
} from "../../components/ui/ds"
import { useColors } from "../../components/mca/primitives/useColors"
import type { BillingTeam, TeamMember, TeamMembersView } from "../../services/AdminApi"
import type { BillingPlanView } from "../../services/BillingApi"
import { getTerosClient } from "../../services/terosClientSingleton"
import { useTilingStore } from "../../store/tilingStore"
import {
  buildTeamSettingsPayload,
  filterMembers,
  memberHoursLabel,
  type TeamSettingsForm,
  teamToForm,
  teamToOriginal,
} from "./teams"

const STATUSES: TeamSettingsForm["status"][] = ["active", "paused", "cancelled"]

/** Team status → badge tone. */
function statusTone(status: string): BadgeTone {
  if (status === "active") return "g"
  if (status === "paused") return "a"
  if (status === "cancelled") return "r"
  return "i"
}

export interface BillingTeamsWindowProps {
  windowId?: string
}

export function BillingTeamsWindowContent(_props: BillingTeamsWindowProps) {
  const client = getTerosClient()
  const [teams, setTeams] = useState<BillingTeam[] | null>(null)
  const [listError, setListError] = useState(false)
  const [plans, setPlans] = useState<BillingPlanView[]>([])
  const [teamId, setTeamId] = useState<string | null>(null)

  const loadTeams = useCallback(async () => {
    setListError(false)
    try {
      setTeams((await client.admin.listBillingTeams()).teams)
    } catch {
      setTeams([])
      setListError(true)
    }
  }, [client])

  useEffect(() => {
    loadTeams()
    client.billing
      .listPlans()
      .then((res) => setPlans(res.plans))
      .catch(() => setPlans([]))
  }, [client, loadTeams])

  if (teamId) {
    return (
      <TeamDetailContainer
        teamId={teamId}
        plans={plans}
        onBack={() => {
          setTeamId(null)
          loadTeams()
        }}
      />
    )
  }
  return <TeamListView teams={teams} error={listError} onOpen={setTeamId} />
}

// ============================================================================
// LIST VIEW
// ============================================================================

function TeamListView({
  teams,
  error,
  onOpen,
}: {
  teams: BillingTeam[] | null
  error: boolean
  onOpen: (teamId: string) => void
}) {
  const { t } = useTranslation()
  const eyebrow = t("billing.eyebrow", { defaultValue: "Facturación" })
  const title = t("windows.billingTeams")

  if (teams === null) return <Loading />
  if (error) {
    return (
      <Page>
        <PageHead eyebrow={eyebrow} title={title} />
        <ErrorStrip testID="billing-teams-error" text={t("billing.teams.loadError")} />
      </Page>
    )
  }
  if (teams.length === 0) {
    return (
      <Page>
        <PageHead eyebrow={eyebrow} title={title} />
        <View testID="billing-teams-empty">
          <EmptyState icon="users-three" title={t("billing.teams.empty")} />
        </View>
      </Page>
    )
  }

  const seats = teams.reduce((n, tm) => n + tm.seatCount, 0)
  const maxSeats = teams.reduce((n, tm) => n + tm.maxSeats, 0)
  const active = teams.filter((tm) => tm.status === "active").length

  return (
    <Page testID="billing-teams-list">
      <PageHead
        eyebrow={eyebrow}
        title={title}
        lead={t("billing.teams.lead", {
          defaultValue: "Equipos con facturación compartida: plan, asientos y miembros.",
        })}
      />
      <Stats cols={3} style={{ marginBottom: 20 }}>
        <Stat
          label={t("billing.teams.statTeams", { defaultValue: "Equipos" })}
          v={teams.length}
          sub={t("billing.teams.statActive", { defaultValue: "{{n}} activos", n: active })}
        />
        <Stat
          label={t("billing.teams.statSeats", { defaultValue: "Asientos" })}
          v={`${seats} / ${maxSeats}`}
          sub={t("billing.teams.statSeatsSub", { defaultValue: "ocupados / máximo" })}
        />
        <Stat
          label={t("billing.teams.statOverrides", { defaultValue: "Precios negociados" })}
          v={teams.filter((tm) => tm.customSeatPrice != null).length}
          sub={t("billing.teams.statOverridesSub", { defaultValue: "equipos con override" })}
        />
      </Stats>
      <SectionLabel label={t("windows.billingTeams")} count={teams.length} />
      <LGroup>
        {teams.map((team) => (
          <TeamRow key={team._id} team={team} onOpen={() => onOpen(team._id)} />
        ))}
      </LGroup>
    </Page>
  )
}

function TeamRow({ team, onOpen }: { team: BillingTeam; onOpen: () => void }) {
  const c = useColors()
  const pct =
    team.maxSeats > 0 ? Math.min(100, Math.round((team.seatCount / team.maxSeats) * 100)) : 0
  return (
    <LRow testID={`team-row-${team._id}`} onPress={onOpen}>
      <Avatar name={team.name} size={36} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <T step="base" ellipsis>
          {team.name}
        </T>
        <T step="12" tone="text3" ellipsis>
          {team.slug}
        </T>
      </View>
      <Badge tone="i">{team.planName}</Badge>
      {/* Seats bar: thin violet fill + mono counter */}
      <View style={{ width: 120, gap: 5 }}>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: c.wash2, overflow: "hidden" }}>
          <View
            style={{ width: `${pct}%`, height: 6, borderRadius: 3, backgroundColor: c.accent }}
          />
        </View>
        <T step="codenote" tone="text3">
          {team.seatCount}/{team.maxSeats} · {team.customSeatPrice ?? team.seatPrice}
          {team.customSeatPrice != null ? " *" : ""}
        </T>
      </View>
      <Badge tone={statusTone(team.status)} dot>
        {team.status}
      </Badge>
      <Ph name="caret-right" size={14} color={c.text3} />
    </LRow>
  )
}

// ============================================================================
// DETAIL — data container (loads the roster, owns reload)
// ============================================================================

function TeamDetailContainer({
  teamId,
  plans,
  onBack,
}: {
  teamId: string
  plans: BillingPlanView[]
  onBack: () => void
}) {
  const { t } = useTranslation()
  const client = getTerosClient()
  const [detail, setDetail] = useState<TeamMembersView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      setDetail(await client.admin.getTeamMembers(teamId))
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [client, teamId])

  useEffect(() => {
    reload()
  }, [reload])

  return (
    <Page testID="billing-team-detail">
      <PageHead
        eyebrow={t("billing.eyebrow", { defaultValue: "Facturación" })}
        title={detail?.team.name ?? t("windows.billingTeams")}
        lead={
          detail ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <T step="sm" tone="text2">
                {detail.team.slug}
              </T>
              <Badge tone="i">{detail.team.planName}</Badge>
              <Badge tone={statusTone(detail.team.status)} dot>
                {detail.team.status}
              </Badge>
            </View>
          ) : undefined
        }
        actions={
          <Btn testID="team-back-btn" variant="sec" size="sm" icon="arrow-left" onPress={onBack}>
            {t("common.back")}
          </Btn>
        }
      />
      {loading || !detail ? (
        error ? (
          <ErrorStrip testID="billing-team-detail-error" text={t("billing.teams.loadError")} />
        ) : (
          <View style={{ paddingVertical: 48, alignItems: "center" }}>
            <AppSpinner variant="brand" />
          </View>
        )
      ) : (
        <DetailBody detail={detail} plans={plans} reload={reload} />
      )}
    </Page>
  )
}

function DetailBody({
  detail,
  plans,
  reload,
}: {
  detail: TeamMembersView
  plans: BillingPlanView[]
  reload: () => Promise<void>
}) {
  const team = detail.team
  return (
    <View style={{ gap: 24 }}>
      <SettingsCard
        key={`${team.planId}-${team.seatPrice}-${team.status}-${team.maxSeats}`}
        team={team}
        plans={plans}
        onSaved={reload}
      />
      <MembersCard teamId={team._id} members={detail.members} onChanged={reload} />
      <CompanySettingsPlaceholder owner={detail.owner} />
    </View>
  )
}

// ============================================================================
// DETAIL — settings card (owns the form + save)
// ============================================================================

function SettingsCard({
  team,
  plans,
  onSaved,
}: {
  team: TeamMembersView["team"]
  plans: BillingPlanView[]
  onSaved: () => Promise<void>
}) {
  const { t } = useTranslation()
  const client = getTerosClient()
  const toast = useToast()
  const [form, setForm] = useState<TeamSettingsForm>(() => teamToForm(team))
  const [saving, setSaving] = useState(false)

  const save = useCallback(async () => {
    const payload = buildTeamSettingsPayload(team._id, form, teamToOriginal(team))
    if (Object.keys(payload).length === 1) {
      toast.info(t("billing.teams.noChanges"))
      return
    }
    setSaving(true)
    try {
      await client.admin.updateBillingTeam(payload)
      toast.success(t("billing.teams.saved"))
      await onSaved()
    } catch {
      toast.error(t("billing.teams.saveError"))
    } finally {
      setSaving(false)
    }
  }, [client, form, team, onSaved, t, toast])

  return (
    <View testID="team-settings-card">
      <Card pad={20}>
        <T step="base">{t("billing.teams.planPricing")}</T>
        <SettingsFields form={form} setForm={setForm} plans={plans} />
        <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 20 }}>
          <Btn
            testID="team-save-btn"
            variant="primary"
            icon="floppy-disk"
            disabled={saving}
            loading={saving}
            onPress={save}
          >
            {t("billing.teams.save")}
          </Btn>
        </View>
      </Card>
    </View>
  )
}

function SettingsFields({
  form,
  setForm,
  plans,
}: {
  form: TeamSettingsForm
  setForm: (f: TeamSettingsForm) => void
  plans: BillingPlanView[]
}) {
  const { t } = useTranslation()
  return (
    <>
      <FieldGroup>
        <FieldLabel>{t("billing.teams.plan")}</FieldLabel>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {plans.map((p) => (
            <ChipBtn
              key={p.planId}
              testID={`team-plan-${p.planId}`}
              on={form.planId === p.planId}
              onPress={() => setForm({ ...form, planId: p.planId })}
            >
              {p.displayName}
            </ChipBtn>
          ))}
        </View>
      </FieldGroup>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
        <FieldGroup style={{ width: 180 }}>
          <FieldLabel>{t("billing.teams.seatPriceOverride")}</FieldLabel>
          <Field
            testID="team-seat-price-input"
            mono
            icon="currency-eur"
            value={form.customSeatPrice}
            onChangeText={(v) => setForm({ ...form, customSeatPrice: v })}
            placeholder={t("billing.teams.seatPricePlaceholder")}
            keyboardType="numeric"
          />
          <FieldHelp>
            {t("billing.teams.seatPriceHelp", {
              defaultValue: "Vacío = precio del plan.",
            })}
          </FieldHelp>
        </FieldGroup>
        <FieldGroup style={{ width: 140 }}>
          <FieldLabel>{t("billing.teams.maxSeats")}</FieldLabel>
          <Field
            testID="team-max-seats-input"
            mono
            icon="users-three"
            value={form.maxSeats}
            onChangeText={(v) => setForm({ ...form, maxSeats: v })}
            keyboardType="numeric"
          />
        </FieldGroup>
      </View>
      <FieldGroup>
        <FieldLabel>{t("billing.teams.status")}</FieldLabel>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {STATUSES.map((s) => (
            <ChipBtn
              key={s}
              testID={`team-status-${s}`}
              on={form.status === s}
              onPress={() => setForm({ ...form, status: s })}
            >
              {s}
            </ChipBtn>
          ))}
        </View>
      </FieldGroup>
    </>
  )
}

// ============================================================================
// DETAIL — members card (owns search + add/remove)
// ============================================================================

function MembersCard({
  teamId,
  members,
  onChanged,
}: {
  teamId: string
  members: TeamMember[]
  onChanged: () => Promise<void>
}) {
  const { t } = useTranslation()
  const client = getTerosClient()
  const toast = useToast()
  const openWindow = useTilingStore((s) => s.openWindow)
  const [query, setQuery] = useState("")
  const [addInput, setAddInput] = useState("")
  const [saving, setSaving] = useState(false)

  const mutate = useCallback(
    async (
      key: "addMemberIds" | "removeMemberIds",
      userId: string,
      okMsg: string,
      errMsg: string,
    ) => {
      setSaving(true)
      try {
        await client.admin.updateBillingTeam({ teamId, [key]: [userId] })
        toast.success(t(okMsg))
        if (key === "addMemberIds") setAddInput("")
        await onChanged()
      } catch {
        toast.error(t(errMsg))
      } finally {
        setSaving(false)
      }
    },
    [client, teamId, onChanged, t, toast],
  )

  const filtered = filterMembers(members, query)
  return (
    <View testID="team-members-card">
      <SectionLabel
        label={t("billing.teams.members")}
        count={members.length}
        right={
          <Field
            testID="team-member-search"
            icon="magnifying-glass"
            value={query}
            onChangeText={setQuery}
            placeholder={t("billing.teams.searchPlaceholder")}
            containerStyle={{ width: 220, height: 30 }}
            style={{ height: 28 }}
          />
        }
      />
      <MemberList
        members={filtered}
        saving={saving}
        onRemove={(userId) =>
          mutate(
            "removeMemberIds",
            userId,
            "billing.teams.memberRemoved",
            "billing.teams.removeError",
          )
        }
        onAudit={(m) =>
          openWindow("billing-audit", { userId: m.userId, userName: m.userName ?? m.userId })
        }
      />
      <AddMemberRow
        value={addInput}
        onChange={setAddInput}
        disabled={saving || addInput.trim() === ""}
        onAdd={() =>
          mutate(
            "addMemberIds",
            addInput.trim(),
            "billing.teams.memberAdded",
            "billing.teams.addError",
          )
        }
      />
    </View>
  )
}

function MemberList({
  members,
  saving,
  onRemove,
  onAudit,
}: {
  members: TeamMember[]
  saving: boolean
  onRemove: (userId: string) => void
  onAudit: (m: TeamMember) => void
}) {
  const { t } = useTranslation()
  if (members.length === 0) {
    return (
      <Card pad>
        <T step="sm" tone="text3">
          {t("billing.teams.noMembers")}
        </T>
      </Card>
    )
  }
  return (
    <LGroup>
      {members.map((m) => (
        <MemberRow
          key={m.userId}
          member={m}
          saving={saving}
          onRemove={() => onRemove(m.userId)}
          onAudit={() => onAudit(m)}
        />
      ))}
    </LGroup>
  )
}

function AddMemberRow({
  value,
  onChange,
  onAdd,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  onAdd: () => void
  disabled: boolean
}) {
  const { t } = useTranslation()
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 }}>
      <Field
        testID="team-add-member-input"
        icon="user-plus"
        mono
        value={value}
        onChangeText={onChange}
        placeholder={t("billing.teams.addPlaceholder")}
        containerStyle={{ flex: 1 }}
      />
      <Btn
        testID="team-add-member-btn"
        variant="primary"
        icon="plus"
        disabled={disabled}
        onPress={onAdd}
      >
        {t("billing.teams.addMember")}
      </Btn>
    </View>
  )
}

function MemberRow({
  member,
  saving,
  onRemove,
  onAudit,
}: {
  member: TeamMember
  saving: boolean
  onRemove: () => void
  onAudit: () => void
}) {
  const { t } = useTranslation()
  const c = useColors()
  const pct = member.usagePct
  // Usage colour by threshold (mirrors teams.usageColor, on theme tokens).
  const usageTone =
    pct === null ? c.text3 : pct >= 100 ? c.tint.r.tx : pct >= 80 ? c.tint.a.tx : c.accent
  return (
    <View testID={`member-row-${member.userId}`}>
      <LRow padV={10}>
        <Avatar name={member.userName ?? member.userId} size={32} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <T step="sm" ellipsis style={{ flexShrink: 1 }}>
              {member.userName ?? member.userId}
            </T>
            {member.isOwner ? (
              <Badge tone="m" sm icon="crown">
                {t("billing.teams.owner")}
              </Badge>
            ) : null}
          </View>
          <T step="12" tone="text3" ellipsis>
            {member.userEmail ?? member.userId} · {member.role ?? "—"}
          </T>
        </View>
        <Badge tone="i">{member.planName ?? "—"}</Badge>
        <T step="code" color={usageTone} style={{ minWidth: 92, textAlign: "right" }}>
          {memberHoursLabel(member.agentHoursUsed, member.agentHoursLimit)}
          {pct !== null ? ` · ${pct}%` : ""}
        </T>
        <IconBtn
          testID={`member-audit-${member.userId}`}
          icon="receipt"
          plain
          sm
          title={t("windows.billingAudit")}
          onPress={onAudit}
        />
        <IconBtn
          testID={`member-remove-${member.userId}`}
          icon="x"
          plain
          sm
          danger={!saving}
          disabled={saving}
          onPress={() => !saving && onRemove()}
        />
      </LRow>
    </View>
  )
}

function CompanySettingsPlaceholder({ owner }: { owner: TeamMembersView["owner"] }) {
  const { t } = useTranslation()
  const c = useColors()
  return (
    <View
      testID="company-settings-placeholder"
      style={{
        borderRadius: 16,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: c.borderStrong,
        padding: 16,
        gap: 6,
        opacity: 0.7,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <T step="base">{t("billing.teams.companySettings")}</T>
        <Badge dashed cap>
          {t("common.soon")}
        </Badge>
      </View>
      <T step="sm" tone="text2">
        {t("billing.teams.companySettingsSoon")}
      </T>
      {owner ? (
        <T step="12" tone="text3">
          {t("billing.teams.owner")}: {owner.userName ?? owner.userId}
        </T>
      ) : null}
    </View>
  )
}

// ============================================================================
// PRIMITIVES (local presentational — colors only, no logic)
// ============================================================================

function Loading() {
  return (
    <Page noScroll>
      <View style={{ paddingVertical: 64, alignItems: "center", justifyContent: "center" }}>
        <AppSpinner variant="brand" />
      </View>
    </Page>
  )
}

/** Tinted red strip for a failed load. */
function ErrorStrip({ text, testID }: { text: string; testID?: string }) {
  const c = useColors()
  return (
    <View
      testID={testID}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          padding: 14,
          borderRadius: 12,
          backgroundColor: c.tint.r.bg,
          borderWidth: 1,
          borderColor: c.tint.r.bd,
        },
        Platform.OS === "web" ? ({ boxShadow: "none" } as any) : null,
      ]}
    >
      <Ph name="warning" size={16} color={c.tint.r.tx} />
      <T step="sm" color={c.tint.r.tx} style={{ flex: 1 }}>
        {text}
      </T>
    </View>
  )
}
