/**
 * MCA Connection Manager — Board Start Task Query
 *
 * Handles the start_task action, which is complex enough to warrant its own module:
 * creates a conversation, sends the task description, and links it to the task.
 */

import { buildTaskInitialMessage } from './board-service';
import { enrichTaskWithColumn } from '../handlers/domains/board/_helpers';
import type { QueryHandlerContext, ActiveConnection } from './mca-connection-manager.types';

export async function handleBoardStartAction(
  ctx: QueryHandlerContext,
  action: string,
  params: Record<string, unknown>,
  userId: string,
  effectiveAgentId: string | undefined,
  connection: ActiveConnection,
): Promise<unknown> {
  let data: unknown;

  switch (action) {
case 'start_task': {
  if (!ctx.boardService || !ctx.channelManager) {
    throw new Error('BoardService or ChannelManager not available');
  }
  const stTaskId = params.taskId as string;
  const stAgentId = params.agentId as string | undefined;
  const stPrompt = params.prompt as string | undefined;
  if (!stTaskId) {
    throw new Error('taskId is required');
  }
  const { task: startedTask } = await ctx.boardService.startTask(
    stTaskId,
    userId,
    stAgentId,
  );
  const assignedAgentId = startedTask.assignedAgentId!;

  // Reuse existing conversation or create a new one
  let channel: any;
  if (startedTask.channelId) {
    channel = await ctx.channelManager.getChannel(startedTask.channelId);
  }
  if (!channel) {
    // Workspace always comes from the project — resolve it from the board (ENGINEERING-PRINCIPLES.md)
    // Never rely on connection.currentWorkspaceId which is not set for HTTP-based MCAs.
    const taskProject = await ctx.db.collection('projects').findOne({ boardId: startedTask.boardId } as any);
    if (!taskProject) {
      throw new Error(
        `[McaConnectionManager.start_task] Project not found for boardId "${startedTask.boardId}". Cannot resolve workspaceId.`
      );
    }
    const taskWorkspaceId = (taskProject as any).workspaceId as string | undefined;
    if (!taskWorkspaceId) {
      throw new Error(
        `[McaConnectionManager.start_task] Project for boardId "${startedTask.boardId}" has no workspaceId. Cannot create task channel.`
      );
    }
    channel = await ctx.channelManager.createChannel(userId, assignedAgentId, {
      name: startedTask.title,
    }, { workspaceId: taskWorkspaceId });
    await ctx.boardService.linkConversation(startedTask.taskId, userId, channel.channelId);
  }

  // Save origin channel (the channel that called start_task) for event notifications.
  // Prefer the explicit callerChannelId param (safe for parallel calls) over the shared
  // connection.currentChannelId (which suffers from a race condition when N parallel
  // start_task calls share the same MCA connection object).
  const callerChannelId = (params.callerChannelId as string | undefined) ?? connection.currentChannelId;
  if (callerChannelId) {
    await ctx.boardService.setOriginChannel(startedTask.taskId, callerChannelId);
  }

  const startedFullTask = { ...startedTask, channelId: channel.channelId, originChannelId: callerChannelId };
  // TER-264: enrich columnName/columnSlug so renderer paints the post-start column
  const stBoardEn = await ctx.boardService.getBoard(startedTask.boardId);
  data = {
    task: enrichTaskWithColumn(startedFullTask, stBoardEn),
    channelId: channel.channelId,
  };
  ctx.pubSubService?.broadcastToTopic(`board:${startedTask.boardId}`, {
    type: 'board_task_updated',
    task: startedFullTask,
  });

  // Build and send initial message to the agent (fire-and-forget)
  const initialMessage = buildTaskInitialMessage(startedTask, stPrompt);

  try {
    // Save the initial message
    const msgId = ctx.channelManager.createMessageId();
    const msgTimestamp = new Date().toISOString();
    const sender = (await ctx.channelManager.getUserSender(userId)) || undefined;

    await ctx.channelManager.saveMessage({
      messageId: msgId,
      channelId: channel.channelId,
      role: 'user' as const,
      userId,
      sender,
      content: { type: 'text' as const, text: initialMessage },
      timestamp: msgTimestamp,
    });

    // Emit event so MessageHandler processes the agent response
    ctx.emit('mca:send_message', {
      channelId: channel.channelId,
      agentId: assignedAgentId,
      message: initialMessage,
    });
  } catch (err: any) {
    console.error(`❌ Error sending initial task message to ${channel.channelId}:`, err);
  }

  break;
  }
  }

  return data;
}
