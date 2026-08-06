/**
 * skill.list — List all skills in a workspace
 */

import type { Db } from 'mongodb'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { SkillService } from '../../../services/skill-service'
import { canAccessWorkspace } from '../../../auth/workspace-access'

interface ListSkillsData {
  workspaceId: string
}

export function createListSkillsHandler(skillService: SkillService, db: Db) {
  return async function listSkills(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ListSkillsData
    const { workspaceId } = data

    if (!workspaceId) {
      throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    }

    // Workspace is sovereign: only members may list its skills
    if (!(await canAccessWorkspace(db, ctx.userId, workspaceId))) {
      throw new HandlerError('FORBIDDEN_WORKSPACE', `No access to workspace ${workspaceId}`)
    }

    const skills = await skillService.listSkills(workspaceId)

    return { skills }
  }
}
