/**
 * Agent Cores Window Content
 *
 * Admin surface to inspect and manage agent cores (the engines behind agents:
 * systemPrompt + model + modelOverrides + defaultApps[MCAs] + capabilities).
 *
 * Layout: master-detail split (core list on the left, editor on the right).
 * Responsive — on a narrow tile it collapses to a single column (list ⇄ form
 * with a back arrow). The editor groups the ~14 engine fields into collapsible
 * sections and supersedes the old full-screen Sheet modals.
 *
 * coreId/coreType are identity and immutable on edit; everything else (model,
 * overrides, personality, capabilities, defaultApps, prompt, status) is editable.
 * The gradual rollout (super-only) lives as a section under the STABLE core.
 */

import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  Hash,
  History,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  User,
  Wrench,
  X,
  Zap,
} from '@tamagui/lucide-icons';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Animated, Easing, Platform, TouchableOpacity } from 'react-native';
import {
  Avatar,
  Button,
  Input,
  ScrollView,
  Separator,
  Text,
  TextArea,
  XStack,
  YStack,
} from 'tamagui';
import { useColors } from '../../components/mca/primitives/useColors';
import { colors as semanticColors, indicators, surface } from '../../components/mca/primitives/colors';
import { resolveRetention } from '@teros/shared';
import { AppSpinner, FullscreenLoader } from '../../components/ui';
import {
  RetentionBadge,
  RetentionConfirmModal,
  RetentionNotice,
  useRetentionGuard,
} from '../../components/dataRetention';
import type { AgentCoreData } from '../../services/AgentApi';
import type { ModelData } from '../../services/ProviderApi';
import { getTerosClient } from '../../services/terosClientSingleton';

// ============================================================================
// Types
// ============================================================================

// Reuse the API-layer contracts directly (single source of truth — no local
// re-declaration that can silently drift from the wire shape).
type AgentCore = AgentCoreData;
type Model = ModelData;

/** Rollout state of a coreType flag (core.agent / core.super-agent). */
interface RolloutState {
  experimentalCoreId: string | null;
  percentage: number;
}

/** Dry-run of a rollout (admin-api.core-rollout-preview) — drives the impact UI. */
interface RolloutPreview {
  total: number;
  distribution: Array<{ coreId: string; count: number }>;
  plan: { migrate: number; revert: number; stay: number };
  resulting: Array<{ coreId: string; count: number }>;
  unbucketed: number;
}

/** One agent in the rollout cohort (admin-api.core-rollout-cohort) — the "who". */
interface CohortEntry {
  agentId: string;
  agentName: string;
  ownerId: string | null;
  ownerName: string;
  current: string;
  target: string;
  kind: 'migrate' | 'revert' | 'stay';
  bucket: number | null;
}

/** One audit-log entry (admin-api.feature-flags-audit-log) — the rollout timeline. */
interface AuditEntry {
  auditId: string;
  action: string;
  actor: string;
  timestamp: string;
  note?: string;
}

type Selection = { mode: 'edit'; core: AgentCore } | { mode: 'create' } | null;

const ACCENT = semanticColors.indigo;
const STATUS_COLORS: Record<string, string> = {
  active: semanticColors.green,
  inactive: '#71717A',
};
/** Below this tile width the split collapses to a single navigable column. */
const SPLIT_BREAKPOINT = 640;

/**
 * The canonical (stable) core of a coreType has `coreId === coreType` (e.g.
 * `coreId: 'agent'`). Experimental cores share the coreType but have their own id.
 * Invariant defined backend-side in agent-provisioning-service.ts / model-service.ts.
 */
const isStableCore = (c: AgentCore): boolean => !!c.coreType && c.coreId === c.coreType;

// ============================================================================
// Small shared pieces
// ============================================================================

function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <XStack
      paddingHorizontal="$2"
      paddingVertical="$1"
      backgroundColor={`${color}15`}
      borderRadius="$2"
      borderWidth={1}
      borderColor={`${color}30`}
    >
      <Text fontSize="$1" color={color}>
        {children}
      </Text>
    </XStack>
  );
}

/** Selectable badge — used for coreType / status / model-less pickers. */
function ToggleBadge({
  label,
  selected,
  onPress,
  color = ACCENT,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  color?: string;
}) {
  const c = useWindowColors();
  return (
    <TouchableOpacity onPress={onPress}>
      <Badge color={selected ? color : c.text3}>{label}</Badge>
    </TouchableOpacity>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <YStack gap="$1.5">
      <Text fontSize="$2" color="$gray11">
        {label}
      </Text>
      {children}
      {hint ? (
        <Text fontSize="$1" color="$gray10">
          {hint}
        </Text>
      ) : null}
    </YStack>
  );
}

/**
 * Theme-adaptive colors for AgentCoresWindow — extends useColors() with
 * isDark + a theme-matched scrollbar color for web ScrollViews.
 */
function useWindowColors() {
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;
  const scrollbarColor = isDark ? 'rgba(63, 63, 70, 0.5)' : 'rgba(10,10,15,0.12)';
  return { ...c, isDark, scrollbarColor };
}

/**
 * Web-only thin scrollbar style. Pass a theme-adaptive color
 * (dark: 'rgba(63,63,70,0.5)', light: 'rgba(10,10,15,0.12)').
 */
const scrollbarStyle = (color: string) =>
  ({
    scrollbarWidth: 'thin',
    scrollbarColor: `${color} transparent`,
    // biome-ignore lint/suspicious/noExplicitAny: web-only CSS keys not in RN ViewStyle
  }) as any;

// ----------------------------------------------------------------------------
// Collapsible form section (chevron animation matches AppConfigPanel)
// ----------------------------------------------------------------------------

function FormSection({
  title,
  icon,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const c = useWindowColors();
  const [open, setOpen] = useState(defaultOpen);
  const rotate = useRef(new Animated.Value(defaultOpen ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(rotate, {
      toValue: open ? 1 : 0,
      duration: 150,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [open, rotate]);

  const rotation = rotate.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '90deg'] });

  return (
    <YStack
      borderWidth={1}
      borderColor={c.border}
      borderRadius="$3"
      backgroundColor={c.bgCard}
      overflow="hidden"
    >
      <TouchableOpacity
        onPress={() => setOpen((o) => !o)}
        activeOpacity={0.7}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 }}
      >
        {icon}
        <Text flex={1} fontSize="$3" fontWeight="600" color="$color">
          {title}
        </Text>
        <Animated.View style={{ transform: [{ rotate: rotation }] }}>
          <ChevronRight size={16} color={c.text3} />
        </Animated.View>
      </TouchableOpacity>
      {open ? (
        <YStack padding="$3" paddingTop={0} gap="$3">
          {children}
        </YStack>
      ) : null}
    </YStack>
  );
}

// ----------------------------------------------------------------------------
// Chip editor (personality / capabilities) — replaces raw CSV
// ----------------------------------------------------------------------------

function ChipEditor({
  values,
  onChange,
  color,
  placeholder,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  color: string;
  placeholder: string;
}) {
  const c = useWindowColors();
  const [draft, setDraft] = useState('');

  const add = () => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  };
  const remove = (v: string) => onChange(values.filter((x) => x !== v));

  return (
    <YStack gap="$2">
      {values.length > 0 ? (
        <XStack flexWrap="wrap" gap="$2">
          {values.map((v) => (
            <XStack
              key={v}
              alignItems="center"
              gap="$1"
              paddingLeft="$2"
              paddingRight="$1"
              paddingVertical="$1"
              backgroundColor={`${color}15`}
              borderRadius="$2"
              borderWidth={1}
              borderColor={`${color}30`}
            >
              <Text fontSize="$1" color={color}>
                {v}
              </Text>
              <TouchableOpacity onPress={() => remove(v)} hitSlop={6}>
                <X size={12} color={color} />
              </TouchableOpacity>
            </XStack>
          ))}
        </XStack>
      ) : null}
      <XStack gap="$2">
        <Input
          flex={1}
          value={draft}
          onChangeText={setDraft}
          placeholder={placeholder}
          backgroundColor={c.bgInner}
          borderColor={c.border}
          onSubmitEditing={add}
          blurOnSubmit={false}
        />
        <Button size="$3" disabled={!draft.trim()} onPress={add} icon={<Plus size={16} />} />
      </XStack>
    </YStack>
  );
}

