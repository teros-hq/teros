/**
 * MCA Connection Manager — Query Dispatcher
 *
 * Dispatches query_conversations requests to the appropriate sub-handler:
 * - Conversation/channel actions  → handleConversationAction
 * - Board read/create actions     → handleBoardReadAction
 * - Board start_task action       → handleBoardStartAction
 * - Board write/modify actions    → handleBoardWriteAction
 * - Board runner self-management  → handleBoardRunnerAction
 */

import { captureException } from '../lib/sentry';
import type { QueryHandlerContext, ActiveConnection } from './mca-connection-manager.types';
import { handleConversationAction } from './mca-connection-manager.queries-conversations';
import { handleBoardReadAction } from './mca-connection-manager.queries-board-read';
import { handleBoardStartAction } from './mca-connection-manager.queries-board-start';
import { handleBoardWriteAction } from './mca-connection-manager.queries-board-write';
import { handleBoardRunnerAction } from './mca-connection-manager.queries-board-runner';

const BOARD_READ_ACTIONS = new Set([
  'get_my_task', 'get_tasks_by_agent', 'get_board_summary', 'list_tasks', 'get_task',
  'list_projects', 'create_project', 'create_task', 'batch_create_tasks', 'update_task',
  'move_task', 'assign_task',
]);

const BOARD_START_ACTIONS = new Set(['start_task']);

const BOARD_WRITE_ACTIONS = new Set([
  'link_conversation', 'delete_task', 'archive_task', 'archive_project', 'add_progress_note', 'delete_project', 'update_board_config', 'update_project',
]);

const BOARD_RUNNER_ACTIONS = new Set([
  'move_my_task', 'complete_my_task', 'block_my_task', 'cancel_my_task',
  'add_my_progress_note', 'get_project', 'list_board_agents',
  'add_dependency', 'remove_dependency', 'get_board_status', 'set_agent_slots',
  'set_agent_play', 'subscribe_to_board', 'unsubscribe_from_board',
  'list_board_subscriptions', 'stop_task', 'get_task_dependencies',
  'add_task_dependency', 'remove_task_dependency',
  'subscribe_to_events', 'unsubscribe_from_events', 'list_event_subscriptions',
]);

export async function handleQueryConversations(
  ctx: QueryHandlerContext,
  appId: string,
  connection: ActiveConnection,
  requestId: string,
  action: string,
  params: Record<string, unknown>,
): Promise<void> {
  console.log(`[McaConnectionManager] query_conversations (${action}) from ${appId}`);

  const agentIdHint = (params as any)?.agentId as string | undefined;
  const effectiveAgentId = await ctx.resolveEffectiveAgentId(connection, agentIdHint);
  console.log(`[McaConnectionManager] query_conversations effectiveAgentId=${effectiveAgentId} agentIdHint=${agentIdHint} (currentAgentId=${connection.currentAgentId})`);

  if (!ctx.channelManager) {
    ctx.send(appId, {
      type: 'query_conversations_result',
      requestId,
      action,
      data: null,
      error: 'ChannelManager not available',
    });
    return;
  }

  // Resolve real userId: if ownerId is a workspace, look up the workspace owner
  let userId = connection.ownerId;
  if (userId?.startsWith('ws_') || userId?.startsWith('work_')) {
    const workspace = await ctx.db.collection('workspaces').findOne({ workspaceId: userId } as any);
    if ((workspace as any)?.ownerId) {
      userId = (workspace as any).ownerId;
    }
  }

  try {
    let data: unknown;

    if (BOARD_READ_ACTIONS.has(action)) {
      data = await handleBoardReadAction(ctx, action, params, userId, effectiveAgentId, connection);
    } else if (BOARD_START_ACTIONS.has(action)) {
      data = await handleBoardStartAction(ctx, action, params, userId, effectiveAgentId, connection);
    } else if (BOARD_WRITE_ACTIONS.has(action)) {
      data = await handleBoardWriteAction(ctx, action, params, userId, effectiveAgentId, connection);
    } else if (BOARD_RUNNER_ACTIONS.has(action)) {
      data = await handleBoardRunnerAction(ctx, action, params, userId, effectiveAgentId, connection, appId);
    } else {
      data = await handleConversationAction(ctx, action, params, userId, effectiveAgentId, connection);
    }

    ctx.send(appId, {
      type: 'query_conversations_result',
      requestId,
      action,
      data,
    });
  } catch (error) {
    console.error(`[McaConnectionManager] Error in query_conversations (${action}):`, error);
    captureException(error, { context: 'mca-query-conversations', appId, action });
    ctx.send(appId, {
      type: 'query_conversations_result',
      requestId,
      action,
      data: null,
      error: error instanceof Error ? error.message : 'Query failed',
    });
  }
}
