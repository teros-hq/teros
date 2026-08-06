import { describe, expect, it } from 'bun:test'
import { mapEventTypeToTriggerKind } from '../../src/handlers/event-handler'
import type { ScheduledEvent } from '../../src/handlers/event-handler'
import type { AgentUsageTriggerKind } from '../../src/types/database'

// TER-650: scheduled/injected events must record their true origin instead of
// masquerading as `user_message` in agent-usage sessions. The mapping is a total
// Record over ScheduledEvent['eventType'] — adding a type without a mapping
// fails the build. This test pins the expected triggerKind for EVERY event type,
// so a wrong/changed mapping (a meaning-change bug) turns red.
describe('mapEventTypeToTriggerKind', () => {
  // The complete, pinned expectation. `undefined` = keep caller default (user_message).
  const EXPECTED: Record<ScheduledEvent['eventType'], AgentUsageTriggerKind | undefined> = {
    reminder: 'scheduled',
    recurring_task: 'scheduled',
    system_resume: undefined,
    task_update: 'event_subscription',
    channel_started: 'event_subscription',
    channel_finished: 'event_subscription',
    channel_permission: 'event_subscription',
    channel_resolved: 'event_subscription',
    'task.moved_to_review': 'event_subscription',
    'task.blocked': 'event_subscription',
    'task.auto_wakes_exhausted': 'event_subscription',
    'task.started': 'event_subscription',
    'task.state_changed': 'event_subscription',
    'task.progress_note_added': 'event_subscription',
    'task.dependency_cancelled': 'event_subscription',
  }

  it('maps every event type to its pinned triggerKind', () => {
    for (const [eventType, expected] of Object.entries(EXPECTED) as Array<
      [ScheduledEvent['eventType'], AgentUsageTriggerKind | undefined]
    >) {
      expect(mapEventTypeToTriggerKind(eventType)).toBe(expected)
    }
  })

  it('maps scheduler events to "scheduled"', () => {
    expect(mapEventTypeToTriggerKind('reminder')).toBe('scheduled')
    expect(mapEventTypeToTriggerKind('recurring_task')).toBe('scheduled')
  })

  it('maps board/channel subscription wakeups to "event_subscription"', () => {
    expect(mapEventTypeToTriggerKind('task_update')).toBe('event_subscription')
    expect(mapEventTypeToTriggerKind('channel_permission')).toBe('event_subscription')
    expect(mapEventTypeToTriggerKind('task.dependency_cancelled')).toBe('event_subscription')
  })

  it('leaves system_resume undefined so it keeps the caller default (user turn replay)', () => {
    expect(mapEventTypeToTriggerKind('system_resume')).toBeUndefined()
  })
})
