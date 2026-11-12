import '../../i18n' // side-effect: initializes i18n (en-US) so t() returns real strings
import { fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithTamagui } from '../../test/renderWithTamagui'
import { StarterCard, knownStarter, starterDetail, starterTarget } from './StarterCard'
import { WebhookUrlDialog } from './WebhookUrlDialog'
import { UNKNOWN_ACTION_META, UNKNOWN_TRIGGER_META } from './starter-meta'
import {
  DEFAULT_STARTER_FILTERS,
  filterStarters,
  hasActiveFilters,
  type AutomateStarter,
} from './types/automate'

const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()

const scheduler: AutomateStarter = {
  starterId: 'starter_scheduler_1',
  name: 'Daily standup reminder',
  type: 'scheduler',
  enabled: true,
  workspaceId: 'ws_1',
  createdBy: 'user_1',
  createdAt: '2026-06-29T09:00:00.000Z',
  trigger: { type: 'scheduler', cronExpression: '0 9 * * 1-5', timezone: 'Europe/Madrid', totalExecutions: 12 },
  action: { type: 'create-task', projectId: 'proj_1', agentId: 'agent_1', targetColumnId: 'col_todo', titleTemplate: 'Issue {{payload.title}}', instructionsTemplate: 'Triage it' },
  projectName: 'Teros Platform',
  agentName: 'Nira',
  columnName: 'To Do',
  avgDailyRuns7d: 3.2,
  lastExecutionAt: twoHoursAgo,
}

const webhook: AutomateStarter = {
  starterId: 'starter_webhook_1',
  name: 'GitHub issues → tasks',
  type: 'webhook',
  enabled: true,
  workspaceId: 'ws_1',
  createdBy: 'user_1',
  createdAt: '2026-06-29T09:00:00.000Z',
  trigger: { type: 'webhook', callCount: 42, lastCallAt: fiveMinutesAgo },
  action: { type: 'create-task', projectId: 'proj_1', agentId: 'agent_2', targetColumnId: 'col_todo', titleTemplate: 'Issue {{payload.title}}', instructionsTemplate: 'Triage it' },
  projectName: 'Teros Platform',
  agentName: 'Nua',
  columnName: 'To Do',
  avgDailyRuns7d: 1.7,
  lastExecutionAt: fiveMinutesAgo,
}

const event: AutomateStarter = {
  starterId: 'starter_event_1',
  name: 'Task moved to review → notify',
  type: 'event',
  enabled: false,
  workspaceId: 'ws_1',
  createdBy: 'user_1',
  createdAt: '2026-06-29T09:00:00.000Z',
  trigger: { type: 'event', eventPattern: 'board.task_*', filters: [{ toStatus: 'review' }] },
  action: { type: 'channel-event', channelId: 'ch_1', agentId: 'agent_1', eventTemplate: 'Moved' },
  channelName: 'Alerts',
  agentName: 'Nira',
  avgDailyRuns7d: 0,
}

const flow: AutomateStarter = {
  starterId: 'starter_flow_1',
  name: 'Issue → flow',
  type: 'webhook',
  enabled: true,
  workspaceId: 'ws_1',
  createdBy: 'user_1',
  createdAt: '2026-06-29T09:00:00.000Z',
  trigger: { type: 'webhook', callCount: 0 },
  action: { type: 'start-flow', flowId: 'flow_1', projectId: 'proj_1', inputMapping: { issueNumber: 'payload.number' } },
  flowName: 'Triage flow',
  projectName: 'Teros Platform',
  avgDailyRuns7d: 0,
}

function renderCard(starter: AutomateStarter, props: Partial<Parameters<typeof StarterCard>[0]> = {}) {
  return renderWithTamagui(
    <StarterCard starter={starter} onOpen={() => {}} onToggle={() => {}} onDelete={() => {}} onOpenChannel={() => {}} {...props} />,
  )
}

