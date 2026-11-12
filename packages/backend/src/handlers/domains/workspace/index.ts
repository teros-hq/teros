/**
 * Workspace domain — registers all workspace handlers with the router
 *
 * Actions:
 *   workspace.list              → List workspaces for the current user
 *   workspace.create            → Create a new workspace
 *   workspace.get               → Get details of a specific workspace
 *   workspace.update            → Update an existing workspace
 *   workspace.archive           → Archive a workspace
 *   workspace.list-apps         → List apps installed in a workspace
 *   workspace.install-app       → Install an MCA app into a workspace
 *   workspace.add_member        → Add member by email (active or pending + invitation)
 *   workspace.revoke_member     → Revoke a pending membership
 *   workspace.resend_invitation → Resend the invitation email for a pending member
 *   workspace.accept_invitation → Accept a pending invitation (invitee, token-validated)
 *   workspace.decline_invitation → Decline a pending invitation (invitee, entry removed)
 *   workspace.list_invitations   → Pending invitations for the current user's email
 *   workspace.list-agents       → List all agents in a workspace
 *   workspace.list-humans       → List all human members of a workspace
 *   workspace.list-members      → Unified list of agents + humans in a workspace
 */

import type { WsRouter } from '../../../ws-framework/WsRouter'
import { McaService } from '../../../services/mca-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'
import type { UserService } from '../../../auth/user-service'
import type { Db } from 'mongodb'

import { createListWorkspacesHandler } from './list'
import { createCreateWorkspaceHandler } from './create'
import { createGetWorkspaceHandler } from './get'
import { createUpdateWorkspaceHandler } from './update'
import { createArchiveWorkspaceHandler } from './archive'
import { createListWorkspaceAppsHandler } from './list-apps'
import { createInstallWorkspaceAppHandler } from './install-app'
import {
  createWorkspaceUsageListSessionsHandler,
  createWorkspaceUsageTokensPerHourHandler,
} from './usage'
import { createAddMemberHandler } from './add-member'
import { createRevokeMemberHandler } from './revoke-member'
import { createRemoveMemberHandler } from './remove-member'
import { createSetMemberRoleHandler } from './set-member-role'
import { createLeaveWorkspaceHandler } from './leave'
import { createResendInvitationHandler } from './resend-invitation'
import { createAcceptInvitationHandler } from './accept-invitation'
import { createDeclineInvitationHandler } from './decline-invitation'
import { createListInvitationsHandler } from './list-invitations'
import { createListWorkspaceAgentsHandler } from './list-agents'
import { createListWorkspaceHumansHandler } from './list-humans'
import { createListWorkspaceMembersHandler } from './list-members'

export interface WorkspaceDomainDeps {
  db: Db
  workspaceService: WorkspaceService
  userService?: UserService
  mcaService?: McaService | null
  pubSubService?: PubSubService | null
}

export function register(router: WsRouter, deps: WorkspaceDomainDeps): void {
  const { db, workspaceService, userService, pubSubService } = deps

  const mcaService = deps.mcaService ?? new McaService(db, { workspaceService })

  router.register('workspace.list', createListWorkspacesHandler(workspaceService))
  router.register('workspace.create', createCreateWorkspaceHandler(workspaceService, pubSubService, db))
  router.register('workspace.get', createGetWorkspaceHandler(workspaceService, userService))
  router.register('workspace.update', createUpdateWorkspaceHandler(workspaceService, pubSubService))
  router.register('workspace.archive', createArchiveWorkspaceHandler(workspaceService, pubSubService))
  router.register('workspace.list-apps', createListWorkspaceAppsHandler(workspaceService, mcaService))
  router.register('workspace.install-app', createInstallWorkspaceAppHandler(workspaceService, mcaService, pubSubService))

  // MUW-14: Invitations & pending membership
  if (userService) {
    router.register('workspace.add_member', createAddMemberHandler(workspaceService, userService, db))
    router.register('workspace.revoke_member', createRevokeMemberHandler(workspaceService))
    router.register('workspace.remove_member', createRemoveMemberHandler(workspaceService))
    router.register('workspace.set_member_role', createSetMemberRoleHandler(workspaceService))
    router.register('workspace.leave', createLeaveWorkspaceHandler(workspaceService))
    router.register('workspace.resend_invitation', createResendInvitationHandler(workspaceService, userService, db))

    // MUW-14 Fase 2: explicit acceptance — the invitee accepts or declines
    router.register('workspace.accept_invitation', createAcceptInvitationHandler(workspaceService, userService))
    router.register('workspace.decline_invitation', createDeclineInvitationHandler(workspaceService, userService))
    router.register('workspace.list_invitations', createListInvitationsHandler(workspaceService, userService))

    // MUW: Member listing for selectors (agents, humans, unified)
    router.register('workspace.list-agents', createListWorkspaceAgentsHandler(db, workspaceService))
    router.register('workspace.list-humans', createListWorkspaceHumansHandler(workspaceService, userService))
    router.register('workspace.list-members', createListWorkspaceMembersHandler(db, workspaceService, userService))
  }

  // Agent usage queries scoped to a workspace (workspace admin only).
  router.register(
    'workspace.usage-tokens-per-hour',
    createWorkspaceUsageTokensPerHourHandler(db, workspaceService),
  )
  router.register(
    'workspace.usage-list-sessions',
    createWorkspaceUsageListSessionsHandler(db, workspaceService),
  )
}
