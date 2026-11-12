/**
 * AutomateApi — typed client for the Automate domain (model v2).
 *
 * Uses the WebSocket transport (transport.request) to call the backend
 * handlers registered under the `automate.*` namespace.
 */

import type { Transport } from './transport/types'
import type {
  AutomateQuota,
  AutomateStarter,
  CreateStarterInput,
  ParseScheduleResult,
  ListCallsResult,
  ListEventTopicsResult,
  ListExecutionsResult,
  ListFlowsResult,
  ListStartersResult,
  StarterMutationResult,
  TestWebhookResult,
  UpdateStarterInput,
} from '../windows/AutomateWindow/types/automate'

export class AutomateApi {
  constructor(private readonly transport: Transport) {}

  /** List all starters in the workspace, with display names and 7-day stats. */
  async listStarters(workspaceId: string): Promise<ListStartersResult> {
    return this.transport.request<ListStartersResult>('automate.list', { workspaceId })
  }

  /** One starter with display names and 7-day stats. */
  async getStarter(starterId: string): Promise<{ starter: AutomateStarter }> {
    return this.transport.request<{ starter: AutomateStarter }>('automate.get', { starterId })
  }

  /** Execution history of a starter, newest first. */
  async listExecutions(starterId: string, opts: { limit?: number; cursor?: string } = {}): Promise<ListExecutionsResult> {
    return this.transport.request<ListExecutionsResult>('automate.list-executions', { starterId, ...opts })
  }

  /** The caller's daily Automate execution budget (plan cap, used today, reset, busiest automations). */
  async getQuota(): Promise<AutomateQuota> {
    return this.transport.request<AutomateQuota>('automate.quota', {})
  }

  /** Event catalog of the workspace (topics the installed apps declare). */
  async listEventTopics(workspaceId: string): Promise<ListEventTopicsResult> {
    return this.transport.request<ListEventTopicsResult>('app.list-event-topics', { workspaceId })
  }

  /**
   * Translate a natural-language schedule (or raw cron) into canonical cron +
   * human description + next occurrences. Read-only — powers the form's
   * always-on preview as the user types (v1.4.4).
   */
  async parseSchedule(workspaceId: string, expression: string, opts: { timezone?: string; locale?: string } = {}): Promise<ParseScheduleResult> {
    return this.transport.request<ParseScheduleResult>('automate.parse-schedule', {
      workspaceId,
      expression,
      ...opts,
    })
  }

  /** Create a starter (any trigger × any action). `url` comes back once for webhooks. */
  async createStarter(workspaceId: string, input: CreateStarterInput): Promise<StarterMutationResult> {
    return this.transport.request<StarterMutationResult>('automate.create-starter', {
      workspaceId,
      ...input,
    })
  }

  /** Patch a starter. `url` comes back once when the trigger was switched to webhook. */
  async updateStarter(
    workspaceId: string,
    starterId: string,
    input: UpdateStarterInput,
  ): Promise<StarterMutationResult> {
    return this.transport.request<StarterMutationResult>('automate.update-starter', {
      workspaceId,
      starterId,
      ...input,
    })
  }

  async deleteStarter(workspaceId: string, starterId: string): Promise<{ deleted: true }> {
    return this.transport.request<{ deleted: true }>('automate.delete', {
      workspaceId,
      starterId,
    })
  }

  async setEnabled(
    workspaceId: string,
    starterId: string,
    enabled: boolean,
  ): Promise<{ starter: AutomateStarter }> {
    return this.transport.request<{ starter: AutomateStarter }>('automate.set-enabled', {
      workspaceId,
      starterId,
      enabled,
    })
  }

  /** Rotate a webhook token. The new URL is shown once. */
  async regenerateWebhookUrl(workspaceId: string, starterId: string): Promise<{ url: string }> {
    return this.transport.request<{ url: string }>('automate.regenerate-url', {
      workspaceId,
      starterId,
    })
  }

  /** Recent calls received by a webhook starter (newest first). */
  async listWebhookCalls(starterId: string): Promise<ListCallsResult> {
    return this.transport.request<ListCallsResult>('automate.list-calls', { starterId })
  }

  /** Fire a webhook starter from the UI with a test payload. */
  async testWebhook(starterId: string, payload: Record<string, unknown>): Promise<TestWebhookResult> {
    return this.transport.request<TestWebhookResult>('automate.test-webhook', { starterId, payload })
  }

  /** Workspace flows (picker data for the start-flow action). */
  async listFlows(workspaceId: string): Promise<ListFlowsResult> {
    return this.transport.request<ListFlowsResult>('automate.list-flows', { workspaceId })
  }
}
