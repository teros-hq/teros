/**
 * Board progress resets the autoplay stuck counter (TER-650/G2).
 *
 * The auto-wake cap only bites tasks that DON'T advance. Real progress — a
 * column move or a progress note — must reset `autoWakeCount` to 0, so a task
 * that is making progress is never auto-blocked. These pin that the reset lives
 * in the progress mutations (and NOT in the per-turn `running` toggle).
 */

import { describe, expect, it } from 'bun:test'
import { BoardService } from '../../src/services/board-service'

function fakeDb(captured: { updates: any[] }, board?: any) {
  return {
    collection: (name: string) => ({
      findOne: async (f: any) => {
        if (name === 'boards') return board ?? null
        if (name === 'tasks') return { taskId: f.taskId, boardId: 'board_1', columnId: 'c_a', position: 0 }
        return null
      },
      find: () => ({
        sort: () => ({ limit: () => ({ toArray: async () => [] }), toArray: async () => [] }),
        limit: () => ({ toArray: async () => [] }),
        toArray: async () => [],
      }),
      updateMany: async () => ({ modifiedCount: 0 }),
      findOneAndUpdate: async (f: any, u: any) => {
        captured.updates.push({ filter: f, update: u })
        return { taskId: f.taskId }
      },
    }),
  } as any
}

describe('BoardService — autoWakeCount reset on progress (G2)', () => {
  it('addProgressNote resetea autoWakeCount a 0', async () => {
    const captured = { updates: [] as any[] }
    const svc = new BoardService(fakeDb(captured))
    await svc.addProgressNote('t1', 'made progress', 'agent_1')
    expect(captured.updates[0].update.$set.autoWakeCount).toBe(0)
  })

  it('moveTask resetea autoWakeCount a 0', async () => {
    const captured = { updates: [] as any[] }
    const board = { boardId: 'board_1', columns: [{ columnId: 'c_a', slug: 'todo' }, { columnId: 'c_b', slug: 'review' }] }
    const svc = new BoardService(fakeDb(captured, board))
    await svc.moveTask('t1', 'agent_1', 'c_b')
    expect(captured.updates[0].update.$set.autoWakeCount).toBe(0)
  })
})
