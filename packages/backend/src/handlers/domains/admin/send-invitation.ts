/**
 * admin.send-invitation — Send an invitation to another user by email
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import { InvitationService } from '../../../auth/invitation-service'

interface SendInvitationData {
  email: string
}

export function createSendInvitationHandler(db: Db) {
  return async function sendInvitation(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SendInvitationData
    const { email } = data

    if (!email) {
      throw new HandlerError('MISSING_FIELDS', 'email is required')
    }

    const invitationService = new InvitationService(db)
    const result = await invitationService.sendInvitationByEmail(ctx.userId, email)

    if (!result.success) {
      // Return a structured error payload instead of a generic HandlerError
      // so the client can distinguish invitation-specific failures
      return {
        success: false,
        error: result.error || 'Failed to send invitation',
        email,
      }
    }

    return {
      success: true,
      toEmail: email,
      accessGranted: result.accessGranted || false,
    }
  }
}
