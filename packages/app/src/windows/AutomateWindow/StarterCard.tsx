/**
 * StarterCard — one automation in the Automate grid.
 *
 * Design-system card (same vocabulary as the Launcher / Flows cards):
 *
 *   ┌ Tile(trigger) │ name                                  [Switch] ┐
 *   │               │ Badge(status) · Badge(trigger)                 │
 *   │  Ph(action) action label → target (channel target is a link)   │
 *   │  codenote: cron · timezone  /  event pattern                   │
 *   │  pulse  3.2/day · last 2h ago                [trash] [caret]   │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * The whole card opens the detail; the switch, the channel link and the
 * trash button stop the press from bubbling.
 */

import React from 'react'
import { describeScheduleCron } from '@teros/shared'
import { useTranslation } from 'react-i18next'
import { Platform, Pressable, View } from 'react-native'
import { useColors } from '../../components/mca/primitives/useColors'
import { Badge, Card, IconBtn, Ph, Switch, T, Tile } from '../../components/ui/ds'
import { formatRelativeTime } from './relative-time'
import { UNKNOWN_ACTION_META, UNKNOWN_TRIGGER_META, actionMeta, triggerMeta } from './starter-meta'
import type { AutomateStarter } from './types/automate'

export interface StarterCardProps {
  starter: AutomateStarter
  onOpen: (starterId: string) => void
  onToggle: (starterId: string, nextEnabled: boolean) => void
  onDelete: (starterId: string) => void
  /** Open the target channel in a chat window (channel-event actions only). */
  onOpenChannel?: (channelId: string) => void
}

/** Resolved target of the action, as shown under the action label. */
export function starterTarget(starter: AutomateStarter): string {
  const action = starter.action
  if (action.type === 'create-task') {
    const parts = [starter.projectName ?? action.projectId, starter.agentName ?? action.agentId]
    if (starter.columnName) parts.push(starter.columnName)
    return parts.join(' · ')
  }
  if (action.type === 'channel-event') {
    return starter.channelName ?? action.channelId
  }
  return [starter.flowName ?? action.flowId, starter.projectName ?? action.projectId].join(' · ')
}

/**
 * Trigger detail. Schedulers show the ALWAYS-ON human description (v1.4.4) —
 * "Runs: weekdays (Monday to Friday) at 09:00" — with the raw cron and
 * timezone as secondary info; the user never decodes "0 9 * * 1-5" alone.
 */
export function starterDetail(starter: AutomateStarter, locale: 'en' | 'es' = 'en'): string | null {
  const trigger = starter.trigger
  if (trigger.type === 'scheduler') {
    const human = describeScheduleCron(trigger.cronExpression, locale)
    const tz = trigger.timezone ? ` · ${trigger.timezone}` : ''
    return `${human} (${trigger.cronExpression})${tz}`
  }
  if (trigger.type === 'once') {
    const when = new Date(trigger.at)
    const label = Number.isNaN(when.getTime()) ? trigger.at : when.toLocaleString()
    return trigger.firedAt ? `${label} · fired` : label
  }
  if (trigger.type === 'event') return trigger.eventPattern
  return null
}

/**
 * True when the frontend knows both the trigger and the action type. Starters
 * with unknown types (legacy/malformed docs, e.g. in a prod DB) are hidden
 * from the list instead of rendered — a degraded card would offer toggles
 * and a delete on a shape we cannot interpret safely.
 */
export function knownStarter(starter: AutomateStarter): boolean {
  return triggerMeta(starter.type) !== UNKNOWN_TRIGGER_META && actionMeta(starter.action.type) !== UNKNOWN_ACTION_META
}

function stop(e: unknown): void {
  ;(e as { stopPropagation?: () => void } | undefined)?.stopPropagation?.()
}

