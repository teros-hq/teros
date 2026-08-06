/**
 * mca.hunter — Health check sub-renderer.
 *
 * `-health-check` is part of every MCA (SDK contract). Output shape:
 * `{ status, issues?, version?, uptime? }`. Composes global primitives;
 * the Hunter logo (via HunterToolShell iconUri) brands the card.
 */

import { CheckCircle2, XCircle } from '../../primitives';
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
import { type HealthCheckOutput, HunterToolShell } from './shared';

type HealthStatus = 'ready' | 'not_ready' | 'degraded' | string;

const STATUS_ACCENT: Record<string, string> = {
  ready: globalColors.green,
  degraded: globalColors.amber,
  not_ready: globalColors.red,
};

const STATUS_TITLE: Record<string, string> = {
  ready: 'Healthy',
  degraded: 'Degraded',
  not_ready: 'Not ready',
};

const STATUS_LABEL: Record<string, string> = {
  ready: 'READY',
  degraded: 'DEGRADED',
  not_ready: 'NOT READY',
};

function issueAccent(code: string): string {
  if (code.startsWith('AUTH_')) return globalColors.red;
  if (code === 'DEPENDENCY_UNAVAILABLE' || code === 'RATE_LIMITED' || code === 'QUOTA_EXCEEDED')
    return globalColors.amber;
  if (code.endsWith('CONFIG_MISSING') || code === 'CONFIG_INVALID') return globalColors.amber;
  return globalColors.muted;
}

function formatUptime(seconds: number | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function resultRows(result: HealthCheckOutput): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  if (result.version) rows.push({ key: 'version', value: result.version });
  const uptime = formatUptime(result.uptime);
  if (uptime) rows.push({ key: 'uptime', value: uptime });
  return rows;
}

export function HealthCheckRenderer({
  toolName,
  status,
  output,
  error,
  appIcon,
}: ToolCallRendererProps): React.ReactNode {
  const parsed = output ? parseOutput<HealthCheckOutput>(output) : null;
  const result =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'status' in (parsed as object)
      ? parsed
      : null;

  const healthStatus: HealthStatus = result?.status ?? 'ready';
  const issues = result?.issues ?? [];
  const healthy = healthStatus === 'ready' && issues.length === 0;
  const accent = STATUS_ACCENT[healthStatus] ?? globalColors.muted;
  const title = STATUS_TITLE[healthStatus] ?? String(healthStatus);

  return (
    <HunterToolShell
      toolName={toolName}
      status={status}
      appIcon={appIcon}
      verb="Health check"
      defaultExpanded={false}
    >
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <ResourceCard
          leading={
            <IconTile
              accent={accent}
              icon={healthy ? <CheckCircle2 size={16} color={accent} /> : <XCircle size={16} color={accent} />}
              size={28}
            />
          }
          title={title}
          subtitle={result?.version ? `Hunter MCA v${result.version}` : undefined}
          meta={<IconChip text={STATUS_LABEL[healthStatus] ?? String(healthStatus).toUpperCase()} accent={accent} />}
        >
          {result && resultRows(result).length > 0 && <KeyValueGrid rows={resultRows(result)} />}
          {healthy && <SuccessBlock message="All checks passed." />}
          {issues.length > 0 && (
            <YStack gap={6}>
              <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                issues ({issues.length})
              </Text>
              {issues.map((issue, i) => (
                <YStack
                  key={`${issue.code}-${i}`}
                  gap={4}
                  padding={8}
                  borderRadius={5}
                  backgroundColor={`${issueAccent(issue.code)}12`}
                  borderWidth={1}
                  borderColor={`${issueAccent(issue.code)}33`}
                >
                  <IconChip text={issue.code} accent={issueAccent(issue.code)} />
                  <Text color={globalColors.primary} fontSize={10}>
                    {issue.message}
                  </Text>
                  {issue.action?.description && (
                    <Text color={globalColors.secondary} fontSize={9}>
                      → {issue.action.description}
                    </Text>
                  )}
                </YStack>
              ))}
            </YStack>
          )}
        </ResourceCard>
      )}
    </HunterToolShell>
  );
}
