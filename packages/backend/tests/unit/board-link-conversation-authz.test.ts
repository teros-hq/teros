/**
 * board.link-conversation authorizes the channel, not just the task.
 *
 * The handler checked write access on the task's workspace and then linked ANY
 * client-supplied channelId and set it to scope 'shared' (REQ-3 auto-share).
 * In a multi-user workspace, member B could link member A's personal
 * conversation to one of B's tasks: it became shared, and canAccessChannel let
 * every member read it. A conversation from another workspace could be linked
 * (and shared there) the same way.
 *
 * Services are stubs; every denial asserts nothing was linked or re-scoped.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { WsHandlerContext } from '@teros/shared';
import { createLinkConversationHandler } from '../../src/handlers/domains/board/link-conversation';

const A = 'user_a';
const B = 'user_b';

const CHANNELS: Record<string, any> = {
  ch_a_personal: { channelId: 'ch_a_personal', userId: A, workspaceId: 'work_1', scope: 'personal' },
  ch_a_shared: { channelId: 'ch_a_shared', userId: A, workspaceId: 'work_1', scope: 'shared' },
  ch_b_personal: { channelId: 'ch_b_personal', userId: B, workspaceId: 'work_1', scope: 'personal' },
  ch_b_other_ws: { channelId: 'ch_b_other_ws', userId: B, workspaceId: 'work_2', scope: 'personal' },
  ch_b_global: { channelId: 'ch_b_global', userId: B, scope: 'personal' },
};

function makeHandler() {
  const boardService = {
    getTask: mock(async () => ({ taskId: 'task_1', boardId: 'board_1' })),
    getBoard: mock(async () => ({ boardId: 'board_1', projectId: 'proj_1' })),
    getProject: mock(async () => ({ projectId: 'proj_1', workspaceId: 'work_1' })),
    linkConversation: mock(async () => ({ taskId: 'task_1', boardId: 'board_1' })),
  } as any;
  const workspaceService = { getUserRole: mock(async () => 'write') } as any;
  const pubSubService = { broadcastToTopic: mock(() => {}) } as any;
  const channelManager = {
    getChannel: mock(async (id: string) => CHANNELS[id] ?? null),
    // Multi-user workspace rule: own channels, or shared ones of a workspace the caller is in
    canAccessChannel: mock(async (id: string, userId: string) => {
      const ch = CHANNELS[id];
      if (!ch) return false;
      if (ch.userId === userId) return true;
      return ch.workspaceId === 'work_1' && ch.scope === 'shared';
    }),
    setChannelScope: mock(async () => {}),
  } as any;
  const handler = createLinkConversationHandler(boardService, workspaceService, pubSubService, channelManager);
  return { handler, boardService, channelManager };
}

const ctx = (userId: string): WsHandlerContext => ({ userId, sessionId: 's', connectionId: 'c' }) as any;

describe('board.link-conversation channel authz', () => {
  it("B cannot link (and thereby share) A's personal conversation", async () => {
    const { handler, boardService, channelManager } = makeHandler();
    await expect(handler(ctx(B), { taskId: 'task_1', channelId: 'ch_a_personal' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(boardService.linkConversation).not.toHaveBeenCalled();
    expect(channelManager.setChannelScope).not.toHaveBeenCalled();
  });

  it('B cannot link a conversation of another workspace, nor an unknown one', async () => {
    const { handler, boardService, channelManager } = makeHandler();
    await expect(handler(ctx(B), { taskId: 'task_1', channelId: 'ch_b_other_ws' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(handler(ctx(B), { taskId: 'task_1', channelId: 'ch_nope' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(boardService.linkConversation).not.toHaveBeenCalled();
    expect(channelManager.setChannelScope).not.toHaveBeenCalled();
  });

  it('B links their own personal conversation, which becomes shared', async () => {
    const { handler, boardService, channelManager } = makeHandler();
    await handler(ctx(B), { taskId: 'task_1', channelId: 'ch_b_personal' });
    expect(boardService.linkConversation).toHaveBeenCalledWith('task_1', B, 'ch_b_personal');
    expect(channelManager.setChannelScope).toHaveBeenCalledWith('ch_b_personal', 'shared');
  });

  it('B links an already shared conversation of the workspace, and their own workspace-less one', async () => {
    const { handler, boardService } = makeHandler();
    await handler(ctx(B), { taskId: 'task_1', channelId: 'ch_a_shared' });
    await handler(ctx(B), { taskId: 'task_1', channelId: 'ch_b_global' });
    expect(boardService.linkConversation).toHaveBeenCalledTimes(2);
  });
});
