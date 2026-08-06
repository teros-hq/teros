/**
 * skill.delete — Delete a skill and all its access entries
 */

import type { Db } from 'mongodb'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { SkillService } from '../../../services/skill-service'
import { canAccessWorkspace } from '../../../auth/workspace-access'

interface DeleteSkillData {
  skillId: string
}

export function createDeleteSkillHandler(skillService: SkillService, db: Db) {
  return async function deleteSkill(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as DeleteSkillData
    const { skillId } = data

    if (!skillId) {
      throw new HandlerError('MISSING_SKILL_ID', 'skillId is required')
    }

    // Authz BEFORE deleting: load the skill, verify workspace membership.
    const existing = await skillService.getSkill(skillId)
    if (!existing) {
      throw new HandlerError('SKILL_NOT_FOUND', `Skill ${skillId} not found`)
    }
    if (!(await canAccessWorkspace(db, ctx.userId, existing.workspaceId))) {
      throw new HandlerError('FORBIDDEN_WORKSPACE', `No access to workspace ${existing.workspaceId}`)
    }

    const deleted = await skillService.deleteSkill(skillId)

    if (!deleted) {
      throw new HandlerError('SKILL_NOT_FOUND', `Skill ${skillId} not found`)
    }

    console.log(`✅ Deleted skill ${skillId}`)

    return { success: true }
  }
}
