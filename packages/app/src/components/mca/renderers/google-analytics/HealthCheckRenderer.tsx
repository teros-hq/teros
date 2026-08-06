/**
 * GA4 Renderer — Health check. Shape: HealthCheckResult from @teros/mca-sdk.
 */

import { CheckCircle2, XCircle } from '@tamagui/lucide-icons';
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
import { GoogleAnalyticsToolShell } from './shared';

type HealthStatus = 'ready' | 'not_ready' | 'degraded';
type HealthActionType = 'user_action' | 'admin_action' | 'auto_retry';

interface HealthIssue {
  code: string;
  message: string;
  action?: { type: HealthActionType; description: string; url?: string };
}

interface HealthCheckResult {
  status: HealthStatus;
  issues?: HealthIssue[];
  version?: string;
  uptime?: number;
}

const STATUS_ACCENT: Record<HealthStatus, string> = {
  ready: globalColors.green,
  degraded: globalColors.amber,
  not_ready: globalColors.red,
};

const STATUS_TITLE: Record<HealthStatus, string> = {
  ready: 'Healthy',
  degraded: 'Degraded',
  not_ready: 'Not ready',
};

const STATUS_LABEL: Record<HealthStatus, string> = {
  ready: 'READY',
  degraded: 'DEGRADED',
  not_ready: 'NOT READY',
};

function issueAccent(code: string): string {
  if (code.startsWith('AUTH_')) return globalColors.red;
  if (
    code === 'DEPENDENCY_UNAVAILABLE' ||
    code === 'RATE_LIMITED' ||
    code === 'QUOTA_EXCEEDED' ||
    code === 'NO_ACCESS'
  )
    return globalColors.amber;
  if (
    code === 'SYSTEM_CONFIG_MISSING' ||
    code === 'USER_CONFIG_MISSING' ||
    code === 'CONFIG_INVALID'
  )
    return globalColors.amber;
  return globalColors.muted;
}

function formatUptime(seconds: number | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function resultRows(result: HealthCheckResult): KeyValueRow[] {
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
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<HealthCheckResult>(output) : null;
  const result =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'status' in (parsed as any)
      ? (parsed as HealthCheckResult)
      : null;

  const healthStatus: HealthStatus = result?.status ?? 'ready';
  const issues = result?.issues ?? [];
  const healthy = healthStatus === 'ready' && issues.length === 0;
  const accent = STATUS_ACCENT[healthStatus];
  const title = STATUS_TITLE[healthStatus];

  return (
    <GoogleAnalyticsToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      description="Health check"
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
          subtitle={result?.version ? `Google Analytics MCA v${result.version}` : undefined}
          meta={<IconChip text={STATUS_LABEL[healthStatus]} accent={accent} />}
        >
          {result && resultRows(result).length > 0 && <KeyValueGrid rows={resultRows(result)} />}
          {healthy && <SuccessBlock message="All checks passed." />}
          {issues.length > 0 && (
            <YStack gap={6}>
              <Text
                color={globalColors.secondary}
                fontSize={9}
                fontFamily="$mono"
                textTransform="uppercase"
              >
                issues ({issues.length})
              </Text>
              {issues.map((issue, i) => (
                <YStack
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable ordered list
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
    </GoogleAnalyticsToolShell>
  );
}
