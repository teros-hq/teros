/**
 * BillingEditForm — the admin edit form for a user's subscription.
 *
 * Boundary-validates (finite numbers + team/override mutex) via the pure
 * `billingForm` helpers BEFORE calling `admin.update-billing-subscription`, and
 * surfaces failures as an inline `FormError` (no native alert). Pickers are the
 * accessible `Select` (no raw select element); the provider-config CRUD lives in an
 * accessible modal. `customAgentHoursLimit` here is the PERMANENT per-user limit
 * — the temporary period boost gets its own card in a later PR (TER-6xx).
 * Colours are monitoring tokens only.
 */

import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Text, XStack, YStack } from "tamagui"
import { tokens } from "../../../components/monitoring/colors"
import type { BillingInfo, TerosProviderConfig, UserSummary } from "../../../services/AdminApi"
import { getTerosClient } from "../../../services/terosClientSingleton"
import { Select, type SelectOption } from "../Select"
import {
  type BillingErrorField,
  type BillingFormValues,
  buildUpdateParams,
  SUB_STATUSES,
  type SubStatus,
  validateBillingInputs,
} from "./billingForm"
import { Button, Chip, FieldLabel, FormError, Hint, TextField } from "./formPrimitives"
import { TerosProviderConfigModal } from "./TerosProviderConfigModal"

interface PlanOption {
  id: string
  label: string
  hidden: boolean
}

export interface BillingEditFormProps {
  user: UserSummary
  billing: BillingInfo
  onCancel: () => void
  onSaved: (billing: BillingInfo) => void
}

function numToStr(n: number | null | undefined): string {
  return n !== null && n !== undefined ? String(n) : ""
}

function initialValues(billing: BillingInfo): BillingFormValues {
  return {
    // Fallback to the entry plan; 'plan_basic' is a retired id the server rejects.
    planId: billing.planId ?? "plan_starter",
    customPrice: numToStr(billing.customPrice),
    customPriceNote: billing.customPriceNote ?? "",
    customLimit: numToStr(billing.customAgentHoursLimit),
    billingNotes: billing.billingNotes ?? "",
    subStatus: (billing.status ?? "active") as SubStatus,
    terosProviderConfigId: billing.terosProviderConfigId ?? "",
    teamId: billing.teamId ?? "",
  }
}

