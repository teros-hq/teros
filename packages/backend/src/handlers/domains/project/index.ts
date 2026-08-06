/**
 * project domain — registers all project handlers
 *
 * Actions:
 *   project.create              → Create a new project in a workspace
 *   project.list                → List all projects in a workspace
 *   project.get                 → Get a project by ID
 *   project.update              → Update project fields (name, description, context)
 *   project.delete              → Delete a project
 *   project.set-channel-project → Associate/disassociate a channel with a project
 */
import type { Db } from 'mongodb'
import type { WsRouter } from '../../../ws-framework/WsRouter'
import { ProjectService } from '../../../services/project-service'

import { createCreateProjectHandler } from './create'
import { createListProjectsHandler } from './list'
import { createGetProjectHandler } from './get'
import { createUpdateProjectHandler } from './update'
import { createDeleteProjectHandler } from './delete'
import { createSetChannelProjectHandler } from './set-channel-project'

export interface ProjectDomainDeps {
  db: Db
  projectService?: ProjectService | null
}

export function register(router: WsRouter, deps: ProjectDomainDeps): void {
  const service = deps.projectService ?? new ProjectService(deps.db)

  router.register('project.create', createCreateProjectHandler(service, deps.db))
  router.register('project.list', createListProjectsHandler(service, deps.db))
  router.register('project.get', createGetProjectHandler(service, deps.db))
  router.register('project.update', createUpdateProjectHandler(service, deps.db))
  router.register('project.delete', createDeleteProjectHandler(service, deps.db))
  router.register('project.set-channel-project', createSetChannelProjectHandler(deps.db, service))
}
