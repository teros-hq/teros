/**
 * workspace.set_member_role — Change an ACTIVE member's role.
 *
 * Authorization: owner or admin (canManageMembers). The owner has no role
 * row (the role `owner` is implicit and not assignable — MUW-REQ-17), so the
 * owner cannot be targeted. Roles: admin | write | read.
 *
 * @spec MUW-REQ-21
 */
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { WorkspaceService } from '../../../services/workspace-service'

interface SetMemberRoleData {
  workspaceId: string
  userId: string
  role: 'admin' | 'write' | 'read'
}

const VALID_ROLES = ['admin', 'write', 'read'] as const

/** @spec MUW-REQ-21 */
export function createSetMemberRoleHandler(workspaceService: WorkspaceService) {
  return async function setMemberRole(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SetMemberRoleData
    if (!data.workspaceId) throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    if (!data.userId) throw new HandlerError('MISSING_USER_ID', 'userId is required')
    if (!VALID_ROLES.includes(data.role)) {
      throw new HandlerError('INVALID_ROLE', 'role must be one of: admin, write, read')
    }

    if (!(await workspaceService.canManageMembers(data.workspaceId, ctx.userId))) {
      throw new HandlerError('ACCESS_DENIED', 'Only workspace admins can manage members')
    }
    if (await workspaceService.isOwner(data.workspaceId, data.userId)) {
      throw new HandlerError('CANNOT_CHANGE_OWNER', 'The workspace owner has no assignable role')
    }

    try {
      const changed = await workspaceService.updateMemberRole(data.workspaceId, data.userId, data.role, ctx.userId)
      if (!changed) throw new HandlerError('MEMBER_NOT_FOUND', 'This user is not a member of the workspace, or already has that role')
      return { success: true, workspaceId: data.workspaceId, userId: data.userId, role: data.role }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Permission denied')) {
        throw new HandlerError('ACCESS_DENIED', 'Only workspace admins can manage members')
      }
      throw e
    }
  }
}
