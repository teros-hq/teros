/**
 * starter-meta — visual identity per trigger / action type.
 *
 * One table for the card, the filter chips, the detail tabs and the launcher
 * sections so every surface agrees: Phosphor icon name, `Tile` tone and the
 * i18n key of the label. Tones are the design-system ones (accent / mint /
 * amber / pink) — never a per-type palette.
 */

import type { TileTone } from '../../components/ui/ds'
import type { ActionType, StarterType } from './types/automate'

export interface StarterTypeMeta {
  /** Phosphor icon name (kebab-case). */
  icon: string
  tone: TileTone
  labelKey: string
  labelFallback: string
}

export const TRIGGER_ORDER: StarterType[] = ['scheduler', 'once', 'webhook', 'event']
export const ACTION_ORDER: ActionType[] = ['create-task', 'channel-event', 'start-flow']

export const TRIGGER_META: Record<StarterType, StarterTypeMeta> = {
  scheduler: {
    icon: 'clock-countdown',
    tone: 'accent',
    labelKey: 'automate.type.scheduler',
    labelFallback: 'Schedule',
  },
  once: {
    icon: 'alarm',
    tone: 'pink',
    labelKey: 'automate.type.once',
    labelFallback: 'Reminder',
  },
  webhook: {
    icon: 'webhooks-logo',
    tone: 'mint',
    labelKey: 'automate.type.webhook',
    labelFallback: 'Webhook',
  },
  event: {
    icon: 'lightning',
    tone: 'amber',
    labelKey: 'automate.type.event',
    labelFallback: 'Event',
  },
}

/** Section headings of the grid when grouped by trigger. */
export const TRIGGER_SECTION: Record<StarterType, { key: string; fallback: string }> = {
  scheduler: { key: 'automate.section.scheduler', fallback: 'Scheduled' },
  once: { key: 'automate.section.once', fallback: 'Reminders' },
  webhook: { key: 'automate.section.webhook', fallback: 'Webhooks' },
  event: { key: 'automate.section.event', fallback: 'Events' },
}

export const ACTION_META: Record<ActionType, StarterTypeMeta> = {
  'create-task': {
    icon: 'kanban',
    tone: 'accent',
    labelKey: 'automate.action.createTask',
    labelFallback: 'Create task',
  },
  'channel-event': {
    icon: 'chat-circle',
    tone: 'accent',
    labelKey: 'automate.action.channelEvent',
    labelFallback: 'Message a channel',
  },
  'start-flow': {
    icon: 'flow-arrow',
    tone: 'accent',
    labelKey: 'automate.action.startFlow',
    labelFallback: 'Start flow',
  },
}

// ===========================================================================
// Unknown-type fallbacks (defensive)
// ===========================================================================

/**
 * Meta for trigger/action types the frontend does not know (legacy or
 * malformed docs in a prod DB). Looking up an unknown type MUST NOT return
 * undefined — that crashed the whole Automate window in prod cloud
 * (TypeError: reading 'icon' at StarterCard). Cards render degraded with
 * this generic meta instead of taking the window down.
 */
export const UNKNOWN_TRIGGER_META: StarterTypeMeta = {
  icon: 'lightning',
  tone: 'muted',
  labelKey: 'automate.type.unknown',
  labelFallback: 'Automation',
}

export const UNKNOWN_ACTION_META: StarterTypeMeta = {
  icon: 'lightning',
  tone: 'muted',
  labelKey: 'automate.action.unknown',
  labelFallback: 'Action',
}

/** Safe lookup: never returns undefined, even for a type outside the union. */
export function triggerMeta(type: string): StarterTypeMeta {
  return TRIGGER_META[type as StarterType] ?? UNKNOWN_TRIGGER_META
}

/** Safe lookup: never returns undefined, even for a type outside the union. */
export function actionMeta(type: string): StarterTypeMeta {
  return ACTION_META[type as ActionType] ?? UNKNOWN_ACTION_META
}
