/**
 * skill.create — Create a new skill in a workspace
 */

import type { Db } from 'mongodb'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import { isValidLoadMode, type SkillLoadMode, type SkillService } from '../../../services/skill-service'
import type { Skill } from '../../../types/database'
import { canWriteWorkspace } from '../../../auth/workspace-access'

interface CreateSkillData {
  workspaceId: string
  name: string
  description?: string
  content: string
  category?: Skill['category']
  tags?: string[]
  loadMode?: SkillLoadMode
}

export function createCreateSkillHandler(skillService: SkillService, db: Db) {
  return async function createSkill(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as CreateSkillData
    const { workspaceId, name, description, content, category, tags, loadMode } = data

    if (!workspaceId) {
      throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    }
    if (!name) {
      throw new HandlerError('MISSING_NAME', 'name is required')
    }
    if (content === undefined || content === null) {
      throw new HandlerError('MISSING_CONTENT', 'content is required')
    }
    if (loadMode !== undefined && !isValidLoadMode(loadMode)) {
      throw new HandlerError('INVALID_LOAD_MODE', "loadMode must be 'always' or 'on-demand'")
    }

    // Workspace is sovereign: only members may create skills in it
    if (!(await canWriteWorkspace(db, ctx.userId, workspaceId))) {
      throw new HandlerError('FORBIDDEN_WORKSPACE', `No access to workspace ${workspaceId}`)
    }

    const skill = await skillService.createSkill(workspaceId, ctx.userId, {
      name,
      description,
      content,
      category,
      tags,
      loadMode,
    })

    console.log(`✅ Created skill ${skill.skillId} ("${skill.name}") in workspace ${workspaceId}`)

    return { skill }
  }
}
