/**
 * skill.reorder — Reorder skills for an agent
 */

import type { Db } from 'mongodb'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { SkillService } from '../../../services/skill-service'
import { canAccessAgent } from '../../../auth/workspace-access'

interface ReorderSkillsData {
  agentId: string
  orderedSkillIds: string[]
}

export function createReorderSkillsHandler(skillService: SkillService, db: Db) {
  return async function reorderSkills(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ReorderSkillsData
    const { agentId, orderedSkillIds } = data

    if (!agentId) {
      throw new HandlerError('MISSING_AGENT_ID', 'agentId is required')
    }
    if (!Array.isArray(orderedSkillIds)) {
      throw new HandlerError('MISSING_ORDERED_SKILL_IDS', 'orderedSkillIds (array) is required')
    }

    // Only someone with access to the agent may reorder its skills
    if (!(await canAccessAgent(db, ctx.userId, agentId))) {
      throw new HandlerError('FORBIDDEN_AGENT', `No access to agent ${agentId}`)
    }

    await skillService.reorderAgentSkills(agentId, orderedSkillIds)

    console.log(`✅ Reordered ${orderedSkillIds.length} skills for agent ${agentId}`)

    return { success: true }
  }
}
