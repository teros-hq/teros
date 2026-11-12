/**
 * profile.delete-account — Erase the caller's account (GDPR, GOV-3/GOV-6)
 *
 * Re-authentication is part of the request, because this is irreversible:
 *   - confirmEmail: the account's email, typed by the user (always required)
 *   - mfaCode: when MFA is enabled
 *   - password: otherwise, when the account has a password
 * OAuth-only accounts without MFA confirm with the email alone (they have no
 * secret to re-enter here).
 *
 * The cascade itself is DeletionService.deleteUser. Owning a shared workspace
 * that still has other members blocks it (ACCOUNT_DELETION_BLOCKED, with the
 * workspace ids) — the owner must transfer or delete those first.
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import { IdentityService } from "../../../auth/identity-service"
import { MFAService } from "../../../auth/mfa-service"
import type { UserService } from "../../../auth/user-service"
import { auditLogger } from "../../../lib/audit-logger"
import { AccountDeletionBlockedError, DeletionService } from "../../../services/deletion-service"
import { HandlerError } from "../../../ws-framework/WsRouter"

interface DeleteAccountData {
  confirmEmail?: unknown
  password?: unknown
  mfaCode?: unknown
}

export function createDeleteAccountHandler(db: Db, userService: UserService) {
  const identityService = new IdentityService(db)
  const mfaService = new MFAService(db)

  return async function deleteAccount(ctx: WsHandlerContext, rawData: unknown) {
    const data = (rawData ?? {}) as DeleteAccountData
    const user = await userService.getByUserId(ctx.userId)
    if (!user) throw new HandlerError("USER_NOT_FOUND", "User not found")

    if (
      typeof data.confirmEmail !== "string" ||
      data.confirmEmail.trim().toLowerCase() !== user.profile.email.toLowerCase()
    ) {
      throw new HandlerError("CONFIRMATION_MISMATCH", "Type your account email to confirm")
    }

    if (user.mfa?.enabled) {
      if (typeof data.mfaCode !== "string")
        throw new HandlerError("MFA_REQUIRED", "MFA code is required")
      const mfa = await mfaService.verifyMFA(ctx.userId, data.mfaCode)
      if (!mfa.success) throw new HandlerError("MFA_INVALID", mfa.error || "Invalid MFA code")
    } else if (await identityService.hasPasswordIdentity(ctx.userId)) {
      if (typeof data.password !== "string")
        throw new HandlerError("MISSING_FIELDS", "Password is required")
      const check = await identityService.verifyPassword(user.profile.email, data.password)
      if (!check.success)
        throw new HandlerError("INVALID_CREDENTIALS", "Password verification failed")
    }

    try {
      await new DeletionService(db).deleteUser(ctx.userId, ctx.userId)
    } catch (err) {
      if (err instanceof AccountDeletionBlockedError) {
        throw new HandlerError("ACCOUNT_DELETION_BLOCKED", err.message)
      }
      throw err
    }

    await auditLogger.log({
      event: "status.change",
      actorUserId: ctx.userId,
      targetUserId: ctx.userId,
      detail: { change: "account_deleted" },
    })
    return { ok: true }
  }
}
