/**
 * skill.create — Create a new skill in a workspace
 */

import type { Db } from 'mongodb'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { SkillService } from '../../../services/skill-service'
import type { Skill } from '../../../types/database'
import { canAccessWorkspace } from '../../../auth/workspace-access'

interface CreateSkillData {
  workspaceId: string
  name: string
  description?: string
  content: string
  category?: Skill['category']
  tags?: string[]
}

export function createCreateSkillHandler(skillService: SkillService, db: Db) {
  return async function createSkill(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as CreateSkillData
    const { workspaceId, name, description, content, category, tags } = data

    if (!workspaceId) {
      throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    }
    if (!name) {
      throw new HandlerError('MISSING_NAME', 'name is required')
    }
    if (content === undefined || content === null) {
      throw new HandlerError('MISSING_CONTENT', 'content is required')
    }

    // Workspace is sovereign: only members may create skills in it
    if (!(await canAccessWorkspace(db, ctx.userId, workspaceId))) {
      throw new HandlerError('FORBIDDEN_WORKSPACE', `No access to workspace ${workspaceId}`)
    }

    const skill = await skillService.createSkill(workspaceId, ctx.userId, {
      name,
      description,
      content,
      category,
      tags,
    })

    console.log(`✅ Created skill ${skill.skillId} ("${skill.name}") in workspace ${workspaceId}`)

    return { skill }
  }
}
