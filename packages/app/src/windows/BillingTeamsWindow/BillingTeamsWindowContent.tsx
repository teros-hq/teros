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
 */

import { ChevronLeft, Crown, ScrollText, X } from "@tamagui/lucide-icons"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ScrollView } from "react-native"
import { Input, Text, XStack, YStack } from "tamagui"
import { useToast } from "../../components/Toast"
import { AppSpinner } from "../../components/ui"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semanticColors, surface } from "../../components/mca/primitives/colors"
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
  usageColor,
} from "./teams"

const STATUSES: TeamSettingsForm["status"][] = ["active", "paused", "cancelled"]

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
  const c = useColors()
  if (teams === null) return <Loading />
  if (error) {
    return (
      <Centered testID="billing-teams-error" color={c.badges.err.text}>
        {t("billing.teams.loadError")}
      </Centered>
    )
  }
  if (teams.length === 0) {
    return (
      <Centered testID="billing-teams-empty" color={c.text2}>
        {t("billing.teams.empty")}
      </Centered>
    )
  }
  return (
    <YStack testID="billing-teams-list" flex={1} backgroundColor={c.bgPage}>
      <Header title={t("windows.billingTeams")} />
      <ScrollView style={{ flex: 1 }}>
        <YStack padding={12} gap={8}>
          {teams.map((team) => (
            <TeamRow key={team._id} team={team} onOpen={() => onOpen(team._id)} />
          ))}
        </YStack>
      </ScrollView>
    </YStack>
  )
}

