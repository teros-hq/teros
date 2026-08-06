/**
 * profile.mark-changelog-seen — Mark the last changelog entry the user has seen
 *
 * Called when the user dismisses the "What's New" modal. Stores the ID of the
 * last entry shown so the modal doesn't appear again until newer entries exist.
 */

import type { WsHandlerContext } from '@teros/shared'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { UserService } from '../../../auth/user-service'

interface MarkChangelogSeenData {
  /** ID of the last changelog entry the user saw */
  lastChangelogSeen: string
}

interface MarkChangelogSeenResult {
  lastChangelogSeen: string
}

export function createMarkChangelogSeenHandler(userService: UserService) {
  return async function markChangelogSeen(
    ctx: WsHandlerContext,
    rawData: unknown,
  ): Promise<MarkChangelogSeenResult> {
    const data = rawData as MarkChangelogSeenData

    if (!data?.lastChangelogSeen || typeof data.lastChangelogSeen !== 'string') {
      throw new HandlerError('INVALID_INPUT', 'lastChangelogSeen is required and must be a string')
    }

    const updated = await userService.updateLastChangelogSeen(ctx.userId, data.lastChangelogSeen)

    if (!updated) {
      throw new HandlerError('USER_NOT_FOUND', 'User not found')
    }

    return {
      lastChangelogSeen: data.lastChangelogSeen,
    }
  }
}
