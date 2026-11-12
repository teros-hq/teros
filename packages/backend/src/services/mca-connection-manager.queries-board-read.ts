/**
 * MCA Connection Manager — Board Read/Create Queries
 *
 * Handles board read and simple creation actions:
 * get_my_task, get_tasks_by_agent, get_board_summary, list_tasks, get_task,
 * list_projects, create_project, create_task, batch_create_tasks, update_task,
 * move_task, assign_task.
 */

import { buildTaskInitialMessage } from './board-service';
import {
  computeProjectStats,
  enrichTaskWithColumn,
  enrichTasksAcrossBoards,
  enrichTasksWithColumns,
} from '../handlers/domains/board/_helpers';
import type { QueryHandlerContext, ActiveConnection } from './mca-connection-manager.types';
import { guardReviewClaim, releaseReviewClaim } from './mca-connection-manager.review-claim-guard';
import {
  emitTaskAssigned,
  emitTaskCreated,
  emitTaskMoved,
  emitTaskUpdated,
} from './board-event-emitters';

export async function handleBoardReadAction(
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
// BOARD / TASK QUERIES
// ==================================================================

case 'get_my_task': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const gmtChannelId = params.channelId as string;
  const gmtAgentId = params.agentId as string;
  if (!gmtChannelId || !gmtAgentId) {
    throw new Error('channelId and agentId are required');
  }
  // params.agentId comes from the MCA: gate on the channel with the
  // server-resolved agent, like get_channel_messages.
  if (!(await ctx.channelManager!.canAccessChannel(gmtChannelId, userId, effectiveAgentId))) {
    throw new Error('Access denied');
  }
  const myTask = await ctx.boardService.getTaskByChannel(gmtChannelId);
  if (myTask && myTask.assignedAgentId !== gmtAgentId) {
    throw new Error('This task is not assigned to you');
  }
  // TER-264: enrich with columnName/columnSlug/projectName for renderer
  if (myTask) {
    const gmtBoard = await ctx.boardService.getBoard(myTask.boardId);
    const gmtProject = gmtBoard ? await ctx.boardService.getProject(gmtBoard.projectId) : null;
    const enrichedMyTask = enrichTaskWithColumn(myTask, gmtBoard);
    data = {
      channelId: gmtChannelId,
      task: {
        ...enrichedMyTask,
        ...(gmtProject ? { projectId: gmtProject.projectId, projectName: gmtProject.name } : {}),
      },
    };
  } else {
    data = { channelId: gmtChannelId, task: null };
  }
  break;
}

case 'get_tasks_by_agent': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const workspaceId = params.workspaceId as string;
  const agentId = params.agentId as string;
  if (!workspaceId || !agentId) {
    throw new Error('workspaceId and agentId are required');
  }
  const agentTags = params.tags as string[] | undefined;
  const tasks = await ctx.boardService.getTasksByAgent(workspaceId, agentId, agentTags);
  // TER-264: enrich across boards with columnName/columnSlug/projectName
  const enrichedAgentTasks = await enrichTasksAcrossBoards(tasks, ctx.boardService);
  data = { agentId, tasks: enrichedAgentTasks };
  break;
}

case 'get_board_summary': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const gbsProjectId = params.projectId as string;
  if (!gbsProjectId) {
    throw new Error('projectId is required');
  }
  const gbsProject = await ctx.boardService.getProject(gbsProjectId);
  if (!gbsProject) {
    throw new Error('Project not found');
  }
  const summary = await ctx.boardService.getBoardSummary(gbsProject.boardId);
  if (!summary) {
    throw new Error('Board not found');
  }
  data = summary;
  break;
}

case 'list_tasks': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const ltProjectId = params.projectId as string;
  if (!ltProjectId) {
    throw new Error('projectId is required');
  }
  const project = await ctx.boardService.getProject(ltProjectId);
  if (!project) {
    throw new Error('Project not found');
  }
  const { projectId: _pid, ...filters } = params;
  const filteredTasks = await ctx.boardService.listTasks(project.boardId, filters as any);
  // TER-264: enrich with columnName/columnSlug + resolve agent names/avatars +
  // attach assigneeName/assigneeAvatarUrl on each task so the MCA renderer does
  // not need to cross-reference the agents map client-side.
  const ltBoard = await ctx.boardService.getBoard(project.boardId);
  const ltEnriched = enrichTasksWithColumns(filteredTasks, ltBoard);
  const ltAgentIds = ctx.boardService.collectAgentIds(filteredTasks);
  const ltAgents = await ctx.boardService.resolveAgents(ltAgentIds);
  const ltTasksWithAssignee = ltEnriched.map((t: any) => {
    if (!t.assignedAgentId) return t;
    const resolvedAgent = (ltAgents as Record<string, any>)[t.assignedAgentId];
    if (!resolvedAgent) return t;
    return {
      ...t,
      ...(resolvedAgent.fullName || resolvedAgent.name
        ? { assigneeName: resolvedAgent.fullName ?? resolvedAgent.name }
        : {}),
      ...(resolvedAgent.avatarUrl ? { assigneeAvatarUrl: resolvedAgent.avatarUrl } : {}), // resuelto por resolveAgents
    };
  });
  data = {
    projectId: ltProjectId,
    projectName: project.name,
    tasks: ltTasksWithAssignee,
    agents: ltAgents,
  };
  break;
}

