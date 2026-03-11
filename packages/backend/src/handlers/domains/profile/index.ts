/**
 * Profile domain — registers all profile handlers with the router
 *
 * Actions:
 *   profile.get    → Get current user profile
 *   profile.update → Update current user profile
 */

import { UserService } from '../../../auth/user-service'
import type { WsRouter } from '../../../ws-framework/WsRouter'
import type { Db } from 'mongodb'
import { createGetProfileHandler } from './get'
import { createUpdateProfileHandler } from './update'

interface ProfileDeps {
  db: Db
}

export function register(router: WsRouter, deps: ProfileDeps): void {
  const userService = new UserService(deps.db)

  router.register('profile.get', createGetProfileHandler(userService))
  router.register('profile.update', createUpdateProfileHandler(userService))
}
