/**
 * Email Service
 *
 * Handles all transactional emails using Resend.
 * Templates are stored in /templates/emails/
 */

import * as fs from "fs"
import { COLLECTIONS, ensureCollectionIndexes } from "../db"
import { createRequire } from "module"
import * as path from "path"
import type { Collection, Db } from "mongodb"
import { generateId } from "@teros/core"
import { Resend } from "resend"
import { fileURLToPath } from "url"
import { secrets } from "../secrets/secrets-manager"

const require = createRequire(import.meta.url)

// Email types
export type EmailTemplate =
  | "welcome-founding-partner"
  | "welcome-registered"
  | "welcome"
  | "access-granted"
  | "changelog-update"
  | "feedback-notification"
  | "feedback-resolved"
  | "workspace-invitation"
  | "email-verification"
  | "password-reset"

interface SendEmailOptions {
  to: string
  subject: string
  template: EmailTemplate
  variables?: Record<string, string>
  /**
   * Variables that must not reach email_audit_log (e.g. one-time codes).
   * They are still rendered into the email.
   */
  secretVariables?: string[]
}

export interface SendEmailResult {
  success: boolean
  messageId?: string
  error?: string
}

export interface EmailAuditLog {
  auditId: string
  to: string
  subject: string
  template: EmailTemplate
  variables?: Record<string, string>
  attempts: Array<{
    attemptId: string
    success: boolean
    resendMessageId?: string
    error?: string
    sentAt: Date
  }>
}

// Template variable types
export interface WelcomeFoundingPartnerVars {
  USER_NAME: string
}

export interface WelcomeRegisteredVars {
  USER_NAME: string
}

export interface WelcomeVars {
  USER_NAME: string
}

export interface EmailVerificationVars {
  USER_NAME: string
  CODE: string
}

export interface PasswordResetVars {
  USER_NAME: string
  CODE: string
}

export interface AccessGrantedVars {
  USER_NAME: string
}

export interface ChangelogUpdateVars {
  UPDATE_DATE: string
  HEADLINE: string
  INTRO_TEXT: string
  FEATURE_TITLE: string
  FEATURE_DESCRIPTION: string
  FEATURE_BOX_TITLE: string
  FEATURE_BOX_TEXT: string
  IMPROVEMENT_TITLE: string
  IMPROVEMENT_DESCRIPTION: string
  COMING_SOON_TEXT: string
  PERSONAL_NOTE: string
  UNSUBSCRIBE_URL: string
}

export interface FeedbackNotificationVars {
  TYPE: string
  TYPE_LABEL: string
  TITLE: string
  SEVERITY?: string
  REPORTED_BY: string
  AGENT_ID: string
  OWNER_ID: string
  DESCRIPTION: string
  FEEDBACK_ID: string
  DATE: string
}

export interface FeedbackResolvedVars {
  FEEDBACK_ID: string
  TITLE: string
  TYPE: string
  TYPE_LABEL: string
  /** Optional admin note explaining what was done. May be empty. */
  RESOLUTION_NOTE: string
  DATE: string
}

/** options.variables without the ones marked secret, for the audit log. */
function auditableVariables(options: SendEmailOptions): Record<string, string> | undefined {
  if (!options.variables || !options.secretVariables?.length) return options.variables
  const secret = new Set(options.secretVariables)
  return Object.fromEntries(Object.entries(options.variables).filter(([key]) => !secret.has(key)))
}

const MAX_RETRIES = 3
const INITIAL_RETRY_DELAY_MS = 8000

export class EmailService {
  private resend: Resend
  private fromEmail: string
  private fromName: string
  private templatesDir: string
  private templateCache: Map<string, string> = new Map()
  private auditCollection: Collection<EmailAuditLog> | null = null

  constructor(
    apiKey: string,
    options?: { fromEmail?: string; fromName?: string; templatesDir?: string; db?: Db },
  ) {
    this.resend = new Resend(apiKey)
    this.fromEmail = options?.fromEmail ?? "hello@teros.ai"
    this.fromName = options?.fromName ?? "Teros"

    if (options?.db) {
      this.auditCollection = options.db.collection<EmailAuditLog>("email_audit_log")
    }

    // Handle both ESM and CommonJS
    if (options?.templatesDir) {
      this.templatesDir = options.templatesDir
    } else if (typeof __dirname !== "undefined") {
      this.templatesDir = path.join(__dirname, "../../templates/emails")
    } else {
      const __filename = fileURLToPath(import.meta.url)
      const __dirname = path.dirname(__filename)
      this.templatesDir = path.join(__dirname, "../../templates/emails")
    }
  }

