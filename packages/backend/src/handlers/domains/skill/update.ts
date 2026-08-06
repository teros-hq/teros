/**
 * skill.update — Update a skill's mutable fields
 */

import type { Db } from 'mongodb'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { SkillService } from '../../../services/skill-service'
import type { Skill } from '../../../types/database'
import { canAccessWorkspace } from '../../../auth/workspace-access'

interface UpdateSkillData {
  skillId: string
  name?: string
  description?: string
  content?: string
  category?: Skill['category']
  tags?: string[]
}

export function createUpdateSkillHandler(skillService: SkillService, db: Db) {
  return async function updateSkill(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UpdateSkillData
    const { skillId, name, description, content, category, tags } = data

    if (!skillId) {
      throw new HandlerError('MISSING_SKILL_ID', 'skillId is required')
    }

    // Authz BEFORE mutating: load the skill, verify workspace membership.
    const existing = await skillService.getSkill(skillId)
    if (!existing) {
      throw new HandlerError('SKILL_NOT_FOUND', `Skill ${skillId} not found`)
    }
    if (!(await canAccessWorkspace(db, ctx.userId, existing.workspaceId))) {
      throw new HandlerError('FORBIDDEN_WORKSPACE', `No access to workspace ${existing.workspaceId}`)
    }

    const skill = await skillService.updateSkill(skillId, {
      name,
      description,
      content,
      category,
      tags,
    })

    if (!skill) {
      throw new HandlerError('SKILL_NOT_FOUND', `Skill ${skillId} not found`)
    }

    console.log(`✅ Updated skill ${skillId}`)

    return { skill }
  }
}