export function BillingEditForm({ user, billing, onCancel, onSaved }: BillingEditFormProps) {
  const { t } = useTranslation()
  const client = getTerosClient()

  const [values, setValues] = useState<BillingFormValues>(() => initialValues(billing))
  // Snapshot of the values at mount, to flag unsaved changes (dirty).
  const [initial] = useState<BillingFormValues>(() => initialValues(billing))
  const [plans, setPlans] = useState<PlanOption[]>([])
  const [configs, setConfigs] = useState<TerosProviderConfig[]>([])
  const [teams, setTeams] = useState<
    { _id: string; name: string; memberCount: number; maxSeats: number }[]
  >([])
  const [configModalOpen, setConfigModalOpen] = useState(false)
  const [errorField, setErrorField] = useState<BillingErrorField | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once on mount
  useEffect(() => {
    client.admin
      .listPlans()
      .then((res) =>
        setPlans(
          res.plans.map((p) => ({ id: p.planId, label: p.displayName, hidden: !p.isPublic })),
        ),
      )
      .catch(() => {})
    client.admin
      .listTerosProviderConfigs()
      .then((res) => setConfigs(res.configs))
      .catch(() => {})
    client.admin
      .listBillingTeams()
      .then((res) => setTeams(res.teams))
      .catch(() => {})
  }, [])

  const setField = <K extends keyof BillingFormValues>(k: K, v: BillingFormValues[K]) =>
    setValues((prev) => ({ ...prev, [k]: v }))

  const handleSave = async () => {
    const check = validateBillingInputs(values)
    if (!check.ok) {
      setErrorField(check.field)
      return
    }
    setErrorField(null)
    setSaveError(null)
    setSaving(true)
    try {
      const params = buildUpdateParams(user.userId, values, check.priceNum, check.limitNum, {
        planId: billing.planId,
        status: billing.status,
      })
      const result = await client.admin.updateBillingSubscription(params)
      onSaved(result.subscription)
    } catch (e) {
      setSaveError(
        (e as { message?: string })?.message ?? t("windows.usersPanel.billing.saveFailed"),
      )
    } finally {
      setSaving(false)
    }
  }

  const errorMessage = errorField ? t(`windows.usersPanel.billing.error.${errorField}`) : saveError
  const dirty = JSON.stringify(values) !== JSON.stringify(initial)

  return (
    <YStack gap={12} paddingTop={4} testID="billing-edit-form">
      <XStack ai="center" jc="space-between" gap={8}>
        <Text fontSize={14} fontWeight="700" color={tokens.text}>
          {t("windows.usersPanel.billing.editTitle")}
        </Text>
        {dirty ? (
          <Text fontSize={11} fontWeight="600" color={tokens.warning}>
            {t("windows.usersPanel.billing.unsavedChanges")}
          </Text>
        ) : null}
      </XStack>

      <Section title={t("windows.usersPanel.billing.sections.plan")}>
        <PlanField
          plans={plans}
          selected={values.planId}
          onSelect={(id) => setField("planId", id)}
          internalSuffix={t("windows.usersPanel.billing.internalTier")}
        />
        <XStack gap={10} flexWrap="wrap">
          <YStack flex={1} minWidth={160}>
            <FieldLabel>{t("windows.usersPanel.billing.customPrice")}</FieldLabel>
            <TextField
              testID="billing-custom-price"
              value={values.customPrice}
              onChangeText={(v) => setField("customPrice", v)}
              placeholder={t("windows.usersPanel.billing.usePlanDefault")}
              numeric
              invalid={errorField === "price"}
            />
          </YStack>
          <YStack flex={1} minWidth={160}>
            <FieldLabel>{t("windows.usersPanel.billing.priceNote")}</FieldLabel>
            <TextField
              testID="billing-price-note"
              value={values.customPriceNote}
              onChangeText={(v) => setField("customPriceNote", v)}
              placeholder={t("windows.usersPanel.billing.priceNotePlaceholder")}
            />
          </YStack>
        </XStack>
      </Section>

      <Section title={t("windows.usersPanel.billing.sections.limit")}>
        <YStack maxWidth={280}>
          <FieldLabel>{t("windows.usersPanel.billing.permanentLimit")}</FieldLabel>
          <TextField
            testID="billing-custom-limit"
            value={values.customLimit}
            onChangeText={(v) => setField("customLimit", v)}
            placeholder={t("windows.usersPanel.billing.usePlanDefault")}
            numeric
            invalid={errorField === "limit"}
          />
          <Hint>{t("windows.usersPanel.billing.permanentLimitHint")}</Hint>
        </YStack>
      </Section>

      <Section title={t("windows.usersPanel.billing.sections.routing")}>
        <ProviderConfigField
          value={values.terosProviderConfigId}
          configs={configs}
          onChange={(v) => setField("terosProviderConfigId", v)}
          onManage={() => setConfigModalOpen(true)}
        />
        <TeamField
          value={values.teamId}
          teams={teams}
          onChange={(v) => setField("teamId", v)}
          invalid={errorField === "team"}
        />
      </Section>

      <Section title={t("windows.usersPanel.billing.sections.status")}>
        <SubStatusField selected={values.subStatus} onSelect={(s) => setField("subStatus", s)} />
      </Section>

      <Section title={t("windows.usersPanel.billing.sections.notes")}>
        <TextField
          testID="billing-notes"
          value={values.billingNotes}
          onChangeText={(v) => setField("billingNotes", v)}
          placeholder={t("windows.usersPanel.billing.notesPlaceholder")}
          multiline
        />
      </Section>

      {errorMessage ? <FormError message={errorMessage} testID="billing-error" /> : null}

      <XStack ai="center" jc="flex-end" gap={8} paddingTop={2}>
        <Button
          label={t("windows.usersPanel.billing.cancel")}
          onPress={onCancel}
          testID="billing-cancel"
        />
        <Button
          label={
            saving ? t("windows.usersPanel.billing.saving") : t("windows.usersPanel.billing.save")
          }
          tone="primary"
          busy={saving}
          onPress={handleSave}
          testID="billing-save"
        />
      </XStack>

      <TerosProviderConfigModal
        open={configModalOpen}
        configs={configs}
        onClose={() => setConfigModalOpen(false)}
        onCreated={(cfg) => setConfigs((prev) => [...prev, cfg])}
        onDeleted={(id) => {
          setConfigs((prev) => prev.filter((c) => c._id !== id))
          setField(
            "terosProviderConfigId",
            values.terosProviderConfigId === id ? "" : values.terosProviderConfigId,
          )
        }}
      />
    </YStack>
  )
}

