/**
 * MCA Connection Manager — Board Runner Queries
 *
 * Handles runner self-management and agent/dependency actions:
 * move_my_task, complete_my_task, block_my_task, cancel_my_task,
 * add_my_progress_note, get_project, update_project, list_board_agents,
 * add_dependency, remove_dependency.
 */

import { enrichTaskWithColumn } from '../handlers/domains/board/_helpers';
import { buildAvatarUrl } from '../lib/avatar-url';
import type { QueryHandlerContext, ActiveConnection } from './mca-connection-manager.types';
import { guardReviewClaim, releaseReviewClaim } from './mca-connection-manager.review-claim-guard';
import {
  emitDependencyAdded,
  emitDependencyRemoved,
  emitTaskMoved,
  emitTaskProgressNote,
} from './board-event-emitters';

// The single-flight review claim guard (guardReviewClaim / releaseReviewClaim)
// lives in ./mca-connection-manager.review-claim-guard and is shared with the
// board-manager query handlers. See docs/specs/20261019_single-flight-review-claims.md.

export async function handleBoardRunnerAction(
  ctx: QueryHandlerContext,
  action: string,
  params: Record<string, unknown>,
  userId: string,
  effectiveAgentId: string | undefined,
  connection: ActiveConnection,
  appId?: string,
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
case 'move_my_task': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const mmtTaskId = params.taskId as string;
  const mmtAgentId = params.agentId as string;
  const mmtColumnId = params.columnId as string;
  const mmtPosition = params.position as number | undefined;
  if (!mmtTaskId || !mmtAgentId || !mmtColumnId) {
    throw new Error('taskId, agentId and columnId are required');
  }
  const mmtTask = await ctx.boardService.getTask(mmtTaskId);
  if (!mmtTask) {
    throw new Error('Task not found');
  }
  if (mmtTask.assignedAgentId !== mmtAgentId) {
    throw new Error('Agent is not assigned to this task');
  }

  // Single-flight guard: for review moves, exactly one session of this agent
  // proceeds; the rest skip without moving.
  const mmtClaimSkip = await guardReviewClaim(ctx, connection, 'move_my_task', mmtTaskId, mmtAgentId, params);
  if (mmtClaimSkip) {
    data = { task: mmtTask, ...mmtClaimSkip };
    break;
  }

  const mmtMoved = await ctx.boardService.moveTask(
    mmtTaskId,
    actor,
    mmtColumnId,
    mmtPosition,
  );
  if (!mmtMoved) {
    throw new Error('Task not found');
  }

  // The move is the review's terminal action → release the claim so the task
  // is claimable again (e.g. a later re-review).
  await releaseReviewClaim(ctx, connection, mmtTaskId, mmtAgentId, params);
  const mmtBoardEn = await ctx.boardService.getBoard(mmtMoved.boardId);
  data = { task: enrichTaskWithColumn(mmtMoved, mmtBoardEn) };
  ctx.pubSubService?.broadcastToTopic(`board:${mmtMoved.boardId}`, {
    type: 'board_task_updated',
    task: mmtMoved,
  });
  // Emit board.task_moved to subscribers (fb_d211b16343bd3034 — mirrors
  // handlers/domains/board/move-my-task.ts). mmtTask is the pre-move snapshot.
  if (ctx.boardSubscriptionService && mmtBoardEn) {
    const mmtFromCol = mmtBoardEn.columns.find((c: any) => c.columnId === mmtTask.columnId);
    const mmtToCol = mmtBoardEn.columns.find((c: any) => c.columnId === mmtColumnId);
    emitTaskMoved(
      ctx.boardSubscriptionService,
      mmtMoved,
      {
        fromColumnId: mmtTask.columnId,
        fromColumnName: mmtFromCol?.name,
        toColumnId: mmtColumnId,
        toColumnName: mmtToCol?.name,
      },
      { actorAgentId: mmtAgentId },
    );
  }

  // ──────────────────────────────────────────────────────────────
  // Workflow hook: if this task was created by a workflow execution
  // and is being moved to 'review' or 'done', notify the ActionBridge
  // to advance the workflow engine.
  // ──────────────────────────────────────────────────────────────
  if (ctx.actionBridgeManager && mmtMoved.workflowExecutionId && mmtBoardEn) {
    const mmtTargetCol = mmtBoardEn.columns.find((c: any) => c.columnId === mmtColumnId);
    const mmtTargetSlug = mmtTargetCol?.slug;
    if (mmtTargetSlug === 'review' || mmtTargetSlug === 'done') {
      try {
        const mmtProject = await ctx.boardService.getProject(mmtBoardEn.projectId);
        if (mmtProject) {
          const mmtResult = await ctx.actionBridgeManager.onTaskCompleted(mmtProject.projectId, {
            taskId: mmtMoved.taskId,
            status: mmtTargetSlug,
            workflowExecutionId: mmtMoved.workflowExecutionId,
            workflowNodeId: mmtMoved.workflowNodeId,
            outputData: mmtMoved.output?.data,
          });

          if (mmtResult.rejected) {
            // The bridge moved the task back. Re-fetch to get updated state.
            const rejectedTask = await ctx.boardService.getTask(mmtTaskId);
            if (rejectedTask) {
              const rejectedBoardEn = await ctx.boardService.getBoard(rejectedTask.boardId);
              data = { task: enrichTaskWithColumn(rejectedTask, rejectedBoardEn) };
            }
          }
        }
      } catch (err) {
        // Workflow hook failure must not break the move flow.
        console.error('[move_my_task MCA] Workflow advancement failed:', err);
      }
    }
  }
  break;
}




