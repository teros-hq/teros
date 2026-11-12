/**
 * MCA Connection Manager — Board Write Queries
 *
 * Handles board write/modify actions:
 * link_conversation, delete_task, archive_task, add_progress_note.
 */

import { enrichTaskWithColumn } from '../handlers/domains/board/_helpers';
import type { QueryHandlerContext, ActiveConnection } from './mca-connection-manager.types';
import { guardReviewClaim } from './mca-connection-manager.review-claim-guard';
import {
  emitTaskArchived,
  emitTaskProgressNote,
  emitTaskUpdated,
} from './board-event-emitters';

export async function handleBoardWriteAction(
  ctx: QueryHandlerContext,
  action: string,
  params: Record<string, unknown>,
  userId: string,
  effectiveAgentId: string | undefined,
  connection: ActiveConnection,
): Promise<unknown> {
  // MCA query handlers are only called by agents, never humans.
  // effectiveAgentId must always be present. If it isn't, the calling MCA
  // tool failed to pass agentId in its queryConversations params — throw
  // so the bug surfaces immediately instead of silently storing null.
  if (!effectiveAgentId) {
    throw new Error(
      `Cannot determine agent for board action "${action}". ` +
      `The MCA tool must pass agentId in its queryConversations params.`
    );
  }
  const actor = effectiveAgentId;
  let data: unknown;

  switch (action) {
case 'link_conversation': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const lcTaskId = params.taskId as string;
  const lcChannelId = params.channelId as string;
  if (!lcTaskId || !lcChannelId) {
    throw new Error('taskId and channelId are required');
  }
  const linkedTask = await ctx.boardService.linkConversation(
    lcTaskId,
    actor,
    lcChannelId,
  );
  if (!linkedTask) {
    throw new Error('Task not found');
  }
  const lcBoardEn = await ctx.boardService.getBoard(linkedTask.boardId);
  data = { task: enrichTaskWithColumn(linkedTask, lcBoardEn) };
  ctx.pubSubService?.broadcastToTopic(`board:${linkedTask.boardId}`, {
    type: 'board_task_updated',
    task: linkedTask,
  });
  // Emit board.task_updated to subscribers (fb_d211b16343bd3034 — linking a
  // conversation is a task mutation; task_updated is the closest domain event).
  if (ctx.boardSubscriptionService) {
    emitTaskUpdated(ctx.boardSubscriptionService, linkedTask, { actorAgentId: actor });
  }
  break;
}

case 'delete_task': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const dtTaskId = params.taskId as string;
  if (!dtTaskId) {
    throw new Error('taskId is required');
  }
  // Get task before deleting for broadcast
  const dtTask = await ctx.boardService.getTask(dtTaskId);
  const deleted = await ctx.boardService.deleteTask(dtTaskId);
  if (!deleted) {
    throw new Error('Task not found');
  }
  data = { taskId: dtTaskId, deleted: true };
  if (dtTask) {
    ctx.pubSubService?.broadcastToTopic(`board:${dtTask.boardId}`, {
      type: 'board_task_deleted',
      taskId: dtTaskId,
    });
  }
  break;
}

case 'archive_task': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const atTaskId = params.taskId as string;
  const atArchived = params.archived as boolean;
  const atArchiveNote = params.archiveNote as string | undefined;
  const atActor = params.actor as string || actor;
  if (!atTaskId || atArchived === undefined) {
    throw new Error('taskId and archived are required');
  }
  const archiveResult = atArchived
    ? await ctx.boardService.archiveTask(atTaskId, atActor, atArchiveNote)
    : await ctx.boardService.unarchiveTask(atTaskId, atActor);
  if (!archiveResult) {
    throw new Error('Task not found');
  }
  const arBoardEn = await ctx.boardService.getBoard(archiveResult.boardId);
  data = { task: enrichTaskWithColumn(archiveResult, arBoardEn) };
  ctx.pubSubService?.broadcastToTopic(`board:${archiveResult.boardId}`, {
    type: 'board_task_updated',
    task: archiveResult,
  });
  // Emit board.task_archived to subscribers (fb_d211b16343bd3034 — mirrors
  // handlers/domains/board/archive-task.ts).
  if (ctx.boardSubscriptionService) {
    emitTaskArchived(ctx.boardSubscriptionService, archiveResult, atArchived, { actorAgentId: atActor });
  }
  break;
}

