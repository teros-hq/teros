/**
 * BillingEditForm — the admin edit form for a user's subscription.
 *
 * Boundary-validates (finite numbers + team/override mutex) via the pure
 * `billingForm` helpers BEFORE calling `admin.update-billing-subscription`, and
 * surfaces failures as an inline `FormError` (no native alert). Pickers are the
 * accessible `Select` (no raw select element); the provider-config CRUD lives in an
 * accessible modal. `customAgentHoursLimit` here is the PERMANENT per-user limit
 * — the temporary period boost gets its own card. Presentation: nested ds
 * `Card` sections, `FieldLabel` / `Field` / `ChipBtn`, `Btn` actions.
 */

import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { Badge, Btn, Card, FieldHelp, T } from "../../../components/ui/ds"
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
import { Chip, FieldLabel, FormError, Hint, TextField } from "./formPrimitives"
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
    <View style={{ gap: 12 }} testID="billing-edit-form">
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <T step="base">{t("windows.usersPanel.billing.editTitle")}</T>
        {dirty ? (
          <Badge tone="a" dot>
            {t("windows.usersPanel.billing.unsavedChanges")}
          </Badge>
        ) : null}
      </View>

      <Section title={t("windows.usersPanel.billing.sections.plan")}>
        <PlanField
          plans={plans}
          selected={values.planId}
          onSelect={(id) => setField("planId", id)}
          internalSuffix={t("windows.usersPanel.billing.internalTier")}
        />
        <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
          <View style={{ flex: 1, minWidth: 160 }}>
            <FieldLabel>{t("windows.usersPanel.billing.customPrice")}</FieldLabel>
            <TextField
              testID="billing-custom-price"
              value={values.customPrice}
              onChangeText={(v) => setField("customPrice", v)}
              placeholder={t("windows.usersPanel.billing.usePlanDefault")}
              numeric
              invalid={errorField === "price"}
            />
          </View>
          <View style={{ flex: 1, minWidth: 160 }}>
            <FieldLabel>{t("windows.usersPanel.billing.priceNote")}</FieldLabel>
            <TextField
              testID="billing-price-note"
              value={values.customPriceNote}
              onChangeText={(v) => setField("customPriceNote", v)}
              placeholder={t("windows.usersPanel.billing.priceNotePlaceholder")}
            />
          </View>
        </View>
      </Section>

      <Section title={t("windows.usersPanel.billing.sections.limit")}>
        <View style={{ maxWidth: 300 }}>
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
        </View>
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

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 8,
          paddingTop: 2,
        }}
      >
        <Btn testID="billing-cancel" variant="ghost" onPress={onCancel}>
          {t("windows.usersPanel.billing.cancel")}
        </Btn>
        <Btn
          testID="billing-save"
          variant="primary"
          icon="floppy-disk"
          loading={saving}
          onPress={handleSave}
        >
          {saving ? t("windows.usersPanel.billing.saving") : t("windows.usersPanel.billing.save")}
        </Btn>
      </View>

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
    </View>
  )
}

/** A titled nested card grouping related fields. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card nested pad>
      <T step="xs" tone="text2" style={{ marginBottom: 12 }}>
        {title}
      </T>
      <View style={{ gap: 12 }}>{children}</View>
    </Card>
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
    <View>
      <FieldLabel>{t("windows.usersPanel.billing.plan")}</FieldLabel>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        {plans.map((p) => (
          <Chip
            key={p.id}
            testID={`billing-plan-${p.id}`}
            label={p.hidden ? `${p.label} ${internalSuffix}` : p.label}
            active={selected === p.id}
            onPress={() => onSelect(p.id)}
          />
        ))}
      </View>
    </View>
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
    <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
      {SUB_STATUSES.map((s) => (
        <Chip
          key={s}
          testID={`billing-substatus-${s}`}
          label={t(`windows.usersPanel.billing.subStatusName.${s}`)}
          active={selected === s}
          onPress={() => onSelect(s)}
        />
      ))}
    </View>
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
    <View style={{ zIndex: 2 }}>
      <FieldLabel>{t("windows.usersPanel.billing.providerConfig")}</FieldLabel>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Select
          testID="billing-provider-config"
          value={value}
          options={options}
          onChange={onChange}
          minWidth={220}
          ariaLabel={t("windows.usersPanel.billing.providerConfig")}
        />
        <Btn testID="billing-manage-configs" variant="sec" icon="gear-six" onPress={onManage}>
          {t("windows.usersPanel.billing.manageConfigs")}
        </Btn>
      </View>
    </View>
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
    <View style={{ zIndex: 1 }}>
      <FieldLabel>{t("windows.usersPanel.billing.team")}</FieldLabel>
      <View style={{ alignItems: "flex-start" }}>
        <Select
          testID="billing-team"
          value={value}
          options={options}
          onChange={onChange}
          minWidth={220}
          ariaLabel={t("windows.usersPanel.billing.team")}
        />
      </View>
      {value !== "" ? (
        <FieldHelp error={invalid}>{t("windows.usersPanel.billing.teamOverrideHint")}</FieldHelp>
      ) : null}
    </View>
  )
}
