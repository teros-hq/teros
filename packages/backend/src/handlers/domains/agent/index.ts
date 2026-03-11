/**
 * Agent domain — registers all agent handlers with the router
 *
 * Actions:
 *   agent.list                → List agent instances (user or workspace)
 *   agent.create              → Create a new agent instance
 *   agent.update              → Update an existing agent instance
 *   agent.delete              → Delete an agent instance
 *   agent.generate-profile    → Generate a unique agent profile via LLM
 *   agent.list-cores          → List available agent cores (engines)
 *   agent.update-core         → Update an agent core configuration
 *   agent.get-apps            → Get apps an agent has access to
 *   agent.list-providers      → List providers available for an agent
 *   agent.set-providers       → Set availableProviders for an agent
 *   agent.set-preferred-provider → Set preferredProviderId for an agent
 */

import type { Db } from 'mongodb'
import type { WsRouter } from '../../../ws-framework/WsRouter'
import { ModelService } from '../../../services/model-service'
import { McaService } from '../../../services/mca-service'
import type { ProviderService } from '../../../services/provider-service'
import type { WorkspaceService } from '../../../services/workspace-service'

import { createListAgentsHandler } from './list'
import { createCreateAgentHandler } from './create'
import { createUpdateAgentHandler } from './update'
import { createDeleteAgentHandler } from './delete'
import { createGenerateProfileHandler } from './generate-profile'
import { createListCoresHandler } from './list-cores'
import { createUpdateCoreHandler } from './update-core'
import { createGetAppsHandler } from './get-apps'
import { createListProvidersHandler } from './list-providers'
import { createSetProvidersHandler } from './set-providers'
import { createSetPreferredProviderHandler } from './set-preferred-provider'

export interface AgentDomainDeps {
  db: Db
  providerService: ProviderService
  workspaceService?: WorkspaceService | null
}

export function register(router: WsRouter, deps: AgentDomainDeps): void {
  const { db, providerService, workspaceService } = deps

  const modelService = new ModelService(db)
  const mcaService = new McaService(db)

  router.register('agent.list', createListAgentsHandler(db, workspaceService))
  router.register('agent.create', createCreateAgentHandler(db, workspaceService))
  router.register('agent.update', createUpdateAgentHandler(db))
  router.register('agent.delete', createDeleteAgentHandler(db))
  router.register('agent.generate-profile', createGenerateProfileHandler(db, providerService))
  router.register('agent.list-cores', createListCoresHandler(db, modelService))
  router.register('agent.update-core', createUpdateCoreHandler(db, modelService))
  router.register('agent.get-apps', createGetAppsHandler(mcaService))
  router.register('agent.list-providers', createListProvidersHandler(db))
  router.register('agent.set-providers', createSetProvidersHandler(db))
  router.register('agent.set-preferred-provider', createSetPreferredProviderHandler(db))
}