case 'archive_project': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const apProjectId = params.projectId as string;
  const apArchiveNote = params.archiveNote as string | undefined;
  const apActor = params.actor as string || actor;
  if (!apProjectId) {
    throw new Error('projectId is required');
  }
  const archivedProject = await ctx.boardService.archiveProject(apProjectId, apActor, apArchiveNote);
  if (!archivedProject) {
    throw new Error('Project not found');
  }
  data = { project: archivedProject };
  ctx.pubSubService?.broadcastToTopic(`board:${archivedProject.boardId}`, {
    type: 'board_project_archived',
    project: archivedProject,
  });
  break;
}

case 'add_progress_note': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const apnTaskId = params.taskId as string;
  const apnText = params.text as string;
  const apnActor = params.actor as string || actor;
  if (!apnTaskId || !apnText) {
    throw new Error('taskId and text are required');
  }
  // Single-flight review claim: a review note is guarded (not terminal → no
  // release here; the claim is released by the move that follows, or by TTL).
  const apnClaimSkip = await guardReviewClaim(ctx, connection, 'add_progress_note', apnTaskId, apnActor, params);
  if (apnClaimSkip) {
    data = apnClaimSkip;
    break;
  }
  const noteTask = await ctx.boardService.addProgressNote(apnTaskId, apnText, apnActor);
  if (!noteTask) {
    throw new Error('Task not found');
  }
  const apnBoardEn = await ctx.boardService.getBoard(noteTask.boardId);
  data = { task: enrichTaskWithColumn(noteTask, apnBoardEn) };
  ctx.pubSubService?.broadcastToTopic(`board:${noteTask.boardId}`, {
    type: 'board_task_updated',
    task: noteTask,
  });
  // Emit board.task_progress_note to subscribers (fb_d211b16343bd3034 —
  // mirrors handlers/domains/board/add-progress-note.ts). MCA callers are
  // agents, so the actor is attributed as agent (self-wake guard).
  if (ctx.boardSubscriptionService) {
    emitTaskProgressNote(ctx.boardSubscriptionService, noteTask, apnText, { actorAgentId: apnActor });
  }
  break;
}

case 'delete_project': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const dpProjectId = params.projectId as string;
  if (!dpProjectId) {
    throw new Error('projectId is required');
  }
  // Verify project exists
  const dpProject = await ctx.boardService.getProject(dpProjectId);
  if (!dpProject) {
    throw new Error('Project not found');
  }
  // Only admin/owner can delete — verify via workspaceService
  if (!ctx.workspaceService) {
    throw new Error('WorkspaceService not available');
  }
  const dpRole = await ctx.workspaceService.getUserRole(dpProject.workspaceId, userId);
  if (dpRole !== 'owner' && dpRole !== 'admin') {
    throw new Error('Only workspace admin or owner can delete projects');
  }
  await ctx.boardService.deleteProject(dpProjectId, userId);
  data = { projectId: dpProjectId, deleted: true };
  ctx.pubSubService?.broadcastToTopic(`board:${dpProject.boardId}`, {
    type: 'board_project_deleted',
    projectId: dpProjectId,
  });
  break;
}

case 'update_board_config': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const ubcProjectId = params.projectId as string;
  const ubcConfig = params.config as Record<string, unknown>;
  if (!ubcProjectId || !ubcConfig) {
    throw new Error('projectId and config are required');
  }
  const ubcProject = await ctx.boardService.getProject(ubcProjectId);
  if (!ubcProject) {
    throw new Error('Project not found');
  }
  // Verify write access
  if (!ctx.workspaceService) {
    throw new Error('WorkspaceService not available');
  }
  const ubcRole = await ctx.workspaceService.getUserRole(ubcProject.workspaceId, userId);
  if (ubcRole !== 'owner' && ubcRole !== 'admin' && ubcRole !== 'write') {
    throw new Error('No write access to workspace');
  }
  const ubcBoard = await ctx.boardService.updateBoardConfig(ubcProject.boardId, ubcConfig);
  if (!ubcBoard) {
    throw new Error('Board not found');
  }
  data = { projectId: ubcProjectId, config: ubcBoard.config };
  ctx.pubSubService?.broadcastToTopic(`board:${ubcProject.boardId}`, {
    type: 'board_config_updated',
    projectId: ubcProjectId,
    config: ubcBoard.config,
  });
  break;
}


case 'update_project': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const upProjectId = params.projectId as string;
  if (!upProjectId) {
    throw new Error('projectId is required');
  }
  const upProject = await ctx.boardService.updateProject(upProjectId, {
    name: params.name as string | undefined,
    description: params.description as string | undefined,
    context: params.context as string | undefined,
  });
  if (!upProject) {
    throw new Error('Project not found');
  }
  data = { project: upProject };
  ctx.pubSubService?.broadcastToTopic(`board:${upProject.boardId}`, {
    type: 'board_project_updated',
    project: upProject,
  });
  break;
}

  }

  return data;
}
