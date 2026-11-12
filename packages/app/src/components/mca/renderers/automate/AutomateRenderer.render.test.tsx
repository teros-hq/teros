/**
 * mca.teros.automate renderer — structure-asserting render tests.
 *
 *   1. create-automation completed → header names the automation, ACTIVE
 *      badge, when/then rows, webhook URL masked until revealed.
 *   2. list-automations completed → one row per automation with its status.
 *   3. delete-automation → irreversible card with the id.
 *   4. parse-time-expression (cron) → cron + meaning rows.
 *   5. every tool in tools.json has a renderer (no dev fallback).
 */

import '../../../../i18n';
import { fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithTamagui } from '../../../../test/renderWithTamagui';
import type { ToolCallRendererProps } from '../../types';
import toolsJson from '../../../../../../../mcas/mca.teros.automate/tools.json';
import { AutomateToolCallRenderer, __TEST_RENDERERS } from './index';

function render(props: Partial<ToolCallRendererProps> & { toolName: string }) {
  const merged = { toolCallId: 'tc1', status: 'completed', ...props } as ToolCallRendererProps;
  return renderWithTamagui(<AutomateToolCallRenderer {...merged} />);
}

const automation = {
  automationId: 'starter_0123456789abcdef',
  name: 'GitHub issues → tasks',
  enabled: true,
  trigger: { kind: 'webhook', callCount: 0 },
  action: { kind: 'create-task', projectName: 'Teros', agentName: 'Nira', columnName: 'To Do' },
  stats: { avgDailyRuns7d: 0 },
};

describe('AutomateRenderer', () => {
  it('create-automation: names the automation, shows when/then and masks the webhook URL', () => {
    const r = render({
      toolName: 'automate_create-automation',
      input: { name: 'GitHub issues → tasks' },
      output: JSON.stringify({ action: 'created', automation, webhookUrl: 'https://teros.test/api/v1/webhooks/0123456789abcdef0123456789abcdef' }),
    });
    expect(r.getByText('Created automation “GitHub issues → tasks”')).toBeTruthy();
    expect(r.getByText('ACTIVE')).toBeTruthy();
    expect(r.getByText(/Create task → Teros · Nira · To Do/)).toBeTruthy();
    // masked by default, revealed on demand
    expect(r.queryByText('https://teros.test/api/v1/webhooks/0123456789abcdef0123456789abcdef')).toBeNull();
    fireEvent.click(r.getByLabelText('Reveal'));
    expect(r.getByText('https://teros.test/api/v1/webhooks/0123456789abcdef0123456789abcdef')).toBeTruthy();
  });

  it('list-automations: one row per automation with its status', () => {
    const r = render({
      toolName: 'automate_list-automations',
      output: JSON.stringify({
        items: [
          automation,
          { ...automation, automationId: 'starter_fedcba9876543210', name: 'Daily digest', enabled: false, trigger: { kind: 'schedule', cronDescription: 'Every weekday at 9:00', timezone: 'Europe/Madrid' }, action: { kind: 'channel-event', channelName: 'General' } },
        ],
        count: 2,
      }),
    });
    expect(r.getByText('Listed 2 automations')).toBeTruthy();
    expect(r.getByText('GitHub issues → tasks')).toBeTruthy();
    expect(r.getByText('Daily digest')).toBeTruthy();
    expect(r.getByText('DISABLED')).toBeTruthy();
    expect(r.getByText(/Every weekday at 9:00 · Europe\/Madrid · Message a channel/)).toBeTruthy();
  });

  it('delete-automation: irreversible, shows the id', () => {
    const r = render({ toolName: 'automate_delete-automation', input: { automationId: 'starter_0123456789abcdef' }, output: JSON.stringify({ action: 'deleted', automationId: 'starter_0123456789abcdef' }) });
    expect(r.getByText('Deleted the automation')).toBeTruthy();
    expect(r.getByText('DELETED')).toBeTruthy();
    expect(r.getAllByText('starter_0123456789abcdef').length).toBeGreaterThan(0);
  });

  it('parse-time-expression: cron kind shows the expression and its meaning', () => {
    const r = render({
      toolName: 'automate_parse-time-expression',
      input: { expression: '0 9 * * 1-5' },
      output: JSON.stringify({ kind: 'cron', cronExpression: '0 9 * * 1-5', cronDescription: 'Every weekday at 9:00', timezone: 'UTC', next: [{ at: '2026-10-15T09:00:00.000Z', human: 'tomorrow at 09:00' }] }),
    });
    expect(r.getByText('Read “0 9 * * 1-5” as a time')).toBeTruthy();
    expect(r.getByText('CRON')).toBeTruthy();
    expect(r.getByText('Every weekday at 9:00')).toBeTruthy();
  });

  it('covers every tool declared in tools.json', () => {
    const declared = (toolsJson as { tools: Array<{ name: string }> }).tools.map((t) => t.name).sort();
    const covered = Object.keys(__TEST_RENDERERS).sort();
    expect(covered).toEqual(declared);
  });
});

describe('AutomateRenderer — daily quota', () => {
  it('get-quota: summary line, remaining badge and busiest automations', () => {
    const r = render({
      toolName: 'automate_get-quota',
      output: JSON.stringify({
        limit: 20, used: 7, remaining: 13, exhausted: false, planId: 'plan_starter', planName: 'Starter',
        resetsAt: '2026-10-16T00:00:00.000Z', unlimited: false,
        summary: '7 of 20 Automate runs used today (Starter plan, 13 left, resets at 00:00 UTC).',
        topStarters: [{ starterId: 'starter_1', name: 'Daily digest', workspaceId: 'w', count: 7 }],
      }),
    })
    expect(r.getByText('Checked the daily budget: 7 of 20 runs')).toBeTruthy()
    expect(r.getByText('7 of 20 Automate runs used today (Starter plan, 13 left, resets at 00:00 UTC).')).toBeTruthy()
    expect(r.getByText('13 LEFT')).toBeTruthy()
    expect(r.getByText('Daily digest')).toBeTruthy()
  })

  it('get-quota: spent / unlimited badges', () => {
    const spent = render({ toolName: 'automate_get-quota', output: JSON.stringify({ limit: 5, used: 5, remaining: 0, exhausted: true, planName: 'Seed', resetsAt: 'x', topStarters: [] }) })
    expect(spent.getByText('SPENT')).toBeTruthy()
    const unlimited = render({ toolName: 'automate_get-quota', output: JSON.stringify({ limit: 0, used: 0, remaining: null, exhausted: false, planName: 'Enterprise', resetsAt: 'x', unlimited: true, topStarters: [] }) })
    expect(unlimited.getByText('UNLIMITED')).toBeTruthy()
  })

  it('list-executions: a skipped row gets the SKIPPED badge and says why', () => {
    const r = render({
      toolName: 'automate_list-executions',
      output: JSON.stringify({ items: [
        { executionId: 'e1', source: 'schedule', ok: true, at: '2026-10-15T09:00:00.000Z', agoHuman: 'today' },
        { executionId: 'e2', source: 'schedule', ok: false, skipped: true, skippedBy: 'daily-quota', error: 'quota-automate_daily_limit: 5/5', at: '2026-10-15T09:01:00.000Z', agoHuman: 'today' },
      ], count: 2, skipped: 1 }),
    })
    expect(r.getByText('SKIPPED')).toBeTruthy()
    expect(r.getByText('Skipped: the daily Automate budget was spent')).toBeTruthy()
  })
})
