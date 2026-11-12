/**
 * workspace.leave — The caller leaves a workspace they are an active member of.
 *
 * The owner cannot leave (archive or transfer instead). Pending invitations
 * are declined through workspace.decline_invitation, not here.
 *
 * @spec MUW-REQ-22
 */
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { WorkspaceService } from '../../../services/workspace-service'

interface LeaveData {
  workspaceId: string
}

/** @spec MUW-REQ-22 */
export function createLeaveWorkspaceHandler(workspaceService: WorkspaceService) {
  return async function leaveWorkspace(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as LeaveData
    if (!data.workspaceId) throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    try {
      const left = await workspaceService.leaveWorkspace(data.workspaceId, ctx.userId)
      if (!left) throw new HandlerError('WORKSPACE_NOT_FOUND', 'Workspace not found')
      return { success: true, workspaceId: data.workspaceId }
    } catch (e) {
      if (e instanceof Error && e.message === 'OWNER_CANNOT_LEAVE') {
        throw new HandlerError('OWNER_CANNOT_LEAVE', 'The owner cannot leave the workspace — archive it instead')
      }
      if (e instanceof Error && e.message === 'NOT_A_MEMBER') {
        throw new HandlerError('NOT_A_MEMBER', 'You are not an active member of this workspace')
      }
      throw e
    }
  }
}
