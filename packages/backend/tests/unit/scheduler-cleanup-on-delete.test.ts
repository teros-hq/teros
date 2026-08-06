/**
 * Scheduler task cleanup on channel/agent delete (TER-650/G7).
 *
 * A recurring task / reminder must not outlive its channel or agent — otherwise
 * the scheduler keeps firing it (failing ownership) until the failure cap. These
 * tests pin that deleting a channel (or an agent) removes its scheduler tasks.
 */

import { describe, expect, it } from 'bun:test'
import { ChannelManager } from '../../src/services/channel-manager'
import { createDeleteAgentHandler } from '../../src/handlers/domains/agent/delete'

function recordingDb() {
  const deleteManyCalls: Array<{ col: string; filter: any }> = []
  const store: Record<string, any[]> = {}
  const db = {
    collection: (name: string) => ({
      deleteMany: async (filter: any) => {
        deleteManyCalls.push({ col: name, filter })
        return { deletedCount: 1 }
      },
      deleteOne: async () => ({ deletedCount: 1 }),
      findOne: async (f: any) => (store[name] ?? []).find((d) => shallowMatch(d, f)) ?? null,
      find: (f: any) => ({
        project: () => ({ toArray: async () => (store[name] ?? []).filter((d) => shallowMatch(d, f)) }),
        toArray: async () => (store[name] ?? []).filter((d) => shallowMatch(d, f)),
      }),
    }),
  } as any
  return { db, deleteManyCalls, store }
}

function shallowMatch(doc: any, filter: any): boolean {
  return Object.entries(filter ?? {}).every(([k, v]) => doc[k] === v)
}

describe('deleteChannelCompletely — scheduler cleanup (G7)', () => {
  it('deletes recurring tasks + reminders for the channel', async () => {
    const { db, deleteManyCalls } = recordingDb()
    const cm = new ChannelManager(db, {} as any)
    await cm.deleteChannelCompletely('ch_1' as any)
    const scheduler = deleteManyCalls.filter((c) => c.col.startsWith('scheduler_'))
    expect(scheduler.map((c) => c.col).sort()).toEqual([
      'scheduler_recurring_tasks',
      'scheduler_reminders',
    ])
    // Scoped to THIS channel.
    for (const c of scheduler) expect(c.filter).toEqual({ channel_id: 'ch_1' })
  })
})

describe('agent.delete — scheduler cleanup (G7)', () => {
  it("deletes scheduler tasks for the agent's channels", async () => {
    const { db, deleteManyCalls, store } = recordingDb()
    store.agents = [{ agentId: 'agent_1', ownerId: 'user_1', workspaceId: 'work_1' }]
    store.channels = [
      { agentId: 'agent_1', channelId: 'ch_a' },
      { agentId: 'agent_1', channelId: 'ch_b' },
    ]
    const handler = createDeleteAgentHandler(db, null)
    await handler({ userId: 'user_1' } as any, { agentId: 'agent_1' })
    const scheduler = deleteManyCalls.filter((c) => c.col.startsWith('scheduler_'))
    expect(scheduler.map((c) => c.col).sort()).toEqual([
      'scheduler_recurring_tasks',
      'scheduler_reminders',
    ])
    // Scoped to the agent's two channels.
    for (const c of scheduler) expect(c.filter).toEqual({ channel_id: { $in: ['ch_a', 'ch_b'] } })
  })

  it('no scheduler delete when the agent has no channels', async () => {
    const { db, deleteManyCalls, store } = recordingDb()
    store.agents = [{ agentId: 'agent_1', ownerId: 'user_1' }]
    store.channels = []
    const handler = createDeleteAgentHandler(db, null)
    await handler({ userId: 'user_1' } as any, { agentId: 'agent_1' })
    expect(deleteManyCalls.filter((c) => c.col.startsWith('scheduler_'))).toEqual([])
  })
})