/** A titled card grouping related fields. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <YStack
      gap={12}
      padding={14}
      borderRadius={12}
      borderWidth={1}
      borderColor={tokens.border}
      backgroundColor={tokens.bgCard}
    >
      <Text
        fontSize={11}
        fontWeight="700"
        letterSpacing={0.6}
        textTransform="uppercase"
        color={tokens.textTertiary}
      >
        {title}
      </Text>
      {children}
    </YStack>
  )
}

function PlanField({
  plans,
  selected,
  onSelect,
  internalSuffix,
}: {
  plans: PlanOption[]
  selected: string
  onSelect: (id: string) => void
  internalSuffix: string
}) {
  const { t } = useTranslation()
  return (
    <YStack gap={6}>
      <FieldLabel>{t("windows.usersPanel.billing.plan")}</FieldLabel>
      <XStack gap={6} flexWrap="wrap">
        {plans.map((p) => (
          <Chip
            key={p.id}
            testID={`billing-plan-${p.id}`}
            label={p.hidden ? `${p.label} ${internalSuffix}` : p.label}
            active={selected === p.id}
            onPress={() => onSelect(p.id)}
          />
        ))}
      </XStack>
    </YStack>
  )
}

function SubStatusField({
  selected,
  onSelect,
}: {
  selected: SubStatus
  onSelect: (s: SubStatus) => void
}) {
  const { t } = useTranslation()
  return (
    <YStack gap={6}>
      <XStack gap={6} flexWrap="wrap">
        {SUB_STATUSES.map((s) => (
          <Chip
            key={s}
            testID={`billing-substatus-${s}`}
            label={t(`windows.usersPanel.billing.subStatusName.${s}`)}
            active={selected === s}
            onPress={() => onSelect(s)}
          />
        ))}
      </XStack>
    </YStack>
  )
}

function ProviderConfigField({
  value,
  configs,
  onChange,
  onManage,
}: {
  value: string
  configs: TerosProviderConfig[]
  onChange: (v: string) => void
  onManage: () => void
}) {
  const { t } = useTranslation()
  const defaultName = configs.find((c) => c.isDefault)?.name ?? "—"
  const options: SelectOption[] = [
    { key: "", label: t("windows.usersPanel.billing.configDefaultOption", { name: defaultName }) },
    ...configs.filter((c) => !c.isDefault).map((c) => ({ key: c._id, label: c.name })),
  ]
  return (
    <YStack gap={6}>
      <FieldLabel>{t("windows.usersPanel.billing.providerConfig")}</FieldLabel>
      <XStack gap={8} ai="center" flexWrap="wrap">
        <Select
          testID="billing-provider-config"
          value={value}
          options={options}
          onChange={onChange}
          minWidth={200}
          ariaLabel={t("windows.usersPanel.billing.providerConfig")}
        />
        <Button
          testID="billing-manage-configs"
          label={t("windows.usersPanel.billing.manageConfigs")}
          tone="primary"
          onPress={onManage}
        />
      </XStack>
    </YStack>
  )
}

function TeamField({
  value,
  teams,
  onChange,
  invalid = false,
}: {
  value: string
  teams: { _id: string; name: string; memberCount: number; maxSeats: number }[]
  onChange: (v: string) => void
  invalid?: boolean
}) {
  const { t } = useTranslation()
  const options: SelectOption[] = [
    { key: "", label: t("windows.usersPanel.billing.noTeam") },
    ...teams.map((tm) => ({
      key: tm._id,
      label: t("windows.usersPanel.billing.teamOption", {
        name: tm.name,
        used: tm.memberCount,
        max: tm.maxSeats,
      }),
    })),
  ]
  return (
    <YStack gap={6}>
      <FieldLabel>{t("windows.usersPanel.billing.team")}</FieldLabel>
      <Select
        testID="billing-team"
        value={value}
        options={options}
        onChange={onChange}
        minWidth={200}
        ariaLabel={t("windows.usersPanel.billing.team")}
      />
      {value !== "" ? (
        <Text fontSize={11} color={invalid ? tokens.error : tokens.textMuted} marginTop={4}>
          {t("windows.usersPanel.billing.teamOverrideHint")}
        </Text>
      ) : null}
    </YStack>
  )
}
