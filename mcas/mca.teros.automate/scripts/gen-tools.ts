#!/usr/bin/env bun
/**
 * Generate tools.json and i18n/en.json from the tool definitions, so the
 * catalog (sync-mcas) and the LLM always see what the code declares.
 *
 *   bun scripts/gen-tools.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import * as tools from '../src/tools';
import manifest from '../manifest.json';

const ORDER: Array<[string, keyof typeof tools]> = [
  ['-health-check', 'healthCheck'],
  ['list-automations', 'listAutomations'],
  ['get-automation', 'getAutomation'],
  ['list-executions', 'listExecutions'],
  ['get-quota', 'getQuota'],
  ['list-webhook-calls', 'listWebhookCalls'],
  ['list-upcoming', 'listUpcoming'],
  ['list-event-topics', 'listEventTopics'],
  ['parse-time-expression', 'parseTimeExpressionTool'],
  ['create-automation', 'createAutomation'],
  ['schedule-reminder', 'scheduleReminder'],
  ['create-recurring-task', 'createRecurringTask'],
  ['create-webhook', 'createWebhook'],
  ['update-automation', 'updateAutomation'],
  ['enable-automation', 'enableAutomation'],
  ['disable-automation', 'disableAutomation'],
  ['snooze-reminder', 'snoozeReminder'],
  ['regenerate-webhook-url', 'regenerateWebhookUrl'],
  ['test-webhook', 'testWebhook'],
  ['delete-automation', 'deleteAutomation'],
  ['cancel-reminder', 'cancelReminder'],
  ['bulk-cancel', 'bulkCancel'],
];

const root = path.resolve(import.meta.dir, '..');

const toolsJson = {
  $schema: 'https://teros.ai/schemas/mca-tools.json',
  mcaId: manifest.id,
  tools: ORDER.map(([name, key]) => {
    const t = tools[key] as { description: string; parameters: Record<string, unknown>; annotations?: Record<string, unknown> };
    return { name, description: t.description, inputSchema: t.parameters, annotations: t.annotations ?? {} };
  }),
};
fs.writeFileSync(path.join(root, 'tools.json'), `${JSON.stringify(toolsJson, null, 2)}\n`);

const en = {
  name: manifest.name,
  description: manifest.description,
  tools: Object.fromEntries(
    ORDER.map(([name, key]) => {
      const t = tools[key] as { description: string; parameters: { properties: Record<string, { description?: string }> } };
      const params = Object.fromEntries(
        Object.entries(t.parameters.properties ?? {})
          .filter(([, p]) => typeof p.description === 'string')
          .map(([k, p]) => [k, p.description]),
      );
      return [name, { name, description: t.description, params }];
    }),
  ),
  changelog: Object.fromEntries(manifest.changelog.map((c) => [c.version, c.notes])),
};
fs.mkdirSync(path.join(root, 'i18n'), { recursive: true });
fs.writeFileSync(path.join(root, 'i18n', 'en.json'), `${JSON.stringify(en, null, 2)}\n`);

console.log(`tools.json: ${toolsJson.tools.length} tools · i18n/en.json written`);
