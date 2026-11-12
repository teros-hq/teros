#!/usr/bin/env bun

/**
 * Automate MCA v1.0.0
 *
 * Agent tools for Automate: automations that couple a trigger (schedule,
 * once, webhook, event) with an action (create a task, message a channel,
 * start a flow). Replaces mca.teros.scheduler (reminders + recurring tasks
 * are once / schedule automations that message a channel).
 *
 * This MCA owns NO data. Every tool is a `domain_request` over the MCA
 * WebSocket to the backend's `automate.*` handlers — the same ones the
 * Automate window uses — with the tool's acting identity. Natural-language
 * time parsing (chrono-node) and cron helpers (croner) run here, before the
 * call. Execution lives in the backend's AutomateRunner.
 */

import { McaServer } from '@teros/mca-sdk';
import { initializeWsClient } from './lib';
import {
  bulkCancel,
  cancelReminder,
  createAutomation,
  createRecurringTask,
  createWebhook,
  deleteAutomation,
  disableAutomation,
  enableAutomation,
  getAutomation,
  getQuota,
  healthCheck,
  listAutomations,
  listEventTopics,
  listExecutions,
  listUpcoming,
  listWebhookCalls,
  parseTimeExpressionTool,
  regenerateWebhookUrl,
  scheduleReminder,
  snoozeReminder,
  testWebhook,
  updateAutomation,
} from './tools';

const server = new McaServer({
  id: 'mca.teros.automate',
  name: 'Automate',
  version: '1.0.0',
});

// Internal
server.tool('-health-check', healthCheck);

// Query
server.tool('list-automations', listAutomations);
server.tool('get-automation', getAutomation);
server.tool('list-executions', listExecutions);
server.tool('get-quota', getQuota);
server.tool('list-webhook-calls', listWebhookCalls);
server.tool('list-upcoming', listUpcoming);
server.tool('list-event-topics', listEventTopics);
server.tool('parse-time-expression', parseTimeExpressionTool);

// Create
server.tool('create-automation', createAutomation);
server.tool('schedule-reminder', scheduleReminder);
server.tool('create-recurring-task', createRecurringTask);
server.tool('create-webhook', createWebhook);

// Modify
server.tool('update-automation', updateAutomation);
server.tool('enable-automation', enableAutomation);
server.tool('disable-automation', disableAutomation);
server.tool('snooze-reminder', snoozeReminder);
server.tool('regenerate-webhook-url', regenerateWebhookUrl);
server.tool('test-webhook', testWebhook);

// Delete
server.tool('delete-automation', deleteAutomation);
server.tool('cancel-reminder', cancelReminder);
server.tool('bulk-cancel', bulkCancel);

async function main(): Promise<void> {
  await initializeWsClient();
  await server.start();
  console.error('Automate MCA running (tools over the backend automate.* API; execution by AutomateRunner)');
}

main().catch((error) => {
  console.error('[Automate MCA] Fatal error:', error);
  process.exit(1);
});
