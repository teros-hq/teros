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
  if (app.ownerId === userId) return true
  if (app.ownerType === 'workspace' && workspaceService) {
    return workspaceService.canAccess(app.ownerId, userId)
  }
  return false
}

async function getExecutionContext(
  mcaService: McaService,
  userId: string,
  appId: string,
): Promise<{ userId: string; workspaceId?: string } | null> {
  const app = await mcaService.getApp(appId)
  if (!app) return null
  if (app.ownerType === 'workspace') {
    return { userId, workspaceId: app.ownerId }
  }
  return { userId: app.ownerId }
}

export function createExecuteToolHandler(
  mcaService: McaService,
  mcaManager: McaManager | null,
  workspaceService?: WorkspaceService,
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

    const context = await getExecutionContext(mcaService, ctx.userId, appId)
    if (!context) {
      throw new HandlerError('APP_NOT_FOUND', `App ${appId} not found`)
    }

    const app = await mcaService.getApp(appId)
    if (!app) {
      throw new HandlerError('APP_NOT_FOUND', `App ${appId} not found`)
    }

    const fullToolName = `${app.name}_${tool}`
    console.log(`[app.execute-tool] Executing ${fullToolName} for user ${ctx.userId} (app: ${appId})`)

    const result = await mcaManager.executeTool(fullToolName, input, {
      appId,
      userId: context.userId,
      workspaceId: context.workspaceId,
    })

    let output: any
    try {
      output = JSON.parse(result.output)
    } catch {
      output = result.output
    }

    console.log(`[app.execute-tool] Tool executed: ${fullToolName} (success: ${!result.isError})`)

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