case 'get_task': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const taskId = params.taskId as string;
  if (!taskId) {
    throw new Error('taskId is required');
  }
  const task = await ctx.boardService.getTask(taskId);
  if (!task) {
    throw new Error('Task not found');
  }
  const allTasks = await ctx.boardService.listTasks(task.boardId, {});
  const subTasks = allTasks.filter((t: any) => t.parentTaskId === taskId);
  // TER-264: enrich with columnName/columnSlug + parentTaskTitle +
  // projectName + resolved agents so the renderer pinta everything inline.
  const gtBoard = await ctx.boardService.getBoard(task.boardId);
  const gtProject = gtBoard ? await ctx.boardService.getProject(gtBoard.projectId) : null;
  let gtParentTaskTitle: string | undefined;
  if (task.parentTaskId) {
    const parent = allTasks.find((t: any) => t.taskId === task.parentTaskId);
    gtParentTaskTitle = parent?.title;
  }
  const gtEnrichedTask = enrichTaskWithColumn(task, gtBoard);
  const gtEnrichedSubTasks = enrichTasksWithColumns(subTasks, gtBoard);
  const gtAgentIds = ctx.boardService.collectAgentIds([task, ...subTasks]);
  const gtAgents = await ctx.boardService.resolveAgents(gtAgentIds);
  data = {
    task: {
      ...gtEnrichedTask,
      ...(gtParentTaskTitle ? { parentTaskTitle: gtParentTaskTitle } : {}),
      ...(gtProject ? { projectId: gtProject.projectId, projectName: gtProject.name } : {}),
    },
    subTasks: gtEnrichedSubTasks,
    agents: gtAgents,
  };
  break;
}

case 'list_projects': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const lpWorkspaceId = params.workspaceId as string;
  if (!lpWorkspaceId) {
    throw new Error('workspaceId is required');
  }
  const lpIncludeArchived = params.includeArchived as boolean | undefined;
  const projects = await ctx.boardService.listProjects(lpWorkspaceId, lpIncludeArchived);
  // TER-264: attach taskCount + activeAgentCount per project for renderer chips.
  const lpEnrichedProjects = await computeProjectStats(projects, ctx.boardService);
  data = { workspaceId: lpWorkspaceId, projects: lpEnrichedProjects };
  break;
}

case 'create_project': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const cpWorkspaceId = params.workspaceId as string;
  const cpName = params.name as string;
  const cpDescription = params.description as string | undefined;
  if (!cpWorkspaceId || !cpName) {
    throw new Error('workspaceId and name are required');
  }
  // Validate workspaceId format before hitting the DB
  if (!cpWorkspaceId.startsWith('work_') && !cpWorkspaceId.startsWith('ws_')) {
    throw new Error(`Invalid workspaceId: "${cpWorkspaceId}". Must be a valid workspace ID (format: work_<id> or ws_<id>).`);
  }
  // Verify workspace exists and user has write access
  if (!ctx.workspaceService) {
    throw new Error('WorkspaceService not available');
  }
  const cpRole = await ctx.workspaceService.getUserRole(cpWorkspaceId, userId);
  if (cpRole !== 'owner' && cpRole !== 'admin' && cpRole !== 'write') {
    throw new Error(`No write access to workspace "${cpWorkspaceId}". Use list-projects to find your workspaces.`);
  }
  const { project: newProject, board: newBoard } = await ctx.boardService.createProject(
    cpWorkspaceId,
    actor,
    { name: cpName, description: cpDescription },
  );
  data = { project: newProject, board: newBoard };
  // Broadcast project.created so connected clients' navbars update in realtime
  // (the agent-driven path otherwise emits no event, unlike create_task above).
  // broadcastToWorkspace is async (unlike the sync broadcastToTopic used by
  // create_task); catch the floating promise so a transient failure does not
  // surface as an unhandled rejection.
  ctx.pubSubService
    ?.broadcastToWorkspace(cpWorkspaceId, {
      type: 'project.created',
      project: newProject,
      board: newBoard,
    })
    .catch((err) => console.warn('[create_project] broadcast failed', err));
  break;
}

