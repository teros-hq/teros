/**
 * workspace.remove_member — Remove an ACTIVE member from a workspace.
 *
 * Authorization: owner or admin (canManageMembers). The owner cannot be
 * removed; an admin removing themselves must use workspace.leave instead.
 * The removed member loses every access immediately (membership is the gate)
 * and is told live through `workspace.membership_removed`.
 *
 * @spec MUW-REQ-20
 */
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { WorkspaceService } from '../../../services/workspace-service'

interface RemoveMemberData {
  workspaceId: string
  userId: string
}

/** @spec MUW-REQ-20 */
export function createRemoveMemberHandler(workspaceService: WorkspaceService) {
  return async function removeMember(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as RemoveMemberData
    if (!data.workspaceId) throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    if (!data.userId) throw new HandlerError('MISSING_USER_ID', 'userId is required')

    if (!(await workspaceService.canManageMembers(data.workspaceId, ctx.userId))) {
      throw new HandlerError('ACCESS_DENIED', 'Only workspace admins can manage members')
    }
    if (data.userId === ctx.userId) {
      throw new HandlerError('USE_LEAVE', 'Use workspace.leave to leave a workspace yourself')
    }

    try {
      const removed = await workspaceService.removeMember(data.workspaceId, data.userId, ctx.userId)
      if (!removed) throw new HandlerError('MEMBER_NOT_FOUND', 'This user is not an active member of the workspace')
      return { success: true, workspaceId: data.workspaceId, userId: data.userId }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Cannot remove owner')) {
        throw new HandlerError('CANNOT_REMOVE_OWNER', 'The workspace owner cannot be removed')
      }
      if (e instanceof Error && e.message.startsWith('Permission denied')) {
        throw new HandlerError('ACCESS_DENIED', 'Only workspace admins can manage members')
      }
      throw e
    }
  }
}
