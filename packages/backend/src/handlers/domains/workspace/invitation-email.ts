/**
 * Shared invitation-email builder (MUW-14 REQ-12/16).
 *
 * Extracted from add-member.ts / resend-invitation.ts, which each carried a
 * private copy of this logic — and both were broken the same way: they called
 * bare `require('../../../config')`, which is undefined under tsx + ESM
 * ("type": "module"), so the invitation email silently failed on both paths
 * (the catch swallowed the ReferenceError → invitationEmailSent: false).
 * This module uses a static ESM import instead.
 *
 * Used by:
 *   - WS handler workspace.add_member      (handlers/domains/workspace/add-member.ts)
 *   - WS handler workspace.resend_invitation (handlers/domains/workspace/resend-invitation.ts)
 *   - MCA HTTP path POST /resources/workspaces/:id/members (routes/mca-resources-handlers.ts)
 */

import { config } from '../../../config'
import { isEmailConfigured, getEmailService } from '../../../services/email-service'
import type { Db } from 'mongodb'
import type { UserService } from '../../../auth/user-service'

export type InvitationEmailSendFn = (
  to: string,
  vars: Record<string, string>,
) => Promise<boolean>

/**
 * Build the best-effort invitation email sender (NFR-5: non-blocking, never
 * throws — returns false on failure so the membership is still created).
 *
 * `inviterUserId` is resolved to a display name for the subject line and the
 * INVITER_NAME template variable (WorkspaceService passes the raw userId in
 * vars.INVITER_NAME; this overrides it with the display name).
 */
export function buildInvitationEmailSendFn(
  userService: UserService,
  db: Db,
  inviterUserId: string,
  opts: { logTag: string },
): InvitationEmailSendFn {
  return async function sendInvitationEmail(
    to: string,
    vars: Record<string, string>,
  ): Promise<boolean> {
    if (!isEmailConfigured()) {
      console.warn(`[${opts.logTag}] Email not configured — invitation email skipped`)
      return false
    }

    try {
      // Resolve inviter display name
      const inviter = await userService.getByUserId(inviterUserId)
      const inviterName = inviter?.profile?.displayName ?? inviterUserId

      // Build signup CTA URL with email pre-filled
      const appUrl = process.env.APP_URL || config.share.baseUrl || 'https://os.teros.ai'
      const ctaUrl = `${appUrl}/?invite_email=${encodeURIComponent(to)}&invite_token=${vars.INVITE_TOKEN}`

      const emailService = getEmailService(db)
      const result = await emailService.send({
        to,
        subject: `${inviterName} invited you to join Teros`,
        template: 'workspace-invitation',
        variables: {
          ...vars,
          INVITER_NAME: inviterName,
          CTA_URL: ctaUrl,
          STATIC_BASE_URL: config.static.baseUrl,
        },
      })
      return result.success
    } catch (e) {
      console.error(`[${opts.logTag}] Failed to send invitation email:`, e)
      return false
    }
  }
}
