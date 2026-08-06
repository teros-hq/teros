/**
 * skill.get — Get a skill by ID
 */

import type { Db } from 'mongodb'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { SkillService } from '../../../services/skill-service'
import { canAccessWorkspace } from '../../../auth/workspace-access'

interface GetSkillData {
  skillId: string
}

export function createGetSkillHandler(skillService: SkillService, db: Db) {
  return async function getSkill(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetSkillData
    const { skillId } = data

    if (!skillId) {
      throw new HandlerError('MISSING_SKILL_ID', 'skillId is required')
    }

    const skill = await skillService.getSkill(skillId)

    if (!skill) {
      throw new HandlerError('SKILL_NOT_FOUND', `Skill ${skillId} not found`)
    }

    // Workspace is sovereign: only members may read the skill (incl. its content)
    if (!(await canAccessWorkspace(db, ctx.userId, skill.workspaceId))) {
      throw new HandlerError('FORBIDDEN_WORKSPACE', `No access to workspace ${skill.workspaceId}`)
    }

    return { skill }
  }
}
