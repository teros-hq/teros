/**
 * Agent Cores Window Content
 *
 * Admin surface to inspect and manage agent cores (the engines behind agents:
 * systemPrompt + model + modelOverrides + defaultApps[MCAs] + capabilities).
 *
 * Layout (OS prototype vocabulary): a `Page` with the cores as a `Card hov`
 * grid; selecting one (or "create") opens the editor page — `Card` sections
 * per form group, with a back arrow in the head. The editor groups the ~14
 * engine fields into collapsible sections.
 *
 * coreId/coreType are identity and immutable on edit; everything else (model,
 * overrides, personality, capabilities, defaultApps, prompt, status) is editable.
 * The gradual rollout (super-only) lives as a section under the STABLE core.
 */

import type React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Animated, Easing, Platform, Pressable, ScrollView, View } from "react-native"
import { XStack, YStack } from "tamagui"
import { useColors } from "../../components/mca/primitives/useColors"
import { colors as semantic } from "../../components/mca/primitives/colors"
import { resolveRetention } from "@teros/shared"
import { AppSpinner, FullscreenLoader } from "../../components/ui"
import { Avatar } from "../../components/Avatar"
import {
  Badge,
  Btn,
  Card,
  ChipBtn,
  Dot,
  EmptyState,
  Field,
  FieldHelp,
  FieldLabel,
  Grid,
  IconBtn,
  LGroup,
  LRow,
  Page,
  PageHead,
  Ph,
  SectionLabel,
  SelectField,
  Stat,
  Stats,
  T,
} from "../../components/ui/ds"
import type { BadgeTone } from "../../components/ui/ds"
import {
  RetentionBadge,
  RetentionConfirmModal,
  RetentionNotice,
  useRetentionGuard,
} from "../../components/dataRetention"
import type { AgentCoreData } from "../../services/AgentApi"
import type { ModelData } from "../../services/ProviderApi"
import { getTerosClient } from "../../services/terosClientSingleton"

// ============================================================================
// Types
// ============================================================================

// Reuse the API-layer contracts directly (single source of truth — no local
// re-declaration that can silently drift from the wire shape).
type AgentCore = AgentCoreData
type Model = ModelData

/** Rollout state of a coreType flag (core.agent / core.super-agent). */
interface RolloutState {
  experimentalCoreId: string | null
  percentage: number
}

/** Dry-run of a rollout (admin-api.core-rollout-preview) — drives the impact UI. */
interface RolloutPreview {
  total: number
  distribution: Array<{ coreId: string; count: number }>
  plan: { migrate: number; revert: number; stay: number }
  resulting: Array<{ coreId: string; count: number }>
  unbucketed: number
}

/** One agent in the rollout cohort (admin-api.core-rollout-cohort) — the "who". */
interface CohortEntry {
  agentId: string
  agentName: string
  ownerId: string | null
  ownerName: string
  current: string
  target: string
  kind: "migrate" | "revert" | "stay"
  bucket: number | null
}

/** One audit-log entry (admin-api.feature-flags-audit-log) — the rollout timeline. */
interface AuditEntry {
  auditId: string
  action: string
  actor: string
  timestamp: string
  note?: string
}

type Selection = { mode: "edit"; core: AgentCore } | { mode: "create" } | null

const EYEBROW_KEY = "admin.platformEyebrow"
const EYEBROW_DEFAULT = "Administración de la plataforma"

/**
 * The canonical (stable) core of a coreType has `coreId === coreType` (e.g.
 * `coreId: 'agent'`). Experimental cores share the coreType but have their own id.
 * Invariant defined backend-side in agent-provisioning-service.ts / model-service.ts.
 */
const isStableCore = (c: AgentCore): boolean => !!c.coreType && c.coreId === c.coreType

// ============================================================================
// Small shared pieces
// ============================================================================

/** Label + control + hint — the prototype's form vocabulary. */
function FormField({
  label,
  hint,
  required,
  children,
}: {
  label: string
  hint?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <View>
      <FieldLabel required={required}>{label}</FieldLabel>
      {children}
      {hint ? <FieldHelp>{hint}</FieldHelp> : null}
    </View>
  )
}

/**
 * Theme-adaptive colors for AgentCoresWindow — extends useColors() with a
 * theme-matched scrollbar color for web ScrollViews.
 */
function useWindowColors() {
  const c = useColors()
  return { ...c, scrollbarColor: c.borderStrong }
}

/** Web-only thin scrollbar style. */
const scrollbarStyle = (color: string) =>
  Platform.OS === "web"
    ? ({
        scrollbarWidth: "thin",
        scrollbarColor: `${color} transparent`,
        // biome-ignore lint/suspicious/noExplicitAny: web-only CSS keys not in RN ViewStyle
      } as any)
    : null

// ----------------------------------------------------------------------------
// Collapsible form section — a Card with a caret header
// ----------------------------------------------------------------------------

function FormSection({
  title,
  icon,
  defaultOpen = true,
  children,
}: {
  title: string
  /** Phosphor icon name. */
  icon: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const c = useWindowColors()
  const [open, setOpen] = useState(defaultOpen)
  const rotate = useRef(new Animated.Value(defaultOpen ? 1 : 0)).current

  useEffect(() => {
    Animated.timing(rotate, {
      toValue: open ? 1 : 0,
      duration: 150,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    }).start()
  }, [open, rotate])

  const rotation = rotate.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "90deg"] })

  return (
    <Card>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
        style={[
          {
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingHorizontal: 16,
            paddingVertical: 14,
          },
          Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
        ]}
      >
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            backgroundColor: c.tile,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Ph name={icon} size={15} color={c.accent} />
        </View>
        <T step="base" style={{ flex: 1 }}>
          {title}
        </T>
        <Animated.View style={{ transform: [{ rotate: rotation }] }}>
          <Ph name="caret-right" size={14} color={c.text3} />
        </Animated.View>
      </Pressable>
      {open ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 16 }}>{children}</View>
      ) : null}
    </Card>
  )
}

// ----------------------------------------------------------------------------
// Chip editor (personality / capabilities) — replaces raw CSV
// ----------------------------------------------------------------------------

