/**
 * board.get-my-task (WS handler) and the MCA `get_my_task` query must check
 * access to the channel, not only the client-supplied agentId.
 *
 * Before the fix both paths only compared task.assignedAgentId with the
 * agentId the caller sent: anyone who knew another user's task channelId and
 * the assigned agent's id read the full task (title, description,
 * instructions, progress notes). board.get-task-by-channel already had the
 * channel check (SEC-2 M5); get-my-task was its unfixed twin.
 *
 * The channel-access fake mirrors ChannelManager.canAccessChannel, including
 * its "agentId is the channel's agent" shortcut. No real MongoDB.
 */

import { describe, expect, it, mock } from 'bun:test'
import type { WsHandlerContext } from '@teros/shared'
import { createGetMyTaskHandler } from '../../src/handlers/domains/board/get-my-task'
import { handleBoardReadAction } from '../../src/services/mca-connection-manager.queries-board-read'

const ATTACKER = 'user_b'
const VICTIM = 'user_a'
const VICTIM_CHANNEL = 'ch_task_a'
const VICTIM_AGENT = 'agent_runner_a'
const ATTACKER_AGENT = 'agent_runner_b'

const channels: Record<string, { userId: string; agentId: string }> = {
  [VICTIM_CHANNEL]: { userId: VICTIM, agentId: VICTIM_AGENT },
}

const victimTask = {
  taskId: 'task_a',
  boardId: 'board_a',
  channelId: VICTIM_CHANNEL,
  assignedAgentId: VICTIM_AGENT,
  title: 'Secret roadmap',
  columnId: 'col_doing',
}

function ctx(userId: string): WsHandlerContext {
  return { userId, sessionId: 's', ip: '127.0.0.1' }
}

function fakes() {
  const boardService = {
    getTaskByChannel: mock(async (channelId: string) => (channelId === VICTIM_CHANNEL ? victimTask : null)),
    getBoard: mock(async (boardId: string) => ({ boardId, projectId: 'proj_a', columns: [] })),
    getProject: mock(async (projectId: string) => ({ projectId, name: 'A project' })),
  }
  const channelManager = {
    canAccessChannel: mock(async (channelId: string, userId: string, agentId?: string) => {
      const ch = channels[channelId]
      if (!ch) return false
      return ch.userId === userId || (agentId !== undefined && ch.agentId === agentId)
    }),
  }
  return { boardService, channelManager }
}

describe('board.get-my-task (WS handler) channel authz', () => {
  it("rejects reading another user's task even with its channelId and agentId", async () => {
    const f = fakes()
    const handler = createGetMyTaskHandler(f.boardService as any, f.channelManager as any)

    await expect(
      handler(ctx(ATTACKER), { channelId: VICTIM_CHANNEL, agentId: VICTIM_AGENT }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(f.boardService.getTaskByChannel).not.toHaveBeenCalled()
  })

  it('returns the task to the channel owner', async () => {
    const f = fakes()
    const handler = createGetMyTaskHandler(f.boardService as any, f.channelManager as any)

    const res = (await handler(ctx(VICTIM), { channelId: VICTIM_CHANNEL, agentId: VICTIM_AGENT })) as any
    expect(res.task).toMatchObject({ taskId: 'task_a', title: 'Secret roadmap' })
  })
})

describe('MCA get_my_task channel authz', () => {
  const connection = {} as any

  it("rejects another tenant's agent reading the victim's task with a forged agentId param", async () => {
    const f = fakes()
    const qctx = { boardService: f.boardService, channelManager: f.channelManager } as any

    // The MCA connection belongs to the attacker: userId is the attacker and
    // the server-resolved agent is the attacker's runner. Only the params lie.
    await expect(
      handleBoardReadAction(
        qctx, 'get_my_task', { channelId: VICTIM_CHANNEL, agentId: VICTIM_AGENT }, ATTACKER, ATTACKER_AGENT, connection,
      ),
    ).rejects.toThrow('Access denied')
    expect(f.boardService.getTaskByChannel).not.toHaveBeenCalled()
  })

  it("returns the task to the runner of that channel (server-resolved agent)", async () => {
    const f = fakes()
    const qctx = { boardService: f.boardService, channelManager: f.channelManager } as any

    // Workspace-owned MCA: userId is the workspace owner, not the channel owner;
    // the runner is let through by being the channel's agent.
    const res = (await handleBoardReadAction(
      qctx, 'get_my_task', { channelId: VICTIM_CHANNEL, agentId: VICTIM_AGENT }, 'user_ws_owner', VICTIM_AGENT, connection,
    )) as any
    expect(res.task).toMatchObject({ taskId: 'task_a' })
  })
})
