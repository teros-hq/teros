/**
 * mca.teros.http — `-health-check` sub-renderer.
 *
 * The `-health-check` tool is part of every MCA (SDK-level contract). Its
 * output shape is `HealthCheckResult = { status, issues?, version?, uptime? }`.
 * Adapted from `linear/HealthCheckRenderer.tsx` but composed on the generic
 * `ToolCallCard` (no brand shell) — the MCA logo is supplied via `appIcon`.
 */

import { CheckCircle2, XCircle } from '../../primitives';
import type React from 'react';
import { Text, YStack } from 'tamagui';
import {
  Badge,
  colors,
  ErrorBlock,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  parseOutput,
  ResourceCard,
  SuccessBlock,
  ToolCallCard,
  useColors,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';

// ============================================================================
// Types (local copy of the HealthCheckResult shape — @teros/shared/mca-health)
// ============================================================================

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

// ============================================================================
// Helpers
// ============================================================================

const STATUS_ACCENT: Record<HealthStatus, string> = {
  ready: colors.green,
  degraded: colors.amber,
  not_ready: colors.red,
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

function issueAccent(code: string, text3: string): string {
  if (code.startsWith('AUTH_')) return colors.red;
  if (
    code === 'DEPENDENCY_UNAVAILABLE' ||
    code === 'RATE_LIMITED' ||
    code === 'QUOTA_EXCEEDED' ||
    code === 'SYSTEM_CONFIG_MISSING' ||
    code === 'USER_CONFIG_MISSING' ||
    code === 'CONFIG_INVALID'
  ) {
    return colors.amber;
  }
  return text3;
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

function healthBadge(
  status: ToolCallRendererProps['status'],
  result: HealthCheckResult | null,
): React.ReactNode {
  if (status === 'failed') return <Badge text="failed" variant="error" />;
  if (status !== 'completed') return null;
  const hs = result?.status ?? 'ready';
  if (hs === 'ready') return <Badge text="ready" variant="success" />;
  if (hs === 'degraded') return <Badge text="degraded" variant="warning" />;
  return <Badge text="not ready" variant="error" />;
}

// ============================================================================
// Renderer
// ============================================================================

export function HealthCheckRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const c = useColors();
  const parsed = output ? parseOutput<HealthCheckResult>(output) : null;
  const result =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'status' in parsed
      ? (parsed as HealthCheckResult)
      : null;

  const healthStatus: HealthStatus = result?.status ?? 'ready';
  const issues = result?.issues ?? [];
  const healthy = healthStatus === 'ready' && issues.length === 0;
  const accent = STATUS_ACCENT[healthStatus];

  return (
    <ToolCallCard
      status={status}
      description="Health check"
      iconUri={appIcon}
      badge={healthBadge(status, result)}
    >
      {error && <ErrorBlock message={error} />}
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
          subtitle={result?.version ? `HTTP MCA v${result.version}` : undefined}
          meta={<IconChip text={STATUS_LABEL[healthStatus]} accent={accent} />}
        >
          {result && resultRows(result).length > 0 && <KeyValueGrid rows={resultRows(result)} />}
          {healthy && <SuccessBlock message="All checks passed." />}
          {issues.length > 0 && (
            <YStack gap={6}>
              <Text
                color={c.text2}
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
                  backgroundColor={`${issueAccent(issue.code, c.text3)}12`}
                  borderWidth={1}
                  borderColor={`${issueAccent(issue.code, c.text3)}33`}
                >
                  <IconChip text={issue.code} accent={issueAccent(issue.code, c.text3)} />
                  <Text color={c.text} fontSize={10}>
                    {issue.message}
                  </Text>
                  {issue.action && (
                    <Text color={c.text2} fontSize={9}>
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
    </ToolCallCard>
  );
}
