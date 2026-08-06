/**
 * Canva Renderer — Health check.
 *
 * SDK-level contract shape: { status, issues?, version?, uptime? }.
 * Composes only global primitives + the CanvaToolShell wrapper.
 */

import { CheckCircle2, XCircle } from '../../primitives';
import { Text, YStack } from 'tamagui';

import {
  ErrorBlock,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  ResourceCard,
  SuccessBlock,
  colors as globalColors,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { CANVA_BRAND, CanvaToolShell } from './shared';

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

const STATUS_ACCENT: Record<HealthStatus, string> = {
  ready: globalColors.success,
  degraded: globalColors.amber,
  not_ready: globalColors.failed,
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
  if (code.startsWith('AUTH_')) return globalColors.failed;
  if (
    code === 'DEPENDENCY_UNAVAILABLE' ||
    code === 'RATE_LIMITED' ||
    code === 'QUOTA_EXCEEDED' ||
    code.endsWith('_CONFIG_MISSING') ||
    code === 'CONFIG_INVALID'
  )
    return globalColors.amber;
  return globalColors.muted;
}

function formatUptime(seconds?: number): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function resultRows(r: HealthCheckResult): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  if (r.version) rows.push({ key: 'version', value: r.version });
  const uptime = formatUptime(r.uptime);
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
    parsed && typeof parsed === 'object' && 'status' in (parsed as object)
      ? (parsed as HealthCheckResult)
      : null;
  const healthStatus: HealthStatus = result?.status ?? 'ready';
  const issues = result?.issues ?? [];
  const healthy = healthStatus === 'ready' && issues.length === 0;
  const accent = STATUS_ACCENT[healthStatus];

  return (
    <CanvaToolShell
      toolName={toolName}
      status={status}
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
          title={STATUS_TITLE[healthStatus]}
          subtitle={result?.version ? `Canva MCA v${result.version}` : undefined}
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
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable ordered
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
          {healthStatus === 'ready' && (
            <Text color={CANVA_BRAND.teal} fontSize={9} fontFamily="$mono" opacity={0.6}>
              canva connect API
            </Text>
          )}
        </ResourceCard>
      )}
    </CanvaToolShell>
  );
}