  async ensureIndexes(): Promise<void> {
    if (this.auditCollection) {
      // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
      // ensureAllIndexes after migrations. Kept for tests and scripts.
      await ensureCollectionIndexes(this.auditCollection, COLLECTIONS.emailAuditLog)
    }
  }

  /**
   * Load and cache a template
   */
  private loadTemplate(template: EmailTemplate): string {
    const cached = this.templateCache.get(template)
    if (cached) return cached

    const templatePath = path.join(this.templatesDir, `${template}.html`)
    const content = fs.readFileSync(templatePath, "utf-8")
    this.templateCache.set(template, content)
    return content
  }

  /**
   * Replace template variables
   */
  private replaceVariables(html: string, variables: Record<string, string>): string {
    let result = html
    for (const [key, value] of Object.entries(variables)) {
      // Function replacement: values are data, so `$&` / `$\`` inside a
      // user-supplied display name must not act as replacement patterns.
      result = result.replace(new RegExp(`{{${key}}}`, "g"), () => value)
    }
    return result
  }

  private async logEmail(
    options: SendEmailOptions,
    result: SendEmailResult,
  ): Promise<void> {
    if (!this.auditCollection) return

    try {
      const attempt = {
        attemptId: generateId("emlat"),
        success: result.success,
        resendMessageId: result.messageId,
        error: result.error,
        sentAt: new Date(),
      }

      // Try to append to existing audit log for this email
      const updateResult = await this.auditCollection.updateOne(
        {
          to: options.to,
          subject: options.subject,
          template: options.template,
        },
        {
          $push: { attempts: attempt },
        },
      )

      // If no document matched, create a new one
      if (updateResult.matchedCount === 0) {
        await this.auditCollection.insertOne({
          auditId: generateId("eml"),
          to: options.to,
          subject: options.subject,
          template: options.template,
          variables: auditableVariables(options),
          attempts: [attempt],
        })
      }
    } catch (err) {
      console.error("[EmailService] Failed to write audit log:", err)
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async sendOnce(html: string, options: SendEmailOptions): Promise<SendEmailResult> {
    try {
      const resendResult = await this.resend.emails.send({
        from: `${this.fromName} <${this.fromEmail}>`,
        to: options.to,
        subject: options.subject,
        html,
      })

      if (resendResult.error) {
        console.error("[EmailService] Resend error:", resendResult.error)
        return { success: false, error: resendResult.error.message }
      }

      console.log(`[EmailService] Email sent: ${options.template} -> ${options.to}`)
      return { success: true, messageId: resendResult.data?.id }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error"
      console.error("[EmailService] Error sending email:", message)
      return { success: false, error: message }
    }
  }

  async send(options: SendEmailOptions): Promise<SendEmailResult> {
    if (!this.auditCollection) {
      return { success: false, error: "Email audit logging is not configured (no database)" }
    }

    let html = this.loadTemplate(options.template)

    const { config } = require("../config")
    const baseVariables: Record<string, string> = {
      STATIC_BASE_URL: config.static.baseUrl,
    }

    const allVariables = { ...baseVariables, ...options.variables }
    html = this.replaceVariables(html, allVariables)

    let delay = INITIAL_RETRY_DELAY_MS
    let result: SendEmailResult = { success: false, error: "No attempts made" }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        console.log(
          `[EmailService] Retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${MAX_RETRIES + 1})`,
        )
        await this.sleep(delay)
        delay *= 2
      }

      result = await this.sendOnce(html, options)
      await this.logEmail(options, result)

      if (result.success) return result
    }

    return result
  }

  // ============================================
  // Convenience methods for each email type
  // ============================================

  /**
   * Send welcome email to Founding Partner (VIP early access)
   */
  async sendWelcomeFoundingPartner(
    to: string,
    vars: WelcomeFoundingPartnerVars,
  ): Promise<SendEmailResult> {
    return this.send({
      to,
      subject: "You're in. Welcome to the beginning.",
      template: "welcome-founding-partner",
      variables: vars as unknown as Record<string, string>,
    })
  }

  /**
   * Send welcome email to new registered user (waitlisted)
   */
  async sendWelcomeRegistered(to: string, vars: WelcomeRegisteredVars): Promise<SendEmailResult> {
    return this.send({
      to,
      subject: "You're on the list — here's what's next",
      template: "welcome-registered",
      variables: vars as unknown as Record<string, string>,
    })
  }

  /**
   * Send welcome email to a new user who already has platform access
   * (no waitlist). Distinct from sendWelcomeRegistered, which is the
   * legacy "you're on the list" email.
   */
  async sendWelcome(to: string, vars: WelcomeVars): Promise<SendEmailResult> {
    return this.send({
      to,
      subject: "Welcome to Teros",
      template: "welcome",
      variables: vars as unknown as Record<string, string>,
    })
  }

