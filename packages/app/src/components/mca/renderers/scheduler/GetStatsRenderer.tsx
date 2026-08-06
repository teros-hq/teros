/**
 * Scheduler — get-stats renderer.
 *
 * Output: { active: { reminders, recurringTasks }, nextScheduledAt, nextScheduledIso, nextScheduledHumanReadable, timezone }.
 * Split out of -health-check (criterio 7 RUNBOOK: HealthCheckBuilder shape canónico).
 */

import { CalendarClock } from '@tamagui/lucide-icons';
import type React from 'react';
import {
  colors as globalColors,
  ErrorBlock,
  IconTile,
  parseOutput,
  ResourceCard,
  Specsheet,
  type SpecsheetSection,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { SchedulerToolShell, STATUS_ACCENT } from './shared';

interface StatsResult {
  active?: { reminders: number; recurringTasks: number };
  nextScheduledAt?: number | null;
  nextScheduledIso?: string | null;
  nextScheduledHumanReadable?: string | null;
  timezone?: string;
}

/**
 * Stats as a 2-section `Specsheet` — separates the *current* active state from
 * the *future* scheduled run. Each section answers a different question:
 * "what's running now?" vs "when does the next thing fire?".
 */
function statsSections(r: StatsResult): SpecsheetSection[] {
  const out: SpecsheetSection[] = [];
  if (r.active) {
    out.push({
      title: 'Active',
      rows: [
        { key: 'reminders', value: String(r.active.reminders) },
        { key: 'recurring', value: String(r.active.recurringTasks) },
        { key: 'total', value: String(r.active.reminders + r.active.recurringTasks) },
      ],
    });
  }
  const scheduled: SpecsheetSection['rows'] = [];
  if (r.nextScheduledHumanReadable) scheduled.push({ key: 'next run', value: r.nextScheduledHumanReadable });
  if (r.nextScheduledIso) scheduled.push({ key: 'next iso', value: r.nextScheduledIso });
  if (r.timezone) scheduled.push({ key: 'timezone', value: r.timezone });
  if (scheduled.length > 0) out.push({ title: 'Scheduled', rows: scheduled });
  return out;
}

export function GetStatsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const raw = output ? parseOutput<StatsResult>(output) : null;
  const result =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as StatsResult) : null;
  const totalActive = (result?.active?.reminders ?? 0) + (result?.active?.recurringTasks ?? 0);

  return (
    <SchedulerToolShell toolName={toolName} status={status} duration={duration}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && result && (
        <ResourceCard
          leading={
            <IconTile
              icon={<CalendarClock size={14} color={STATUS_ACCENT.enabled} />}
              accent={STATUS_ACCENT.enabled}
              size={28}
            />
          }
          title={`${totalActive} active item${totalActive === 1 ? '' : 's'}`}
          subtitle={result.nextScheduledHumanReadable ?? 'No scheduled runs.'}
        >
          {statsSections(result).length > 0 && <Specsheet sections={statsSections(result)} />}
        </ResourceCard>
      )}
    </SchedulerToolShell>
  );
}