export function StarterCard({ starter, onOpen, onToggle, onDelete, onOpenChannel }: StarterCardProps) {
  const { t, i18n } = useTranslation()
  const c = useColors()
  // Defensive lookups: an unknown type (legacy/malformed doc) must render a
  // degraded card, never crash the window (prod cloud bug, 2026-11-12).
  const trigger = triggerMeta(starter.type)
  const action = actionMeta(starter.action.type)
  const target = starterTarget(starter)
  const detail = starterDetail(starter, i18n.language?.startsWith('es') ? 'es' : 'en')
  const channelId = starter.action.type === 'channel-event' ? starter.action.channelId : undefined

  const avg = starter.avgDailyRuns7d ?? 0
  const lastAt =
    starter.lastExecutionAt ??
    (starter.trigger.type === 'scheduler'
      ? starter.trigger.lastExecutionAt
      : starter.trigger.type === 'webhook'
        ? starter.trigger.lastCallAt
        : undefined)
  const stats = [
    avg > 0
      ? t('automate.card.perDay', { defaultValue: '{{avg}}/day', avg: avg.toFixed(1) })
      : t('automate.card.noRuns', { defaultValue: 'no runs yet' }),
    lastAt
      ? t('automate.card.last', { defaultValue: 'last {{time}}', time: formatRelativeTime(lastAt, t) })
      : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Card
      pad
      hov
      accent
      onPress={() => onOpen(starter.starterId)}
      style={{ minHeight: 150, opacity: starter.enabled ? 1 : 0.72 }}
      testID={`starter-card-${starter.starterId}`}
    >
      {/* Header: tile + name/badges + switch */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <Tile sm icon={trigger.icon} tone={trigger.tone} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T step="base" ellipsis>
            {starter.name}
          </T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            <Badge tone={starter.enabled ? 'g' : 'muted'} dot sm>
              {starter.enabled
                ? t('automate.status.enabled', { defaultValue: 'Active' })
                : t('automate.status.disabled', { defaultValue: 'Disabled' })}
            </Badge>
            <Badge sm icon={trigger.icon}>
              {t(trigger.labelKey, { defaultValue: trigger.labelFallback })}
            </Badge>
          </View>
        </View>
        {/* The ds Switch has no event to stop; a thin pressable shell owns the press. */}
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: starter.enabled }}
          accessibilityLabel={
            starter.enabled
              ? t('automate.disable', { defaultValue: 'Disable' })
              : t('automate.enable', { defaultValue: 'Enable' })
          }
          onPress={(e) => {
            stop(e)
            onToggle(starter.starterId, !starter.enabled)
          }}
          testID={`starter-toggle-${starter.starterId}`}
          style={Platform.OS === 'web' ? ({ cursor: 'pointer' } as any) : undefined}
        >
          <View style={{ pointerEvents: 'none' }}>
            <Switch on={starter.enabled} size="sm" />
          </View>
        </Pressable>
      </View>

      {/* Action line */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12, minWidth: 0 }}>
        <Ph name={action.icon} size={13} color={c.text3} />
        <T step="12" tone="text2" numberOfLines={1} style={{ flexShrink: 0 }}>
          {t(action.labelKey, { defaultValue: action.labelFallback })}
        </T>
        <Ph name="arrow-right" size={11} color={c.text3} />
        {channelId && onOpenChannel ? (
          <Pressable
            onPress={(e) => {
              stop(e)
              onOpenChannel(channelId)
            }}
            accessibilityRole="link"
            accessibilityLabel={t('automate.card.openChannel', { defaultValue: 'Open channel' })}
            style={[
              { flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 1, minWidth: 0 },
              Platform.OS === 'web' ? ({ cursor: 'pointer' } as any) : null,
            ]}
          >
            <T step="12" tone="accent" ellipsis style={{ flexShrink: 1 }}>
              {target}
            </T>
            <Ph name="arrow-up-right" size={11} color={c.accent} />
          </Pressable>
        ) : (
          <T step="12" tone="text2" ellipsis style={{ flexShrink: 1 }}>
            {target}
          </T>
        )}
      </View>

      {/* Trigger detail (cron / pattern) */}
      {detail ? (
        <T step="code" tone="text3" ellipsis style={{ marginTop: 6 }}>
          {detail}
        </T>
      ) : null}

      <View style={{ flex: 1 }} />

      {/* Footer: stats + delete + caret */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 }}>
        <Ph name="pulse" size={11} color={c.text3} />
        <T step="codenote" tone="text3" ellipsis style={{ flex: 1 }}>
          {stats}
        </T>
        <IconBtn
          icon="trash"
          plain
          sm
          danger
          title={t('automate.delete', { defaultValue: 'Delete' })}
          accessibilityLabel={t('automate.delete', { defaultValue: 'Delete' })}
          testID={`starter-delete-${starter.starterId}`}
          onPress={(e: unknown) => {
            stop(e)
            onDelete(starter.starterId)
          }}
        />
        <Ph name="caret-right" size={12} color={c.text3} />
      </View>
    </Card>
  )
}