case 'create_task': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const ctProjectId = params.projectId as string;
  if (!ctProjectId) {
    throw new Error('projectId is required');
  }
  const ctProject = await ctx.boardService.getProject(ctProjectId);
  if (!ctProject) {
    throw new Error('Project not found');
  }
  const { projectId: _ctPid, agentId: _ctAid, callerAgentId: _ctCaid, ...taskInput } = params;
  const newTask = await ctx.boardService.createTask(
    ctProject.boardId,
    actor,
    taskInput as any,
  );
  // TER-264: enrich columnName/columnSlug
  const ctBoardEn = await ctx.boardService.getBoard(ctProject.boardId);
  data = { task: enrichTaskWithColumn(newTask, ctBoardEn) };
  ctx.pubSubService?.broadcastToTopic(`board:${ctProject.boardId}`, {
    type: 'board_task_created',
    task: newTask,
  });
  // Emit board.task_created to subscribers (fb_d211b16343bd3034 — MCA path
  // previously never emitted; mirrors handlers/domains/board/create-task.ts).
  if (ctx.boardSubscriptionService) {
    const ctColumn = ctBoardEn?.columns.find((c: any) => c.columnId === newTask.columnId);
    emitTaskCreated(ctx.boardSubscriptionService, newTask, ctColumn?.name, { actorAgentId: actor });
  }
  break;
}

case 'batch_create_tasks': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const bctProjectId = params.projectId as string;
  const bctTasks = params.tasks as any[];
  if (!bctProjectId || !bctTasks || !Array.isArray(bctTasks)) {
    throw new Error('projectId and tasks array are required');
  }
  const bctProject = await ctx.boardService.getProject(bctProjectId);
  if (!bctProject) {
    throw new Error('Project not found');
  }
  const createdTasks = await ctx.boardService.batchCreateTasks(
    bctProject.boardId,
    actor,
    bctTasks,
  );
  // TER-264: enrich all created tasks with columnName/columnSlug
  const bctBoardEn = await ctx.boardService.getBoard(bctProject.boardId);
  const bctEnriched = enrichTasksWithColumns(createdTasks, bctBoardEn);
  data = { projectId: bctProjectId, tasks: bctEnriched, count: bctEnriched.length };
  ctx.pubSubService?.broadcastToTopic(`board:${bctProject.boardId}`, {
    type: 'board_tasks_batch_created',
    tasks: createdTasks,
  });
  // Emit board.task_created per task to subscribers (fb_d211b16343bd3034 —
  // mirrors handlers/domains/board/batch-create-tasks.ts).
  if (ctx.boardSubscriptionService) {
    for (const bctTask of createdTasks) {
      const bctColumn = bctBoardEn?.columns.find((c: any) => c.columnId === bctTask.columnId);
      emitTaskCreated(ctx.boardSubscriptionService, bctTask, bctColumn?.name, { actorAgentId: actor });
    }
  }
  break;
}

case 'update_task': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const utTaskId = params.taskId as string;
  if (!utTaskId) {
    throw new Error('taskId is required');
  }
  const { taskId: _utTid, ...updateInput } = params;
  const updatedTask = await ctx.boardService.updateTask(
    utTaskId,
    actor,
    updateInput as any,
  );
  if (!updatedTask) {
    throw new Error('Task not found');
  }
  const utBoardEn = await ctx.boardService.getBoard(updatedTask.boardId);
  data = { task: enrichTaskWithColumn(updatedTask, utBoardEn) };
  ctx.pubSubService?.broadcastToTopic(`board:${updatedTask.boardId}`, {
    type: 'board_task_updated',
    task: updatedTask,
  });
  // Emit board.task_updated to subscribers (fb_d211b16343bd3034 — mirrors
  // handlers/domains/board/update-task.ts).
  if (ctx.boardSubscriptionService) {
    emitTaskUpdated(ctx.boardSubscriptionService, updatedTask, { actorAgentId: actor });
  }
  break;
}

