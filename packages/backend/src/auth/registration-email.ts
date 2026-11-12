import type { EmailService, SendEmailResult } from "../services/email-service"

/**
 * The EmailService surface the registration email needs. Narrow on purpose:
 * the caller injects it, so this module stays free of the module singleton
 * (getEmailService) and is directly unit-testable with a plain fake.
 */
export type RegistrationEmailSender = Pick<EmailService, "sendWelcome" | "sendWelcomeRegistered">

/** The only user fields the registration email reads. */
export interface RegistrationEmailUser {
  accessGranted: boolean
  profile: { email: string; displayName: string }
}

/**
 * Sends the welcome email a newly-registered user should receive.
 *
 * - accessGranted === true  → "welcome" (instant access, no waitlist)
 * - accessGranted === false → "welcome-registered" (legacy waitlist email)
 *
 * accessGranted is set by UserService.createUser from the `access.auto-grant`
 * feature flag, so this transparently follows waitlist on/off.
 */
export function sendWelcomeEmail(
  svc: RegistrationEmailSender,
  user: RegistrationEmailUser,
): Promise<SendEmailResult> {
  const vars = { USER_NAME: user.profile.displayName }
  return user.accessGranted
    ? svc.sendWelcome(user.profile.email, vars)
    : svc.sendWelcomeRegistered(user.profile.email, vars)
}
