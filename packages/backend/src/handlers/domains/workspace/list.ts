/**
 * workspace.list — List workspaces for the current user
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { WorkspaceService } from '../../../services/workspace-service'

export function createListWorkspacesHandler(workspaceService: WorkspaceService) {
  return async function listWorkspaces(ctx: WsHandlerContext) {
    const workspaces = await workspaceService.listUserWorkspaces(ctx.userId)

    const workspacesWithRole = await Promise.all(
      workspaces.map(async (workspace) => {
        const role = await workspaceService.getUserRole(workspace.workspaceId, ctx.userId)
        return {
          workspaceId: workspace.workspaceId,
          name: workspace.name,
          description: workspace.description,
          context: workspace.context,
          volumeId: workspace.volumeId,
          appearance: workspace.appearance,
          role,
          status: workspace.status,
          createdAt: workspace.createdAt,
        }
      }),
    )

    return { workspaces: workspacesWithRole }
  }
}