case 'move_task': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const mtTaskId = params.taskId as string;
  const mtColumnId = params.columnId as string;
  const mtPosition = params.position as number | undefined;
  if (!mtTaskId || !mtColumnId) {
    throw new Error('taskId and columnId are required');
  }
  // Single-flight review claim: when a manager/checker session reacts to a
  // review event, exactly one concurrent session proceeds; the rest skip.
  const mtClaimSkip = await guardReviewClaim(ctx, connection, 'move_task', mtTaskId, actor, params);
  if (mtClaimSkip) {
    data = mtClaimSkip;
    break;
  }
  // Snapshot before the move — needed for the from-column in the subscription
  // event (mirrors handlers/domains/board/move-task.ts).
  const mtBefore = await ctx.boardService.getTask(mtTaskId);
  if (!mtBefore) {
    throw new Error('Task not found');
  }
  const movedTask = await ctx.boardService.moveTask(
    mtTaskId,
    actor,
    mtColumnId,
    mtPosition,
  );
  if (!movedTask) {
    throw new Error('Task not found');
  }
  // Release the review claim after the terminal move completes.
  await releaseReviewClaim(ctx, connection, mtTaskId, actor, params);
  const mtBoardEn = await ctx.boardService.getBoard(movedTask.boardId);
  data = { task: enrichTaskWithColumn(movedTask, mtBoardEn) };
  ctx.pubSubService?.broadcastToTopic(`board:${movedTask.boardId}`, {
    type: 'board_task_updated',
    task: movedTask,
  });
  // Emit board.task_moved to subscribers (fb_d211b16343bd3034 — mirrors
  // handlers/domains/board/move-task.ts).
  if (ctx.boardSubscriptionService && mtBoardEn) {
    const mtFromCol = mtBoardEn.columns.find((c: any) => c.columnId === mtBefore.columnId);
    const mtToCol = mtBoardEn.columns.find((c: any) => c.columnId === mtColumnId);
    emitTaskMoved(
      ctx.boardSubscriptionService,
      movedTask,
      {
        fromColumnId: mtBefore.columnId,
        fromColumnName: mtFromCol?.name,
        toColumnId: mtColumnId,
        toColumnName: mtToCol?.name,
      },
      { actorAgentId: actor },
    );
  }

  // ──────────────────────────────────────────────────────────────
  // Workflow hook: if this task was created by a workflow execution
  // and is being moved to 'review' or 'done', notify the ActionBridge
  // to advance the workflow engine.
  // ──────────────────────────────────────────────────────────────
  if (ctx.actionBridgeManager && movedTask.workflowExecutionId && mtBoardEn) {
    const mtTargetCol = mtBoardEn.columns.find((c: any) => c.columnId === mtColumnId);
    const mtTargetSlug = mtTargetCol?.slug;
    if (mtTargetSlug === 'review' || mtTargetSlug === 'done') {
      try {
        const mtProject = await ctx.boardService.getProject(mtBoardEn.projectId);
        if (mtProject) {
          const mtResult = await ctx.actionBridgeManager.onTaskCompleted(mtProject.projectId, {
            taskId: movedTask.taskId,
            status: mtTargetSlug,
            workflowExecutionId: movedTask.workflowExecutionId,
            workflowNodeId: movedTask.workflowNodeId,
            outputData: movedTask.output?.data,
          });

          if (mtResult.rejected) {
            // The bridge moved the task back. Re-fetch to get updated state.
            const rejectedTask = await ctx.boardService.getTask(mtTaskId);
            if (rejectedTask) {
              const rejectedBoardEn = await ctx.boardService.getBoard(rejectedTask.boardId);
              data = { task: enrichTaskWithColumn(rejectedTask, rejectedBoardEn) };
            }
          }
        }
      } catch (err) {
        // Workflow hook failure must not break the move flow.
        console.error('[move_task MCA] Workflow advancement failed:', err);
      }
    }
  }
  break;
}

case 'assign_task': {
  if (!ctx.boardService) {
    throw new Error('BoardService not available');
  }
  const atTaskId = params.taskId as string;
  const atAgentId = params.agentId as string | undefined;
  if (!atTaskId) {
    throw new Error('taskId is required');
  }
  const assignedTask = await ctx.boardService.assignTask(atTaskId, actor, atAgentId);
  if (!assignedTask) {
    throw new Error('Task not found');
  }
  const atBoardEn = await ctx.boardService.getBoard(assignedTask.boardId);
  data = { task: enrichTaskWithColumn(assignedTask, atBoardEn) };
  ctx.pubSubService?.broadcastToTopic(`board:${assignedTask.boardId}`, {
    type: 'board_task_updated',
    task: assignedTask,
  });
  // Emit board.task_assigned to subscribers (fb_d211b16343bd3034 — mirrors
  // handlers/domains/board/assign-task.ts).
  if (ctx.boardSubscriptionService) {
    emitTaskAssigned(ctx.boardSubscriptionService, assignedTask, { actorAgentId: actor });
  }
  break;
}

  }

  return data;
}