case 'complete_my_task': {
  if (!ctx.wsRouter) throw new Error('WsRouter not available');
  if (!ctx.wsRouter.has('board.complete-my-task')) throw new Error('board.complete-my-task handler not registered');
  const cmtResult = await ctx.dispatchToRouter(appId!, connection, 'board.complete-my-task', params) as { task?: any };
  // TER-264 S3: enrich task with columnName/columnSlug (dispatcher reenviaba
  // el resultado del handler tal cual; ahora mirror del resto del MCA path).
  if (cmtResult?.task && ctx.boardService) {
    const cmtBoardEn = await ctx.boardService.getBoard(cmtResult.task.boardId);
    data = { ...cmtResult, task: enrichTaskWithColumn(cmtResult.task, cmtBoardEn) };
  } else {
    data = cmtResult;
  }
  break;
}

case 'block_my_task': {
  if (!ctx.wsRouter) throw new Error('WsRouter not available');
  if (!ctx.wsRouter.has('board.block-my-task')) throw new Error('board.block-my-task handler not registered');
  const bmtResult = await ctx.dispatchToRouter(appId!, connection, 'board.block-my-task', params) as { task?: any };
  if (bmtResult?.task && ctx.boardService) {
    const bmtBoardEn = await ctx.boardService.getBoard(bmtResult.task.boardId);
    data = { ...bmtResult, task: enrichTaskWithColumn(bmtResult.task, bmtBoardEn) };
  } else {
    data = bmtResult;
  }
  break;
}

case 'cancel_my_task': {
  if (!ctx.wsRouter) throw new Error('WsRouter not available');
  if (!ctx.wsRouter.has('board.cancel-my-task')) throw new Error('board.cancel-my-task handler not registered');
  const cmtCancelResult = await ctx.dispatchToRouter(appId!, connection, 'board.cancel-my-task', params) as { task?: any };
  if (cmtCancelResult?.task && ctx.boardService) {
    const cmtCancelBoardEn = await ctx.boardService.getBoard(cmtCancelResult.task.boardId);
    data = { ...cmtCancelResult, task: enrichTaskWithColumn(cmtCancelResult.task, cmtCancelBoardEn) };
  } else {
    data = cmtCancelResult;
  }
  break;
}

