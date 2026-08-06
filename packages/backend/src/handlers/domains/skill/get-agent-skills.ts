/**
 * skill.get-agent-skills — Get all enabled skills assigned to an agent (in injection order)
 */

import type { Db } from 'mongodb'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { SkillService } from '../../../services/skill-service'
import { canAccessAgent } from '../../../auth/workspace-access'

interface GetAgentSkillsData {
  agentId: string
}

export function createGetAgentSkillsHandler(skillService: SkillService, db: Db) {
  return async function getAgentSkills(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetAgentSkillsData
    const { agentId } = data

    if (!agentId) {
      throw new HandlerError('MISSING_AGENT_ID', 'agentId is required')
    }

    // Only someone with access to the agent may read its enabled skills
    if (!(await canAccessAgent(db, ctx.userId, agentId))) {
      throw new HandlerError('FORBIDDEN_AGENT', `No access to agent ${agentId}`)
    }

    const skills = await skillService.getAgentSkills(agentId)

    return { skills }
  }
}