describe('StarterCard', () => {
  it('renders name, status, trigger badge, action label and resolved target', () => {
    const { getByText } = renderCard(scheduler)
    expect(getByText('Daily standup reminder')).toBeTruthy()
    expect(getByText('Active')).toBeTruthy()
    expect(getByText('Schedule')).toBeTruthy()
    expect(getByText('Create task')).toBeTruthy()
    expect(getByText('Teros Platform · Nira · To Do')).toBeTruthy()
    // v1.4.4: human description first, cron + timezone secondary — the user
    // never decodes "0 9 * * 1-5" alone.
    expect(getByText('Runs: weekdays (Monday to Friday) at 09:00 (0 9 * * 1-5) · Europe/Madrid')).toBeTruthy()
  })

  it('shows the 7-day stat and relative last run', () => {
    const { getByText } = renderCard(scheduler)
    expect(getByText('3.2/day · last 2h ago')).toBeTruthy()
  })

  it('shows "no runs yet" and Disabled for an idle, disabled starter', () => {
    const { getByText } = renderCard(event)
    expect(getByText('Disabled')).toBeTruthy()
    expect(getByText('no runs yet')).toBeTruthy()
    expect(getByText('board.task_*')).toBeTruthy()
  })

  it('opens the detail when the card body is pressed', () => {
    const onOpen = vi.fn()
    const { getByText } = renderCard(scheduler, { onOpen })
    fireEvent.click(getByText('Daily standup reminder'))
    expect(onOpen).toHaveBeenCalledWith('starter_scheduler_1')
  })

  it('toggles from the switch without opening the detail', () => {
    const onOpen = vi.fn()
    const onToggle = vi.fn()
    const { getByTestId } = renderCard(scheduler, { onOpen, onToggle })
    fireEvent.click(getByTestId('starter-toggle-starter_scheduler_1'))
    expect(onToggle).toHaveBeenCalledWith('starter_scheduler_1', false)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('deletes from the footer without opening the detail', () => {
    const onOpen = vi.fn()
    const onDelete = vi.fn()
    const { getByTestId } = renderCard(webhook, { onOpen, onDelete })
    fireEvent.click(getByTestId('starter-delete-starter_webhook_1'))
    expect(onDelete).toHaveBeenCalledWith('starter_webhook_1')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('renders a channel target as a link that opens the channel', () => {
    const onOpen = vi.fn()
    const onOpenChannel = vi.fn()
    const { getByText } = renderCard(event, { onOpen, onOpenChannel })
    fireEvent.click(getByText('Alerts'))
    expect(onOpenChannel).toHaveBeenCalledWith('ch_1')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('resolves targets and details per action/trigger kind', () => {
    expect(starterTarget(flow)).toBe('Triage flow · Teros Platform')
    expect(starterTarget(event)).toBe('Alerts')
    expect(starterDetail(webhook)).toBeNull()
    expect(starterDetail(event)).toBe('board.task_*')
  })

  // Regression (prod cloud, 2026-11-12): a starter with a type outside the
  // union (legacy/malformed doc) made TRIGGER_META[type] undefined and the
  // whole Automate window crashed with "Cannot read properties of undefined
  // (reading 'icon')". It must render the degraded fallback instead.
  const legacyCron: AutomateStarter = {
    ...scheduler,
    starterId: 'starter_legacy_1',
    name: 'Legacy cron import',
    // Deliberately outside the StarterType union (legacy/malformed doc).
    type: 'legacy-cron',
    trigger: { type: 'scheduler', cronExpression: '0 3 * * *' },
  } as unknown as AutomateStarter

  it('does NOT throw for an unknown trigger type and renders the fallback meta', () => {
    let q: ReturnType<typeof renderCard> | undefined
    expect(() => {
      q = renderCard(legacyCron)
    }).not.toThrow()
    const { getByText } = q!
    expect(getByText('Legacy cron import')).toBeTruthy()
    expect(getByText('Automation')).toBeTruthy()
  })

  it('does NOT throw for an unknown action type and renders the fallback meta', () => {
    const legacyAction = {
      ...scheduler,
      starterId: 'starter_legacy_2',
      name: 'Legacy action',
      action: { type: 'legacy-notify' } as unknown as AutomateStarter['action'],
    }
    let q: ReturnType<typeof renderCard> | undefined
    expect(() => {
      q = renderCard(legacyAction)
    }).not.toThrow()
    const { getByText } = q!
    expect(getByText('Action')).toBeTruthy()
  })

  it('exposes unknown metas and flags unknown starters via knownStarter', () => {
    expect(UNKNOWN_TRIGGER_META.icon).toBe('lightning')
    expect(UNKNOWN_TRIGGER_META.tone).toBe('muted')
    expect(UNKNOWN_TRIGGER_META.labelFallback).toBe('Automation')
    expect(UNKNOWN_ACTION_META.labelFallback).toBe('Action')
    expect(knownStarter(scheduler)).toBe(true)
    expect(knownStarter(legacyCron)).toBe(false)
  })
})

describe('filterStarters', () => {
  const all = [scheduler, webhook, event, flow]

  it('is a no-op with default filters', () => {
    expect(hasActiveFilters(DEFAULT_STARTER_FILTERS)).toBe(false)
    expect(filterStarters(all, DEFAULT_STARTER_FILTERS)).toHaveLength(4)
  })

  it('filters by trigger, action and status', () => {
    expect(filterStarters(all, { ...DEFAULT_STARTER_FILTERS, trigger: 'webhook' }).map((s) => s.starterId)).toEqual([
      'starter_webhook_1',
      'starter_flow_1',
    ])
    expect(filterStarters(all, { ...DEFAULT_STARTER_FILTERS, action: 'channel-event' })).toHaveLength(1)
    expect(filterStarters(all, { ...DEFAULT_STARTER_FILTERS, status: 'disabled' })[0].starterId).toBe('starter_event_1')
  })

  it('searches names, targets and raw trigger detail, accent-insensitively', () => {
    expect(filterStarters(all, { ...DEFAULT_STARTER_FILTERS, search: 'github' })).toHaveLength(1)
    expect(filterStarters(all, { ...DEFAULT_STARTER_FILTERS, search: 'NIRA' })).toHaveLength(2)
    expect(filterStarters(all, { ...DEFAULT_STARTER_FILTERS, search: 'board.task' })).toHaveLength(1)
    expect(filterStarters(all, { ...DEFAULT_STARTER_FILTERS, search: 'tríage' })).toHaveLength(1)
  })
})

describe('WebhookUrlDialog', () => {
  it('renders nothing without a URL', () => {
    const { queryByTestId } = renderWithTamagui(<WebhookUrlDialog url={null} onClose={() => {}} />)
    expect(queryByTestId('webhook-url-dialog')).toBeNull()
  })

  it('shows the URL and the one-time warning once there is one', () => {
    const { getByText } = renderWithTamagui(
      <WebhookUrlDialog url="https://teros.test/api/v1/webhooks/abc" onClose={() => {}} />,
    )
    expect(getByText('https://teros.test/api/v1/webhooks/abc')).toBeTruthy()
    expect(getByText(/shown only once/)).toBeTruthy()
  })

  it('closes from Done', () => {
    const onClose = vi.fn()
    const { getByTestId } = renderWithTamagui(<WebhookUrlDialog url="https://x/y" onClose={onClose} />)
    fireEvent.click(getByTestId('webhook-url-done'))
    expect(onClose).toHaveBeenCalled()
  })
})
