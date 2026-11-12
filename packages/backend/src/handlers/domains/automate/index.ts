/**
 * Automate domain — registers all WS handlers (model v2).
 *
 * Actions:
 *   automate.list            — list starters (filters, paging) with names + 7-day stats
 *   automate.get             — one starter with names + stats
 *   automate.list-executions — execution history of a starter
 *   automate.quota           — the caller's daily execution budget (plan cap, used, reset)
 *   automate.parse-schedule  — NL/cron → canonical cron + human preview + next runs (read-only)
 *   automate.create-starter  — create (any trigger × any action)
 *   automate.update-starter  — patch name / enabled / trigger / action
 *   automate.delete          — delete a starter
 *   automate.set-enabled     — toggle enabled
 *   automate.regenerate-url  — rotate a webhook token (URL shown once)
 *   automate.list-calls      — webhook call audit log
 *   automate.test-webhook    — fire a webhook starter from the UI
 *   automate.list-flows      — flow picker data for the start-flow action
 *   automate.sync-flow-triggers — a flow's triggers as owned start-flow starters
 */

import type { Db } from 'mongodb'
import type { WsRouter } from '../../../ws-framework/WsRouter'
import type { AutomateRunner } from '../../../services/automate-runner'
import type { WorkspaceService } from '../../../services/workspace-service'
import { AutomateModel } from '../../../models/automate'

import { createListHandler } from './list'
import { createGetHandler } from './get'
import { createListExecutionsHandler } from './list-executions'
import { createCreateStarterHandler } from './create-starter'
import { createUpdateStarterHandler } from './update-starter'
import { createTestWebhookHandler } from './test-webhook'
import { createDeleteHandler } from './delete'
import { createSetEnabledHandler } from './set-enabled'
import { createRegenerateUrlHandler } from './regenerate-url'
import { createListCallsHandler } from './list-calls'
import { createListFlowsHandler } from './list-flows'
import { createSyncFlowTriggersHandler } from './sync-flow-triggers'
import { createQuotaHandler } from './quota'
import { createParseScheduleHandler } from './parse-schedule'
import { AutomateQuotaService } from '../../../services/automate-quota'

export interface AutomateDomainDeps {
  db: Db
  workspaceService: WorkspaceService
  runner: AutomateRunner | null
}

export function register(router: WsRouter, deps: AutomateDomainDeps): void {
  const model = new AutomateModel(deps.db)

  router.register('automate.list', createListHandler(model, deps.workspaceService))
  router.register('automate.get', createGetHandler(model, deps.workspaceService))
  router.register('automate.list-executions', createListExecutionsHandler(model, deps.workspaceService))
  router.register('automate.quota', createQuotaHandler(new AutomateQuotaService(deps.db, model)))
  router.register('automate.parse-schedule', createParseScheduleHandler(deps.workspaceService))
  router.register(
    'automate.create-starter',
    createCreateStarterHandler(model, deps.workspaceService, deps.db),
  )
  router.register(
    'automate.update-starter',
    createUpdateStarterHandler(model, deps.workspaceService, deps.db),
  )
  router.register('automate.delete', createDeleteHandler(model, deps.workspaceService))
  router.register('automate.set-enabled', createSetEnabledHandler(model, deps.workspaceService))
  router.register(
    'automate.regenerate-url',
    createRegenerateUrlHandler(model, deps.workspaceService),
  )
  router.register('automate.list-calls', createListCallsHandler(model, deps.workspaceService))
  router.register(
    'automate.list-flows',
    createListFlowsHandler(deps.db, deps.workspaceService),
  )
  router.register(
    'automate.sync-flow-triggers',
    createSyncFlowTriggersHandler(model, deps.workspaceService, deps.db),
  )
  router.register(
    'automate.test-webhook',
    createTestWebhookHandler(model, deps.workspaceService, deps.runner),
  )
}
