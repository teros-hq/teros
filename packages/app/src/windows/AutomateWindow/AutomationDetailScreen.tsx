/**
 * AutomationDetailScreen — create / edit one automation.
 *
 * A narrow design-system page: back + actions bar, PageHead, then three
 * plain sections (no nested cards, so the Select popovers are never clipped):
 *
 *   Basics   — name, enabled
 *   Trigger  — PTabs (schedule / webhook / event) + per-kind fields
 *   Action   — PTabs (task / channel / flow) + per-kind pickers
 *   Webhook  — (edit only) regenerate URL, send a test payload, recent calls
 *
 * Both trigger and action can be changed on an existing automation; the
 * backend carries the trigger's runtime state over and returns a fresh URL
 * when the trigger becomes a webhook.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cronToScheduleText, estimateCronRunsPerDay, isFiveFieldCron, parseScheduleExpression, validateTemplate } from '@teros/shared'
import { View } from 'react-native'
import { useColors } from '../../components/mca/primitives/useColors'
import {
  Badge,
  Btn,
  Field,
  FieldGroup,
  FieldHelp,
  FieldLabel,
  LGroup,
  LRow,
  Page,
  PageHead,
  Ph,
  PTabs,
  SectionLabel,
  Switch,
  T,
} from '../../components/ui/ds'
import type { AgentData } from '../../services/AgentApi'
import type { BoardColumn } from '../../services/BoardApi'
import type { ChannelData } from '../../services/ChannelApi'
import type { ProjectData } from '../../services/ProjectApi'
import { getTerosClient } from '../../services/terosClientSingleton'
import { Select, type SelectOption } from '../UsersWindow/Select'
import { formatRelativeTime } from './relative-time'
import { AUTOMATE_QUOTA_ERROR_PREFIX } from './types/automate'
import { ACTION_META, ACTION_ORDER, TRIGGER_META, TRIGGER_ORDER } from './starter-meta'
import type {
  ActionType,
  AutomateAction,
  AutomateExecution,
  AutomateStarter,
  AutomateTrigger,
  EventTopic,
  FlowListItem,
  ParseScheduleResult,
  StarterType,
  WebhookCall,
} from './types/automate'

export interface AutomationDetailScreenProps {
  starter?: AutomateStarter | null
  workspaceId: string
  onBack: () => void
  onSaved: () => void | Promise<void>
  onDelete?: () => void
  onRevealUrl?: (url: string) => void
  /** The creator's Automate runs per UTC day (0 = unlimited) — warns when a cron alone would exceed it. */
  dailyLimit?: number
  /** Bumped by the window on every live run (automate.quota-updated) so the history reloads. */
  executionsVersion?: number
}

/** Short date for the preview's "Next:" line — "Mon 2 Nov, 09:00". */
function formatPreviewDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

interface FormErrors {
  titleTemplate?: string
  instructionsTemplate?: string
  descriptionTemplate?: string
  eventTemplate?: string
  name?: string
  scheduleText?: string
  cronExpression?: string
  timezone?: string
  onceAt?: string
  eventPattern?: string
  filters?: string
  projectId?: string
  agentId?: string
  channelId?: string
  flowId?: string
  inputMapping?: string
}

interface FormState {
  triggerType: StarterType
  actionType: ActionType
  name: string
  enabled: boolean
  // trigger: scheduler — TWO always-visible fields (v1.4.4, reworked):
  // fill either one and the other auto-fills (NL → cron, cron → NL).
  // lastScheduleEdit records which field the user typed in last, so the
  // auto-fill never fights the user; both fields validate independently and
  // a mismatch between them is surfaced as a sync error on both.
  scheduleText: string
  cronExpression: string
  lastScheduleEdit: 'nl' | 'cron' | null
  timezone: string
  // trigger: once
  onceAt: string
  // trigger: event
  eventPattern: string
  filtersJson: string
  // action: create-task
  ctProjectId: string
  ctAgentId: string
  ctColumnId: string
  ctTitleTemplate: string
  ctInstructionsTemplate: string
  ctDescriptionTemplate: string
  // action: channel-event
  ceChannelId: string
  ceAgentId: string
  ceEventTemplate: string
  // action: start-flow
  sfFlowId: string
  sfProjectId: string
  sfInputMapping: string
}

const defaultForm: FormState = {
  triggerType: 'scheduler',
  actionType: 'channel-event',
  name: '',
  enabled: true,
  scheduleText: 'weekdays a las 9',
  lastScheduleEdit: null,
  cronExpression: '0 9 * * 1-5',
  timezone: '',
  onceAt: '',
  eventPattern: '',
  filtersJson: '',
  ctProjectId: '',
  ctAgentId: '',
  ctColumnId: '',
  ctTitleTemplate: '',
  ctInstructionsTemplate: '',
  ctDescriptionTemplate: '',
  ceChannelId: '',
  ceAgentId: '',
  ceEventTemplate: '',
  sfFlowId: '',
  sfProjectId: '',
  sfInputMapping: '',
}

function formFromStarter(starter: AutomateStarter): FormState {
  const base: FormState = { ...defaultForm, name: starter.name, enabled: starter.enabled, triggerType: starter.type }
  const trigger = starter.trigger
  const action = starter.action
  if (trigger.type === 'scheduler') {
    base.cronExpression = trigger.cronExpression
    // Editing an existing automation: the NL box starts at the human text for
    // the stored cron when it round-trips, else at the cron itself (it parses
    // as a passthrough) — the user sees plain language immediately.
    const nl = cronToScheduleText(trigger.cronExpression, 'es')
    const roundTrips = (() => {
      const r = parseScheduleExpression(nl)
      return r.ok && r.cron === trigger.cronExpression
    })()
    base.scheduleText = roundTrips ? nl : trigger.cronExpression
    base.lastScheduleEdit = null
    base.timezone = trigger.timezone ?? ''
  } else if (trigger.type === 'once') {
    base.onceAt = trigger.at
    base.timezone = trigger.timezone ?? ''
  } else if (trigger.type === 'event') {
    base.eventPattern = trigger.eventPattern
    base.filtersJson = trigger.filters && trigger.filters.length > 0 ? JSON.stringify(trigger.filters, null, 2) : ''
  }
  base.actionType = action.type
  if (action.type === 'create-task') {
    base.ctProjectId = action.projectId
    base.ctAgentId = action.agentId
    base.ctColumnId = action.targetColumnId || ''
    base.ctTitleTemplate = action.titleTemplate ?? ''
    base.ctInstructionsTemplate = action.instructionsTemplate ?? ''
    base.ctDescriptionTemplate = action.descriptionTemplate ?? ''
  } else if (action.type === 'channel-event') {
    base.ceChannelId = action.channelId
    base.ceAgentId = action.agentId
    base.ceEventTemplate = action.eventTemplate ?? ''
  } else {
    base.sfFlowId = action.flowId
    base.sfProjectId = action.projectId
    base.sfInputMapping =
      action.inputMapping && Object.keys(action.inputMapping).length > 0
        ? JSON.stringify(action.inputMapping, null, 2)
        : ''
  }
  return base
}

function parseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  if (!raw.trim()) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false }
  }
}

/** Inline error banner (same tint as the Providers window). */
function ErrorBanner({ text }: { text: string }) {
  const c = useColors()
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        padding: 12,
        paddingHorizontal: 14,
        borderRadius: 10,
        backgroundColor: c.tint.r.bg,
        borderWidth: 1,
        borderColor: c.tint.r.bd,
        marginBottom: 16,
      }}
    >
      <Ph name="warning-circle" size={16} color={c.tint.r.tx} />
      <T step="sm" color={c.tint.r.tx} style={{ flex: 1 }}>
        {text}
      </T>
    </View>
  )
}

/** A labelled Select with a placeholder row while nothing is chosen. */
function PickerField({
  label,
  value,
  options,
  placeholder,
  error,
  disabled,
  onChange,
  testID,
}: {
  label: string
  value: string
  options: SelectOption[]
  placeholder: string
  error?: string
  disabled?: boolean
  onChange: (value: string) => void
  testID: string
}) {
  const all = value && options.some((o) => o.key === value) ? options : [{ key: '', label: placeholder }, ...options]
  return (
    <FieldGroup>
      <FieldLabel required>{label}</FieldLabel>
      <View style={{ opacity: disabled ? 0.6 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
        <Select testID={testID} value={value} options={all} onChange={onChange} minWidth={240} ariaLabel={label} />
      </View>
      {error ? <FieldHelp error>{error}</FieldHelp> : null}
    </FieldGroup>
  )
}

export function AutomationDetailScreen({
  starter,
  workspaceId,
  onBack,
  onSaved,
  onDelete,
  onRevealUrl, dailyLimit = 0, executionsVersion = 0 }: AutomationDetailScreenProps) {
  const { t, i18n } = useTranslation()
  const c = useColors()
  const client = getTerosClient()
  const isCreate = !starter

  const [form, setForm] = useState<FormState>(starter ? formFromStarter(starter) : defaultForm)
  const [errors, setErrors] = useState<FormErrors>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const [projects, setProjects] = useState<ProjectData[]>([])
  const [agents, setAgents] = useState<AgentData[]>([])
  const [channels, setChannels] = useState<ChannelData[]>([])
  const [flows, setFlows] = useState<FlowListItem[]>([])
  const [topics, setTopics] = useState<EventTopic[]>([])
  const [executions, setExecutions] = useState<AutomateExecution[]>([])
  const [columns, setColumns] = useState<BoardColumn[]>([])
  const [loadingResources, setLoadingResources] = useState(true)
  const [resourceError, setResourceError] = useState<string | null>(null)

  const [calls, setCalls] = useState<WebhookCall[]>([])
  const [loadingCalls, setLoadingCalls] = useState(false)
  // Always-on schedule preview (v1.4.4): whatever the user types — natural
  // language or raw cron — is echoed back as plain text + next runs.
  const [schedulePreview, setSchedulePreview] = useState<ParseScheduleResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [testPayload, setTestPayload] = useState('{"title": "Example", "discriminator": "example-1"}')
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)

  const update = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }, [])

  // ── Resources ─────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setLoadingResources(true)
      setResourceError(null)
      try {
        const [p, a, ch, f, ev] = await Promise.all([
          client.project.list(workspaceId),
          client.agent.listAgents(workspaceId),
          // The picker needs every conversation of the workspace, not the first page of 30.
          client.channel.list(workspaceId, undefined, 100),
          client.automate.listFlows(workspaceId),
          client.automate.listEventTopics(workspaceId).catch(() => ({ topics: [] as EventTopic[] })),
        ])
        if (cancelled) return
        setProjects(p.projects)
        setAgents(a.agents)
        setChannels(ch.channels)
        setFlows(f.flows)
        setTopics(ev.topics)
      } catch (err) {
        if (!cancelled) {
          setResourceError(
            err instanceof Error ? err.message : t('automate.errors.resources', { defaultValue: 'Could not load projects, agents and channels' }),
          )
        }
      } finally {
        if (!cancelled) setLoadingResources(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [workspaceId, client, t])

  // Columns follow the create-task project.
  useEffect(() => {
    if (!form.ctProjectId) {
      setColumns([])
      return
    }
    let cancelled = false
    client.board
      .getBoard(form.ctProjectId)
      .then(({ board }) => {
        if (cancelled) return
        setColumns(board.config.columns)
        setForm((prev) => {
          const stillValid = board.config.columns.some((col) => col.columnId === prev.ctColumnId)
          return stillValid ? prev : { ...prev, ctColumnId: board.config.columns[0]?.columnId ?? '' }
        })
      })
      .catch((err) => {
        if (!cancelled) console.error('[AutomationDetailScreen] Failed to load columns:', err)
      })
    return () => {
      cancelled = true
    }
  }, [form.ctProjectId, client.board])

  // Webhook calls (edit only).
  const loadCalls = useCallback(async () => {
    if (!starter || starter.type !== 'webhook') return
    setLoadingCalls(true)
    try {
      const res = await client.automate.listWebhookCalls(starter.starterId)
      setCalls(res.calls)
    } catch (err) {
      console.error('[AutomationDetailScreen] Failed to load calls:', err)
    } finally {
      setLoadingCalls(false)
    }
  }, [starter, client.automate])

  useEffect(() => {
    void loadCalls()
  }, [loadCalls])

  // Execution history (edit only, any trigger kind).
  useEffect(() => {
    if (!starter?.starterId) return
    let cancelled = false
    client.automate
      .listExecutions(starter.starterId, { limit: 20 })
      .then((res) => {
        if (!cancelled) setExecutions(res.executions)
      })
      .catch((err) => console.error('[AutomationDetailScreen] Failed to load executions:', err))
    return () => {
      cancelled = true
    }
  }, [starter?.starterId, client.automate, executionsVersion])

  // ── Schedule resolution (local, instant, bidirectional) ───────────────────
  // Both fields parse locally with @teros/shared: filling either one
  // auto-fills the other (NL → cron, cron → NL). lastScheduleEdit keeps the
  // auto-fill from fighting the user. The debounced backend preview below
  // only adds next-run dates on top.
  const locale = i18n.language?.startsWith('es') ? 'es' : 'en'
  const nlParsed = useMemo(
    () => (form.scheduleText.trim() ? parseScheduleExpression(form.scheduleText, locale) : null),
    [form.scheduleText, locale],
  )
  const cronParsed = useMemo(
    () => (form.cronExpression.trim() ? (isFiveFieldCron(form.cronExpression) ? { ok: true as const, cron: form.cronExpression.trim() } : null) : null),
    [form.cronExpression],
  )
  // The cron each field resolves to, independently.
  const nlCron = nlParsed?.ok ? nlParsed.cron : null
  const cronCron = cronParsed?.ok ? cronParsed.cron : null
  // The effective cron: the field the user edited last wins; when it is not
  // resolvable, fall back to the other field so the preview keeps working.
  const effectiveCron = form.lastScheduleEdit === 'cron' ? cronCron ?? nlCron : nlCron ?? cronCron
  // Out of sync: both fields resolve but to different crons.
  const scheduleMismatch =
    form.triggerType === 'scheduler' && nlCron !== null && cronCron !== null && nlCron !== cronCron
  // Auto-fill: when the field edited last resolves, mirror it into the other.
  const scheduleAutoFill = useMemo(() => {
    if (form.triggerType !== 'scheduler') return form
    if (form.lastScheduleEdit === 'nl' && nlCron !== null && cronCron !== nlCron) {
      return { ...form, cronExpression: nlCron }
    }
    if (form.lastScheduleEdit === 'cron' && cronCron !== null) {
      const nl = cronToScheduleText(cronCron, locale)
      const reparsed = parseScheduleExpression(nl, locale)
      // Only overwrite the NL box when the text round-trips to the same cron
      // (else keep the cron string, which parses as a passthrough).
      const text = reparsed.ok && reparsed.cron === cronCron ? nl : cronCron
      if (text !== form.scheduleText) return { ...form, scheduleText: text }
    }
    return form
  }, [form, nlCron, cronCron, locale])
  // Apply the auto-fill once, without re-triggering (the derived form is
  // deterministic from the same inputs).
  useEffect(() => {
    if (scheduleAutoFill !== form) setForm(scheduleAutoFill)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleAutoFill])

  // ── Schedule preview (debounced, always-on) ────────────────────────────────
  // Adds next-run dates on top of the local resolution, from the same parser
  // the backend serves (automate.parse-schedule), so preview and save agree.
  const previewExpression = form.triggerType === 'scheduler' ? effectiveCron ?? '' : ''
  useEffect(() => {
    if (!previewExpression.trim()) {
      setSchedulePreview(null)
      return
    }
    let cancelled = false
    setPreviewLoading(true)
    const timer = setTimeout(async () => {
      try {
        const res = await client.automate.parseSchedule(workspaceId, previewExpression, {
          ...(form.timezone.trim() ? { timezone: form.timezone.trim() } : {}),
          locale: i18n.language?.startsWith('es') ? 'es' : 'en',
        })
        if (!cancelled) setSchedulePreview(res)
      } catch {
        // Preview is best-effort: the submit path re-validates authoritatively.
        if (!cancelled) setSchedulePreview(null)
      } finally {
        if (!cancelled) setPreviewLoading(false)
      }
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [previewExpression, form.timezone, workspaceId, client.automate, i18n.language])

  // ── Options ───────────────────────────────────────────────────────────────

  const cronRunsPerDay = useMemo(
    () =>
      form.triggerType === 'scheduler' && effectiveCron
        ? estimateCronRunsPerDay(effectiveCron)
        : null,
    [form.triggerType, schedulePreview],
  )

  const projectOptions = useMemo<SelectOption[]>(() => projects.map((p) => ({ key: p.projectId, label: p.name })), [projects])
  const agentOptions = useMemo<SelectOption[]>(() => agents.map((a) => ({ key: a.agentId, label: a.fullName ?? a.name })), [agents])
  const columnOptions = useMemo<SelectOption[]>(() => columns.map((col) => ({ key: col.columnId, label: col.name })), [columns])
  // Conversations as "Agent · Title" (title = metadata.name): a channel-event
  // is delivered to the channel and wakes ITS agent, so the agent leads.
  const channelOptions = useMemo<SelectOption[]>(() => {
    const agentName = new Map(agents.map((a) => [a.agentId, a.fullName ?? a.name]))
    return channels.map((ch) => {
      const title = ch.metadata?.name || ch.title || ch.channelId
      const agent = agentName.get(ch.agentId)
      return { key: ch.channelId, label: agent ? `${agent} · ${title}` : title }
    })
  }, [channels, agents])
  const flowOptions = useMemo<SelectOption[]>(() => flows.map((f) => ({ key: f.flowId, label: f.name })), [flows])

  // ── Validation + submit ───────────────────────────────────────────────────

  const validate = (): boolean => {
    const next: FormErrors = {}
    if (!form.name.trim()) next.name = t('automate.form.nameRequired', { defaultValue: 'Give it a name' })
    if (form.triggerType === 'scheduler') {
      // Per-field: each box must resolve on its own (local parser — instant).
      if (!form.scheduleText.trim()) {
        next.scheduleText = t('automate.form.scheduleRequired', { defaultValue: 'Describe the schedule in plain language' })
      } else if (!nlParsed?.ok) {
        next.scheduleText =
          nlParsed?.suggestion ??
          t('automate.form.scheduleInvalid', { defaultValue: 'Could not understand that schedule' })
      }
      if (!form.cronExpression.trim()) {
        next.cronExpression = t('automate.form.cronRequired', { defaultValue: 'A cron expression is required' })
      } else if (!cronParsed?.ok) {
        next.cronExpression = t('automate.form.cronInvalid', {
          defaultValue: 'Not a valid 5-field cron: minute · hour · day · month · weekday',
        })
      }
      // Sync: both resolve but to different crons — the boxes disagree.
      if (!next.scheduleText && !next.cronExpression && scheduleMismatch) {
        const syncMsg = t('automate.form.scheduleMismatch', {
          defaultValue: 'The two fields do not match — edit either one and the other will update',
        })
        next.scheduleText = syncMsg
        next.cronExpression = syncMsg
      }
    }
    if (form.triggerType === 'once') {
      const ms = Date.parse(form.onceAt)
      if (!form.onceAt.trim() || Number.isNaN(ms)) {
        next.onceAt = t('automate.form.onceAtRequired', { defaultValue: 'Pick a date and time (ISO 8601)' })
      } else if (ms < Date.now()) {
        next.onceAt = t('automate.form.onceAtPast', { defaultValue: 'That time is in the past' })
      }
    }
    if (form.triggerType === 'event') {
      if (!form.eventPattern.trim()) next.eventPattern = t('automate.form.patternRequired', { defaultValue: 'An event pattern is required' })
      if (form.filtersJson.trim()) {
        const parsed = parseJson(form.filtersJson)
        if (!parsed.ok || !Array.isArray(parsed.value)) {
          next.filters = t('automate.form.filtersInvalid', { defaultValue: 'Filters must be a JSON array of objects' })
        }
      }
    }
    // Templates: required ones must be present, every one must follow the shared grammar.
    const templateError = (value: string, required: boolean, requiredMsg: string): string | undefined => {
      if (!value.trim()) return required ? requiredMsg : undefined
      const v = validateTemplate(value)
      return v.ok ? undefined : t('automate.form.templateInvalid', { defaultValue: 'Unsupported template syntax: {{error}}', error: v.error })
    }
    if (form.actionType === 'create-task') {
      if (!form.ctProjectId) next.projectId = t('automate.form.projectRequired', { defaultValue: 'Pick a project' })
      if (!form.ctAgentId) next.agentId = t('automate.form.agentRequired', { defaultValue: 'Pick an agent' })
      const titleErr = templateError(form.ctTitleTemplate, true, t('automate.form.titleTemplateRequired', { defaultValue: 'A title template is required' }))
      if (titleErr) next.titleTemplate = titleErr
      const instrErr = templateError(form.ctInstructionsTemplate, true, t('automate.form.instructionsTemplateRequired', { defaultValue: 'An instructions template is required' }))
      if (instrErr) next.instructionsTemplate = instrErr
      const descErr = templateError(form.ctDescriptionTemplate, false, '')
      if (descErr) next.descriptionTemplate = descErr
    }
    if (form.actionType === 'channel-event') {
      if (!form.ceChannelId) next.channelId = t('automate.form.channelRequired', { defaultValue: 'Pick a channel' })
      const msgErr = templateError(form.ceEventTemplate, true, t('automate.form.messageRequired', { defaultValue: 'A message is required' }))
      if (msgErr) next.eventTemplate = msgErr
    }
    if (form.actionType === 'start-flow') {
      if (!form.sfFlowId) next.flowId = t('automate.form.flowRequired', { defaultValue: 'Pick a flow' })
      if (!form.sfProjectId) next.projectId = t('automate.form.projectRequired', { defaultValue: 'Pick a project' })
      if (form.sfInputMapping.trim()) {
        const parsed = parseJson(form.sfInputMapping)
        if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
          next.inputMapping = t('automate.form.inputMappingInvalid', { defaultValue: 'Input mapping must be a JSON object' })
        }
      }
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const buildTrigger = (): AutomateTrigger => {
    if (form.triggerType === 'scheduler') {
      // v1.4.4 (reworked): the saved value is the effective cron the two
      // fields agree on — the backend never sees natural language.
      if (!effectiveCron) throw new Error('No valid schedule to save')
      return {
        type: 'scheduler',
        cronExpression: effectiveCron,
        ...(form.timezone.trim() ? { timezone: form.timezone.trim() } : {}),
      }
    }
    if (form.triggerType === 'once') {
      return {
        type: 'once',
        at: new Date(form.onceAt).toISOString(),
        ...(form.timezone.trim() ? { timezone: form.timezone.trim() } : {}),
      }
    }
    if (form.triggerType === 'event') {
      const parsed = parseJson(form.filtersJson)
      const filters =
        parsed.ok && Array.isArray(parsed.value) && parsed.value.length > 0
          ? (parsed.value as Array<Record<string, unknown>>)
          : undefined
      return { type: 'event', eventPattern: form.eventPattern.trim(), ...(filters ? { filters } : {}) }
    }
    return { type: 'webhook' }
  }

  const buildAction = (): AutomateAction => {
    if (form.actionType === 'create-task') {
      return {
        type: 'create-task',
        projectId: form.ctProjectId,
        agentId: form.ctAgentId,
        targetColumnId: form.ctColumnId,
        titleTemplate: form.ctTitleTemplate.trim(),
        instructionsTemplate: form.ctInstructionsTemplate.trim(),
        ...(form.ctDescriptionTemplate.trim() ? { descriptionTemplate: form.ctDescriptionTemplate.trim() } : {}),
      }
    }
    if (form.actionType === 'channel-event') {
      // The agent is the channel's: the message is injected into the
      // conversation and wakes whoever owns it.
      const channel = channels.find((ch) => ch.channelId === form.ceChannelId)
      return {
        type: 'channel-event',
        channelId: form.ceChannelId,
        agentId: channel?.agentId ?? form.ceAgentId,
        eventTemplate: form.ceEventTemplate.trim(),
      }
    }
    const parsed = parseJson(form.sfInputMapping)
    const inputMapping =
      parsed.ok && typeof parsed.value === 'object' && parsed.value !== null && !Array.isArray(parsed.value)
        ? (parsed.value as Record<string, string>)
        : undefined
    return {
      type: 'start-flow',
      flowId: form.sfFlowId,
      projectId: form.sfProjectId,
      ...(inputMapping ? { inputMapping } : {}),
    }
  }

  const handleSave = async () => {
    setSubmitError(null)
    if (!validate()) return
    setSubmitting(true)
    try {
      const input = { name: form.name.trim(), trigger: buildTrigger(), action: buildAction(), enabled: form.enabled }
      const result = isCreate
        ? await client.automate.createStarter(workspaceId, input)
        : await client.automate.updateStarter(workspaceId, starter!.starterId, input)
      if (result.url && onRevealUrl) onRevealUrl(result.url)
      await onSaved()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : t('automate.errors.save', { defaultValue: 'Could not save the automation' }))
    } finally {
      setSubmitting(false)
    }
  }

  const handleRegenerateUrl = async () => {
    if (!starter || starter.type !== 'webhook') return
    try {
      const { url } = await client.automate.regenerateWebhookUrl(workspaceId, starter.starterId)
      onRevealUrl?.(url)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : t('automate.errors.regenerate', { defaultValue: 'Could not regenerate the URL' }))
    }
  }

  const handleTest = async () => {
    if (!starter || starter.type !== 'webhook') return
    const parsed = parseJson(testPayload)
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
      setTestResult({ ok: false, text: t('automate.test.invalid', { defaultValue: 'The payload must be a JSON object' }) })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const res = await client.automate.testWebhook(starter.starterId, parsed.value as Record<string, unknown>)
      const target = res.taskId ?? res.executionId ?? ''
      setTestResult({
        ok: true,
        text:
          res.outcome === 'updated'
            ? t('automate.test.updated', { defaultValue: 'Appended to task {{target}}', target })
            : t('automate.test.created', { defaultValue: 'Fired — {{target}}', target }),
      })
      await loadCalls()
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : t('automate.test.failed', { defaultValue: 'Test failed' }) })
    } finally {
      setTesting(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const triggerTabs = TRIGGER_ORDER.map((type) => ({
    key: type,
    label: t(TRIGGER_META[type].labelKey, { defaultValue: TRIGGER_META[type].labelFallback }),
    icon: TRIGGER_META[type].icon,
  }))
  const actionTabs = ACTION_ORDER.map((type) => ({
    key: type,
    label: t(ACTION_META[type].labelKey, { defaultValue: ACTION_META[type].labelFallback }),
    icon: ACTION_META[type].icon,
  }))

  const title = isCreate ? t('automate.detail.newTitle', { defaultValue: 'New automation' }) : starter!.name
  const lead = isCreate
    ? t('automate.detail.newLead', { defaultValue: 'Pick when it fires and what it does. You can change both later.' })
    : undefined

  return (
    <Page narrow>
      {/* Top bar */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
        <Btn variant="ghost" icon="arrow-left" onPress={onBack} testID="automation-back">
          {t('automate.detail.back', { defaultValue: 'Automations' })}
        </Btn>
        <View style={{ flex: 1 }} />
        {!isCreate && onDelete ? (
          <Btn variant="dangerSoft" icon="trash" onPress={onDelete} disabled={submitting} testID="automation-delete">
            {t('common.delete', { defaultValue: 'Delete' })}
          </Btn>
        ) : null}
        <Btn
          variant="primary"
          icon="check"
          onPress={handleSave}
          loading={submitting}
          disabled={submitting || loadingResources}
          testID="automation-save"
        >
          {isCreate ? t('automate.detail.create', { defaultValue: 'Create' }) : t('automate.detail.save', { defaultValue: 'Save' })}
        </Btn>
      </View>

      <PageHead
        eyebrow={t('automate.eyebrow', { defaultValue: 'Automate' })}
        title={title}
        lead={lead}
        eyebrowRight={
          !isCreate ? (
            <Badge tone={starter!.enabled ? 'g' : 'muted'} dot sm>
              {starter!.enabled
                ? t('automate.status.enabled', { defaultValue: 'Active' })
                : t('automate.status.disabled', { defaultValue: 'Disabled' })}
            </Badge>
          ) : undefined
        }
      />

      {resourceError ? <ErrorBanner text={resourceError} /> : null}
      {submitError ? <ErrorBanner text={submitError} /> : null}

      {/* ── Basics ─────────────────────────────────────────────────────── */}
      <FieldGroup style={{ marginTop: 0 }}>
        <FieldLabel required>{t('automate.form.name', { defaultValue: 'Name' })}</FieldLabel>
        <Field
          value={form.name}
          onChangeText={(text) => update('name', text)}
          placeholder={t('automate.form.namePlaceholder', { defaultValue: 'e.g. GitHub issues → tasks' })}
          editable={!submitting}
          error={!!errors.name}
          testID="automation-name"
        />
        {errors.name ? <FieldHelp error>{errors.name}</FieldHelp> : null}
      </FieldGroup>

      <FieldGroup>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Switch on={form.enabled} onToggle={(next) => update('enabled', next)} disabled={submitting} />
          <View style={{ flex: 1 }}>
            <T step="sm">{t('automate.form.enabled', { defaultValue: 'Enabled' })}</T>
            <T step="12" tone="text3">
              {t('automate.form.enabledHint', { defaultValue: 'Disabled automations keep their configuration but never fire.' })}
            </T>
          </View>
        </View>
      </FieldGroup>

      {/* ── Trigger ────────────────────────────────────────────────────── */}
      <SectionLabel label={t('automate.form.triggerSection', { defaultValue: 'When does it fire?' })} style={{ marginTop: 28 }} />
      <PTabs value={form.triggerType} onChange={(key) => update('triggerType', key)} items={triggerTabs} />

      {form.triggerType === 'scheduler' ? (
        <>
          <FieldGroup>
            <FieldLabel required>{t('automate.form.schedule', { defaultValue: 'Schedule (plain language)' })}</FieldLabel>
            <Field
              value={form.scheduleText}
              onChangeText={(text) => setForm((prev) => ({ ...prev, scheduleText: text, lastScheduleEdit: 'nl' }))}
              placeholder={t('automate.form.schedulePlaceholder', { defaultValue: 'cada lunes a las 9' })}
              autoCapitalize="none"
              editable={!submitting}
              error={!!errors.scheduleText}
              testID="automation-schedule"
            />
            <FieldHelp error={!!errors.scheduleText}>
              {errors.scheduleText ??
                t('automate.form.scheduleHint', {
                  defaultValue: 'Plain language: "cada lunes a las 9", "weekdays a las 8", "cada 2 horas", "todos los días a las 9:30".',
                })}
            </FieldHelp>

            <FieldLabel required style={{ marginTop: 12 }}>
              {t('automate.form.cron', { defaultValue: 'Cron expression' })}
            </FieldLabel>
            <Field
              mono
              value={form.cronExpression}
              onChangeText={(text) => setForm((prev) => ({ ...prev, cronExpression: text, lastScheduleEdit: 'cron' }))}
              placeholder="0 9 * * 1-5"
              autoCapitalize="none"
              editable={!submitting}
              error={!!errors.cronExpression}
              testID="automation-cron"
            />
            <FieldHelp error={!!errors.cronExpression}>
              {errors.cronExpression ??
                t('automate.form.cronHint', {
                  defaultValue: '5 fields: minute · hour · day · month · weekday. "0 9 * * 1-5" is weekdays at 09:00.',
                })}
            </FieldHelp>

            {/* Always-on preview of the effective schedule: the user never
                decodes cron, and sees the next runs before saving (v1.4.4). */}
            {effectiveCron && schedulePreview?.ok ? (
              <View
                testID="automation-schedule-preview"
                style={{ marginTop: 8, padding: 10, borderRadius: 8, backgroundColor: c.tint.a.bg, borderWidth: 1, borderColor: c.tint.a.bd }}
              >
                <T step="12" tone="text2">
                  {schedulePreview.scheduleHuman}
                </T>
                {schedulePreview.next && schedulePreview.next.length > 0 ? (
                  <T step="12" tone="text3" style={{ marginTop: 4 }}>
                    {t('automate.form.nextRuns', { defaultValue: 'Next: {{first}} · {{second}}', first: formatPreviewDate(schedulePreview.next[0]), second: formatPreviewDate(schedulePreview.next[1]) })}
                  </T>
                ) : null}
              </View>
            ) : null}
            {cronRunsPerDay !== null && dailyLimit > 0 && cronRunsPerDay > dailyLimit ? (
              <View
                testID="automation-cron-quota-warning"
                style={{
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  gap: 8,
                  marginTop: 8,
                  padding: 10,
                  borderRadius: 8,
                  backgroundColor: c.tint.a.bg,
                  borderWidth: 1,
                  borderColor: c.tint.a.bd,
                }}
              >
                <Ph name="warning" size={14} color={c.tint.a.tx} />
                <T step="12" tone="text2" style={{ flex: 1 }}>
                  {t('automate.form.cronQuotaWarning', {
                    defaultValue:
                      'This schedule fires about {{runs}} times a day, but your plan allows {{limit}} Automate runs a day across all automations. Runs beyond the limit are skipped. Space it out, or upgrade your plan.',
                    runs: cronRunsPerDay,
                    limit: dailyLimit,
                  })}
                </T>
              </View>
            ) : null}
          </FieldGroup>
          <FieldGroup>
            <FieldLabel>{t('automate.form.timezone', { defaultValue: 'Timezone' })}</FieldLabel>
            <Field
              mono
              value={form.timezone}
              onChangeText={(text) => update('timezone', text)}
              placeholder="UTC"
              autoCapitalize="none"
              editable={!submitting}
              testID="automation-timezone"
            />
            <FieldHelp>{t('automate.form.timezoneHint', { defaultValue: 'IANA name such as Europe/Madrid. Empty means UTC.' })}</FieldHelp>
          </FieldGroup>
        </>
      ) : null}

      {form.triggerType === 'once' ? (
        <>
          <FieldGroup>
            <FieldLabel required>{t('automate.form.onceAt', { defaultValue: 'When' })}</FieldLabel>
            <Field
              mono
              value={form.onceAt}
              onChangeText={(text) => update('onceAt', text)}
              placeholder={new Date(Date.now() + 3_600_000).toISOString().slice(0, 16)}
              autoCapitalize="none"
              editable={!submitting}
              error={!!errors.onceAt}
              testID="automation-once-at"
            />
            <FieldHelp error={!!errors.onceAt}>
              {errors.onceAt ??
                t('automate.form.onceAtHint', {
                  defaultValue: 'ISO 8601 date and time, e.g. 2026-10-15T09:00. Fires once, then the automation disables itself.',
                })}
            </FieldHelp>
          </FieldGroup>
          <FieldGroup>
            <FieldLabel>{t('automate.form.timezone', { defaultValue: 'Timezone' })}</FieldLabel>
            <Field
              mono
              value={form.timezone}
              onChangeText={(text) => update('timezone', text)}
              placeholder="UTC"
              autoCapitalize="none"
              editable={!submitting}
              testID="automation-once-timezone"
            />
            <FieldHelp>{t('automate.form.timezoneHint', { defaultValue: 'IANA name such as Europe/Madrid. Empty means UTC.' })}</FieldHelp>
          </FieldGroup>
        </>
      ) : null}

      {form.triggerType === 'event' ? (
        <>
          {topics.length > 0 ? (
            <PickerField
              label={t('automate.form.eventTopic', { defaultValue: 'Event' })}
              value={topics.some((tp) => tp.topic === form.eventPattern) ? form.eventPattern : ''}
              options={topics.map((tp) => ({ key: tp.topic, label: `${tp.topic} · ${tp.appName}` }))}
              placeholder={t('automate.form.selectTopic', { defaultValue: 'Pick an event, or type a pattern below' })}
              onChange={(value) => update('eventPattern', value)}
              testID="automation-topic-select"
            />
          ) : null}
          <FieldGroup>
            <FieldLabel required>{t('automate.form.eventPattern', { defaultValue: 'Event pattern' })}</FieldLabel>
            <Field
              mono
              value={form.eventPattern}
              onChangeText={(text) => update('eventPattern', text)}
              placeholder="board.task_moved · telegram.* · board.*"
              autoCapitalize="none"
              editable={!submitting}
              error={!!errors.eventPattern}
              testID="automation-pattern"
            />
            <FieldHelp error={!!errors.eventPattern}>
              {errors.eventPattern ??
                (() => {
                  const chosen = topics.find((tp) => tp.topic === form.eventPattern)
                  const fields = chosen?.payload ? Object.keys(chosen.payload) : []
                  return fields.length > 0
                    ? t('automate.form.patternFields', { defaultValue: 'Payload fields you can filter on: {{fields}}', fields: fields.join(', ') })
                    : t('automate.form.patternHint', { defaultValue: 'Topic to listen to. * matches anything.' })
                })()}
            </FieldHelp>
          </FieldGroup>
          <FieldGroup>
            <FieldLabel>{t('automate.form.filters', { defaultValue: 'Filters' })}</FieldLabel>
            <Field
              area
              mono
              minHeight={80}
              value={form.filtersJson}
              onChangeText={(text) => update('filtersJson', text)}
              placeholder='[{"toStatus": "review"}]'
              editable={!submitting}
              error={!!errors.filters}
              testID="automation-filters"
            />
            <FieldHelp error={!!errors.filters}>
              {errors.filters ??
                t('automate.form.filtersHint', { defaultValue: 'Optional JSON array. Objects are OR-ed; fields inside an object are AND-ed.' })}
            </FieldHelp>
          </FieldGroup>
        </>
      ) : null}

      {form.triggerType === 'webhook' ? (
        <FieldGroup>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              padding: 12,
              borderRadius: 10,
              backgroundColor: c.tint.i.bg,
              borderWidth: 1,
              borderColor: c.tint.i.bd,
            }}
          >
            <Ph name="link" size={14} color={c.tint.i.tx} />
            <T step="12" color={c.tint.i.tx} style={{ flex: 1 }}>
              {isCreate || starter?.type !== 'webhook'
                ? t('automate.form.webhookHintCreate', { defaultValue: 'A unique URL is generated when you save. It is shown once — copy it then.' })
                : t('automate.form.webhookHintEdit', { defaultValue: 'External systems POST JSON to the URL. Regenerate it below to rotate the secret.' })}
            </T>
          </View>
        </FieldGroup>
      ) : null}

      {/* ── Action ─────────────────────────────────────────────────────── */}
      <SectionLabel label={t('automate.form.actionSection', { defaultValue: 'What happens?' })} style={{ marginTop: 28 }} />
      <PTabs value={form.actionType} onChange={(key) => update('actionType', key)} items={actionTabs} />

      {form.actionType === 'create-task' ? (
        <>
          <PickerField
            label={t('automate.form.project', { defaultValue: 'Project' })}
            value={form.ctProjectId}
            options={projectOptions}
            placeholder={t('automate.form.selectProject', { defaultValue: 'Select a project' })}
            error={errors.projectId}
            disabled={loadingResources}
            onChange={(value) => update('ctProjectId', value)}
            testID="automation-project-select"
          />
          <PickerField
            label={t('automate.form.agent', { defaultValue: 'Agent' })}
            value={form.ctAgentId}
            options={agentOptions}
            placeholder={t('automate.form.selectAgent', { defaultValue: 'Select an agent' })}
            error={errors.agentId}
            disabled={loadingResources}
            onChange={(value) => update('ctAgentId', value)}
            testID="automation-agent-select"
          />
          <PickerField
            label={t('automate.form.column', { defaultValue: 'Column' })}
            value={form.ctColumnId}
            options={columnOptions}
            placeholder={t('automate.form.selectColumn', { defaultValue: 'Default column' })}
            disabled={!form.ctProjectId || loadingResources}
            onChange={(value) => update('ctColumnId', value)}
            testID="automation-column-select"
          />
          <FieldGroup>
            <FieldLabel>{t('automate.form.titleTemplate', { defaultValue: 'Title template' })} *</FieldLabel>
            <Field
              value={form.ctTitleTemplate}
              onChangeText={(text) => update('ctTitleTemplate', text)}
              placeholder="Issue #{{payload.number}}: {{payload.title}}"
              editable={!submitting}
              error={!!errors.titleTemplate}
              testID="automation-title-template"
            />
            <FieldHelp error={!!errors.titleTemplate}>
              {errors.titleTemplate ?? t('automate.form.templateHint', { defaultValue: '{{payload.xxx}} placeholders are filled from the trigger payload; {{now.date}} and {{now.time}} stamp the execution date/time; {{a || b || "text"}} takes the first non-empty value. Required — an empty title fails the run.' })}
            </FieldHelp>
          </FieldGroup>
          <FieldGroup>
            <FieldLabel>{t('automate.form.instructionsTemplate', { defaultValue: 'Instructions template' })} *</FieldLabel>
            <Field
              area
              minHeight={96}
              value={form.ctInstructionsTemplate}
              onChangeText={(text) => update('ctInstructionsTemplate', text)}
              placeholder={t('automate.form.instructionsPlaceholder', { defaultValue: 'Qualify the lead {{payload.fromName || payload.fromId}} and reply in the same chat.' })}
              editable={!submitting}
              error={!!errors.instructionsTemplate}
              testID="automation-instructions-template"
            />
            <FieldHelp error={!!errors.instructionsTemplate}>
              {errors.instructionsTemplate ?? t('automate.form.instructionsHint', { defaultValue: 'What the agent has to do. The whole payload also reaches the task as its input artifact.' })}
            </FieldHelp>
          </FieldGroup>
          <FieldGroup>
            <FieldLabel>{t('automate.form.descriptionTemplate', { defaultValue: 'Description template' })}</FieldLabel>
            <Field
              value={form.ctDescriptionTemplate}
              onChangeText={(text) => update('ctDescriptionTemplate', text)}
              placeholder={t('automate.form.descriptionPlaceholder', { defaultValue: 'Telegram: message from {{payload.fromName}} in {{payload.chatTitle}}' })}
              editable={!submitting}
              error={!!errors.descriptionTemplate}
              testID="automation-description-template"
            />
            <FieldHelp error={!!errors.descriptionTemplate}>
              {errors.descriptionTemplate ?? t('automate.form.descriptionHint', { defaultValue: 'Optional one-line summary shown on the card. Leave empty for none.' })}
            </FieldHelp>
          </FieldGroup>
        </>
      ) : null}

      {form.actionType === 'channel-event' ? (
        <>
          <PickerField
            label={t('automate.form.channel', { defaultValue: 'Channel' })}
            value={form.ceChannelId}
            options={channelOptions}
            placeholder={t('automate.form.selectChannel', { defaultValue: 'Select a channel' })}
            error={errors.channelId}
            disabled={loadingResources}
            onChange={(value) => {
              update('ceChannelId', value)
              const agentId = channels.find((ch) => ch.channelId === value)?.agentId
              if (agentId) update('ceAgentId', agentId)
            }}
            testID="automation-channel-select"
          />
          <FieldHelp>
            {t('automate.form.channelHint', { defaultValue: 'The message lands in this conversation and wakes its agent.' })}
          </FieldHelp>
          {!loadingResources && channels.length === 0 ? (
            <FieldHelp>
              {t('automate.form.noChannels', {
                defaultValue:
                  'No conversations are visible to you in this workspace yet. Conversations are private to their creator until shared — open one and toggle "Make shared", or create a new conversation here.',
              })}
            </FieldHelp>
          ) : null}
          <FieldGroup>
            <FieldLabel>{t('automate.form.messageTemplate', { defaultValue: 'Message' })} *</FieldLabel>
            <Field
              area
              minHeight={80}
              value={form.ceEventTemplate}
              onChangeText={(text) => update('ceEventTemplate', text)}
              placeholder={t('automate.form.messagePlaceholder', { defaultValue: 'Good morning — review the board and report what is blocked.' })}
              editable={!submitting}
              error={!!errors.eventTemplate}
              testID="automation-message-template"
            />
            <FieldHelp error={!!errors.eventTemplate}>
              {errors.eventTemplate ?? t('automate.form.messageHint', { defaultValue: 'What the agent receives in the channel. Supports {{payload.xxx}}, {{topic}}, {{now.*}} (execution date/time) and {{a || b || "text"}} fallbacks. Required.' })}
            </FieldHelp>
          </FieldGroup>
        </>
      ) : null}

      {form.actionType === 'start-flow' ? (
        <>
          <PickerField
            label={t('automate.form.flow', { defaultValue: 'Flow' })}
            value={form.sfFlowId}
            options={flowOptions}
            placeholder={t('automate.form.selectFlow', { defaultValue: 'Select a flow' })}
            error={errors.flowId}
            disabled={loadingResources}
            onChange={(value) => update('sfFlowId', value)}
            testID="automation-flow-select"
          />
          <PickerField
            label={t('automate.form.flowProject', { defaultValue: 'Project' })}
            value={form.sfProjectId}
            options={projectOptions}
            placeholder={t('automate.form.selectProject', { defaultValue: 'Select a project' })}
            error={errors.projectId}
            disabled={loadingResources}
            onChange={(value) => update('sfProjectId', value)}
            testID="automation-flow-project-select"
          />
          <FieldGroup>
            <FieldLabel>{t('automate.form.inputMapping', { defaultValue: 'Input mapping' })}</FieldLabel>
            <Field
              area
              mono
              minHeight={80}
              value={form.sfInputMapping}
              onChangeText={(text) => update('sfInputMapping', text)}
              placeholder='{"issueNumber": "payload.number"}'
              editable={!submitting}
              error={!!errors.inputMapping}
              testID="automation-input-mapping"
            />
            <FieldHelp error={!!errors.inputMapping}>
              {errors.inputMapping ??
                t('automate.form.inputMappingHint', { defaultValue: 'Optional JSON object: flow input → dot-path into the payload.' })}
            </FieldHelp>
          </FieldGroup>
        </>
      ) : null}

      {/* ── Recent runs (edit only) ─────────────────────────────────────── */}
      {!isCreate ? (
        <>
          <SectionLabel label={t('automate.runs.section', { defaultValue: 'Recent runs' })} count={executions.length} style={{ marginTop: 28 }} />
          {executions.length === 0 ? (
            <T step="12" tone="text3">
              {t('automate.runs.none', { defaultValue: 'No runs yet.' })}
            </T>
          ) : (
            <LGroup>
              {executions.map((ex) => (
                <LRow key={ex.executionId}>
                  <Ph name={ex.ok ? 'check-circle' : 'warning-circle'} size={14} color={ex.ok ? c.tint.g.tx : c.tint.r.tx} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T step="sm" ellipsis>
                      {ex.source === 'scheduler'
                        ? t('automate.type.scheduler', { defaultValue: 'Schedule' })
                        : ex.source === 'once'
                          ? t('automate.type.once', { defaultValue: 'Reminder' })
                          : ex.source === 'webhook'
                            ? t('automate.type.webhook', { defaultValue: 'Webhook' })
                            : (ex.topic ?? t('automate.type.event', { defaultValue: 'Event' }))}
                      <T step="sm" tone="text3">
                        {' · '}
                        {formatRelativeTime(ex.createdAt, t)}
                      </T>
                    </T>
                    <T step="12" tone={ex.ok ? 'text3' : ex.refused ? 'text2' : 'danger'} ellipsis>
                      {ex.refused
                        ? ex.error?.startsWith(AUTOMATE_QUOTA_ERROR_PREFIX)
                          ? t('automate.runs.skippedQuota', { defaultValue: 'Skipped: the daily Automate budget of your plan was spent' })
                          : t('automate.runs.skippedBilling', { defaultValue: 'Skipped: agent hours or payment blocked it' })
                        : (ex.error ?? ex.taskId ?? ex.executionRefId ?? new Date(ex.createdAt).toLocaleString())}
                    </T>
                  </View>
                  <Badge tone={ex.ok ? 'g' : ex.refused ? 'a' : 'r'} sm>
                    {ex.ok
                      ? t('automate.runs.ok', { defaultValue: 'ok' })
                      : ex.refused
                        ? t('automate.runs.skipped', { defaultValue: 'skipped' })
                        : t('automate.runs.failed', { defaultValue: 'failed' })}
                  </Badge>
                </LRow>
              ))}
            </LGroup>
          )}
        </>
      ) : null}

      {/* ── Webhook tools (edit only) ───────────────────────────────────── */}
      {!isCreate && starter?.type === 'webhook' ? (
        <>
          <SectionLabel label={t('automate.webhook.section', { defaultValue: 'Webhook' })} style={{ marginTop: 28 }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <View style={{ flex: 1, minWidth: 220 }}>
              <T step="sm">{t('automate.webhook.urlTitle', { defaultValue: 'Secret URL' })}</T>
              <T step="12" tone="text3">
                {t('automate.webhook.urlHint', { defaultValue: 'Hidden after creation. Regenerating invalidates the old one immediately.' })}
              </T>
            </View>
            <Btn variant="sec" icon="arrows-clockwise" onPress={handleRegenerateUrl} disabled={submitting} testID="automation-regenerate">
              {t('automate.webhook.regenerate', { defaultValue: 'Regenerate URL' })}
            </Btn>
          </View>

          <FieldGroup>
            <FieldLabel>{t('automate.test.label', { defaultValue: 'Test payload' })}</FieldLabel>
            <Field
              area
              mono
              minHeight={96}
              value={testPayload}
              onChangeText={setTestPayload}
              editable={!testing}
              testID="automation-test-payload"
            />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
              <Btn variant="mint" icon="play" onPress={handleTest} loading={testing} testID="automation-send-test">
                {t('automate.test.send', { defaultValue: 'Send test' })}
              </Btn>
              {testResult ? (
                <T step="12" tone={testResult.ok ? 'text2' : 'danger'} style={{ flex: 1 }}>
                  {testResult.text}
                </T>
              ) : null}
            </View>
          </FieldGroup>

          <SectionLabel
            label={t('automate.webhook.calls', { defaultValue: 'Recent calls' })}
            count={calls.length}
            style={{ marginTop: 28 }}
          />
          {loadingCalls && calls.length === 0 ? (
            <T step="12" tone="text3">
              {t('common.loading', { defaultValue: 'Loading…' })}
            </T>
          ) : calls.length === 0 ? (
            <T step="12" tone="text3">
              {t('automate.webhook.noCalls', { defaultValue: 'No calls yet. Send a test or point an external system at the URL.' })}
            </T>
          ) : (
            <LGroup>
              {calls.map((call) => (
                <LRow key={call.callId}>
                  <Ph name={call.createdTask ? 'plus-circle' : 'arrow-bend-down-right'} size={14} color={c.text3} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T step="sm" ellipsis>
                      {new Date(call.createdAt).toLocaleString()}
                      <T step="sm" tone="text3">
                        {' · '}
                        {formatRelativeTime(call.createdAt, t)}
                      </T>
                    </T>
                    <T step="12" tone="text3" ellipsis>
                      {call.discriminator
                        ? t('automate.webhook.discriminator', { defaultValue: 'discriminator {{value}}', value: call.discriminator })
                        : t('automate.webhook.noDiscriminator', { defaultValue: 'no discriminator' })}
                    </T>
                  </View>
                  <Badge tone={call.createdTask ? 'g' : 'i'} sm>
                    {call.createdTask
                      ? t('automate.webhook.created', { defaultValue: 'created' })
                      : t('automate.webhook.updated', { defaultValue: 'updated' })}
                  </Badge>
                  {call.taskId ? (
                    <T step="codenote" tone="text3">
                      {call.taskId}
                    </T>
                  ) : null}
                </LRow>
              ))}
            </LGroup>
          )}
        </>
      ) : null}

      <View style={{ height: 24 }} />
    </Page>
  )
}