case 'add_my_progress_note': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const ampnTaskId = params.taskId as string;
  const ampnAgentId = params.agentId as string;
  const ampnText = params.text as string;
  if (!ampnTaskId || !ampnAgentId || !ampnText) {
    throw new Error('taskId, agentId and text are required');
  }
  const ampnTask = await ctx.boardService.getTask(ampnTaskId);
  if (!ampnTask) {
    throw new Error('Task not found');
  }
  if (ampnTask.assignedAgentId !== ampnAgentId) {
    throw new Error('Agent is not assigned to this task');
  }

  // Single-flight guard: for review notes, exactly one session of this agent
  // posts; the rest skip without writing a duplicate note.
  const ampnClaimSkip = await guardReviewClaim(ctx, connection, 'add_my_progress_note', ampnTaskId, ampnAgentId, params);
  if (ampnClaimSkip) {
    data = { task: ampnTask, ...ampnClaimSkip };
    break;
  }

  const ampnNoteTask = await ctx.boardService.addProgressNote(ampnTaskId, ampnText, ampnAgentId);
  if (!ampnNoteTask) {
    throw new Error('Task not found');
  }
  // TER-264: enrich columnName/columnSlug for renderer
  const ampnBoard = await ctx.boardService.getBoard(ampnNoteTask.boardId);
  data = { task: enrichTaskWithColumn(ampnNoteTask, ampnBoard) };
  ctx.pubSubService?.broadcastToTopic(`board:${ampnNoteTask.boardId}`, {
    type: 'board_task_updated',
    task: ampnNoteTask,
  });
  // Emit board.task_progress_note to subscribers (fb_d211b16343bd3034 — THE
  // bug case: runner progress notes went through this inline path and never
  // emitted, so subscriptions with taskIds/eventTypes filters got zero wakes.
  // Mirrors handlers/domains/board/add-my-progress-note.ts).
  if (ctx.boardSubscriptionService) {
    emitTaskProgressNote(ctx.boardSubscriptionService, ampnNoteTask, ampnText, { actorAgentId: ampnAgentId });
  }
  break;
}

case 'get_project': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const gpProjectId = params.projectId as string;
  if (!gpProjectId) {
    throw new Error('projectId is required');
  }
  const gpProject = await ctx.boardService.getProject(gpProjectId);
  if (!gpProject) {
    throw new Error('Project not found');
  }
  const gpBoard = await ctx.boardService.getBoard(gpProject.boardId);
  data = { project: gpProject, board: gpBoard };
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
  break;
}

case 'list_board_agents': {
  const lbaWorkspaceId = params.workspaceId as string;
  if (!lbaWorkspaceId) {
    throw new Error('workspaceId is required');
  }
  const appsCollection = ctx.db.collection('apps');
  const accessCollection = ctx.db.collection('agent_app_access');
  const agentsCollection = ctx.db.collection('agents');
  const agentCoresCollection = ctx.db.collection('agent_cores');

  const boardApps = await appsCollection.find({
    ownerId: lbaWorkspaceId,
    ownerType: 'workspace',
    status: 'active',
    mcaId: { $in: ['mca.teros.board-manager', 'mca.teros.board-runner'] },
  }).toArray() as any[];

  if (boardApps.length === 0) {
    data = { workspaceId: lbaWorkspaceId, agents: [], count: 0 };
    break;
  }

  const boardManagerAppIds = boardApps.filter((a) => a.mcaId === 'mca.teros.board-manager').map((a) => a.appId);
  const boardRunnerAppIds = boardApps.filter((a) => a.mcaId === 'mca.teros.board-runner').map((a) => a.appId);
  const allBoardAppIds = boardApps.map((a) => a.appId);

  const accessRecords = await accessCollection.find({ appId: { $in: allBoardAppIds } }).toArray() as any[];
  if (accessRecords.length === 0) {
    data = { workspaceId: lbaWorkspaceId, agents: [], count: 0 };
    break;
  }

  const agentRoleMap = new Map<string, { hasManager: boolean; hasRunner: boolean }>();
  for (const record of accessRecords) {
    const current = agentRoleMap.get(record.agentId) ?? { hasManager: false, hasRunner: false };
    if (boardManagerAppIds.includes(record.appId)) current.hasManager = true;
    if (boardRunnerAppIds.includes(record.appId)) current.hasRunner = true;
    agentRoleMap.set(record.agentId, current);
  }

  const lbaAgentIds = Array.from(agentRoleMap.keys());
  const lbaAgents = await agentsCollection.find({ agentId: { $in: lbaAgentIds }, workspaceId: lbaWorkspaceId }).toArray() as any[];
  const cores = await agentCoresCollection.find({}).toArray() as any[];
  const coreMap = new Map(cores.map((c: any) => [c.coreId, c]));

  const lbaResult = lbaAgents.map((agent: any) => {
    const roles = agentRoleMap.get(agent.agentId) ?? { hasManager: false, hasRunner: false };
    let boardRole: 'manager' | 'runner' | 'both';
    if (roles.hasManager && roles.hasRunner) boardRole = 'both';
    else if (roles.hasManager) boardRole = 'manager';
    else boardRole = 'runner';
    const core = coreMap.get(agent.coreId) as any;
    const avatarFilename = agent.avatarUrl || core?.avatarUrl;
    return {
      agentId: agent.agentId,
      name: agent.name,
      fullName: agent.fullName,
      role: agent.role,
      avatarUrl: buildAvatarUrl(avatarFilename),
      boardRole,
    };
  });

  data = { workspaceId: lbaWorkspaceId, agents: lbaResult, count: lbaResult.length };
  break;
}

