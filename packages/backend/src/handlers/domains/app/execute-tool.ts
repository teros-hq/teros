/**
 * app.execute-tool — Execute a tool directly (without agent/LLM)
 *
 * Used by frontend UI views (Tasks, Calendar, etc.) to interact with MCAs directly.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { McaService } from '../../../services/mca-service'
import type { McaManager } from '../../../services/mca-manager'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'
import type { Db } from 'mongodb'

interface ExecuteToolData {
  requestId?: string
  appId: string
  tool: string
  input?: Record<string, any>
}

async function userHasAppAccess(
  mcaService: McaService,
  workspaceService: WorkspaceService | undefined,
  userId: string,
  appId: string,
): Promise<boolean> {
  const app = await mcaService.getApp(appId)
  if (!app) return false
  if (workspaceService) {
    return workspaceService.canAccess(app.ownerId, userId)
  }
  return false
}

async function getExecutionContext(
  mcaService: McaService,
  userId: string,
  appId: string,
): Promise<{ userId: string; workspaceId: string } | null> {
  const app = await mcaService.getApp(appId)
  if (!app) return null
  return { userId, workspaceId: app.ownerId }
}

export function createExecuteToolHandler(
  mcaService: McaService,
  mcaManager: McaManager | null,
  workspaceService?: WorkspaceService,
  pubSubService?: PubSubService | null,
  db?: Db,
) {
  return async function executeTool(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ExecuteToolData
    const { requestId, appId, tool, input = {} } = data

    if (!appId) {
      throw new HandlerError('MISSING_APP_ID', 'appId is required')
    }
    if (!tool) {
      throw new HandlerError('MISSING_TOOL', 'tool name is required')
    }
    if (!mcaManager) {
      throw new HandlerError('MCA_UNAVAILABLE', 'MCA system is not available')
    }

    const hasAccess = await userHasAppAccess(mcaService, workspaceService, ctx.userId, appId)
    if (!hasAccess) {
      throw new HandlerError('ACCESS_DENIED', `You don't have access to app ${appId}`)
    }

    const app = await mcaService.getApp(appId)
    if (!app) {
      throw new HandlerError('APP_NOT_FOUND', `App ${appId} not found`)
    }

    // ──────────────────────────────────────────────────────────────────────
    // MUW-REQ-12/13 (UI path): the caller must see the app, and inside a
    // conversation the per-conversation rule applies — shared conversation →
    // shared apps only; personal conversation → shared + the creator's own.
    // ──────────────────────────────────────────────────────────────────────
    if (!mcaService.isAppVisibleTo(app, ctx.userId)) {
      throw new HandlerError('ACCESS_DENIED', `You don't have access to app ${appId}`)
    }
    const gateChannelId = (input as Record<string, any>)?.channelId
    if (gateChannelId && (await mcaService.isAppBlockedInChannel(app, gateChannelId))) {
      throw new HandlerError(
        'PERSONAL_APP_BLOCKED',
        'This personal app cannot be used in this conversation (shared conversations only run shared apps).',
      )
    }

    const context = await getExecutionContext(mcaService, ctx.userId, appId)
    if (!context) {
      throw new HandlerError('APP_NOT_FOUND', `App ${appId} not found`)
    }

    const fullToolName = `${app.name}_${tool}`
    console.log(`[app.execute-tool] Executing ${fullToolName} for user ${ctx.userId} (app: ${appId})`)

    // Extract channelId from input (e.g. terminal window passes it for streaming)
    // and forward it to the execution context so MCAs can use it for callbacks.
    const { channelId: inputChannelId, ...toolInput } = input as Record<string, any>

    const result = await mcaManager.executeTool(fullToolName, toolInput, {
      appId,
      userId: context.userId,
      workspaceId: context.workspaceId,
      ...(inputChannelId ? { channelId: inputChannelId } : {}),
      // UI path: windows parse the raw JSON (no LLM context). The 200K
      // truncation guard is for LLM prompts — here it would cut a large
      // get-tree payload mid-JSON and the window would silently render an
      // empty tree (2026-10-24 incident: 396-node tree, ~260K chars).
      skipTruncation: true,
    })

    let output: any
    try {
      output = JSON.parse(result.output)
    } catch {
      output = result.output
    }

    console.log(`[app.execute-tool] Tool executed: ${fullToolName} (success: ${!result.isError})`)

    // Broadcast todo_node_changed event so the TodoWindow refreshes in real-time
    // when the user interacts with the todo-list MCA directly from the frontend.
    // Only broadcast for WRITE tools — read tools (get-tree, get-node, search-nodes)
    // would cause an infinite loop: loadTree → get-tree → broadcast → loadTree → ...
    const TODO_WRITE_TOOLS = new Set([
      'add-node', 'update-node', 'toggle-complete',
      'delete-node', 'move-node', 'add-log-entry',
      'set-state', 'set-kind', 'set-progress', 'set-input', 'set-output',
      'toggle-instruction-item', 'plan-node', 'assign-node',
      // Archive: the flag changes what the default views show.
      'set-archived', 'archive-finished',
      // To Do autoplay (TODOAP): a manual start writes the node. Runner changes
      // are not node writes — they broadcast todo_autoplay_changed themselves.
      'start-node',
      // 'toggle-collapse' removed — UI state, doesn't need real-time sync
    ]);
    if (!result.isError && app.mcaId === 'mca.teros.todo-list' && TODO_WRITE_TOOLS.has(tool)) {
      // Extract nodeId, parentId, and full node data from the tool result so the
      // frontend can apply granular animations (insert/delete/update) without a
      // full tree reload — avoids a round-trip for every real-time event.
      let nodeId: string | undefined;
      let parentId: string | null | undefined;
      let node: any | undefined;
      if (typeof output === 'object' && output !== null) {
        node = (output as any)?.node;
        nodeId = node?.nodeId ?? (output as any)?.nodeId;
        parentId = node?.parentId;
      }
      pubSubService?.broadcastToTopic(`todo:${context.userId}`, {
        type: 'todo_node_changed',
        action: tool,
        userId: context.userId,
        ...(nodeId ? { nodeId } : {}),
        ...(parentId !== undefined ? { parentId } : {}),
        ...(node ? { node } : {}),
        timestamp: Date.now(),
      })
    }

    return {
      requestId,
      appId,
      tool,
      success: !result.isError,
      result: output,
      mcaId: result.mcaId,
    }
  }
}
