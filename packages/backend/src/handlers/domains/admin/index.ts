/**
 * Admin domain — registers all admin and invitation handlers with the router
 *
 * Actions:
 *   admin.list-users            → List all users with stats (admin only)
 *   admin.get-user              → Get detailed user info (admin only)
 *   admin.update-user-role      → Update a user's role (super only)
 *   admin.update-user-status    → Update a user's status (admin only)
 *   admin.get-invitation-status → Get current user's invitation status
 *   admin.send-invitation       → Send an invitation to another user by email
 *   admin.get-invitations-sent  → Get list of invitations sent by current user
 *   admin.get-invitable-users   → Get users that can be invited
 *   admin.revoke-invitation     → Revoke an invitation (admin only)
 */

import type { WsRouter } from '../../../ws-framework/WsRouter'
import type { Db } from 'mongodb'
import { UserService } from '../../../auth/user-service'

import { createListUsersHandler } from './list-users'
import { createGetUserHandler } from './get-user'
import { createUpdateUserRoleHandler } from './update-user-role'
import { createUpdateUserStatusHandler } from './update-user-status'
import { createGetInvitationStatusHandler } from './get-invitation-status'
import { createSendInvitationHandler } from './send-invitation'
import { createGetInvitationsSentHandler } from './get-invitations-sent'
import { createGetInvitableUsersHandler } from './get-invitable-users'
import { createRevokeInvitationHandler } from './revoke-invitation'

export interface AdminDomainDeps {
  db: Db
}

export function register(router: WsRouter, deps: AdminDomainDeps): void {
  const { db } = deps
  const userService = new UserService(db)

  // User management (admin/super only)
  router.register('admin.list-users', createListUsersHandler(userService, db))
  router.register('admin.get-user', createGetUserHandler(userService, db))
  router.register('admin.update-user-role', createUpdateUserRoleHandler(userService))
  router.register('admin.update-user-status', createUpdateUserStatusHandler(userService))

  // Invitation system
  router.register('admin.get-invitation-status', createGetInvitationStatusHandler(db))
  router.register('admin.send-invitation', createSendInvitationHandler(db))
  router.register('admin.get-invitations-sent', createGetInvitationsSentHandler(db))
  router.register('admin.get-invitable-users', createGetInvitableUsersHandler(db))
  router.register('admin.revoke-invitation', createRevokeInvitationHandler(db))
}
