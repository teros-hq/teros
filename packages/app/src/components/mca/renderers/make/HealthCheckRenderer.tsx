/**
 * mca.make — -health-check sub-renderer.
 *
 * Parses the SDK `HealthCheckResult` ({ status, issues?, version?, uptime? }).
 * Status accent uses semantic tokens (green/amber/red) — the Make logo (via the
 * shell's iconUri) already brands the card, so no brand color on status.
 */

import type React from 'react';
import { Text, YStack } from 'tamagui';
import {
  CheckCircle2,
  colors,
  ErrorBlock,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  ResourceCard,
  SuccessBlock,
  XCircle,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { type HealthCheckResult, type HealthStatus, MakeToolShell, parseMakeOutput, useMakeColors } from './shared';

// Semantic status accents — theme-agnostic (green/amber/red from `colors`).
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

/**
 * Map an issue code to a semantic accent color.
 * `fallback` is the theme-adaptive text3 token (passed from the component so
 * this function stays pure and doesn't need to be a hook itself).
 */
function issueAccent(code: string, fallback: string): string {
  if (code.startsWith('AUTH_')) return colors.red;
  if (code === 'DEPENDENCY_UNAVAILABLE' || code === 'RATE_LIMITED' || code === 'QUOTA_EXCEEDED') {
    return colors.amber;
  }
  if (code === 'CONFIG_INVALID' || code === 'USER_CONFIG_MISSING' || code === 'SYSTEM_CONFIG_MISSING') {
    return colors.amber;
  }
  return fallback;
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
  status,
  output,
  error,
  appIcon,
}: ToolCallRendererProps): React.ReactNode {
  const c = useMakeColors();
  const parsed = output ? parseMakeOutput<HealthCheckResult>(output) : null;
  const result =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'status' in parsed
      ? parsed
      : null;

  const healthStatus: HealthStatus = result?.status ?? 'ready';
  const issues = result?.issues ?? [];
  const healthy = healthStatus === 'ready' && issues.length === 0;
  const accent = STATUS_ACCENT[healthStatus];

  return (
    <MakeToolShell
      toolName="-health-check"
      status={status}
      appIcon={appIcon}
      description="Make health check"
      defaultExpanded={false}
    >
      {error && <ErrorBlock message={error} title="Health check failed" />}
      {!error && status === 'completed' && (
        <ResourceCard
          leading={
            <IconTile
              accent={accent}
              size={28}
              icon={healthy ? <CheckCircle2 size={16} color={accent} /> : <XCircle size={16} color={accent} />}
            />
          }
          title={STATUS_TITLE[healthStatus]}
          subtitle={result?.version ? `Make MCA v${result.version}` : undefined}
          meta={<IconChip text={STATUS_LABEL[healthStatus]} accent={accent} />}
        >
          {result && resultRows(result).length > 0 && <KeyValueGrid rows={resultRows(result)} />}
          {healthy && <SuccessBlock message="Webhook trigger ready (account token optional)." />}
          {issues.length > 0 && (
            <YStack gap={6}>
              <Text color={c.text2} fontSize={9} fontFamily="$mono" textTransform="uppercase">
                issues ({issues.length})
              </Text>
              {issues.map((issue, i) => (
                <YStack
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
    </MakeToolShell>
  );
}
