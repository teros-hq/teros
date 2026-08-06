/**
 * Skill domain — registers all skill handlers with the router
 *
 * Actions:
 *   skill.create           → Create a new skill in a workspace
 *   skill.list             → List all skills in a workspace
 *   skill.get              → Get a skill by ID
 *   skill.update           → Update a skill's mutable fields
 *   skill.delete           → Delete a skill (cascades to access entries)
 *   skill.grant-access     → Grant a skill to an agent
 *   skill.revoke-access    → Revoke a skill from an agent
 *   skill.set-enabled      → Enable or disable a skill for an agent
 *   skill.get-agent-skills → Get all enabled skills for an agent (in order)
 *   skill.reorder          → Reorder skills for an agent
 */

import type { Db } from 'mongodb'
import type { WsRouter } from '../../../ws-framework/WsRouter'
import { SkillService } from '../../../services/skill-service'

import { createCreateSkillHandler } from './create'
import { createListSkillsHandler } from './list'
import { createGetSkillHandler } from './get'
import { createUpdateSkillHandler } from './update'
import { createDeleteSkillHandler } from './delete'
import { createGrantSkillAccessHandler } from './grant-access'
import { createRevokeSkillAccessHandler } from './revoke-access'
import { createSetSkillEnabledHandler } from './set-enabled'
import { createGetAgentSkillsHandler } from './get-agent-skills'
import { createReorderSkillsHandler } from './reorder'

export interface SkillDomainDeps {
  db: Db
  skillService?: SkillService | null
}

export function register(router: WsRouter, deps: SkillDomainDeps): void {
  const skillService = deps.skillService ?? new SkillService(deps.db)

  router.register('skill.create', createCreateSkillHandler(skillService, deps.db))
  router.register('skill.list', createListSkillsHandler(skillService, deps.db))
  router.register('skill.get', createGetSkillHandler(skillService, deps.db))
  router.register('skill.update', createUpdateSkillHandler(skillService, deps.db))
  router.register('skill.delete', createDeleteSkillHandler(skillService, deps.db))
  router.register('skill.grant-access', createGrantSkillAccessHandler(skillService, deps.db))
  router.register('skill.revoke-access', createRevokeSkillAccessHandler(skillService, deps.db))
  router.register('skill.set-enabled', createSetSkillEnabledHandler(skillService, deps.db))
  router.register('skill.get-agent-skills', createGetAgentSkillsHandler(skillService, deps.db))
  router.register('skill.reorder', createReorderSkillsHandler(skillService, deps.db))
}