function TeamRow({ team, onOpen }: { team: BillingTeam; onOpen: () => void }) {
  const c = useColors()
  return (
    <XStack
      testID={`team-row-${team._id}`}
      onPress={onOpen}
      cursor="pointer"
      hoverStyle={{ borderColor: semanticColors.indigo }}
      borderRadius={10}
      borderWidth={1}
      borderColor={c.border}
      backgroundColor={c.bgCard}
      padding={12}
      alignItems="center"
      gap={10}
    >
      <YStack flex={1} gap={2}>
        <Text fontSize={14} fontWeight="700" color={c.text}>
          {team.name}
        </Text>
        <Text fontSize={11} color={c.text3}>
          {team.slug}
        </Text>
      </YStack>
      <Text fontSize={12} color={semanticColors.indigo}>
        {team.planName}
      </Text>
      <Text fontSize={12} color={c.text2}>
        {team.seatCount}/{team.maxSeats} · {team.customSeatPrice ?? team.seatPrice}
        {team.customSeatPrice != null ? " *" : ""}
      </Text>
      <StatusPill status={team.status} />
    </XStack>
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
  const c = useColors()
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
    <YStack testID="billing-team-detail" flex={1} backgroundColor={c.bgPage}>
      <DetailHeader name={detail?.team.name ?? ""} onBack={onBack} />
      {loading || !detail ? (
        error ? (
          <Centered testID="billing-team-detail-error" color={c.badges.err.text}>
            {t("billing.teams.loadError")}
          </Centered>
        ) : (
          <Loading />
        )
      ) : (
        <DetailBody detail={detail} plans={plans} reload={reload} />
      )}
    </YStack>
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
    <ScrollView style={{ flex: 1 }}>
      <YStack padding={12} gap={12}>
        <SettingsCard
          key={`${team.planId}-${team.seatPrice}-${team.status}-${team.maxSeats}`}
          team={team}
          plans={plans}
          onSaved={reload}
        />
        <MembersCard teamId={team._id} members={detail.members} onChanged={reload} />
        <CompanySettingsPlaceholder owner={detail.owner} />
      </YStack>
    </ScrollView>
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
  const c = useColors()
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
    <YStack testID="team-settings-card" gap={10} {...cardStyle(c)}>
      <SectionTitle title={t("billing.teams.planPricing")} />
      <SettingsFields form={form} setForm={setForm} plans={plans} />
      <XStack justifyContent="flex-end">
        <PrimaryButton testID="team-save-btn" disabled={saving} onPress={save}>
          {t("billing.teams.save")}
        </PrimaryButton>
      </XStack>
    </YStack>
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
      <Field label={t("billing.teams.plan")}>
        <XStack gap={6} flexWrap="wrap">
          {plans.map((p) => (
            <ChoicePill
              key={p.planId}
              testID={`team-plan-${p.planId}`}
              label={p.displayName}
              active={form.planId === p.planId}
              onPress={() => setForm({ ...form, planId: p.planId })}
            />
          ))}
        </XStack>
      </Field>
      <XStack gap={10} flexWrap="wrap">
        <Field label={t("billing.teams.seatPriceOverride")}>
          <Input
            testID="team-seat-price-input"
            value={form.customSeatPrice}
            onChangeText={(v) => setForm({ ...form, customSeatPrice: v })}
            placeholder={t("billing.teams.seatPricePlaceholder")}
            keyboardType="numeric"
            width={140}
            {...inputStyle()}
          />
        </Field>
        <Field label={t("billing.teams.maxSeats")}>
          <Input
            testID="team-max-seats-input"
            value={form.maxSeats}
            onChangeText={(v) => setForm({ ...form, maxSeats: v })}
            keyboardType="numeric"
            width={100}
            {...inputStyle()}
          />
        </Field>
      </XStack>
      <Field label={t("billing.teams.status")}>
        <XStack gap={6}>
          {STATUSES.map((s) => (
            <ChoicePill
              key={s}
              testID={`team-status-${s}`}
              label={s}
              active={form.status === s}
              onPress={() => setForm({ ...form, status: s })}
            />
          ))}
        </XStack>
      </Field>
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
  const c = useColors()
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
    <YStack testID="team-members-card" gap={10} {...cardStyle(c)}>
      <SectionTitle title={t("billing.teams.members")} count={members.length} />
      <Input
        testID="team-member-search"
        value={query}
        onChangeText={setQuery}
        placeholder={t("billing.teams.searchPlaceholder")}
        {...inputStyle()}
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
    </YStack>
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
  const c = useColors()
  if (members.length === 0) {
    return (
      <Text fontSize={12} color={c.text2}>
        {t("billing.teams.noMembers")}
      </Text>
    )
  }
  return (
    <>
      {members.map((m) => (
        <MemberRow
          key={m.userId}
          member={m}
          saving={saving}
          onRemove={() => onRemove(m.userId)}
          onAudit={() => onAudit(m)}
        />
      ))}
    </>
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
    <XStack gap={6} marginTop={4}>
      <Input
        testID="team-add-member-input"
        flex={1}
        value={value}
        onChangeText={onChange}
        placeholder={t("billing.teams.addPlaceholder")}
        {...inputStyle()}
      />
      <PrimaryButton testID="team-add-member-btn" disabled={disabled} onPress={onAdd}>
        {t("billing.teams.addMember")}
      </PrimaryButton>
    </XStack>
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
  const c = useColors()
  return (
    <XStack testID={`member-row-${member.userId}`} alignItems="center" gap={8}>
      {member.isOwner && <Crown size={13} color={semanticColors.indigo} />}
      <YStack flex={1} gap={1}>
        <Text fontSize={13} color={c.text} numberOfLines={1}>
          {member.userName ?? member.userId}
        </Text>
        <Text fontSize={10} color={c.text3} numberOfLines={1}>
          {member.userEmail ?? member.userId} · {member.role ?? "—"}
        </Text>
      </YStack>
      <Text fontSize={11} color={c.text2}>
        {member.planName ?? "—"}
      </Text>
      <Text fontSize={11} color={usageColor(member.usagePct)} minWidth={68} textAlign="right">
        {memberHoursLabel(member.agentHoursUsed, member.agentHoursLimit)}
        {member.usagePct !== null ? ` · ${member.usagePct}%` : ""}
      </Text>
      <ScrollText
        size={14}
        color={c.text3}
        cursor="pointer"
        onPress={onAudit}
        testID={`member-audit-${member.userId}`}
      />
      <X
        size={14}
        color={saving ? c.text3 : c.badges.err.text}
        cursor="pointer"
        onPress={() => !saving && onRemove()}
        testID={`member-remove-${member.userId}`}
      />
    </XStack>
  )
}

function CompanySettingsPlaceholder({ owner }: { owner: TeamMembersView["owner"] }) {
  const { t } = useTranslation()
  const c = useColors()
  return (
    <YStack
      testID="company-settings-placeholder"
      gap={6}
      opacity={0.6}
      {...cardStyle(c)}
      borderStyle="dashed"
    >
      <SectionTitle title={t("billing.teams.companySettings")} />
      <Text fontSize={12} color={c.text2}>
        {t("billing.teams.companySettingsSoon")}
      </Text>
      {owner && (
        <Text fontSize={11} color={c.text3}>
          {t("billing.teams.owner")}: {owner.userName ?? owner.userId}
        </Text>
      )}
    </YStack>
  )
}

// ============================================================================
// PRIMITIVES (local presentational — colors only, no logic)
// ============================================================================

function cardStyle(c: ReturnType<typeof useColors>) {
  return {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bgCard,
    padding: 12,
  } as const
}

function inputStyle() {
  const c = useColors()
  const isDark = c.bgPage === surface.dark.bgPage
  return {
    backgroundColor: isDark ? "rgba(39,39,42,0.6)" : c.bgInner,
    borderColor: c.borderStrong,
    color: c.text,
    fontSize: 13,
    height: 34,
  } as const
}

function Loading() {
  const c = useColors()
  return (
    <YStack flex={1} backgroundColor={c.bgPage} justifyContent="center" alignItems="center">
      <AppSpinner variant="brand" />
    </YStack>
  )
}

function Header({ title }: { title: string }) {
  const c = useColors()
  const isDark = c.bgPage === surface.dark.bgPage
  return (
    <XStack
      height={44}
      paddingHorizontal={12}
      alignItems="center"
      borderBottomWidth={1}
      borderBottomColor={isDark ? "rgba(39,39,42,0.6)" : c.bgInner}
    >
      <Text fontSize={13} fontWeight="700" color={c.text}>
        {title}
      </Text>
    </XStack>
  )
}

function DetailHeader({ name, onBack }: { name: string; onBack: () => void }) {
  const c = useColors()
  const isDark = c.bgPage === surface.dark.bgPage
  return (
    <XStack
      height={44}
      paddingHorizontal={10}
      alignItems="center"
      gap={6}
      borderBottomWidth={1}
      borderBottomColor={isDark ? "rgba(39,39,42,0.6)" : c.bgInner}
    >
      <ChevronLeft
        size={18}
        color={semanticColors.indigo}
        cursor="pointer"
        onPress={onBack}
        testID="team-back-btn"
      />
      <Text fontSize={13} fontWeight="700" color={c.text} numberOfLines={1}>
        {name}
      </Text>
    </XStack>
  )
}

function Centered({
  children,
  color,
  testID,
}: {
  children: React.ReactNode
  color: string
  testID?: string
}) {
  const c = useColors()
  return (
    <YStack
      testID={testID}
      flex={1}
      backgroundColor={c.bgPage}
      justifyContent="center"
      alignItems="center"
      padding={20}
    >
      <Text fontSize={13} color={color}>
        {children}
      </Text>
    </YStack>
  )
}

function StatusPill({ status }: { status: string }) {
  const c = useColors()
  return (
    <XStack
      paddingHorizontal={8}
      paddingVertical={2}
      borderRadius={9999}
      backgroundColor={c.badges.info.bg}
    >
      <Text fontSize={10} fontWeight="600" color={c.badges.info.text} textTransform="capitalize">
        {status}
      </Text>
    </XStack>
  )
}

function ChoicePill({
  label,
  active,
  onPress,
  testID,
}: {
  label: string
  active: boolean
  onPress: () => void
  testID?: string
}) {
  const c = useColors()
  return (
    <XStack
      testID={testID}
      onPress={onPress}
      cursor="pointer"
      paddingHorizontal={10}
      paddingVertical={5}
      borderRadius={9999}
      borderWidth={1}
      borderColor={active ? semanticColors.indigo : c.border}
      backgroundColor={active ? c.badges.info.bg : "transparent"}
    >
      <Text
        fontSize={11}
        fontWeight="600"
        color={active ? semanticColors.indigo : c.text2}
        textTransform="capitalize"
      >
        {label}
      </Text>
    </XStack>
  )
}

function PrimaryButton({
  children,
  onPress,
  disabled,
  testID,
}: {
  children: React.ReactNode
  onPress: () => void
  disabled?: boolean
  testID?: string
}) {
  return (
    <XStack
      testID={testID}
      onPress={disabled ? undefined : onPress}
      cursor={disabled ? "default" : "pointer"}
      opacity={disabled ? 0.5 : 1}
      paddingHorizontal={14}
      paddingVertical={7}
      borderRadius={8}
      backgroundColor={semanticColors.indigo}
    >
      <Text fontSize={12} fontWeight="700" color="#fff">
        {children}
      </Text>
    </XStack>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const c = useColors()
  return (
    <YStack gap={4}>
      <Text fontSize={10} color={c.text3} textTransform="uppercase" letterSpacing={0.5}>
        {label}
      </Text>
      {children}
    </YStack>
  )
}

function SectionTitle({ title, count }: { title: string; count?: number }) {
  const c = useColors()
  return (
    <XStack gap={6} alignItems="center">
      <Text
        fontSize={11}
        fontWeight="700"
        color={c.text}
        textTransform="uppercase"
        letterSpacing={0.5}
      >
        {title}
      </Text>
      {count !== undefined && (
        <Text fontSize={11} color={c.text2}>
          {count}
        </Text>
      )}
    </XStack>
  )
}
