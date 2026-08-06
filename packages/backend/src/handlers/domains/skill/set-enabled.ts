/**
 * skill.set-enabled — Enable or disable a skill for a specific agent
 *
 * Workspace is derived from the existing access entry. Authz is enforced
 * against both the agent and the skill's workspace.
 */

import type { Db } from 'mongodb'
import type { WsHandlerContext } from '@teros/shared'
import { HandlerError } from '../../../ws-framework/WsRouter'
import { canAccessAgent, canAccessWorkspace } from '../../../auth/workspace-access'
import type { SkillService } from '../../../services/skill-service'

interface SetSkillEnabledData {
  agentId: string
  skillId: string
  enabled: boolean
}

export function createSetSkillEnabledHandler(skillService: SkillService, db: Db) {
  return async function setSkillEnabled(ctx: WsHandlerContext, rawData: unknown) {
    const { agentId, skillId, enabled } = (rawData ?? {}) as SetSkillEnabledData

    if (!agentId) {
      throw new HandlerError('MISSING_AGENT_ID', 'agentId is required')
    }
    if (!skillId) {
      throw new HandlerError('MISSING_SKILL_ID', 'skillId is required')
    }
    if (typeof enabled !== 'boolean') {
      throw new HandlerError('MISSING_ENABLED', 'enabled (boolean) is required')
    }

    const existing = await skillService.getAccessEntry(agentId, skillId)
    if (!existing) {
      throw new HandlerError(
        'SKILL_ACCESS_NOT_FOUND',
        `No access entry found for agent ${agentId} and skill ${skillId}`,
      )
    }

    if (!(await canAccessAgent(db, ctx.userId, agentId))) {
      throw new HandlerError('FORBIDDEN_AGENT', `No access to agent ${agentId}`)
    }
    if (!(await canAccessWorkspace(db, ctx.userId, existing.workspaceId))) {
      throw new HandlerError('FORBIDDEN_WORKSPACE', `No access to workspace ${existing.workspaceId}`)
    }

    await skillService.setSkillEnabled(agentId, skillId, enabled)

    return { success: true }
  }
}
