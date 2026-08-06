/**
 * skill.grant-access — Grant a skill to an agent
 *
 * The workspaceId is derived server-side from the skill record; clients
 * must NOT pass it. Authz is enforced against both the agent and the
 * skill's workspace.
 */

import type { Db } from 'mongodb'
import type { WsHandlerContext } from '@teros/shared'
import { HandlerError } from '../../../ws-framework/WsRouter'
import { canAccessAgent, canAccessWorkspace } from '../../../auth/workspace-access'
import type { SkillService } from '../../../services/skill-service'

interface GrantSkillAccessData {
  agentId: string
  skillId: string
  order?: number
}

export function createGrantSkillAccessHandler(skillService: SkillService, db: Db) {
  return async function grantSkillAccess(ctx: WsHandlerContext, rawData: unknown) {
    const { agentId, skillId, order } = (rawData ?? {}) as GrantSkillAccessData

    if (!agentId) {
      throw new HandlerError('MISSING_AGENT_ID', 'agentId is required')
    }
    if (!skillId) {
      throw new HandlerError('MISSING_SKILL_ID', 'skillId is required')
    }

    const skill = await skillService.getSkill(skillId)
    if (!skill) {
      throw new HandlerError('SKILL_NOT_FOUND', `Skill ${skillId} not found`)
    }

    if (!(await canAccessAgent(db, ctx.userId, agentId))) {
      throw new HandlerError('FORBIDDEN_AGENT', `No access to agent ${agentId}`)
    }
    if (!(await canAccessWorkspace(db, ctx.userId, skill.workspaceId))) {
      throw new HandlerError('FORBIDDEN_WORKSPACE', `No access to workspace ${skill.workspaceId}`)
    }

    const access = await skillService.grantSkillAccess(
      agentId,
      skillId,
      skill.workspaceId,
      ctx.userId,
      order,
    )

    return { access }
  }
}
