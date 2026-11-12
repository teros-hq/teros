/**
 * board.subscribe-to-board / unsubscribe-from-board / list-board-subscriptions
 * must check access to the target channel, not only to the board.
 *
 * Before the fix, subscribe-to-board only checked the caller's role on the
 * board's workspace and then subscribed whatever channelId the client sent:
 * user B could subscribe user A's conversation to B's own board, and every
 * task B wrote was delivered into A's conversation (waking A's agent with A's
 * tools). unsubscribe-from-board and list-board-subscriptions checked nothing.
 *
 * The channel-access fake mirrors ChannelManager.canAccessChannel, including
 * its "agentId is the channel's agent" shortcut, so a handler that forwarded
 * the client-supplied agentId would be caught by the forged-agentId case.
 * No real MongoDB.
 */

import { describe, expect, it, mock } from 'bun:test'
import type { WsHandlerContext } from '@teros/shared'
import { createListBoardSubscriptionsHandler } from '../../src/handlers/domains/board/list-board-subscriptions'
import { createSubscribeToBoardHandler } from '../../src/handlers/domains/board/subscribe-to-board'
import { createUnsubscribeFromBoardHandler } from '../../src/handlers/domains/board/unsubscribe-from-board'

const ATTACKER = 'user_b'
const VICTIM = 'user_a'
const VICTIM_CHANNEL = 'ch_victim'
const VICTIM_AGENT = 'agent_victim'
const ATTACKER_CHANNEL = 'ch_attacker'
const ATTACKER_AGENT = 'agent_attacker'
const ATTACKER_BOARD = 'board_b'

const channels: Record<string, { userId: string; agentId: string }> = {
  [VICTIM_CHANNEL]: { userId: VICTIM, agentId: VICTIM_AGENT },
  [ATTACKER_CHANNEL]: { userId: ATTACKER, agentId: ATTACKER_AGENT },
}

function ctx(userId: string): WsHandlerContext {
  return { userId, sessionId: 's', ip: '127.0.0.1' }
}

function deps() {
  const boardService = {
    getBoard: mock(async (boardId: string) => (boardId === ATTACKER_BOARD ? { boardId, projectId: 'proj_b' } : null)),
    getProject: mock(async (projectId: string) => ({ projectId, workspaceId: 'work_b', name: 'B board' })),
  }
  // The attacker is a member of their own board's workspace.
  const workspaceService = {
    getUserRole: mock(async (_ws: string, userId: string) => (userId === ATTACKER ? 'owner' : null)),
  }
  const boardSubscriptionService = {
    // dev's handler uses subscribeWithStatus (fb_d211b16343bd3034 upsert surfacing)
    subscribeWithStatus: mock(async (boardId: string, channelId: string, agentId: string, filter: unknown) => ({
      subscription: { subscriptionId: 'bsub_1', boardId, channelId, agentId, filter }, created: true,
    })),
    unsubscribe: mock(async () => true),
    listByChannel: mock(async (channelId: string) => [
      { subscriptionId: 'bsub_1', boardId: ATTACKER_BOARD, channelId, filter: {}, createdAt: 'now' },
    ]),
  }
  const channelManager = {
    canAccessChannel: mock(async (channelId: string, userId: string, agentId?: string) => {
      const ch = channels[channelId]
      if (!ch) return false
      return ch.userId === userId || (agentId !== undefined && ch.agentId === agentId)
    }),
  }
  return { boardService, workspaceService, boardSubscriptionService, channelManager }
}

describe('board.subscribe-to-board channel authz', () => {
  it("rejects subscribing another user's conversation to the caller's board", async () => {
    const d = deps()
    const handler = createSubscribeToBoardHandler(
      d.boardService as any, d.workspaceService as any, d.boardSubscriptionService as any, d.channelManager as any,
    )

    await expect(
      handler(ctx(ATTACKER), { boardId: ATTACKER_BOARD, channelId: VICTIM_CHANNEL }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'No access to this channel' })
    expect(d.boardSubscriptionService.subscribeWithStatus).not.toHaveBeenCalled()
  })

  it("does not trust a client-supplied agentId (the victim channel's agent)", async () => {
    const d = deps()
    const handler = createSubscribeToBoardHandler(
      d.boardService as any, d.workspaceService as any, d.boardSubscriptionService as any, d.channelManager as any,
    )

    await expect(
      handler(ctx(ATTACKER), { boardId: ATTACKER_BOARD, channelId: VICTIM_CHANNEL, agentId: VICTIM_AGENT }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(d.boardSubscriptionService.subscribeWithStatus).not.toHaveBeenCalled()
  })

  it("subscribes the caller's own conversation", async () => {
    const d = deps()
    const handler = createSubscribeToBoardHandler(
      d.boardService as any, d.workspaceService as any, d.boardSubscriptionService as any, d.channelManager as any,
    )

    const res = await handler(ctx(ATTACKER), { boardId: ATTACKER_BOARD, channelId: ATTACKER_CHANNEL, agentId: ATTACKER_AGENT })
    expect(res).toMatchObject({ subscriptionId: 'bsub_1', boardId: ATTACKER_BOARD })
    expect(d.boardSubscriptionService.subscribeWithStatus).toHaveBeenCalledWith(ATTACKER_BOARD, ATTACKER_CHANNEL, ATTACKER_AGENT, {})
  })
})

describe('board.unsubscribe-from-board channel authz', () => {
  it("rejects removing another conversation's subscription", async () => {
    const d = deps()
    const handler = createUnsubscribeFromBoardHandler(d.boardSubscriptionService as any, d.channelManager as any)

    await expect(
      handler(ctx(ATTACKER), { boardId: ATTACKER_BOARD, channelId: VICTIM_CHANNEL }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'No access to this channel' })
    expect(d.boardSubscriptionService.unsubscribe).not.toHaveBeenCalled()
  })

  it("removes the caller's own subscription", async () => {
    const d = deps()
    const handler = createUnsubscribeFromBoardHandler(d.boardSubscriptionService as any, d.channelManager as any)

    await handler(ctx(ATTACKER), { boardId: ATTACKER_BOARD, channelId: ATTACKER_CHANNEL })
    expect(d.boardSubscriptionService.unsubscribe).toHaveBeenCalledWith(ATTACKER_BOARD, ATTACKER_CHANNEL)
  })
})

describe('board.list-board-subscriptions channel authz', () => {
  it("rejects listing another conversation's subscriptions", async () => {
    const d = deps()
    const handler = createListBoardSubscriptionsHandler(
      d.boardService as any, d.boardSubscriptionService as any, d.channelManager as any,
    )

    await expect(handler(ctx(ATTACKER), { channelId: VICTIM_CHANNEL })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'No access to this channel',
    })
    expect(d.boardSubscriptionService.listByChannel).not.toHaveBeenCalled()
  })

  it("lists the caller's own conversation", async () => {
    const d = deps()
    const handler = createListBoardSubscriptionsHandler(
      d.boardService as any, d.boardSubscriptionService as any, d.channelManager as any,
    )

    const res = (await handler(ctx(ATTACKER), { channelId: ATTACKER_CHANNEL })) as { subscriptions: unknown[] }
    expect(res.subscriptions).toHaveLength(1)
  })
})