case 'add_dependency': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const adTaskId = params.taskId as string;
  const adDependsOnTaskId = params.dependsOnTaskId as string;
  if (!adTaskId || !adDependsOnTaskId) {
    throw new Error('taskId and dependsOnTaskId are required');
  }
  let adTask;
  try {
    adTask = await ctx.boardService.addDependency(adTaskId, adDependsOnTaskId, actor);
  } catch (err: any) {
    if (err.message?.startsWith('CIRCULAR_DEPENDENCY:')) {
      throw new Error(err.message);
    }
    throw err;
  }
  ctx.pubSubService?.broadcastToTopic(`board:${adTask.boardId}`, { type: 'board_task_updated', task: adTask });
  const adBoardEn = await ctx.boardService.getBoard(adTask.boardId);
  data = { task: enrichTaskWithColumn(adTask, adBoardEn) };
  // Emit board.dependency_added to subscribers (fb_d211b16343bd3034 — mirrors
  // handlers/domains/board/add-dependency.ts).
  if (ctx.boardSubscriptionService) {
    emitDependencyAdded(ctx.boardSubscriptionService, adTask, adDependsOnTaskId, { actorAgentId: actor });
  }
  break;
}

case 'remove_dependency': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const rdTaskId = params.taskId as string;
  const rdDependsOnTaskId = params.dependsOnTaskId as string;
  if (!rdTaskId || !rdDependsOnTaskId) {
    throw new Error('taskId and dependsOnTaskId are required');
  }
  const rdTask = await ctx.boardService.removeDependency(rdTaskId, rdDependsOnTaskId, actor);
  ctx.pubSubService?.broadcastToTopic(`board:${rdTask.boardId}`, { type: 'board_task_updated', task: rdTask });
  const rdBoardEn = await ctx.boardService.getBoard(rdTask.boardId);
  data = { task: enrichTaskWithColumn(rdTask, rdBoardEn) };
  // Emit board.dependency_removed to subscribers (fb_d211b16343bd3034 —
  // mirrors handlers/domains/board/remove-dependency.ts).
  if (ctx.boardSubscriptionService) {
    emitDependencyRemoved(ctx.boardSubscriptionService, rdTask, rdDependsOnTaskId, { actorAgentId: actor });
  }
  break;
}

// ==========================================================================
// Autoplay v2 + Board supervision (Fase 3)
//
// Estos 7 actions estaban declarados en BOARD_RUNNER_ACTIONS pero el switch
// no tenía sus case branches — caían al default y devolvían "Unknown action".
// Bug latente detectado en el smoke test de TER-264 (PR #46) que bloqueaba
// bloques 5-7 del test (set-agent-slots, set-agent-play, subscribe/
// unsubscribe-from-board, list-board-subscriptions, get-board-status,
// stop-task). Los handlers WS subyacentes sí existen en
// `handlers/domains/board/` — este patch los conecta vía dispatchToRouter.
// ==========================================================================