// ----------------------------------------------------------------------------
// MCA picker (defaultApps) — toggleable badges from the catalog
// ----------------------------------------------------------------------------

function McaPicker({
  catalog,
  selected,
  onToggle,
}: {
  catalog: { mcaId: string; name: string }[];
  selected: Set<string>;
  onToggle: (mcaId: string) => void;
}) {
  const { t } = useTranslation();
  if (catalog.length === 0) {
    return (
      <Text fontSize="$1" color="$gray10">
        {t('agentCores.noCatalog')}
      </Text>
    );
  }
  return (
    <XStack gap="$2" flexWrap="wrap">
      {catalog.map((m) => (
        <ToggleBadge
          key={m.mcaId}
          label={m.name}
          selected={selected.has(m.mcaId)}
          color={semanticColors.green}
          onPress={() => onToggle(m.mcaId)}
        />
      ))}
    </XStack>
  );
}

// ----------------------------------------------------------------------------
// Inline model dropdown (no portal) — fits inside the editor pane
// ----------------------------------------------------------------------------

function ModelSelect({
  models,
  value,
  onChange,
}: {
  models: Model[];
  value: string;
  onChange: (modelId: string) => void;
}) {
  const c = useWindowColors();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { guard, modalProps } = useRetentionGuard();
  const active = models.filter((m) => m.status === 'active');
  const selected = active.find((m) => m.modelId === value);
  const selectedRetention = selected
    ? (selected.retention ?? resolveRetention(selected.provider))
    : null;

  return (
    <YStack gap="$2">
      <TouchableOpacity
        onPress={() => setOpen((o) => !o)}
        activeOpacity={0.7}
        style={{
          backgroundColor: c.bgInner,
          borderWidth: 1,
          borderColor: c.border,
          borderRadius: 8,
          paddingVertical: 10,
          paddingHorizontal: 12,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <XStack alignItems="center" gap="$2" flex={1}>
          <Text color={selected ? c.text : c.text3} fontSize="$3">
            {selected?.name ?? value ?? t('agentCores.selectModel')}
          </Text>
          {selectedRetention ? <RetentionBadge info={selectedRetention} compact /> : null}
        </XStack>
        <ChevronDown size={16} color={c.text3} />
      </TouchableOpacity>
      {open ? (
        <YStack
          maxHeight={240}
          borderWidth={1}
          borderColor={c.border}
          borderRadius="$3"
          overflow="hidden"
        >
          <ScrollView style={scrollbarStyle(c.scrollbarColor)}>
            {active.map((m) => {
              const isSel = m.modelId === value;
              return (
                <TouchableOpacity
                  key={m.modelId}
                  onPress={() => {
                    const info = m.retention ?? resolveRetention(m.provider);
                    guard(info, m.modelId, m.name, () => {
                      onChange(m.modelId);
                      setOpen(false);
                    });
                  }}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingVertical: 10,
                    paddingHorizontal: 12,
                    backgroundColor: isSel ? semanticColors.indigoGlow : 'transparent',
                  }}
                >
                  <YStack flex={1} gap={4}>
                    <Text fontSize="$2" color={c.text}>
                      {m.name}
                    </Text>
                    <XStack alignItems="center" gap="$2">
                      <Text fontSize="$1" color="$gray10">
                        {m.provider}
                      </Text>
                      <RetentionBadge info={m.retention ?? resolveRetention(m.provider)} compact />
                    </XStack>
                  </YStack>
                  {isSel ? <Check size={16} color={ACCENT} /> : null}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </YStack>
      ) : null}
      {selectedRetention ? <RetentionNotice info={selectedRetention} /> : null}
      <RetentionConfirmModal {...modalProps} />
    </YStack>
  );
}

// ============================================================================
// Rollout section (shown under the STABLE core's editor, super-only)
// ============================================================================

interface RolloutSectionProps {
  coreType: 'agent' | 'super-agent';
  /** All cores of this coreType (stable + experimental) — for legible labels. */
  cores: AgentCore[];
  candidates: AgentCore[];
  rollout: RolloutState;
  onSet: (coreType: string, experimentalCoreId: string, percentage: number) => Promise<void>;
  onClear: (coreType: string) => Promise<void>;
  onApply: (
    coreType: string,
  ) => Promise<{ migrated: number; reverted: number; unchanged: number; total: number }>;
  onPreview: (
    coreType: string,
    hypothetical?: { experimentalCoreId: string; percentage: number },
  ) => Promise<RolloutPreview>;
  onCohort: (
    coreType: string,
    hypothetical?: { experimentalCoreId: string; percentage: number },
  ) => Promise<CohortEntry[]>;
  onAuditLog: (coreType: string) => Promise<AuditEntry[]>;
  onListOverrides: (coreType: string) => Promise<{ targetId: string; value: string }[]>;
  onSetOverride: (coreType: string, userId: string, value: string) => Promise<void>;
  onDeleteOverride: (coreType: string, userId: string) => Promise<void>;
}

/** A horizontal bar row for one core's agent count, sized to its share of total. */
function DistroBar({
  label,
  count,
  total,
  stable,
}: {
  label: string;
  count: number;
  total: number;
  stable: boolean;
}) {
  const c = useWindowColors();
  const color = stable ? STATUS_COLORS.active : semanticColors.amber;
  const frac = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <XStack alignItems="center" gap="$2">
      <Text fontSize="$1" color="$gray11" width={116} numberOfLines={1}>
        {label}
      </Text>
      <YStack
        flex={1}
        height={8}
        backgroundColor={c.bgInner}
        borderRadius={4}
        overflow="hidden"
      >
        <YStack height={8} width={`${frac}%`} backgroundColor={color} borderRadius={4} />
      </YStack>
      <Text fontSize="$2" color="$color" width={26} textAlign="right">
        {count}
      </Text>
    </XStack>
  );
}

/**
 * Data side of the rollout section: the saved-state preview (current distribution
 * + what an Apply would do right now, exact) and the live preview (impact of the
 * in-progress exp/% before saving, debounced). Kept out of the component so the
 * render stays focused on presentation.
 */
function useRolloutPreview(
  coreType: 'agent' | 'super-agent',
  exp: string,
  parsedPct: number,
  onPreview: RolloutSectionProps['onPreview'],
) {
  const [saved, setSaved] = useState<RolloutPreview | null>(null);
  const [live, setLive] = useState<RolloutPreview | null>(null);

  const refreshSaved = useCallback(async () => {
    try {
      setSaved(await onPreview(coreType));
    } catch {
      setSaved(null);
    }
  }, [coreType, onPreview]);

  // Load on mount / coreType change. Mutations from this section call refreshSaved
  // directly (see `run`), so the saved rollout changing never needs to be a dep.
  useEffect(() => {
    refreshSaved();
  }, [refreshSaved]);

  // Live preview of the in-progress selection, debounced. Needs an experimental
  // core selected; the percentage may be anything in [0, 100] (0 = full revert).
  useEffect(() => {
    if (!exp) {
      setLive(null);
      return;
    }
    const id = setTimeout(() => {
      onPreview(coreType, { experimentalCoreId: exp, percentage: parsedPct })
        .then(setLive)
        .catch(() => setLive(null));
    }, 350);
    return () => clearTimeout(id);
  }, [coreType, exp, parsedPct, onPreview]);

  return { saved, live, refreshSaved };
}

/** Compact diff of what a migrated agent gains/loses moving stable → experimental. */
function CoreDiff({ stable, exp }: { stable?: AgentCore; exp?: AgentCore }) {
  const c = useWindowColors();
  const { t } = useTranslation();
  if (!stable || !exp || stable.coreId === exp.coreId) return null;
  const stableApps = new Set(stable.defaultApps ?? []);
  const expApps = new Set(exp.defaultApps ?? []);
  const added = [...expApps].filter((a) => !stableApps.has(a));
  const removed = [...stableApps].filter((a) => !expApps.has(a));
  const modelChanged = stable.modelId !== exp.modelId;
  const promptChanged = (stable.systemPrompt ?? '') !== (exp.systemPrompt ?? '');
  const short = (id: string) => id.replace(/^mca\./, '');

  if (!modelChanged && !promptChanged && added.length === 0 && removed.length === 0) {
    return (
      <Text fontSize="$1" color="$gray10">
        {t('agentCores.diffIdentical')}
      </Text>
    );
  }
  return (
    <YStack gap="$1" padding="$2.5" borderRadius="$2" backgroundColor={c.bgInner}>
      <Text fontSize="$1" color="$gray11" fontWeight="600">
        {t('agentCores.diffTitle')}
      </Text>
      {modelChanged ? (
        <Text fontSize="$1" color="$gray11">
          {t('agentCores.diffModel')}: {stable.modelId} →{' '}
          <Text color={semanticColors.amber}>{exp.modelId}</Text>
        </Text>
      ) : null}
      {added.length > 0 ? (
        <Text fontSize="$1" color={semanticColors.green}>
          + {added.map(short).join(', ')}
        </Text>
      ) : null}
      {removed.length > 0 ? (
        <Text fontSize="$1" color={semanticColors.red}>
          − {removed.map(short).join(', ')}
        </Text>
      ) : null}
      {promptChanged ? (
        <Text fontSize="$1" color="$gray10">
          {t('agentCores.diffPrompt')}
        </Text>
      ) : null}
    </YStack>
  );
}

/** Percentage control: quick ramp chips (5/25/50/100) + numeric input. */
function RampInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const c = useWindowColors();
  const current = parseInt(value, 10);
  return (
    <YStack gap="$2">
      <XStack gap="$2" alignItems="center">
        <Text fontSize="$2" color="$gray11" width={16}>
          %
        </Text>
        <Input
          flex={1}
          keyboardType="number-pad"
          value={value}
          onChangeText={onChange}
          placeholder="0"
          backgroundColor={c.bgInner}
          borderColor={c.border}
          disabled={disabled}
        />
      </XStack>
      <XStack gap="$2" flexWrap="wrap">
        {[5, 25, 50, 100].map((s) => (
          <ToggleBadge
            key={s}
            label={`${s}%`}
            selected={current === s}
            onPress={() => onChange(String(s))}
          />
        ))}
      </XStack>
    </YStack>
  );
}

/** Hero figures for an impact plan: migrate / revert / unchanged. */
function PlanFigures({ plan }: { plan: { migrate: number; revert: number; stay: number } }) {
  const { t } = useTranslation();
  const Fig = ({ n, label, color }: { n: number; label: string; color: string }) => (
    <YStack alignItems="center" minWidth={58}>
      <Text fontSize="$7" fontWeight="700" color={n > 0 ? color : '$gray9'}>
        {n}
      </Text>
      <Text fontSize="$1" color="$gray10">
        {label}
      </Text>
    </YStack>
  );
  return (
    <XStack gap="$4">
      <Fig n={plan.migrate} label={t('agentCores.figMigrate')} color={semanticColors.amber} />
      <Fig n={plan.revert} label={t('agentCores.figRevert')} color={semanticColors.green} />
      <Fig n={plan.stay} label={t('agentCores.figStay')} color="$gray11" />
    </XStack>
  );
}

/** The "who" panel: the rollout cohort grouped by owner, scrollable. */
function CohortPanel({
  cohort,
  labelFor,
}: {
  cohort: CohortEntry[];
  labelFor: (coreId: string) => string;
}) {
  const c = useWindowColors();
  const { t } = useTranslation();
  const byOwner = new Map<string, CohortEntry[]>();
  for (const e of cohort) {
    const list = byOwner.get(e.ownerName) ?? [];
    list.push(e);
    byOwner.set(e.ownerName, list);
  }
  const kindColor = (kind: CohortEntry['kind']) =>
    kind === 'migrate' ? semanticColors.amber : kind === 'revert' ? semanticColors.green : '$gray10';

  if (cohort.length === 0) {
    return (
      <Text fontSize="$1" color="$gray10">
        {t('agentCores.cohortEmpty')}
      </Text>
    );
  }
  return (
    <YStack
      maxHeight={260}
      borderWidth={1}
      borderColor={c.border}
      borderRadius="$3"
      overflow="hidden"
    >
      <ScrollView style={scrollbarStyle(c.scrollbarColor)}>
        <YStack padding="$2.5" gap="$2">
          {[...byOwner.entries()].map(([owner, entries]) => (
            <YStack key={owner} gap="$1">
              <XStack justifyContent="space-between" alignItems="center">
                <Text fontSize="$2" color="$color" fontWeight="600" numberOfLines={1}>
                  {owner}
                </Text>
                {entries[0].bucket != null ? (
                  <Text fontSize="$1" color="$gray10">
                    bucket {entries[0].bucket}
                  </Text>
                ) : (
                  <Badge color={semanticColors.red}>{t('agentCores.noBucket')}</Badge>
                )}
              </XStack>
              {entries.map((e) => (
                <XStack key={e.agentId} gap="$2" alignItems="center" paddingLeft="$2">
                  <Text fontSize="$1" color="$gray11" flex={1} numberOfLines={1}>
                    {e.agentName}
                  </Text>
                  <Text fontSize="$1" color="$gray10">
                    {labelFor(e.current)}
                  </Text>
                  {e.kind !== 'stay' ? (
                    <Text fontSize="$1" color={kindColor(e.kind)}>
                      → {labelFor(e.target)}
                    </Text>
                  ) : null}
                </XStack>
              ))}
            </YStack>
          ))}
        </YStack>
      </ScrollView>
    </YStack>
  );
}

/** Rollout timeline from the audit log (set / clear / apply), most recent first. */
function AuditTimeline({ entries }: { entries: AuditEntry[] }) {
  const c = useWindowColors();
  const { t } = useTranslation();
  const describe = (e: AuditEntry) => {
    if (e.action === 'apply_rollout') {
      const m = /migrated=(\d+) reverted=(\d+)/.exec(e.note ?? '');
      return t('agentCores.auditApply', { migrated: m?.[1] ?? '?', reverted: m?.[2] ?? '?' });
    }
    if (e.action === 'set_rollout') {
      const p = /percentage=(\d+)/.exec(e.note ?? '')?.[1];
      return t('agentCores.auditSet', { pct: p ?? '?' });
    }
    if (e.action === 'clear_rollout') return t('agentCores.auditClear');
    return e.action;
  };
  const when = (ts: string) => {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
  };
  if (entries.length === 0) {
    return (
      <Text fontSize="$1" color="$gray10">
        {t('agentCores.auditEmpty')}
      </Text>
    );
  }
  return (
    <YStack maxHeight={200} borderWidth={1} borderColor={c.border} borderRadius="$3" overflow="hidden">
      <ScrollView style={scrollbarStyle(c.scrollbarColor)}>
        <YStack padding="$2.5" gap="$1.5">
          {entries.map((e) => (
            <XStack key={e.auditId} gap="$2" alignItems="flex-start">
              <Text fontSize="$1" color="$gray10" width={132} numberOfLines={1}>
                {when(e.timestamp)}
              </Text>
              <Text fontSize="$1" color="$gray11" flex={1}>
                {describe(e)} · {e.actor}
              </Text>
            </XStack>
          ))}
        </YStack>
      </ScrollView>
    </YStack>
  );
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
  coreType: string;
  expCoreId: string | null;
  labelFor: (coreId: string) => string;
  onList: (coreType: string) => Promise<{ targetId: string; value: string }[]>;
  onSet: (coreType: string, userId: string, value: string) => Promise<void>;
  onDelete: (coreType: string, userId: string) => Promise<void>;
}) {
  const c = useWindowColors();
  const { t } = useTranslation();
  const [overrides, setOverrides] = useState<{ targetId: string; value: string }[]>([]);
  const [uid, setUid] = useState('');
  const [target, setTarget] = useState(coreType);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    onList(coreType)
      .then(setOverrides)
      .catch(() => setOverrides([]));
  }, [coreType, onList]);
  useEffect(() => {
    reload();
  }, [reload]);

  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    fn()
      .then(reload)
      .finally(() => setBusy(false));
  };

  return (
    <YStack gap="$2">
      {overrides.length === 0 ? (
        <Text fontSize="$1" color="$gray10">
          {t('agentCores.noOverrides')}
        </Text>
      ) : (
        overrides.map((o) => (
          <XStack key={o.targetId} gap="$2" alignItems="center">
            <Text fontSize="$1" color="$gray11" flex={1} numberOfLines={1}>
              {o.targetId}
            </Text>
            <Badge color={o.value === coreType ? STATUS_COLORS.active : semanticColors.amber}>
              {labelFor(o.value)}
            </Badge>
            <TouchableOpacity
              onPress={() => run(() => onDelete(coreType, o.targetId))}
              hitSlop={6}
              disabled={busy}
            >
              <X size={14} color={c.text3} />
            </TouchableOpacity>
          </XStack>
        ))
      )}
      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <Input
          flex={1}
          value={uid}
          onChangeText={setUid}
          placeholder={t('agentCores.overrideUserPlaceholder')}
          autoCapitalize="none"
          backgroundColor={c.bgInner}
          borderColor={c.border}
        />
        <ToggleBadge
          label={labelFor(coreType)}
          selected={target === coreType}
          color={STATUS_COLORS.active}
          onPress={() => setTarget(coreType)}
        />
        {expCoreId ? (
          <ToggleBadge
            label={labelFor(expCoreId)}
            selected={target === expCoreId}
            color={semanticColors.amber}
            onPress={() => setTarget(expCoreId)}
          />
        ) : null}
        <Button
          size="$2"
          icon={<Plus size={14} />}
          disabled={busy || !uid.trim()}
          onPress={() => run(() => onSet(coreType, uid.trim(), target).then(() => setUid('')))}
        />
      </XStack>
    </YStack>
  );
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
  const c = useWindowColors();
  const { t } = useTranslation();
  const [exp, setExp] = useState<string>(rollout.experimentalCoreId ?? '');
  const [pct, setPct] = useState<string>(String(rollout.percentage ?? 0));
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'apply' | 'clear' | 'revert' | null>(null);
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'error' } | null>(null);
  const [cohort, setCohort] = useState<CohortEntry[] | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [overridesOpen, setOverridesOpen] = useState(false);

  // Resync the form with the server state when it changes (e.g. after Clear/Set
  // reloads the flags). This component is not remounted on those changes — without
  // this, exp/pct keep the stale pre-clear values and "Set rollout" would re-create
  // the rollout the admin just cleared.
  useEffect(() => {
    setExp(rollout.experimentalCoreId ?? '');
    setPct(String(rollout.percentage ?? 0));
  }, [rollout.experimentalCoreId, rollout.percentage]);

  const parsedPct = Math.max(0, Math.min(100, parseInt(pct, 10) || 0));
  const { saved, live, refreshSaved } = useRolloutPreview(coreType, exp, parsedPct, onPreview);

  const hasRollout = !!rollout.experimentalCoreId && rollout.percentage > 0;

  const labelFor = (coreId: string) => cores.find((c) => c.coreId === coreId)?.fullName ?? coreId;
  const isStable = (coreId: string) => coreId === coreType;

  // Order the distribution rows: stable core first, then experimentals.
  const distRows = (p: RolloutPreview | null) =>
    (p?.distribution ?? [])
      .slice()
      .sort((a, b) => Number(isStable(b.coreId)) - Number(isStable(a.coreId)));

  // Agents currently sitting on an experimental core. Clear does NOT move them —
  // only an Apply (at 0%) reverts them. We surface that so "Clear" is not mistaken
  // for a rollback, and to gate the one-click "Revert all".
  const migratedRows = distRows(saved).filter((d) => !isStable(d.coreId) && d.count > 0);
  const migratedAway = migratedRows.reduce((sum, d) => sum + d.count, 0);
  const migratedExp = migratedRows[0]?.coreId;

  // Diff stable ↔ in-progress experimental (what migrated agents would receive).
  const stableCore = cores.find((c) => isStable(c.coreId));
  const expCore = cores.find((c) => c.coreId === exp);

  // The SAVED rollout may point at a core deactivated after Set → Apply would throw.
  // Warn up-front and gate Apply instead of failing at click time.
  const savedExpCore = cores.find((c) => c.coreId === rollout.experimentalCoreId);
  const savedExpInactive = hasRollout && (!savedExpCore || savedExpCore.status !== 'active');

  // Target declared (flag) vs reality (applied): Set without Apply leaves them out
  // of sync. saved.plan counts what an Apply right now would still move.
  const pending = saved ? saved.plan.migrate + saved.plan.revert : 0;

  const ok = (text: string) => setMsg({ text, kind: 'ok' });

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : String(err), kind: 'error' });
    } finally {
      // Always resync — Apply is non-transactional, so even on a mid-run failure the
      // distribution may have partially changed and must reflect reality.
      await refreshSaved();
      setBusy(false);
    }
  };

  // Revert everyone to the stable core: set the saved experimental to 0% and Apply.
  const revertAll = () =>
    run(async () => {
      if (rollout.experimentalCoreId) await onSet(coreType, rollout.experimentalCoreId, 0);
      const res = await onApply(coreType);
      setConfirm(null);
      ok(t('agentCores.rolloutApplied', res));
    });

  return (
    <FormSection
      title={t('agentCores.rollout')}
      icon={<Cpu size={16} color={semanticColors.amber} />}
      defaultOpen={hasRollout}
    >
      {/* What this does — Set declares the plan; Apply moves agents. */}
      <Text fontSize="$1" color="$gray10" lineHeight={16}>
        {t('agentCores.rolloutHelp')}
      </Text>

      {/* The saved rollout points at a core that is no longer active → Apply throws. */}
      {savedExpInactive ? (
        <XStack
          gap="$2"
          alignItems="center"
          padding="$2.5"
          borderRadius="$3"
          borderWidth={1}
          borderColor={indicators.irreversible.border}
          backgroundColor={indicators.irreversible.bg}
        >
          <AlertTriangle size={16} color={semanticColors.red} />
          <Text fontSize="$1" color={semanticColors.red} flex={1}>
            {t('agentCores.experimentalInactive', {
              exp: labelFor(rollout.experimentalCoreId ?? ''),
            })}
          </Text>
        </XStack>
      ) : null}

      {/* Current state: stable + experimental + sync (declared vs applied) */}
      <XStack gap="$2" flexWrap="wrap" alignItems="center">
        <Badge color={STATUS_COLORS.active}>
          {t('agentCores.stable')}: {coreType}
        </Badge>
        {hasRollout ? (
          <Badge color={semanticColors.amber}>
            {t('agentCores.experimental')}: {labelFor(rollout.experimentalCoreId ?? '')} ·{' '}
            {rollout.percentage}%
          </Badge>
        ) : (
          <Text fontSize="$1" color="$gray10">
            {t('agentCores.noActiveRollout')}
          </Text>
        )}
        {saved && saved.total > 0 ? (
          <Badge color={pending > 0 ? semanticColors.amber : STATUS_COLORS.active}>
            {pending > 0 ? t('agentCores.pendingApply', { count: pending }) : t('agentCores.synced')}
          </Badge>
        ) : null}
      </XStack>

      {/* Current distribution — who runs what today. */}
      {saved && saved.total > 0 ? (
        <YStack gap="$2">
          <Text fontSize="$2" color="$gray11">
            {t('agentCores.currentDistribution', { total: saved.total })}
          </Text>
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
            <Text fontSize="$1" color={semanticColors.red}>
              {t('agentCores.neverMigrate', { count: saved.unbucketed })}
            </Text>
          ) : null}
          <XStack>
            <Button
              size="$2"
              chromeless
              onPress={() =>
                cohort
                  ? setCohort(null)
                  : onCohort(coreType)
                      .then(setCohort)
                      .catch(() => setCohort(null))
              }
            >
              {cohort
                ? t('agentCores.hideCohort')
                : t('agentCores.viewCohort', { count: saved.total })}
            </Button>
          </XStack>
          {cohort ? <CohortPanel cohort={cohort} labelFor={labelFor} /> : null}
        </YStack>
      ) : null}

      {candidates.length === 0 ? (
        <Text fontSize="$1" color="$gray10">
          {t('agentCores.noExperimentalCandidates')}
        </Text>
      ) : (
        <YStack gap="$2">
          <Text fontSize="$2" color="$gray11">
            {t('agentCores.chooseExperimental')}
          </Text>
          <XStack gap="$2" flexWrap="wrap">
            {candidates.map((c) => (
              <ToggleBadge
                key={c.coreId}
                label={labelFor(c.coreId)}
                selected={exp === c.coreId}
                onPress={() => setExp(c.coreId)}
              />
            ))}
          </XStack>

          {/* What migrated agents would receive (model / MCAs / prompt). */}
          {exp ? <CoreDiff stable={stableCore} exp={expCore} /> : null}

          <RampInput value={pct} onChange={setPct} disabled={busy} />
          <XStack justifyContent="flex-end">
            <Button
              size="$2"
              variant="outlined"
              disabled={busy || !exp}
              onPress={() =>
                run(async () => {
                  await onSet(coreType, exp, parsedPct);
                  ok(t('agentCores.rolloutSaved'));
                })
              }
            >
              {t('agentCores.setRollout')}
            </Button>
          </XStack>

          {/* Live impact of the in-progress selection (before saving). */}
          {exp && live ? (
            <YStack
              gap="$1.5"
              padding="$2.5"
              borderRadius="$3"
              borderWidth={1}
              borderColor={indicators.risk.border}
              backgroundColor={indicators.risk.bg}
            >
              <Text fontSize="$1" color={semanticColors.amber}>
                {t('agentCores.liveImpactAt', { percentage: parsedPct })}
              </Text>
              <PlanFigures plan={live.plan} />
              <Text fontSize="$1" color="$gray11">
                {t('agentCores.wouldResult', {
                  summary: distRows(live)
                    .map((d) => `${labelFor(d.coreId)} ${d.count}`)
                    .join(' · '),
                })}
              </Text>
            </YStack>
          ) : null}

          {confirm === 'apply' ? (
            <YStack gap="$2">
              {saved ? (
                <>
                  <Text fontSize="$1" color={semanticColors.amber}>
                    {t('agentCores.confirmApplyTitle')}
                  </Text>
                  <PlanFigures plan={saved.plan} />
                </>
              ) : (
                <Text fontSize="$1" color={semanticColors.amber}>
                  {t('agentCores.confirmApply', { coreType })}
                </Text>
              )}
              <XStack gap="$2" justifyContent="flex-end">
                <Button size="$2" disabled={busy} onPress={() => setConfirm(null)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  size="$2"
                  backgroundColor={semanticColors.amber}
                  color="white"
                  disabled={busy}
                  onPress={() =>
                    run(async () => {
                      const res = await onApply(coreType);
                      setConfirm(null);
                      ok(t('agentCores.rolloutApplied', res));
                    })
                  }
                >
                  {t('common.confirm')}
                </Button>
              </XStack>
            </YStack>
          ) : confirm === 'revert' ? (
            // One-click rollback: set the saved experimental to 0% and Apply.
            <XStack gap="$2" alignItems="center" flexWrap="wrap">
              <Text fontSize="$1" color={semanticColors.green} flex={1}>
                {t('agentCores.confirmRevert', { count: migratedAway })}
              </Text>
              <Button size="$2" disabled={busy} onPress={() => setConfirm(null)}>
                {t('common.cancel')}
              </Button>
              <Button size="$2" theme="active" disabled={busy} onPress={revertAll}>
                {t('agentCores.revertAll')}
              </Button>
            </XStack>
          ) : confirm === 'clear' ? (
            // Clear only drops the flag — it does NOT move migrated agents back.
            <XStack gap="$2" alignItems="center" flexWrap="wrap">
              <Text fontSize="$1" color={semanticColors.amber} flex={1}>
                {t('agentCores.confirmClear', {
                  count: migratedAway,
                  exp: migratedExp ? labelFor(migratedExp) : '',
                })}
              </Text>
              <Button size="$2" disabled={busy} onPress={() => setConfirm(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                size="$2"
                disabled={busy}
                onPress={() =>
                  run(async () => {
                    await onClear(coreType);
                    setConfirm(null);
                  })
                }
              >
                {t('agentCores.clearRollout')}
              </Button>
            </XStack>
          ) : (
            <XStack gap="$2" flexWrap="wrap" alignItems="center">
              {/* Apply is the only action that mutates production now → it leads. */}
              <Button
                size="$2"
                backgroundColor={savedExpInactive ? undefined : semanticColors.amber}
                color={savedExpInactive ? undefined : 'white'}
                icon={<Zap size={14} />}
                disabled={busy || savedExpInactive}
                onPress={() => setConfirm('apply')}
              >
                {t('agentCores.applyRollout')}
              </Button>
              {migratedAway > 0 ? (
                <Button
                  size="$2"
                  variant="outlined"
                  icon={<RotateCcw size={14} />}
                  disabled={busy}
                  onPress={() => setConfirm('revert')}
                >
                  {t('agentCores.revertAll')}
                </Button>
              ) : null}
              {hasRollout ? (
                <Button
                  size="$2"
                  chromeless
                  disabled={busy}
                  // With agents already on the experimental, Clear is easy to mistake
                  // for a rollback — confirm and explain it isn't. Otherwise clear directly.
                  onPress={() =>
                    migratedAway > 0 ? setConfirm('clear') : run(() => onClear(coreType))
                  }
                >
                  {t('agentCores.clearRollout')}
                </Button>
              ) : null}
            </XStack>
          )}
        </YStack>
      )}

      {busy ? (
        <XStack gap="$2" alignItems="center">
          <AppSpinner size="sm" />
          {saved && saved.total > 0 ? (
            <Text fontSize="$1" color="$gray10">
              {t('agentCores.applyingTo', { total: saved.total })}
            </Text>
          ) : null}
        </XStack>
      ) : null}
      {msg ? (
        <YStack gap="$1">
          <Text fontSize="$1" color={msg.kind === 'error' ? '$red10' : '$gray11'}>
            {msg.text}
          </Text>
          {msg.kind === 'error' ? (
            <Text fontSize="$1" color="$gray10">
              {t('agentCores.applyRetryHint')}
            </Text>
          ) : null}
        </YStack>
      ) : null}

      {/* History — who changed / applied the rollout, when (from the audit log). */}
      <XStack>
        <Button
          size="$2"
          chromeless
          icon={<History size={14} />}
          onPress={() =>
            audit
              ? setAudit(null)
              : onAuditLog(coreType)
                  .then(setAudit)
                  .catch(() => setAudit([]))
          }
        >
          {audit ? t('agentCores.hideHistory') : t('agentCores.showHistory')}
        </Button>
      </XStack>
      {audit ? <AuditTimeline entries={audit} /> : null}

      {/* Per-user overrides — force/exclude a specific user (beats the percentage). */}
      <XStack>
        <Button size="$2" chromeless onPress={() => setOverridesOpen((o) => !o)}>
          {overridesOpen ? t('agentCores.hideOverrides') : t('agentCores.showOverrides')}
        </Button>
      </XStack>
      {overridesOpen ? (
        <YStack gap="$1.5">
          <Text fontSize="$1" color="$gray10">
            {t('agentCores.overridesHint')}
          </Text>
          <OverridesPanel
            coreType={coreType}
            expCoreId={rollout.experimentalCoreId ?? (exp || null)}
            labelFor={labelFor}
            onList={onListOverrides}
            onSet={onSetOverride}
            onDelete={onDeleteOverride}
          />
        </YStack>
      ) : null}
    </FormSection>
  );
}

// ============================================================================
// Core editor (create + edit) — the detail pane
// ============================================================================

interface CoreFormPayload {
  coreId: string;
  coreType: 'agent' | 'super-agent';
  name: string;
  fullName: string;
  version?: string;
  systemPrompt: string;
  personality: string[];
  capabilities: string[];
  defaultApps: string[];
  modelId: string;
  modelOverrides?: { temperature?: number; maxTokens?: number };
  status: 'active' | 'inactive';
}

interface CoreFormProps {
  mode: 'create' | 'edit';
  core?: AgentCore;
  models: Model[];
  catalog: { mcaId: string; name: string; system: boolean }[];
  /** Rollout controls (stable core + super only). Rendered as a trailing section. */
  rollout?: React.ReactNode;
  /** Back arrow in the header — present only in the single-column (narrow) layout. */
  onBack?: () => void;
  onSubmit: (payload: CoreFormPayload) => Promise<void>;
  onCancel: () => void;
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
  const c = useWindowColors();
  const { t } = useTranslation();

  const [coreId, setCoreId] = useState(core?.coreId ?? '');
  const [coreType, setCoreType] = useState<'agent' | 'super-agent'>(core?.coreType ?? 'agent');
  const [name, setName] = useState(core?.name ?? '');
  const [fullName, setFullName] = useState(core?.fullName ?? '');
  const [version, setVersion] = useState(core?.version ?? '');
  const [status, setStatus] = useState<'active' | 'inactive'>(core?.status ?? 'active');
  const [modelId, setModelId] = useState(core?.modelId ?? '');
  const [temperature, setTemperature] = useState(
    core?.modelOverrides?.temperature?.toString() ?? '',
  );
  const [maxTokens, setMaxTokens] = useState(core?.modelOverrides?.maxTokens?.toString() ?? '');
  const [personality, setPersonality] = useState<string[]>(core?.personality ?? []);
  const [capabilities, setCapabilities] = useState<string[]>(core?.capabilities ?? []);
  const [defaultApps, setDefaultApps] = useState<Set<string>>(new Set(core?.defaultApps ?? []));
  const [systemPrompt, setSystemPrompt] = useState(core?.systemPrompt ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const valid =
    coreId.trim() && name.trim() && fullName.trim() && systemPrompt.trim() && modelId.trim();

  const toggleApp = (id: string) =>
    setDefaultApps((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const handleSubmit = async () => {
    if (!valid) return;
    setSaving(true);
    setErr(null);
    try {
      const overrides: { temperature?: number; maxTokens?: number } = {};
      if (temperature.trim()) overrides.temperature = parseFloat(temperature);
      if (maxTokens.trim()) overrides.maxTokens = parseInt(maxTokens, 10);
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
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const isEdit = mode === 'edit';
  const title = isEdit
    ? t('agentCores.editCore', { name: core?.fullName ?? '' })
    : t('agentCores.createCore');

  return (
    <YStack flex={1}>
      {/* Header */}
      <XStack
        alignItems="center"
        gap="$2"
        padding="$3"
        borderBottomWidth={1}
        borderBottomColor={c.border}
      >
        {onBack ? (
          <Button size="$2" circular chromeless icon={<ArrowLeft size={18} />} onPress={onBack} />
        ) : null}
        <Text flex={1} fontSize="$5" fontWeight="600" color="$color" numberOfLines={1}>
          {title}
        </Text>
      </XStack>

      <ScrollView flex={1} style={scrollbarStyle(c.scrollbarColor)}>
        <YStack padding="$3" gap="$3">
          {/* Identity */}
          <FormSection
            title={t('agentCores.sectionIdentity')}
            icon={<Hash size={16} color={ACCENT} />}
          >
            {isEdit ? (
              <XStack gap="$2" flexWrap="wrap">
                <Badge color={c.text3}>coreId: {coreId}</Badge>
                {core?.coreType ? <Badge color={c.text3}>coreType: {core.coreType}</Badge> : null}
              </XStack>
            ) : (
              <>
                <Field label="coreId" hint={t('agentCores.coreIdHint')}>
                  <Input
                    value={coreId}
                    onChangeText={setCoreId}
                    placeholder="super-agent-v2"
                    autoCapitalize="none"
                    backgroundColor={c.bgInner}
                    borderColor={c.border}
                  />
                </Field>
                <Field label={t('agentCores.coreType')}>
                  <XStack gap="$2">
                    {(['agent', 'super-agent'] as const).map((ct) => (
                      <ToggleBadge
                        key={ct}
                        label={ct}
                        selected={coreType === ct}
                        onPress={() => setCoreType(ct)}
                      />
                    ))}
                  </XStack>
                </Field>
              </>
            )}
            <Field label="name">
              <Input
                value={name}
                onChangeText={setName}
                placeholder="Super Agent v2"
                backgroundColor={c.bgInner}
                borderColor={c.border}
              />
            </Field>
            <Field label="fullName">
              <Input
                value={fullName}
                onChangeText={setFullName}
                placeholder="Teros Super Agent v2"
                backgroundColor={c.bgInner}
                borderColor={c.border}
              />
            </Field>
            <Field label="version">
              <Input
                value={version}
                onChangeText={setVersion}
                placeholder="v1.0"
                backgroundColor={c.bgInner}
                borderColor={c.border}
              />
            </Field>
            <Field label={t('agentCores.status')}>
              <XStack gap="$2">
                {(['active', 'inactive'] as const).map((s) => (
                  <ToggleBadge
                    key={s}
                    label={t(`agentCores.${s}`)}
                    selected={status === s}
                    color={STATUS_COLORS[s]}
                    onPress={() => setStatus(s)}
                  />
                ))}
              </XStack>
            </Field>
          </FormSection>

          {/* Engine */}
          <FormSection
            title={t('agentCores.sectionEngine')}
            icon={<Cpu size={16} color={semanticColors.amber} />}
          >
            <Field label={t('agentCores.model')}>
              <ModelSelect models={models} value={modelId} onChange={setModelId} />
            </Field>
            <XStack gap="$3">
              <YStack flex={1}>
                <Field label={t('agentCores.temperature')} hint={t('agentCores.temperatureHint')}>
                  <Input
                    keyboardType="decimal-pad"
                    value={temperature}
                    onChangeText={setTemperature}
                    placeholder={t('agentCores.temperaturePlaceholder')}
                    backgroundColor={c.bgInner}
                    borderColor={c.border}
                  />
                </Field>
              </YStack>
              <YStack flex={1}>
                <Field label={t('agentCores.maxTokens')} hint={t('agentCores.maxTokensHint')}>
                  <Input
                    keyboardType="number-pad"
                    value={maxTokens}
                    onChangeText={setMaxTokens}
                    placeholder={t('agentCores.maxTokensPlaceholder')}
                    backgroundColor={c.bgInner}
                    borderColor={c.border}
                  />
                </Field>
              </YStack>
            </XStack>
          </FormSection>

          {/* Behavior */}
          <FormSection
            title={t('agentCores.sectionBehavior')}
            icon={<Sparkles size={16} color={semanticColors.violet} />}
          >
            <Field label={t('agentCores.personality')}>
              <ChipEditor
                values={personality}
                onChange={setPersonality}
                color={semanticColors.violet}
                placeholder={t('agentCores.addTraitPlaceholder')}
              />
            </Field>
            <Field label={t('agentCores.capabilities')}>
              <ChipEditor
                values={capabilities}
                onChange={setCapabilities}
                color={ACCENT}
                placeholder={t('agentCores.addTraitPlaceholder')}
              />
            </Field>
          </FormSection>

          {/* MCAs — the core's editable defaultApps + the always-on system apps so
              the editor shows the COMPLETE engine each agent receives. */}
          <FormSection title={t('agentCores.defaultApps')} icon={<Cpu size={16} color={semanticColors.green} />}>
            <McaPicker
              catalog={catalog.filter((m) => !m.system)}
              selected={defaultApps}
              onToggle={toggleApp}
            />
            {catalog.some((m) => m.system) ? (
              <YStack
                gap="$1.5"
                paddingTop="$2.5"
                borderTopWidth={1}
                borderTopColor={c.border}
              >
                <Text fontSize="$2" color="$gray11" fontWeight="600">
                  {t('agentCores.systemApps')}
                </Text>
                <Text fontSize="$1" color="$gray10">
                  {t('agentCores.systemAppsHint')}
                </Text>
                <XStack gap="$2" flexWrap="wrap">
                  {catalog
                    .filter((m) => m.system)
                    .map((m) => (
                      <Badge key={m.mcaId} color={c.text3}>
                        {m.name}
                      </Badge>
                    ))}
                </XStack>
              </YStack>
            ) : null}
          </FormSection>

          {/* System prompt */}
          <FormSection
            title={t('agentCores.systemPrompt')}
            icon={<Wrench size={16} color={ACCENT} />}
          >
            <TextArea
              value={systemPrompt}
              onChangeText={setSystemPrompt}
              placeholder={t('agentCores.systemPromptPlaceholder')}
              minHeight={220}
              fontSize="$2"
              fontFamily={Platform.OS === 'web' ? 'monospace' : '$mono'}
              backgroundColor={c.bgInner}
              borderColor={c.border}
              style={scrollbarStyle(c.scrollbarColor)}
            />
            <Text fontSize="$1" color="$gray10">
              {t('agentCores.charactersCount', { count: systemPrompt.length })}
            </Text>
          </FormSection>

          {/* Rollout (stable core + super) */}
          {rollout}

          {err ? (
            <Text fontSize="$2" color="$red10">
              {err}
            </Text>
          ) : null}
        </YStack>
      </ScrollView>

      {/* Actions */}
      <XStack
        gap="$3"
        justifyContent="flex-end"
        padding="$3"
        borderTopWidth={1}
        borderTopColor={c.border}
      >
        <Button variant="outlined" onPress={onCancel} disabled={saving}>
          {t('common.cancel')}
        </Button>
        <Button
          backgroundColor={ACCENT}
          color="white"
          icon={saving ? <AppSpinner size="sm" /> : <Save size={16} />}
          onPress={handleSubmit}
          disabled={!valid || saving}
        >
          {saving
            ? t('common.saving')
            : isEdit
              ? t('agentCores.saveChanges')
              : t('agentCores.createCore')}
        </Button>
      </XStack>
    </YStack>
  );
}

// ============================================================================
// Core list (master pane)
// ============================================================================

function CoreListItem({
  core,
  active,
  onPress,
}: {
  core: AgentCore;
  active: boolean;
  onPress: () => void;
}) {
  const c = useWindowColors();
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7}>
      <XStack
        alignItems="center"
        gap="$2.5"
        padding="$2.5"
        borderRadius="$3"
        borderWidth={1}
        borderColor={active ? `${ACCENT}50` : c.border}
        backgroundColor={active ? semanticColors.indigoGlow : c.bgCard}
      >
        <Avatar circular size={34}>
          <Avatar.Image src={core.avatarUrl} />
          <Avatar.Fallback
            backgroundColor={semanticColors.indigoGlow}
            justifyContent="center"
            alignItems="center"
            delayMs={0}
          >
            <User size={16} color={ACCENT} />
          </Avatar.Fallback>
        </Avatar>
        <YStack flex={1}>
          <Text fontSize="$3" fontWeight="600" color="$color" numberOfLines={1}>
            {core.fullName}
          </Text>
          <Text fontSize="$1" color="$gray10" numberOfLines={1}>
            {core.coreId} · {core.modelId}
          </Text>
        </YStack>
        <YStack
          width={8}
          height={8}
          borderRadius={4}
          backgroundColor={STATUS_COLORS[core.status]}
        />
      </XStack>
    </TouchableOpacity>
  );
}

function CoreList({
  cores,
  selectedId,
  onSelect,
  onCreate,
}: {
  cores: AgentCore[];
  selectedId: string | null;
  onSelect: (core: AgentCore) => void;
  onCreate: () => void;
}) {
  const c = useWindowColors();
  const { t } = useTranslation();
  return (
    <YStack flex={1}>
      <XStack alignItems="center" justifyContent="space-between" padding="$3" gap="$2">
        <Text fontSize="$3" fontWeight="600" color="$gray11">
          {t('agentCores.totalCores')} · {cores.length}
        </Text>
        <Button size="$2" theme="active" icon={<Plus size={14} />} onPress={onCreate}>
          {t('agentCores.createCore')}
        </Button>
      </XStack>
      <Separator borderColor={c.border} />
      <ScrollView flex={1} style={scrollbarStyle(c.scrollbarColor)}>
        <YStack gap="$2" padding="$3">
          {cores.map((c) => (
            <CoreListItem
              key={c.coreId}
              core={c}
              active={c.coreId === selectedId}
              onPress={() => onSelect(c)}
            />
          ))}
          {cores.length === 0 ? (
            <YStack padding="$6" alignItems="center" gap="$2">
              <Cpu size={40} color={c.text3} />
              <Text color="$gray10" textAlign="center">
                {t('agentCores.noCoresConfigured')}
              </Text>
            </YStack>
          ) : null}
        </YStack>
      </ScrollView>
    </YStack>
  );
}

// ============================================================================
// Window
// ============================================================================

export interface AgentCoresWindowContentProps {
  windowId: string;
}

export function AgentCoresWindowContent(_props: AgentCoresWindowContentProps) {
  const c = useWindowColors();
  const { t } = useTranslation();
  const client = getTerosClient();

  const [cores, setCores] = useState<AgentCore[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [mcaCatalog, setMcaCatalog] = useState<
    { mcaId: string; name: string; system: boolean }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [width, setWidth] = useState(0);

  // Rollout state per coreType (super-only; plain admins get FORBIDDEN → hidden).
  const [rollouts, setRollouts] = useState<Record<string, RolloutState>>({});
  const [rolloutAvailable, setRolloutAvailable] = useState(false);

  const wide = width >= SPLIT_BREAKPOINT;

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
      client.agent.listCores('active').then((r) => r.cores),
      client.agent.listCores('inactive').then((r) => r.cores),
    ]);
    return [...active, ...inactive].filter((c) => !!c.coreType);
  }, [client]);

  const loadFlags = useCallback(async () => {
    try {
      const { flags } = await client.admin.listFeatureFlags();
      const next: Record<string, RolloutState> = {};
      for (const f of flags) {
        if (f.key === 'core.agent' || f.key === 'core.super-agent') {
          const coreType = f.key.slice('core.'.length);
          next[coreType] = f.rollout
            ? { experimentalCoreId: String(f.rollout.value), percentage: f.rollout.percentage }
            : { experimentalCoreId: null, percentage: 0 };
        }
      }
      setRollouts(next);
      setRolloutAvailable(true);
    } catch {
      setRolloutAvailable(false);
    }
  }, [client]);

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
      ]);
      setCores(coresList);
      setModels(modelsList.models);
      setMcaCatalog(
        mcas.map((m) => ({
          mcaId: m.mcaId,
          name: m.name,
          system: m.availability?.system ?? false,
        })),
      );
      await loadFlags();
    } catch (err) {
      console.error('Failed to load data:', err);
      setError(err instanceof Error ? err.message : t('agentCores.failedToLoadData'));
    } finally {
      setLoading(false);
    }
  }, [client, fetchAllCores, loadFlags, t]);

  useEffect(() => {
    if (client.isConnected()) {
      loadData();
    } else {
      const onConnected = () => {
        loadData();
        client.off('connected', onConnected);
      };
      client.on('connected', onConnected);
      return () => client.off('connected', onConnected);
    }
  }, [client, loadData]);

  const reloadCores = useCallback(async (): Promise<AgentCore[]> => {
    const list = await fetchAllCores();
    setCores(list);
    return list;
  }, [fetchAllCores]);

  const retry = () => {
    setError(null);
    setLoading(true);
    loadData();
  };

  const handleSubmit = async (payload: CoreFormPayload) => {
    if (selection?.mode === 'create') {
      const { core } = await client.agent.createCore(payload);
      const list = await reloadCores();
      const fresh = list.find((c) => c.coreId === core.coreId) ?? core;
      setSelection({ mode: 'edit', core: fresh });
    } else if (selection?.mode === 'edit') {
      const { coreId: _omitId, coreType: _omitType, ...updates } = payload;
      await client.agent.updateCore(selection.core.coreId, updates);
      const list = await reloadCores();
      const fresh = list.find((c) => c.coreId === selection.core.coreId);
      if (fresh) setSelection({ mode: 'edit', core: fresh });
    }
    await loadFlags();
  };

  const handleSetRollout = async (
    coreType: string,
    experimentalCoreId: string,
    percentage: number,
  ) => {
    await client.admin.setFeatureFlagRollout(`core.${coreType}`, experimentalCoreId, percentage);
    await loadFlags();
  };
  const handleClearRollout = async (coreType: string) => {
    await client.admin.clearFeatureFlagRollout(`core.${coreType}`);
    await loadFlags();
  };
  const handleApplyRollout = (coreType: string) =>
    client.admin.applyCoreRollout(coreType as 'agent' | 'super-agent').then(async (res) => {
      await reloadCores();
      return res;
    });
  // Memoized: RolloutSection drives effects off onPreview's identity, so a fresh
  // closure each render would loop the dry-run requests.
  const handlePreview = useCallback(
    (
      coreType: string,
      hypothetical?: { experimentalCoreId: string; percentage: number },
    ): Promise<RolloutPreview> =>
      client.admin.previewCoreRollout(coreType as 'agent' | 'super-agent', hypothetical),
    [client],
  );
  const handleCohort = useCallback(
    (
      coreType: string,
      hypothetical?: { experimentalCoreId: string; percentage: number },
    ): Promise<CohortEntry[]> =>
      client.admin
        .cohortCoreRollout(coreType as 'agent' | 'super-agent', hypothetical)
        .then((r) => r.cohort),
    [client],
  );
  const handleAuditLog = useCallback(
    (coreType: string): Promise<AuditEntry[]> =>
      client.admin.getFeatureFlagAuditLog(`core.${coreType}`).then((r) => r.entries),
    [client],
  );
  const handleListOverrides = useCallback(
    (coreType: string) =>
      client.admin.getFeatureFlagOverrides(`core.${coreType}`).then((r) =>
        r.overrides
          .filter((o) => o.targetType === 'user')
          .map((o) => ({ targetId: o.targetId, value: String(o.value) })),
      ),
    [client],
  );
  const handleSetOverride = useCallback(
    (coreType: string, userId: string, value: string): Promise<void> =>
      client.admin.setFeatureFlagOverride(`core.${coreType}`, 'user', userId, value).then(() => {}),
    [client],
  );
  const handleDeleteOverride = useCallback(
    (coreType: string, userId: string): Promise<void> =>
      client.admin.deleteFeatureFlagOverride(`core.${coreType}`, 'user', userId).then(() => {}),
    [client],
  );

  if (loading) {
    return <FullscreenLoader variant="default" label={t('agentCores.loadingCores')} />;
  }

  if (error) {
    return (
      <YStack
        flex={1}
        backgroundColor="$background"
        justifyContent="center"
        alignItems="center"
        padding="$4"
        gap="$3"
      >
        <Text color="$red10" textAlign="center">
          {error}
        </Text>
        <Button size="$3" onPress={retry}>
          {t('common.retry')}
        </Button>
      </YStack>
    );
  }

  // Build the rollout node for the selected core, if it's the stable core and
  // rollout controls are available (super-only).
  const rolloutNode =
    selection?.mode === 'edit' &&
    selection.core.coreType &&
    isStableCore(selection.core) &&
    rolloutAvailable ? (
      <RolloutSection
        coreType={selection.core.coreType}
        cores={cores.filter((c) => c.coreType === selection.core.coreType)}
        candidates={cores.filter(
          (c) =>
            c.coreType === selection.core.coreType && !isStableCore(c) && c.status === 'active',
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
    ) : undefined;

  const selectedId = selection?.mode === 'edit' ? selection.core.coreId : null;

  const list = (
    <CoreList
      cores={cores}
      selectedId={selectedId}
      onSelect={(core) => setSelection({ mode: 'edit', core })}
      onCreate={() => setSelection({ mode: 'create' })}
    />
  );

  const editor = selection ? (
    <CoreForm
      // Remount on selection change → form state resets cleanly.
      key={selection.mode === 'edit' ? `edit:${selection.core.coreId}` : 'create'}
      mode={selection.mode}
      core={selection.mode === 'edit' ? selection.core : undefined}
      models={models}
      catalog={mcaCatalog}
      rollout={rolloutNode}
      onBack={wide ? undefined : () => setSelection(null)}
      onSubmit={handleSubmit}
      onCancel={() => setSelection(null)}
    />
  ) : (
    <YStack flex={1} justifyContent="center" alignItems="center" padding="$6" gap="$2">
      <Cpu size={48} color={c.text3} />
      <Text color="$gray10" textAlign="center">
        {t('agentCores.selectCorePrompt')}
      </Text>
    </YStack>
  );

  return (
    <YStack
      flex={1}
      backgroundColor="$background"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {wide ? (
        <XStack flex={1}>
          <YStack width={260} borderRightWidth={1} borderRightColor={c.border}>
            {list}
          </YStack>
          <YStack flex={1}>{editor}</YStack>
        </XStack>
      ) : selection ? (
        editor
      ) : (
        list
      )}
    </YStack>
  );
}
