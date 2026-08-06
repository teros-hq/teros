/**
 * Scheduler — Health check renderer.
 *
 * Output shape: HealthCheckResult { status, issues?, version?, uptime? } —
 * canonical SDK shape, nothing extra. Active counts and nextScheduled live in
 * the dedicated `get-stats` tool / GetStatsRenderer (criterio 7 RUNBOOK).
 */

import { CheckCircle2, XCircle } from '@tamagui/lucide-icons';
import type React from 'react';
import { Text, YStack } from 'tamagui';
import {
  colors as globalColors,
  ErrorBlock,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  parseOutput,
  ResourceCard,
  SuccessBlock,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { SchedulerToolShell, STATUS_ACCENT } from './shared';

type HealthStatus = 'ready' | 'not_ready' | 'degraded';

interface HealthIssue {
  code: string;
  message: string;
  action?: { type: 'user_action' | 'admin_action' | 'auto_retry'; description: string; url?: string };
}

interface HealthCheckResult {
  status: HealthStatus;
  issues?: HealthIssue[];
  version?: string;
  uptime?: number;
}

const STATUS_TITLE: Record<HealthStatus, string> = {
  ready: 'Healthy',
  degraded: 'Degraded',
  not_ready: 'Not ready',
};

const HEALTH_ACCENT: Record<HealthStatus, string> = {
  ready: STATUS_ACCENT.success,
  degraded: globalColors.warning,
  not_ready: STATUS_ACCENT.failure,
};

function formatUptime(seconds: number | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function rowsForResult(r: HealthCheckResult): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  if (r.version) rows.push({ key: 'version', value: r.version });
  const uptime = formatUptime(r.uptime);
  if (uptime) rows.push({ key: 'uptime', value: uptime });
  return rows;
}

export function HealthCheckRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<HealthCheckResult>(output) : null;
  const result =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'status' in (parsed as object)
      ? (parsed as HealthCheckResult)
      : null;

  const healthStatus: HealthStatus = result?.status ?? 'ready';
  const issues = result?.issues ?? [];
  const healthy = healthStatus === 'ready' && issues.length === 0;
  const accent = HEALTH_ACCENT[healthStatus];
  const title = STATUS_TITLE[healthStatus];

  return (
    <SchedulerToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      verb="check"
      defaultExpanded={status === 'completed' && !healthy}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <ResourceCard
          leading={
            <IconTile
              accent={accent}
              icon={
                healthy ? (
                  <CheckCircle2 size={16} color={accent} />
                ) : (
                  <XCircle size={16} color={accent} />
                )
              }
              size={28}
            />
          }
          title={title}
          subtitle={result?.version ? `Scheduler MCA v${result.version}` : undefined}
          meta={<IconChip text={healthStatus.toUpperCase()} accent={accent} />}
        >
          {result && rowsForResult(result).length > 0 && <KeyValueGrid rows={rowsForResult(result)} />}
          {healthy && <SuccessBlock message="All checks passed." />}
          {issues.length > 0 && (
            <YStack gap={6}>
              <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                issues ({issues.length})
              </Text>
              {issues.map((issue, i) => (
                <YStack
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable list
                  key={`${issue.code}-${i}`}
                  gap={4}
                  padding={8}
                  borderRadius={5}
                  backgroundColor={`${HEALTH_ACCENT.degraded}12`}
                  borderWidth={1}
                  borderColor={`${HEALTH_ACCENT.degraded}33`}
                >
                  <IconChip text={issue.code} accent={HEALTH_ACCENT.degraded} />
                  <Text color={globalColors.primary} fontSize={10}>
                    {issue.message}
                  </Text>
                  {issue.action && (
                    <Text color={globalColors.secondary} fontSize={9}>
                      → {issue.action.description}
                      {issue.action.url ? ` (${issue.action.url})` : ''}
                    </Text>
                  )}
                </YStack>
              ))}
            </YStack>
          )}
        </ResourceCard>
      )}
    </SchedulerToolShell>
  );
}