function ChipEditor({
  values,
  onChange,
  tone = "i",
  placeholder,
}: {
  values: string[]
  onChange: (next: string[]) => void
  tone?: BadgeTone
  placeholder: string
}) {
  const c = useWindowColors()
  const { t } = useTranslation()
  const [draft, setDraft] = useState("")

  const add = () => {
    const v = draft.trim()
    if (v && !values.includes(v)) onChange([...values, v])
    setDraft("")
  }
  const remove = (v: string) => onChange(values.filter((x) => x !== v))
  const tint =
    tone === "g" || tone === "a" || tone === "r" || tone === "i" || tone === "m"
      ? c.tint[tone]
      : null

  return (
    <View style={{ gap: 10 }}>
      {values.length > 0 ? (
        <XStack flexWrap="wrap" gap={6}>
          {values.map((v) => (
            <View
              key={v}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                height: 28,
                paddingLeft: 12,
                paddingRight: 4,
                borderRadius: 100,
                backgroundColor: tint ? tint.bg : c.wash,
              }}
            >
              <T step="12" color={tint ? tint.tx : c.text2}>
                {v}
              </T>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${t("common.delete")} ${v}`}
                onPress={() => remove(v)}
                hitSlop={6}
                style={[
                  {
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    alignItems: "center",
                    justifyContent: "center",
                  },
                  Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
                ]}
              >
                <Ph name="x" size={11} color={tint ? tint.tx : c.text2} />
              </Pressable>
            </View>
          ))}
        </XStack>
      ) : null}
      <XStack gap={8} alignItems="center">
        <Field
          containerStyle={{ flex: 1 }}
          value={draft}
          onChangeText={setDraft}
          placeholder={placeholder}
          onSubmitEditing={add}
          blurOnSubmit={false}
        />
        <Btn variant="sec" icon="plus" disabled={!draft.trim()} onPress={add} />
      </XStack>
    </View>
  )
}

// ----------------------------------------------------------------------------
// MCA picker (defaultApps) — toggleable chips from the catalog
// ----------------------------------------------------------------------------

function McaPicker({
  catalog,
  selected,
  onToggle,
}: {
  catalog: { mcaId: string; name: string }[]
  selected: Set<string>
  onToggle: (mcaId: string) => void
}) {
  const { t } = useTranslation()
  if (catalog.length === 0) {
    return (
      <T step="12" tone="text3">
        {t("agentCores.noCatalog")}
      </T>
    )
  }
  return (
    <XStack gap={6} flexWrap="wrap">
      {catalog.map((m) => {
        const on = selected.has(m.mcaId)
        return (
          <ChipBtn
            key={m.mcaId}
            on={on}
            icon={on ? "check" : "cube"}
            onPress={() => onToggle(m.mcaId)}
          >
            {m.name}
          </ChipBtn>
        )
      })}
    </XStack>
  )
}

// ----------------------------------------------------------------------------
// Inline model select (no portal) — a SelectField that opens a nested list card
// ----------------------------------------------------------------------------

function ModelSelect({
  models,
  value,
  onChange,
}: {
  models: Model[]
  value: string
  onChange: (modelId: string) => void
}) {
  const c = useWindowColors()
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { guard, modalProps } = useRetentionGuard()
  const active = models.filter((m) => m.status === "active")
  const selected = active.find((m) => m.modelId === value)
  const selectedRetention = selected
    ? (selected.retention ?? resolveRetention(selected.provider))
    : null

  return (
    <View style={{ gap: 10 }}>
      <SelectField
        icon="cpu"
        label={selected?.name ?? value ?? t("agentCores.selectModel")}
        meta={selected?.provider}
        onPress={() => setOpen((o) => !o)}
        right={
          <XStack alignItems="center" gap={8}>
            {selectedRetention ? <RetentionBadge info={selectedRetention} compact /> : null}
            <Ph name={open ? "caret-up" : "caret-down"} size={13} color={c.text3} />
          </XStack>
        }
      />
      {open ? (
        <Card nested style={{ maxHeight: 240 }}>
          <ScrollView style={scrollbarStyle(c.scrollbarColor)}>
            {active.map((m, i) => {
              const isSel = m.modelId === value
              return (
                <Pressable
                  key={m.modelId}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSel }}
                  onPress={() => {
                    const info = m.retention ?? resolveRetention(m.provider)
                    guard(info, m.modelId, m.name, () => {
                      onChange(m.modelId)
                      setOpen(false)
                    })
                  }}
                  style={({ pressed }) => [
                    {
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 12,
                      paddingVertical: 10,
                      paddingHorizontal: 14,
                      backgroundColor: isSel ? c.navActive : pressed ? c.nestHover : "transparent",
                      borderTopWidth: i > 0 ? 1 : 0,
                      borderTopColor: c.border,
                    },
                    Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
                  ]}
                >
                  <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                    <T step="sm" color={isSel ? c.accent : c.text}>
                      {m.name}
                    </T>
                    <XStack alignItems="center" gap={8}>
                      <T step="codenote" tone="text3">
                        {m.provider}
                      </T>
                      <RetentionBadge info={m.retention ?? resolveRetention(m.provider)} compact />
                    </XStack>
                  </View>
                  {isSel ? <Ph name="check" size={15} color={c.accent} /> : null}
                </Pressable>
              )
            })}
          </ScrollView>
        </Card>
      ) : null}
      {selectedRetention ? <RetentionNotice info={selectedRetention} /> : null}
      <RetentionConfirmModal {...modalProps} />
    </View>
  )
}

// ============================================================================
// Rollout section (shown under the STABLE core's editor, super-only)
// ============================================================================

interface RolloutSectionProps {
  coreType: "agent" | "super-agent"
  /** All cores of this coreType (stable + experimental) — for legible labels. */
  cores: AgentCore[]
  candidates: AgentCore[]
  rollout: RolloutState
  onSet: (coreType: string, experimentalCoreId: string, percentage: number) => Promise<void>
  onClear: (coreType: string) => Promise<void>
  onApply: (
    coreType: string,
  ) => Promise<{ migrated: number; reverted: number; unchanged: number; total: number }>
  onPreview: (
    coreType: string,
    hypothetical?: { experimentalCoreId: string; percentage: number },
  ) => Promise<RolloutPreview>
  onCohort: (
    coreType: string,
    hypothetical?: { experimentalCoreId: string; percentage: number },
  ) => Promise<CohortEntry[]>
  onAuditLog: (coreType: string) => Promise<AuditEntry[]>
  onListOverrides: (coreType: string) => Promise<{ targetId: string; value: string }[]>
  onSetOverride: (coreType: string, userId: string, value: string) => Promise<void>
  onDeleteOverride: (coreType: string, userId: string) => Promise<void>
}

/** A thin progress row for one core's agent count, sized to its share of total. */
function DistroBar({
  label,
  count,
  total,
  stable,
}: {
  label: string
  count: number
  total: number
  stable: boolean
}) {
  const c = useWindowColors()
  const fill = stable ? c.accent : semantic.mint300
  const frac = total > 0 ? Math.round((count / total) * 100) : 0
  return (
    <XStack alignItems="center" gap={12}>
      <T step="sm" tone="text2" numberOfLines={1} style={{ width: 150 }}>
        {label}
      </T>
      <View
        style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: c.wash, overflow: "hidden" }}
      >
        <View
          style={[
            { height: 6, width: `${frac}%`, borderRadius: 3, backgroundColor: fill },
            Platform.OS === "web"
              ? ({ transition: "width 0.5s cubic-bezier(.16,1,.3,1)" } as any)
              : null,
          ]}
        />
      </View>
      <T step="code" style={{ width: 30, textAlign: "right" }}>
        {count}
      </T>
      <T step="code" tone="text3" style={{ width: 40, textAlign: "right" }}>
        {frac} %
      </T>
    </XStack>
  )
}

/**
 * Data side of the rollout section: the saved-state preview (current distribution
 * + what an Apply would do right now, exact) and the live preview (impact of the
 * in-progress exp/% before saving, debounced). Kept out of the component so the
 * render stays focused on presentation.
 */
function useRolloutPreview(
  coreType: "agent" | "super-agent",
  exp: string,
  parsedPct: number,
  onPreview: RolloutSectionProps["onPreview"],
) {
  const [saved, setSaved] = useState<RolloutPreview | null>(null)
  const [live, setLive] = useState<RolloutPreview | null>(null)

  const refreshSaved = useCallback(async () => {
    try {
      setSaved(await onPreview(coreType))
    } catch {
      setSaved(null)
    }
  }, [coreType, onPreview])

  // Load on mount / coreType change. Mutations from this section call refreshSaved
  // directly (see `run`), so the saved rollout changing never needs to be a dep.
  useEffect(() => {
    refreshSaved()
  }, [refreshSaved])

  // Live preview of the in-progress selection, debounced. Needs an experimental
  // core selected; the percentage may be anything in [0, 100] (0 = full revert).
  useEffect(() => {
    if (!exp) {
      setLive(null)
      return
    }
    const id = setTimeout(() => {
      onPreview(coreType, { experimentalCoreId: exp, percentage: parsedPct })
        .then(setLive)
        .catch(() => setLive(null))
    }, 350)
    return () => clearTimeout(id)
  }, [coreType, exp, parsedPct, onPreview])

  return { saved, live, refreshSaved }
}

/** Compact diff of what a migrated agent gains/loses moving stable → experimental. */
function CoreDiff({ stable, exp }: { stable?: AgentCore; exp?: AgentCore }) {
  const c = useWindowColors()
  const { t } = useTranslation()
  if (!stable || !exp || stable.coreId === exp.coreId) return null
  const stableApps = new Set(stable.defaultApps ?? [])
  const expApps = new Set(exp.defaultApps ?? [])
  const added = [...expApps].filter((a) => !stableApps.has(a))
  const removed = [...stableApps].filter((a) => !expApps.has(a))
  const modelChanged = stable.modelId !== exp.modelId
  const promptChanged = (stable.systemPrompt ?? "") !== (exp.systemPrompt ?? "")
  const short = (id: string) => id.replace(/^mca\./, "")

  if (!modelChanged && !promptChanged && added.length === 0 && removed.length === 0) {
    return (
      <T step="12" tone="text3">
        {t("agentCores.diffIdentical")}
      </T>
    )
  }
  return (
    <Card nested pad={12} style={{ gap: 4 }}>
      <T step="xs" tone="text2">
        {t("agentCores.diffTitle")}
      </T>
      {modelChanged ? (
        <T step="12" tone="text2">
          {t("agentCores.diffModel")}:{" "}
          <T step="code" tone="text2">
            {stable.modelId}
          </T>{" "}
          →{" "}
          <T step="code" color={c.tint.a.tx}>
            {exp.modelId}
          </T>
        </T>
      ) : null}
      {added.length > 0 ? (
        <T step="code" color={c.tint.g.tx}>
          + {added.map(short).join(", ")}
        </T>
      ) : null}
      {removed.length > 0 ? (
        <T step="code" color={c.tint.r.tx}>
          − {removed.map(short).join(", ")}
        </T>
      ) : null}
      {promptChanged ? (
        <T step="12" tone="text3">
          {t("agentCores.diffPrompt")}
        </T>
      ) : null}
    </Card>
  )
}

/** Percentage control: mono field + quick ramp chips (5/25/50/100). */
function RampInput({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  const current = parseInt(value, 10)
  return (
    <XStack gap={10} alignItems="center" flexWrap="wrap">
      <Field
        mono
        keyboardType="number-pad"
        value={value}
        onChangeText={onChange}
        placeholder="0"
        editable={!disabled}
        containerStyle={{ width: 110 }}
        right={
          <T step="codenote" tone="text3">
            %
          </T>
        }
      />
      <XStack gap={4} flexWrap="wrap">
        {[5, 25, 50, 100].map((s) => (
          <ChipBtn
            key={s}
            mono
            on={current === s}
            disabled={disabled}
            onPress={() => onChange(String(s))}
          >
            {`${s} %`}
          </ChipBtn>
        ))}
      </XStack>
    </XStack>
  )
}

/** Hero figures for an impact plan: migrate / revert / unchanged. */
function PlanFigures({ plan }: { plan: { migrate: number; revert: number; stay: number } }) {
  const { t } = useTranslation()
  return (
    <Stats cols={3}>
      <Stat v={plan.migrate} label={t("agentCores.figMigrate")} accent={plan.migrate > 0} />
      <Stat v={plan.revert} label={t("agentCores.figRevert")} accent={plan.revert > 0} />
      <Stat v={plan.stay} label={t("agentCores.figStay")} />
    </Stats>
  )
}

/** The "who" panel: the rollout cohort grouped by owner, scrollable. */
function CohortPanel({
  cohort,
  labelFor,
}: {
  cohort: CohortEntry[]
  labelFor: (coreId: string) => string
}) {
  const c = useWindowColors()
  const { t } = useTranslation()
  const byOwner = new Map<string, CohortEntry[]>()
  for (const e of cohort) {
    const list = byOwner.get(e.ownerName) ?? []
    list.push(e)
    byOwner.set(e.ownerName, list)
  }
  const kindColor = (kind: CohortEntry["kind"]) =>
    kind === "migrate" ? c.tint.a.tx : kind === "revert" ? c.tint.g.tx : c.text3

  if (cohort.length === 0) {
    return (
      <T step="12" tone="text3">
        {t("agentCores.cohortEmpty")}
      </T>
    )
  }
  return (
    <Card nested style={{ maxHeight: 260 }}>
      <ScrollView style={scrollbarStyle(c.scrollbarColor)}>
        {[...byOwner.entries()].map(([owner, entries], i) => (
          <View
            key={owner}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 10,
              gap: 4,
              borderTopWidth: i > 0 ? 1 : 0,
              borderTopColor: c.border,
            }}
          >
            <XStack justifyContent="space-between" alignItems="center" gap={8}>
              <T step="sm" numberOfLines={1} style={{ flex: 1 }}>
                {owner}
              </T>
              {entries[0].bucket != null ? (
                <T step="codenote" tone="text3">
                  bucket {entries[0].bucket}
                </T>
              ) : (
                <Badge tone="r" sm>
                  {t("agentCores.noBucket")}
                </Badge>
              )}
            </XStack>
            {entries.map((e) => (
              <XStack key={e.agentId} gap={8} alignItems="center" paddingLeft={10}>
                <T step="12" tone="text2" numberOfLines={1} style={{ flex: 1 }}>
                  {e.agentName}
                </T>
                <T step="codenote" tone="text3">
                  {labelFor(e.current)}
                </T>
                {e.kind !== "stay" ? (
                  <T step="codenote" color={kindColor(e.kind)}>
                    → {labelFor(e.target)}
                  </T>
                ) : null}
              </XStack>
            ))}
          </View>
        ))}
      </ScrollView>
    </Card>
  )
}

/** Rollout timeline from the audit log (set / clear / apply), most recent first. */
function AuditTimeline({ entries }: { entries: AuditEntry[] }) {
  const c = useWindowColors()
  const { t } = useTranslation()
  const describe = (e: AuditEntry) => {
    if (e.action === "apply_rollout") {
      const m = /migrated=(\d+) reverted=(\d+)/.exec(e.note ?? "")
      return t("agentCores.auditApply", { migrated: m?.[1] ?? "?", reverted: m?.[2] ?? "?" })
    }
    if (e.action === "set_rollout") {
      const p = /percentage=(\d+)/.exec(e.note ?? "")?.[1]
      return t("agentCores.auditSet", { pct: p ?? "?" })
    }
    if (e.action === "clear_rollout") return t("agentCores.auditClear")
    return e.action
  }
  const toneFor = (action: string): BadgeTone =>
    action === "apply_rollout"
      ? "g"
      : action === "set_rollout"
        ? "i"
        : action === "clear_rollout"
          ? "a"
          : "neutral"
  const shortAction = (action: string) => action.replace(/_rollout$/, "")
  const when = (ts: string) => {
    const d = new Date(ts)
    return Number.isNaN(d.getTime()) ? ts : d.toLocaleString()
  }
  if (entries.length === 0) {
    return (
      <T step="12" tone="text3">
        {t("agentCores.auditEmpty")}
      </T>
    )
  }
  return (
    <Card nested style={{ maxHeight: 220 }}>
      <ScrollView style={scrollbarStyle(c.scrollbarColor)}>
        {entries.map((e, i) => (
          <XStack
            key={e.auditId}
            gap={12}
            alignItems="center"
            paddingHorizontal={14}
            paddingVertical={9}
            borderTopWidth={i > 0 ? 1 : 0}
            borderTopColor={c.border}
          >
            <T step="codenote" tone="text3" numberOfLines={1} style={{ width: 150 }}>
              {when(e.timestamp)}
            </T>
            <T step="sm" tone="text2" style={{ flex: 1 }}>
              {describe(e)} · {e.actor}
            </T>
            <Badge mono sm tone={toneFor(e.action)}>
              {shortAction(e.action)}
            </Badge>
          </XStack>
        ))}
      </ScrollView>
    </Card>
  )
}

/** Per-user overrides: force/exclude a specific user onto stable or experimental.
 *  An override beats the percentage rollout (source 'user_override' > 'rollout'). */
function OverridesPanel({
  coreType,
  expCoreId,
  labelFor,
  onList,
  onSet,
  onDelete,
}: {
  coreType: string
  expCoreId: string | null
  labelFor: (coreId: string) => string
  onList: (coreType: string) => Promise<{ targetId: string; value: string }[]>
  onSet: (coreType: string, userId: string, value: string) => Promise<void>
  onDelete: (coreType: string, userId: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const [overrides, setOverrides] = useState<{ targetId: string; value: string }[]>([])
  const [uid, setUid] = useState("")
  const [target, setTarget] = useState(coreType)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(() => {
    onList(coreType)
      .then(setOverrides)
      .catch(() => setOverrides([]))
  }, [coreType, onList])
  useEffect(() => {
    reload()
  }, [reload])

  const run = (fn: () => Promise<void>) => {
    setBusy(true)
    fn()
      .then(reload)
      .finally(() => setBusy(false))
  }

  return (
    <View style={{ gap: 12 }}>
      {overrides.length === 0 ? (
        <T step="12" tone="text3">
          {t("agentCores.noOverrides")}
        </T>
      ) : (
        <LGroup>
          {overrides.map((o) => (
            <LRow key={o.targetId} padV={8} padH={14} gap={10}>
              <T step="code" numberOfLines={1} style={{ flex: 1 }}>
                {o.targetId}
              </T>
              <Badge tone={o.value === coreType ? "g" : "i"} sm>
                {labelFor(o.value)}
              </Badge>
              <IconBtn
                icon="x"
                plain
                sm
                title={t("common.delete")}
                onPress={() => run(() => onDelete(coreType, o.targetId))}
                disabled={busy}
              />
            </LRow>
          ))}
        </LGroup>
      )}
      <XStack gap={8} alignItems="center" flexWrap="wrap">
        <Field
          mono
          containerStyle={{ flex: 1, minWidth: 180 }}
          value={uid}
          onChangeText={setUid}
          placeholder={t("agentCores.overrideUserPlaceholder")}
          autoCapitalize="none"
        />
        <ChipBtn on={target === coreType} onPress={() => setTarget(coreType)}>
          {labelFor(coreType)}
        </ChipBtn>
        {expCoreId ? (
          <ChipBtn on={target === expCoreId} onPress={() => setTarget(expCoreId)}>
            {labelFor(expCoreId)}
          </ChipBtn>
        ) : null}
        <Btn
          variant="sec"
          icon="plus"
          disabled={busy || !uid.trim()}
          onPress={() => run(() => onSet(coreType, uid.trim(), target).then(() => setUid("")))}
        />
      </XStack>
    </View>
  )
}

/** Tinted notice box (amber / red / green). */
function Notice({
  tone,
  icon,
  children,
}: {
  tone: "a" | "r" | "g"
  icon?: string
  children: React.ReactNode
}) {
  const c = useWindowColors()
  const tint = c.tint[tone]
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        padding: 12,
        borderRadius: 12,
        backgroundColor: tint.bg,
        borderWidth: 1,
        borderColor: tint.bd,
      }}
    >
      {icon ? <Ph name={icon} size={15} color={tint.tx} style={{ marginTop: 1 }} /> : null}
      <View style={{ flex: 1, gap: 10 }}>{children}</View>
    </View>
  )
}

function RolloutSection({
  coreType,
  cores,
  candidates,
  rollout,
  onSet,
  onClear,
  onApply,
  onPreview,
  onCohort,
  onAuditLog,
  onListOverrides,
  onSetOverride,
  onDeleteOverride,
}: RolloutSectionProps) {
  const c = useWindowColors()
  const { t } = useTranslation()
  const [exp, setExp] = useState<string>(rollout.experimentalCoreId ?? "")
  const [pct, setPct] = useState<string>(String(rollout.percentage ?? 0))
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<"apply" | "clear" | "revert" | null>(null)
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "error" } | null>(null)
  const [cohort, setCohort] = useState<CohortEntry[] | null>(null)
  const [audit, setAudit] = useState<AuditEntry[] | null>(null)
  const [overridesOpen, setOverridesOpen] = useState(false)

  // Resync the form with the server state when it changes (e.g. after Clear/Set
  // reloads the flags). This component is not remounted on those changes — without
  // this, exp/pct keep the stale pre-clear values and "Set rollout" would re-create
  // the rollout the admin just cleared.
  useEffect(() => {
    setExp(rollout.experimentalCoreId ?? "")
    setPct(String(rollout.percentage ?? 0))
  }, [rollout.experimentalCoreId, rollout.percentage])

  const parsedPct = Math.max(0, Math.min(100, parseInt(pct, 10) || 0))
  const { saved, live, refreshSaved } = useRolloutPreview(coreType, exp, parsedPct, onPreview)

  const hasRollout = !!rollout.experimentalCoreId && rollout.percentage > 0

  const labelFor = (coreId: string) => cores.find((c) => c.coreId === coreId)?.fullName ?? coreId
  const isStable = (coreId: string) => coreId === coreType

  // Order the distribution rows: stable core first, then experimentals.
  const distRows = (p: RolloutPreview | null) =>
    (p?.distribution ?? [])
      .slice()
      .sort((a, b) => Number(isStable(b.coreId)) - Number(isStable(a.coreId)))

  // Agents currently sitting on an experimental core. Clear does NOT move them —
  // only an Apply (at 0%) reverts them. We surface that so "Clear" is not mistaken
  // for a rollback, and to gate the one-click "Revert all".
  const migratedRows = distRows(saved).filter((d) => !isStable(d.coreId) && d.count > 0)
  const migratedAway = migratedRows.reduce((sum, d) => sum + d.count, 0)
  const migratedExp = migratedRows[0]?.coreId

  // Diff stable ↔ in-progress experimental (what migrated agents would receive).
  const stableCore = cores.find((c) => isStable(c.coreId))
  const expCore = cores.find((c) => c.coreId === exp)

  // The SAVED rollout may point at a core deactivated after Set → Apply would throw.
  // Warn up-front and gate Apply instead of failing at click time.
  const savedExpCore = cores.find((c) => c.coreId === rollout.experimentalCoreId)
  const savedExpInactive = hasRollout && (!savedExpCore || savedExpCore.status !== "active")

  // Target declared (flag) vs reality (applied): Set without Apply leaves them out
  // of sync. saved.plan counts what an Apply right now would still move.
  const pending = saved ? saved.plan.migrate + saved.plan.revert : 0

  const ok = (text: string) => setMsg({ text, kind: "ok" })

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : String(err), kind: "error" })
    } finally {
      // Always resync — Apply is non-transactional, so even on a mid-run failure the
      // distribution may have partially changed and must reflect reality.
      await refreshSaved()
      setBusy(false)
    }
  }

  // Revert everyone to the stable core: set the saved experimental to 0% and Apply.
  const revertAll = () =>
    run(async () => {
      if (rollout.experimentalCoreId) await onSet(coreType, rollout.experimentalCoreId, 0)
      const res = await onApply(coreType)
      setConfirm(null)
      ok(t("agentCores.rolloutApplied", res))
    })

  return (
    <FormSection title={t("agentCores.rollout")} icon="rocket-launch" defaultOpen={hasRollout}>
      {/* What this does — Set declares the plan; Apply moves agents. */}
      <T step="12" tone="text3">
        {t("agentCores.rolloutHelp")}
      </T>

      {/* The saved rollout points at a core that is no longer active → Apply throws. */}
      {savedExpInactive ? (
        <Notice tone="r" icon="warning">
          <T step="sm" color={c.tint.r.tx}>
            {t("agentCores.experimentalInactive", {
              exp: labelFor(rollout.experimentalCoreId ?? ""),
            })}
          </T>
        </Notice>
      ) : null}

      {/* Current state: stable + experimental + sync (declared vs applied) */}
      <XStack gap={6} flexWrap="wrap" alignItems="center">
        <Badge tone="g" dot>
          {t("agentCores.stable")}: {coreType}
        </Badge>
        {hasRollout ? (
          <Badge tone="i" dot>
            {t("agentCores.experimental")}: {labelFor(rollout.experimentalCoreId ?? "")} ·{" "}
            {rollout.percentage}%
          </Badge>
        ) : (
          <T step="12" tone="text3">
            {t("agentCores.noActiveRollout")}
          </T>
        )}
        {saved && saved.total > 0 ? (
          <Badge tone={pending > 0 ? "a" : "g"}>
            {pending > 0
              ? t("agentCores.pendingApply", { count: pending })
              : t("agentCores.synced")}
          </Badge>
        ) : null}
      </XStack>

      {/* Current distribution — who runs what today. */}
      {saved && saved.total > 0 ? (
        <View style={{ gap: 10 }}>
          <T step="sm" tone="text2">
            {t("agentCores.currentDistribution", { total: saved.total })}
          </T>
          {distRows(saved).map((d) => (
            <DistroBar
              key={d.coreId}
              label={labelFor(d.coreId)}
              count={d.count}
              total={saved.total}
              stable={isStable(d.coreId)}
            />
          ))}
          {saved.unbucketed > 0 ? (
            <T step="12" color={c.tint.r.tx}>
              {t("agentCores.neverMigrate", { count: saved.unbucketed })}
            </T>
          ) : null}
          <XStack>
            <Btn
              variant="ghost"
              size="sm"
              icon="users-three"
              onPress={() =>
                cohort
                  ? setCohort(null)
                  : onCohort(coreType)
                      .then(setCohort)
                      .catch(() => setCohort(null))
              }
            >
              {cohort
                ? t("agentCores.hideCohort")
                : t("agentCores.viewCohort", { count: saved.total })}
            </Btn>
          </XStack>
          {cohort ? <CohortPanel cohort={cohort} labelFor={labelFor} /> : null}
        </View>
      ) : null}

      {candidates.length === 0 ? (
        <T step="12" tone="text3">
          {t("agentCores.noExperimentalCandidates")}
        </T>
      ) : (
        <View style={{ gap: 12 }}>
          <T step="sm" tone="text2">
            {t("agentCores.chooseExperimental")}
          </T>
          <XStack gap={6} flexWrap="wrap">
            {candidates.map((cand) => (
              <ChipBtn
                key={cand.coreId}
                on={exp === cand.coreId}
                icon={exp === cand.coreId ? "check" : undefined}
                onPress={() => setExp(cand.coreId)}
              >
                {labelFor(cand.coreId)}
              </ChipBtn>
            ))}
          </XStack>

          {/* What migrated agents would receive (model / MCAs / prompt). */}
          {exp ? <CoreDiff stable={stableCore} exp={expCore} /> : null}

          <XStack gap={10} alignItems="center" justifyContent="space-between" flexWrap="wrap">
            <RampInput value={pct} onChange={setPct} disabled={busy} />
            <Btn
              variant="sec"
              size="sm"
              icon="floppy-disk"
              disabled={busy || !exp}
              onPress={() =>
                run(async () => {
                  await onSet(coreType, exp, parsedPct)
                  ok(t("agentCores.rolloutSaved"))
                })
              }
            >
              {t("agentCores.setRollout")}
            </Btn>
          </XStack>

          {/* Live impact of the in-progress selection (before saving). */}
          {exp && live ? (
            <Notice tone="a">
              <T step="xs" color={c.tint.a.tx}>
                {t("agentCores.liveImpactAt", { percentage: parsedPct })}
              </T>
              <PlanFigures plan={live.plan} />
              <T step="12" tone="text2">
                {t("agentCores.wouldResult", {
                  summary: distRows(live)
                    .map((d) => `${labelFor(d.coreId)} ${d.count}`)
                    .join(" · "),
                })}
              </T>
            </Notice>
          ) : null}

          {confirm === "apply" ? (
            <Notice tone="a" icon="lightning">
              {saved ? (
                <>
                  <T step="sm" color={c.tint.a.tx}>
                    {t("agentCores.confirmApplyTitle")}
                  </T>
                  <PlanFigures plan={saved.plan} />
                </>
              ) : (
                <T step="sm" color={c.tint.a.tx}>
                  {t("agentCores.confirmApply", { coreType })}
                </T>
              )}
              <XStack gap={8} justifyContent="flex-end">
                <Btn variant="sec" size="sm" disabled={busy} onPress={() => setConfirm(null)}>
                  {t("common.cancel")}
                </Btn>
                <Btn
                  variant="amber"
                  size="sm"
                  icon="lightning"
                  disabled={busy}
                  onPress={() =>
                    run(async () => {
                      const res = await onApply(coreType)
                      setConfirm(null)
                      ok(t("agentCores.rolloutApplied", res))
                    })
                  }
                >
                  {t("common.confirm")}
                </Btn>
              </XStack>
            </Notice>
          ) : confirm === "revert" ? (
            // One-click rollback: set the saved experimental to 0% and Apply.
            <Notice tone="g" icon="arrow-counter-clockwise">
              <XStack gap={8} alignItems="center" flexWrap="wrap">
                <T step="sm" color={c.tint.g.tx} style={{ flex: 1, minWidth: 200 }}>
                  {t("agentCores.confirmRevert", { count: migratedAway })}
                </T>
                <Btn variant="sec" size="sm" disabled={busy} onPress={() => setConfirm(null)}>
                  {t("common.cancel")}
                </Btn>
                <Btn variant="primary" size="sm" disabled={busy} onPress={revertAll}>
                  {t("agentCores.revertAll")}
                </Btn>
              </XStack>
            </Notice>
          ) : confirm === "clear" ? (
            // Clear only drops the flag — it does NOT move migrated agents back.
            <Notice tone="a" icon="warning">
              <XStack gap={8} alignItems="center" flexWrap="wrap">
                <T step="sm" color={c.tint.a.tx} style={{ flex: 1, minWidth: 200 }}>
                  {t("agentCores.confirmClear", {
                    count: migratedAway,
                    exp: migratedExp ? labelFor(migratedExp) : "",
                  })}
                </T>
                <Btn variant="sec" size="sm" disabled={busy} onPress={() => setConfirm(null)}>
                  {t("common.cancel")}
                </Btn>
                <Btn
                  variant="dangerSoft"
                  size="sm"
                  disabled={busy}
                  onPress={() =>
                    run(async () => {
                      await onClear(coreType)
                      setConfirm(null)
                    })
                  }
                >
                  {t("agentCores.clearRollout")}
                </Btn>
              </XStack>
            </Notice>
          ) : (
            <XStack gap={8} flexWrap="wrap" alignItems="center">
              {/* Apply is the only action that mutates production now → it leads. */}
              <Btn
                variant={savedExpInactive ? "sec" : "amber"}
                size="sm"
                icon="lightning"
                disabled={busy || savedExpInactive}
                onPress={() => setConfirm("apply")}
              >
                {t("agentCores.applyRollout")}
              </Btn>
              {migratedAway > 0 ? (
                <Btn
                  variant="sec"
                  size="sm"
                  icon="arrow-counter-clockwise"
                  disabled={busy}
                  onPress={() => setConfirm("revert")}
                >
                  {t("agentCores.revertAll")}
                </Btn>
              ) : null}
              {hasRollout ? (
                <Btn
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  // With agents already on the experimental, Clear is easy to mistake
                  // for a rollback — confirm and explain it isn't. Otherwise clear directly.
                  onPress={() =>
                    migratedAway > 0 ? setConfirm("clear") : run(() => onClear(coreType))
                  }
                >
                  {t("agentCores.clearRollout")}
                </Btn>
              ) : null}
            </XStack>
          )}
        </View>
      )}

      {busy ? (
        <XStack gap={8} alignItems="center">
          <AppSpinner size="sm" />
          {saved && saved.total > 0 ? (
            <T step="12" tone="text3">
              {t("agentCores.applyingTo", { total: saved.total })}
            </T>
          ) : null}
        </XStack>
      ) : null}
      {msg ? (
        <View style={{ gap: 4 }}>
          <T step="12" color={msg.kind === "error" ? c.tint.r.tx : c.text2}>
            {msg.text}
          </T>
          {msg.kind === "error" ? (
            <T step="12" tone="text3">
              {t("agentCores.applyRetryHint")}
            </T>
          ) : null}
        </View>
      ) : null}

      {/* History — who changed / applied the rollout, when (from the audit log). */}
      <XStack>
        <Btn
          variant="ghost"
          size="sm"
          icon="clock-counter-clockwise"
          onPress={() =>
            audit
              ? setAudit(null)
              : onAuditLog(coreType)
                  .then(setAudit)
                  .catch(() => setAudit([]))
          }
        >
          {audit ? t("agentCores.hideHistory") : t("agentCores.showHistory")}
        </Btn>
      </XStack>
      {audit ? <AuditTimeline entries={audit} /> : null}

      {/* Per-user overrides — force/exclude a specific user (beats the percentage). */}
      <XStack>
        <Btn variant="ghost" size="sm" icon="user-gear" onPress={() => setOverridesOpen((o) => !o)}>
          {overridesOpen ? t("agentCores.hideOverrides") : t("agentCores.showOverrides")}
        </Btn>
      </XStack>
      {overridesOpen ? (
        <View style={{ gap: 10 }}>
          <T step="12" tone="text3">
            {t("agentCores.overridesHint")}
          </T>
          <OverridesPanel
            coreType={coreType}
            expCoreId={rollout.experimentalCoreId ?? (exp || null)}
            labelFor={labelFor}
            onList={onListOverrides}
            onSet={onSetOverride}
            onDelete={onDeleteOverride}
          />
        </View>
      ) : null}
    </FormSection>
  )
}

// ============================================================================
// Core editor (create + edit) — the detail page
// ============================================================================

interface CoreFormPayload {
  coreId: string
  coreType: "agent" | "super-agent"
  name: string
  fullName: string
  version?: string
  systemPrompt: string
  personality: string[]
  capabilities: string[]
  defaultApps: string[]
  modelId: string
  modelOverrides?: { temperature?: number; maxTokens?: number }
  status: "active" | "inactive"
}

interface CoreFormProps {
  mode: "create" | "edit"
  core?: AgentCore
  models: Model[]
  catalog: { mcaId: string; name: string; system: boolean }[]
  /** Rollout controls (stable core + super only). Rendered as a trailing section. */
  rollout?: React.ReactNode
  /** Back arrow in the header. */
  onBack?: () => void
  onSubmit: (payload: CoreFormPayload) => Promise<void>
  onCancel: () => void
}

function CoreForm({
  mode,
  core,
  models,
  catalog,
  rollout,
  onBack,
  onSubmit,
  onCancel,
}: CoreFormProps) {
  const c = useWindowColors()
  const { t } = useTranslation()

  const [coreId, setCoreId] = useState(core?.coreId ?? "")
  const [coreType, setCoreType] = useState<"agent" | "super-agent">(core?.coreType ?? "agent")
  const [name, setName] = useState(core?.name ?? "")
  const [fullName, setFullName] = useState(core?.fullName ?? "")
  const [version, setVersion] = useState(core?.version ?? "")
  const [status, setStatus] = useState<"active" | "inactive">(core?.status ?? "active")
  const [modelId, setModelId] = useState(core?.modelId ?? "")
  const [temperature, setTemperature] = useState(
    core?.modelOverrides?.temperature?.toString() ?? "",
  )
  const [maxTokens, setMaxTokens] = useState(core?.modelOverrides?.maxTokens?.toString() ?? "")
  const [personality, setPersonality] = useState<string[]>(core?.personality ?? [])
  const [capabilities, setCapabilities] = useState<string[]>(core?.capabilities ?? [])
  const [defaultApps, setDefaultApps] = useState<Set<string>>(new Set(core?.defaultApps ?? []))
  const [systemPrompt, setSystemPrompt] = useState(core?.systemPrompt ?? "")
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const valid =
    coreId.trim() && name.trim() && fullName.trim() && systemPrompt.trim() && modelId.trim()

  const toggleApp = (id: string) =>
    setDefaultApps((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const handleSubmit = async () => {
    if (!valid) return
    setSaving(true)
    setErr(null)
    try {
      const overrides: { temperature?: number; maxTokens?: number } = {}
      if (temperature.trim()) overrides.temperature = parseFloat(temperature)
      if (maxTokens.trim()) overrides.maxTokens = parseInt(maxTokens, 10)
      await onSubmit({
        coreId: coreId.trim(),
        coreType,
        name: name.trim(),
        fullName: fullName.trim(),
        version: version.trim() || undefined,
        systemPrompt,
        personality,
        capabilities,
        defaultApps: [...defaultApps],
        modelId,
        // Always send the object (even {}). Emptying the inputs sends {} which the
        // backend persists → clears a previously-set override. `undefined` would be
        // dropped by JSON and leave the old override in place silently.
        modelOverrides: overrides,
        status,
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const isEdit = mode === "edit"
  const title = isEdit
    ? t("agentCores.editCore", { name: core?.fullName ?? "" })
    : t("agentCores.createCore")

  const actions = (
    <>
      <Btn variant="sec" onPress={onCancel} disabled={saving}>
        {t("common.cancel")}
      </Btn>
      <Btn
        variant="primary"
        icon="floppy-disk"
        onPress={handleSubmit}
        disabled={!valid || saving}
        loading={saving}
      >
        {saving
          ? t("common.saving")
          : isEdit
            ? t("agentCores.saveChanges")
            : t("agentCores.createCore")}
      </Btn>
    </>
  )

  return (
    <Page>
      {onBack ? (
        <View style={{ flexDirection: "row", marginBottom: 14 }}>
          <Btn variant="ghost" size="sm" icon="arrow-left" onPress={onBack}>
            {t("common.back")}
          </Btn>
        </View>
      ) : null}

      <PageHead
        eyebrow={t(EYEBROW_KEY, { defaultValue: EYEBROW_DEFAULT })}
        eyebrowRight={
          isEdit && core ? (
            <XStack alignItems="center" gap={6}>
              <Badge tone={isStableCore(core) ? "g" : "i"}>
                {isStableCore(core) ? t("agentCores.stable") : t("agentCores.experimental")}
              </Badge>
              <Badge tone={core.status === "active" ? "g" : "neutral"} dot>
                {t(`agentCores.${core.status}`)}
              </Badge>
            </XStack>
          ) : null
        }
        title={title}
        lead={
          isEdit && core ? (
            <XStack alignItems="center" gap={8} flexWrap="wrap">
              <T step="code" tone="text3">
                {core.coreId}
              </T>
              <T step="code" tone="text3">
                ·
              </T>
              <T step="code" tone="text3">
                {core.modelId}
              </T>
            </XStack>
          ) : undefined
        }
      />

      <YStack gap={14}>
        {/* Identity */}
        <FormSection title={t("agentCores.sectionIdentity")} icon="identification-card">
          {isEdit ? (
            <XStack gap={6} flexWrap="wrap">
              <Badge mono>coreId: {coreId}</Badge>
              {core?.coreType ? <Badge mono>coreType: {core.coreType}</Badge> : null}
            </XStack>
          ) : (
            <>
              <FormField label="coreId" hint={t("agentCores.coreIdHint")} required>
                <Field
                  mono
                  value={coreId}
                  onChangeText={setCoreId}
                  placeholder="super-agent-v2"
                  autoCapitalize="none"
                />
              </FormField>
              <FormField label={t("agentCores.coreType")}>
                <XStack gap={6}>
                  {(["agent", "super-agent"] as const).map((ct) => (
                    <ChipBtn key={ct} mono on={coreType === ct} onPress={() => setCoreType(ct)}>
                      {ct}
                    </ChipBtn>
                  ))}
                </XStack>
              </FormField>
            </>
          )}
          <XStack gap={14} flexWrap="wrap">
            <View style={{ flex: 1, minWidth: 220 }}>
              <FormField label="name" required>
                <Field value={name} onChangeText={setName} placeholder="Super Agent v2" />
              </FormField>
            </View>
            <View style={{ flex: 1, minWidth: 220 }}>
              <FormField label="fullName" required>
                <Field
                  value={fullName}
                  onChangeText={setFullName}
                  placeholder="Teros Super Agent v2"
                />
              </FormField>
            </View>
          </XStack>
          <XStack gap={14} flexWrap="wrap">
            <View style={{ flex: 1, minWidth: 220 }}>
              <FormField label="version">
                <Field mono value={version} onChangeText={setVersion} placeholder="v1.0" />
              </FormField>
            </View>
            <View style={{ flex: 1, minWidth: 220 }}>
              <FormField label={t("agentCores.status")}>
                <XStack gap={6} alignItems="center" height={36}>
                  {(["active", "inactive"] as const).map((s) => (
                    <ChipBtn
                      key={s}
                      on={status === s}
                      icon={status === s ? "check" : undefined}
                      onPress={() => setStatus(s)}
                    >
                      {t(`agentCores.${s}`)}
                    </ChipBtn>
                  ))}
                </XStack>
              </FormField>
            </View>
          </XStack>
        </FormSection>

        {/* Engine */}
        <FormSection title={t("agentCores.sectionEngine")} icon="cpu">
          <FormField label={t("agentCores.model")} required>
            <ModelSelect models={models} value={modelId} onChange={setModelId} />
          </FormField>
          <XStack gap={14} flexWrap="wrap">
            <View style={{ flex: 1, minWidth: 220 }}>
              <FormField label={t("agentCores.temperature")} hint={t("agentCores.temperatureHint")}>
                <Field
                  mono
                  keyboardType="decimal-pad"
                  value={temperature}
                  onChangeText={setTemperature}
                  placeholder={t("agentCores.temperaturePlaceholder")}
                />
              </FormField>
            </View>
            <View style={{ flex: 1, minWidth: 220 }}>
              <FormField label={t("agentCores.maxTokens")} hint={t("agentCores.maxTokensHint")}>
                <Field
                  mono
                  keyboardType="number-pad"
                  value={maxTokens}
                  onChangeText={setMaxTokens}
                  placeholder={t("agentCores.maxTokensPlaceholder")}
                />
              </FormField>
            </View>
          </XStack>
        </FormSection>

        {/* Behavior */}
        <FormSection title={t("agentCores.sectionBehavior")} icon="sparkle">
          <FormField label={t("agentCores.personality")}>
            <ChipEditor
              values={personality}
              onChange={setPersonality}
              tone="i"
              placeholder={t("agentCores.addTraitPlaceholder")}
            />
          </FormField>
          <FormField label={t("agentCores.capabilities")}>
            <ChipEditor
              values={capabilities}
              onChange={setCapabilities}
              tone="m"
              placeholder={t("agentCores.addTraitPlaceholder")}
            />
          </FormField>
        </FormSection>

        {/* MCAs — the core's editable defaultApps + the always-on system apps so
            the editor shows the COMPLETE engine each agent receives. */}
        <FormSection title={t("agentCores.defaultApps")} icon="cube">
          <McaPicker
            catalog={catalog.filter((m) => !m.system)}
            selected={defaultApps}
            onToggle={toggleApp}
          />
          {catalog.some((m) => m.system) ? (
            <View style={{ gap: 8, paddingTop: 14, borderTopWidth: 1, borderTopColor: c.border }}>
              <T step="xs" tone="text2">
                {t("agentCores.systemApps")}
              </T>
              <T step="12" tone="text3">
                {t("agentCores.systemAppsHint")}
              </T>
              <XStack gap={6} flexWrap="wrap">
                {catalog
                  .filter((m) => m.system)
                  .map((m) => (
                    <Badge key={m.mcaId} tone="muted" pill icon="lock-simple">
                      {m.name}
                    </Badge>
                  ))}
              </XStack>
            </View>
          ) : null}
        </FormSection>

        {/* System prompt */}
        <FormSection title={t("agentCores.systemPrompt")} icon="terminal-window">
          <Field
            area
            mono
            minHeight={220}
            value={systemPrompt}
            onChangeText={setSystemPrompt}
            placeholder={t("agentCores.systemPromptPlaceholder")}
            style={scrollbarStyle(c.scrollbarColor)}
          />
          <T step="codenote" tone="text3">
            {t("agentCores.charactersCount", { count: systemPrompt.length })}
          </T>
        </FormSection>

        {/* Rollout (stable core + super) */}
        {rollout}

        {err ? (
          <Notice tone="r" icon="warning">
            <T step="sm" color={c.tint.r.tx}>
              {err}
            </T>
          </Notice>
        ) : null}

        {/* Actions */}
        <XStack gap={10} justifyContent="flex-end" paddingTop={6} flexWrap="wrap">
          {actions}
        </XStack>
      </YStack>
    </Page>
  )
}

// ============================================================================
// Core list (the grid)
// ============================================================================

function CoreListItem({
  core,
  active,
  onPress,
}: {
  core: AgentCore
  active: boolean
  onPress: () => void
}) {
  const c = useWindowColors()
  const { t } = useTranslation()
  const stable = isStableCore(core)
  const live = core.status === "active"
  return (
    <Card
      hov
      pad
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={active ? { borderColor: c.borderAccentStrong } : undefined}
    >
      <XStack alignItems="center" gap={12}>
        <Avatar
          name={core.fullName}
          imageUrl={core.avatarUrl}
          size={40}
          isAgent
          status={live ? "live" : "idle"}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T step="base" numberOfLines={1}>
            {core.fullName}
          </T>
          <T step="code" tone="text3" numberOfLines={1}>
            {core.coreId}
          </T>
        </View>
      </XStack>
      <T step="12" tone="text3" numberOfLines={1} style={{ marginTop: 10 }}>
        {core.modelId}
      </T>
      <XStack alignItems="center" gap={6} marginTop={10} flexWrap="wrap">
        <Badge tone={stable ? "g" : "i"}>
          {stable ? t("agentCores.stable") : t("agentCores.experimental")}
        </Badge>
        {core.version ? (
          <Badge mono sm>
            {core.version}
          </Badge>
        ) : null}
        <View style={{ flex: 1 }} />
        <Dot color={live ? semantic.green : semantic.main500} size={7} />
        <T step="codenote" tone="text3">
          {t(`agentCores.${core.status}`)}
        </T>
      </XStack>
    </Card>
  )
}

function CoreList({
  cores,
  selectedId,
  onSelect,
  onCreate,
}: {
  cores: AgentCore[]
  selectedId: string | null
  onSelect: (core: AgentCore) => void
  onCreate: () => void
}) {
  const { t } = useTranslation()
  if (cores.length === 0) {
    return (
      <Card pad>
        <EmptyState
          icon="cpu"
          title={t("agentCores.noCoresConfigured")}
          action={
            <Btn variant="primary" icon="plus" onPress={onCreate}>
              {t("agentCores.createCore")}
            </Btn>
          }
        />
      </Card>
    )
  }
  return (
    <View>
      <SectionLabel label={t("agentCores.totalCores")} count={cores.length} />
      <Grid cols={3}>
        {cores.map((core) => (
          <CoreListItem
            key={core.coreId}
            core={core}
            active={core.coreId === selectedId}
            onPress={() => onSelect(core)}
          />
        ))}
      </Grid>
    </View>
  )
}

// ============================================================================
// Window
// ============================================================================

export interface AgentCoresWindowContentProps {
  windowId: string
}

export function AgentCoresWindowContent(_props: AgentCoresWindowContentProps) {
  const { t } = useTranslation()
  const client = getTerosClient()

  const [cores, setCores] = useState<AgentCore[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [mcaCatalog, setMcaCatalog] = useState<{ mcaId: string; name: string; system: boolean }[]>(
    [],
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection>(null)

  // Rollout state per coreType (super-only; plain admins get FORBIDDEN → hidden).
  const [rollouts, setRollouts] = useState<Record<string, RolloutState>>({})
  const [rolloutAvailable, setRolloutAvailable] = useState(false)

  // Load BOTH active and inactive cores: an admin who deactivates a core must
  // still see it in the list (with a grey StatusDot) to be able to re-activate it,
  // and the edit-path's `list.find` must keep finding it. The handler defaults to
  // 'active' when no status is passed, so we fetch each explicitly.
  //
  // Filter to cores of the NEW model only (those with a `coreType`). The
  // consolidation migration (20260529_001) soft-deletes pre-internalization
  // legacy cores (status:inactive, no coreType) as residue kept only for the
  // migration's down()/debug — they are not manageable here and would otherwise
  // flood the list. Experimental cores created via create-core always have a
  // coreType, so a deactivated experimental still shows (H1 intact).
  const fetchAllCores = useCallback(async (): Promise<AgentCore[]> => {
    const [active, inactive] = await Promise.all([
      client.agent.listCores("active").then((r) => r.cores),
      client.agent.listCores("inactive").then((r) => r.cores),
    ])
    return [...active, ...inactive].filter((c) => !!c.coreType)
  }, [client])

  const loadFlags = useCallback(async () => {
    try {
      const { flags } = await client.admin.listFeatureFlags()
      const next: Record<string, RolloutState> = {}
      for (const f of flags) {
        if (f.key === "core.agent" || f.key === "core.super-agent") {
          const coreType = f.key.slice("core.".length)
          next[coreType] = f.rollout
            ? { experimentalCoreId: String(f.rollout.value), percentage: f.rollout.percentage }
            : { experimentalCoreId: null, percentage: 0 }
        }
      }
      setRollouts(next)
      setRolloutAvailable(true)
    } catch {
      setRolloutAvailable(false)
    }
  }, [client])

  const loadData = useCallback(async () => {
    try {
      const [coresList, modelsList, mcas] = await Promise.all([
        fetchAllCores(),
        client.provider.listModels(),
        // FULL catalog (admin) — includes system + hidden MCAs so the editor can show
        // the COMPLETE engine (system apps every agent gets + the core's defaultApps),
        // not only the editable defaultApps. Non-fatal if it fails.
        client.app
          .listAllMcas()
          .then((r) => r.mcas)
          .catch(() => []),
      ])
      setCores(coresList)
      setModels(modelsList.models)
      setMcaCatalog(
        mcas.map((m) => ({
          mcaId: m.mcaId,
          name: m.name,
          system: m.availability?.system ?? false,
        })),
      )
      await loadFlags()
    } catch (err) {
      console.error("Failed to load data:", err)
      setError(err instanceof Error ? err.message : t("agentCores.failedToLoadData"))
    } finally {
      setLoading(false)
    }
  }, [client, fetchAllCores, loadFlags, t])

  useEffect(() => {
    if (client.isConnected()) {
      loadData()
    } else {
      const onConnected = () => {
        loadData()
        client.off("connected", onConnected)
      }
      client.on("connected", onConnected)
      return () => client.off("connected", onConnected)
    }
  }, [client, loadData])

  const reloadCores = useCallback(async (): Promise<AgentCore[]> => {
    const list = await fetchAllCores()
    setCores(list)
    return list
  }, [fetchAllCores])

  const retry = () => {
    setError(null)
    setLoading(true)
    loadData()
  }

  const handleSubmit = async (payload: CoreFormPayload) => {
    if (selection?.mode === "create") {
      const { core } = await client.agent.createCore(payload)
      const list = await reloadCores()
      const fresh = list.find((c) => c.coreId === core.coreId) ?? core
      setSelection({ mode: "edit", core: fresh })
    } else if (selection?.mode === "edit") {
      const { coreId: _omitId, coreType: _omitType, ...updates } = payload
      await client.agent.updateCore(selection.core.coreId, updates)
      const list = await reloadCores()
      const fresh = list.find((c) => c.coreId === selection.core.coreId)
      if (fresh) setSelection({ mode: "edit", core: fresh })
    }
    await loadFlags()
  }

  const handleSetRollout = async (
    coreType: string,
    experimentalCoreId: string,
    percentage: number,
  ) => {
    await client.admin.setFeatureFlagRollout(`core.${coreType}`, experimentalCoreId, percentage)
    await loadFlags()
  }
  const handleClearRollout = async (coreType: string) => {
    await client.admin.clearFeatureFlagRollout(`core.${coreType}`)
    await loadFlags()
  }
  const handleApplyRollout = (coreType: string) =>
    client.admin.applyCoreRollout(coreType as "agent" | "super-agent").then(async (res) => {
      await reloadCores()
      return res
    })
  // Memoized: RolloutSection drives effects off onPreview's identity, so a fresh
  // closure each render would loop the dry-run requests.
  const handlePreview = useCallback(
    (
      coreType: string,
      hypothetical?: { experimentalCoreId: string; percentage: number },
    ): Promise<RolloutPreview> =>
      client.admin.previewCoreRollout(coreType as "agent" | "super-agent", hypothetical),
    [client],
  )
  const handleCohort = useCallback(
    (
      coreType: string,
      hypothetical?: { experimentalCoreId: string; percentage: number },
    ): Promise<CohortEntry[]> =>
      client.admin
        .cohortCoreRollout(coreType as "agent" | "super-agent", hypothetical)
        .then((r) => r.cohort),
    [client],
  )
  const handleAuditLog = useCallback(
    (coreType: string): Promise<AuditEntry[]> =>
      client.admin.getFeatureFlagAuditLog(`core.${coreType}`).then((r) => r.entries),
    [client],
  )
  const handleListOverrides = useCallback(
    (coreType: string) =>
      client.admin
        .getFeatureFlagOverrides(`core.${coreType}`)
        .then((r) =>
          r.overrides
            .filter((o) => o.targetType === "user")
            .map((o) => ({ targetId: o.targetId, value: String(o.value) })),
        ),
    [client],
  )
  const handleSetOverride = useCallback(
    (coreType: string, userId: string, value: string): Promise<void> =>
      client.admin.setFeatureFlagOverride(`core.${coreType}`, "user", userId, value).then(() => {}),
    [client],
  )
  const handleDeleteOverride = useCallback(
    (coreType: string, userId: string): Promise<void> =>
      client.admin.deleteFeatureFlagOverride(`core.${coreType}`, "user", userId).then(() => {}),
    [client],
  )

  const eyebrow = t(EYEBROW_KEY, { defaultValue: EYEBROW_DEFAULT })

  if (loading) {
    return <FullscreenLoader variant="default" label={t("agentCores.loadingCores")} />
  }

  if (error) {
    return (
      <Page>
        <PageHead
          eyebrow={eyebrow}
          title={t("windows.agentCores")}
          lead={t("windows.agentCoresSub")}
        />
        <Card pad>
          <EmptyState
            icon="warning"
            title={error}
            action={
              <Btn variant="sec" icon="arrows-clockwise" onPress={retry}>
                {t("common.retry")}
              </Btn>
            }
          />
        </Card>
      </Page>
    )
  }

  // Build the rollout node for the selected core, if it's the stable core and
  // rollout controls are available (super-only).
  const rolloutNode =
    selection?.mode === "edit" &&
    selection.core.coreType &&
    isStableCore(selection.core) &&
    rolloutAvailable ? (
      <RolloutSection
        coreType={selection.core.coreType}
        cores={cores.filter((c) => c.coreType === selection.core.coreType)}
        candidates={cores.filter(
          (c) =>
            c.coreType === selection.core.coreType && !isStableCore(c) && c.status === "active",
        )}
        rollout={rollouts[selection.core.coreType] ?? { experimentalCoreId: null, percentage: 0 }}
        onSet={handleSetRollout}
        onClear={handleClearRollout}
        onApply={handleApplyRollout}
        onPreview={handlePreview}
        onCohort={handleCohort}
        onAuditLog={handleAuditLog}
        onListOverrides={handleListOverrides}
        onSetOverride={handleSetOverride}
        onDeleteOverride={handleDeleteOverride}
      />
    ) : undefined

  const selectedId = selection?.mode === "edit" ? selection.core.coreId : null

  if (selection) {
    return (
      <CoreForm
        // Remount on selection change → form state resets cleanly.
        key={selection.mode === "edit" ? `edit:${selection.core.coreId}` : "create"}
        mode={selection.mode}
        core={selection.mode === "edit" ? selection.core : undefined}
        models={models}
        catalog={mcaCatalog}
        rollout={rolloutNode}
        onBack={() => setSelection(null)}
        onSubmit={handleSubmit}
        onCancel={() => setSelection(null)}
      />
    )
  }

  return (
    <Page>
      <PageHead
        eyebrow={eyebrow}
        title={t("windows.agentCores")}
        lead={t("windows.agentCoresSub")}
        actions={
          <Btn variant="primary" icon="plus" onPress={() => setSelection({ mode: "create" })}>
            {t("agentCores.createCore")}
          </Btn>
        }
      />
      <CoreList
        cores={cores}
        selectedId={selectedId}
        onSelect={(core) => setSelection({ mode: "edit", core })}
        onCreate={() => setSelection({ mode: "create" })}
      />
    </Page>
  )
}
