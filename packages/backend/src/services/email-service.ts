/**
 * Email Service
 *
 * Handles all transactional emails using Resend.
 * Templates are stored in /templates/emails/
 */

import * as fs from "fs"
import { createRequire } from "module"
import * as path from "path"
import { Resend } from "resend"
import { fileURLToPath } from "url"

const require = createRequire(import.meta.url)

// Email types
export type EmailTemplate =
  | "welcome-registered"
  | "invitation-received"
  | "access-granted"
  | "changelog-update"

interface SendEmailOptions {
  to: string
  subject: string
  template: EmailTemplate
  variables?: Record<string, string>
}

interface SendEmailResult {
  success: boolean
  messageId?: string
  error?: string
}

// Template variable types
export interface WelcomeRegisteredVars {
  USER_NAME: string
}

export interface InvitationReceivedVars {
  USER_NAME: string
  INVITER_NAME: string
  INVITER_INITIALS: string
  CURRENT_COUNT: string
  REMAINING_COUNT: string
  REMAINING_PLURAL: string
  DOT_1_CLASS: string
  DOT_2_CLASS: string
  DOT_3_CLASS: string
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

export class EmailService {
  private resend: Resend
  private fromEmail: string
  private fromName: string
  private templatesDir: string
  private templateCache: Map<string, string> = new Map()

  constructor(
    apiKey: string,
    options?: { fromEmail?: string; fromName?: string; templatesDir?: string },
  ) {
    this.resend = new Resend(apiKey)
    this.fromEmail = options?.fromEmail ?? "hello@teros.ai"
    this.fromName = options?.fromName ?? "Teros"

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
      result = result.replace(new RegExp(`{{${key}}}`, "g"), value)
    }
    return result
  }

  /**
   * Send an email using a template
   */
  async send(options: SendEmailOptions): Promise<SendEmailResult> {
    try {
      let html = this.loadTemplate(options.template)

      // Always inject STATIC_BASE_URL
      const { config } = require("../config")
      const baseVariables: Record<string, string> = {
        STATIC_BASE_URL: config.static.baseUrl,
      }

      const allVariables = { ...baseVariables, ...options.variables }
      html = this.replaceVariables(html, allVariables)

      const result = await this.resend.emails.send({
        from: `${this.fromName} <${this.fromEmail}>`,
        to: options.to,
        subject: options.subject,
        html,
      })

      if (result.error) {
        console.error("[EmailService] Resend error:", result.error)
        return { success: false, error: result.error.message }
      }

      console.log(`[EmailService] Email sent: ${options.template} -> ${options.to}`)
      return { success: true, messageId: result.data?.id }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error"
      console.error("[EmailService] Error sending email:", message)
      return { success: false, error: message }
    }
  }

  // ============================================
  // Convenience methods for each email type
  // ============================================

  /**
   * Send welcome email to new registered user (0/3 invitations)
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
   * Send notification when user receives an invitation (1/3 or 2/3)
   */
  async sendInvitationReceived(to: string, vars: InvitationReceivedVars): Promise<SendEmailResult> {
    const remaining = parseInt(vars.REMAINING_COUNT)
    const subject =
      remaining === 1
        ? `${vars.INVITER_NAME} invited you — just 1 more to go`
        : `${vars.INVITER_NAME} invited you — ${remaining} more to go`

    return this.send({
      to,
      subject,
      template: "invitation-received",
      variables: vars as unknown as Record<string, string>,
    })
  }

  /**
   * Send access granted email (3/3 invitations)
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
   * Clear template cache (useful for development)
   */
  clearCache(): void {
    this.templateCache.clear()
  }
}

// Singleton instance (initialized when needed)
let emailServiceInstance: EmailService | null = null

export function getEmailService(): EmailService {
  if (!emailServiceInstance) {
    const { config } = require("../config")
    const { secrets } = require("../secrets/secrets-manager")

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
    })
  }
  return emailServiceInstance
}

/**
 * Check if email service is configured
 */
export function isEmailConfigured(): boolean {
  const { secrets } = require("../secrets/secrets-manager")
  const emailSecret = secrets.system("email")
  return !!emailSecret?.resendApiKey
}