case 'set_agent_slots': {
  if (!ctx.wsRouter) throw new Error('WsRouter not available');
  if (!ctx.wsRouter.has('board.set-agent-slots'))
    throw new Error('board.set-agent-slots handler not registered');
  data = await ctx.dispatchToRouter(appId!, connection, 'board.set-agent-slots', params);
  break;
}

case 'set_agent_play': {
  if (!ctx.wsRouter) throw new Error('WsRouter not available');
  if (!ctx.wsRouter.has('board.set-agent-play'))
    throw new Error('board.set-agent-play handler not registered');
  data = await ctx.dispatchToRouter(appId!, connection, 'board.set-agent-play', params);
  break;
}

case 'subscribe_to_board': {
  if (!ctx.wsRouter) throw new Error('WsRouter not available');
  if (!ctx.wsRouter.has('board.subscribe-to-board'))
    throw new Error('board.subscribe-to-board handler not registered');
  data = await ctx.dispatchToRouter(appId!, connection, 'board.subscribe-to-board', params);
  break;
}

case 'unsubscribe_from_board': {
  if (!ctx.wsRouter) throw new Error('WsRouter not available');
  if (!ctx.wsRouter.has('board.unsubscribe-from-board'))
    throw new Error('board.unsubscribe-from-board handler not registered');
  data = await ctx.dispatchToRouter(appId!, connection, 'board.unsubscribe-from-board', params);
  break;
}

case 'list_board_subscriptions': {
  if (!ctx.wsRouter) throw new Error('WsRouter not available');
  if (!ctx.wsRouter.has('board.list-board-subscriptions'))
    throw new Error('board.list-board-subscriptions handler not registered');
  data = await ctx.dispatchToRouter(appId!, connection, 'board.list-board-subscriptions', params);
  break;
}

case 'get_board_status': {
  if (!ctx.wsRouter) throw new Error('WsRouter not available');
  if (!ctx.wsRouter.has('board.get-board-status'))
    throw new Error('board.get-board-status handler not registered');
  data = await ctx.dispatchToRouter(appId!, connection, 'board.get-board-status', params);
  break;
}

case 'stop_task': {
  if (!ctx.wsRouter) throw new Error('WsRouter not available');
  if (!ctx.wsRouter.has('board.stop-task'))
    throw new Error('board.stop-task handler not registered');
  data = await ctx.dispatchToRouter(appId!, connection, 'board.stop-task', params);
  break;
}

// ==========================================================================
// Generic MCA Event Subscriptions
//
// Routes subscribe_to_events / unsubscribe_from_events / list_event_subscriptions
// to the WS router handlers registered by registerSubscriptionsDomain.
// ==========================================================================

case 'subscribe_to_events': {
  if (!ctx.wsRouter) throw new Error('WsRouter not available');
  if (!ctx.wsRouter.has('mca.subscribe-to-events'))
    throw new Error('mca.subscribe-to-events handler not registered');
  data = await ctx.dispatchToRouter(appId!, connection, 'mca.subscribe-to-events', params);
  break;
}

case 'unsubscribe_from_events': {
  if (!ctx.wsRouter) throw new Error('WsRouter not available');
  if (!ctx.wsRouter.has('mca.unsubscribe-from-events'))
    throw new Error('mca.unsubscribe-from-events handler not registered');
  data = await ctx.dispatchToRouter(appId!, connection, 'mca.unsubscribe-from-events', params);
  break;
}

case 'list_event_subscriptions': {
  if (!ctx.wsRouter) throw new Error('WsRouter not available');
  if (!ctx.wsRouter.has('mca.list-event-subscriptions'))
    throw new Error('mca.list-event-subscriptions handler not registered');
  data = await ctx.dispatchToRouter(appId!, connection, 'mca.list-event-subscriptions', params);
  break;
}

default:
  throw new Error(`Unknown action: ${action}`);
  }

  return data;
}