  /**
   * Send the 6-digit code that confirms a password account's email.
   * The code is rendered into the email but kept out of the audit log.
   */
  async sendEmailVerification(to: string, vars: EmailVerificationVars): Promise<SendEmailResult> {
    return this.send({
      to,
      // Fixed subject: the audit log stores subjects, so the code can't go here.
      subject: "Your Teros verification code",
      template: "email-verification",
      variables: vars as unknown as Record<string, string>,
      secretVariables: ["CODE"],
    })
  }

  /**
   * Send the 6-digit code that lets the owner of an address set a new password.
   * The code is rendered into the email but kept out of the audit log.
   */
  async sendPasswordReset(to: string, vars: PasswordResetVars): Promise<SendEmailResult> {
    return this.send({
      to,
      // Fixed subject: the audit log stores subjects, so the code can't go here.
      subject: "Your Teros password reset code",
      template: "password-reset",
      variables: vars as unknown as Record<string, string>,
      secretVariables: ["CODE"],
    })
  }

  /**
   * Send access granted email
   */
  async sendAccessGranted(to: string, vars: AccessGrantedVars): Promise<SendEmailResult> {
    return this.send({
      to,
      subject: "You're in. Welcome to Teros.",
      template: "access-granted",
      variables: vars as unknown as Record<string, string>,
    })
  }

  /**
   * Send changelog/update email
   */
  async sendChangelogUpdate(to: string, vars: ChangelogUpdateVars): Promise<SendEmailResult> {
    return this.send({
      to,
      subject: `What's new: ${vars.HEADLINE}`,
      template: "changelog-update",
      variables: vars as unknown as Record<string, string>,
    })
  }

  /**
   * Send feedback notification (bug or suggestion) to support team
   */
  async sendFeedbackNotification(to: string, vars: FeedbackNotificationVars): Promise<SendEmailResult> {
    const severityRow = vars.SEVERITY
      ? `<tr><td style="padding-bottom: 10px;"><span style="font-size: 12px; color: #A1A1AA;">Severity:</span><span style="font-size: 13px; color: #FAFAFA; font-weight: 500;">${vars.SEVERITY}</span></td></tr>`
      : '<tr><td></td></tr>'

    // Convert newlines to <br> for email HTML rendering across all clients
    const descriptionHtml = vars.DESCRIPTION.replace(/\n/g, '<br>')

    const variables: Record<string, string> = {
      ...vars as unknown as Record<string, string>,
      SEVERITY_ROW: severityRow,
      DESCRIPTION: descriptionHtml,
    }

    return this.send({
      to,
      subject: `[${vars.TYPE_LABEL}] ${vars.TITLE}`,
      template: "feedback-notification",
      variables,
    })
  }

  /**
   * Send "your report is done" email to the reporter of a feedback item.
   * Used by FeedbackAdminService when an item transitions to resolved.
   */
  async sendFeedbackResolved(to: string, vars: FeedbackResolvedVars): Promise<SendEmailResult> {
    // Convert newlines to <br> for email HTML rendering across all clients
    const noteHtml = vars.RESOLUTION_NOTE.replace(/\n/g, "<br>")

    const variables: Record<string, string> = {
      ...vars as unknown as Record<string, string>,
      RESOLUTION_NOTE: noteHtml,
    }

    return this.send({
      to,
      subject: `Re: [${vars.TYPE_LABEL}] ${vars.TITLE} — completed`,
      template: "feedback-resolved",
      variables,
    })
  }

  /**
   * Clear template cache (useful for development)
   */
  clearCache(): void {
    this.templateCache.clear()
  }
}

// Singleton instance (initialized when needed)
let emailServiceInstance: EmailService | null = null

export function getEmailService(db?: Db): EmailService {
  if (!emailServiceInstance) {
    const { config } = require("../config")
    const emailSecret = secrets.system("email")
    if (!emailSecret?.resendApiKey) {
      throw new Error(
        "Resend API key not configured.\n" +
          "Add it to .secrets/system/email.json:\n" +
          '  { "resendApiKey": "re_..." }',
      )
    }
    emailServiceInstance = new EmailService(emailSecret.resendApiKey, {
      fromEmail: config.email.fromEmail,
      fromName: config.email.fromName,
      db,
    })
  }
  return emailServiceInstance
}

/**
 * Check if email service is configured. The optional `secretsManager`
 * argument exists because under tsx + ESM the module singleton can be
 * initialised twice (CJS interop) and the second instance throws on
 * `loaded=false`; callers that already `.load()`-ed an instance pass it in.
 */
export function isEmailConfigured(secretsManager?: import("../secrets/secrets-manager").SecretsManager): boolean {
  const sm = secretsManager ?? secrets
  const emailSecret = sm.system("email")
  return !!emailSecret?.resendApiKey
}
