/**
 * Brevo — -health-check.
 *
 * Standard SDK health-check shape: { status, issues?, version?, uptime? }.
 * Composes global primitives; the Brevo logo (iconUri) brands the header.
 */

import { Text, YStack } from 'tamagui';
import {
  CheckCircle2,
  ErrorBlock,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  ResourceCard,
  SuccessBlock,
  ToolCallCard,
  XCircle,
  colors,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { BREVO_BRAND, narrowObject, useBrevoColors } from './shared';

type HealthStatus = 'ready' | 'not_ready' | 'degraded';

interface HealthIssue {
  code: string;
  message: string;
  action?: { type: string; description: string; url?: string };
}

interface HealthCheckResult {
  status: HealthStatus;
  issues?: HealthIssue[];
  version?: string;
  uptime?: number;
}

const STATUS_ACCENT: Record<HealthStatus, string> = {
  ready: BREVO_BRAND.green,
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

function issueAccent(code: string): string {
  const c = useBrevoColors();
  if (code.startsWith('AUTH_')) return colors.red;
  if (code === 'DEPENDENCY_UNAVAILABLE' || code === 'RATE_LIMITED') return colors.amber;
  return c.text3;
}

function formatUptime(seconds: number | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

export function HealthCheckRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const c = useBrevoColors();
  const result = output ? narrowObject<HealthCheckResult>(parseOutput<HealthCheckResult>(output)) : null;
  const healthStatus: HealthStatus = result?.status ?? 'ready';
  const issues = result?.issues ?? [];
  const healthy = healthStatus === 'ready' && issues.length === 0;
  const accent = STATUS_ACCENT[healthStatus];

  const rows: KeyValueRow[] = [];
  if (result?.version) rows.push({ key: 'version', value: result.version });
  const uptime = formatUptime(result?.uptime);
  if (uptime) rows.push({ key: 'uptime', value: uptime });

  return (
    <ToolCallCard status={status} description="Health check" iconUri={appIcon} animateExpand>
      {error ? (
        <ErrorBlock error={error} />
      ) : status === 'completed' ? (
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
          subtitle={result?.version ? `Brevo MCA v${result.version}` : undefined}
          meta={<IconChip text={STATUS_LABEL[healthStatus]} accent={accent} />}
        >
          {rows.length > 0 && <KeyValueGrid rows={rows} />}
          {healthy && <SuccessBlock message="All checks passed." />}
          {issues.length > 0 && (
            <YStack gap={6}>
              <Text color={c.secondary} fontSize={9} fontFamily="$mono" textTransform="uppercase">
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
                  <Text color={c.primary} fontSize={10}>
                    {issue.message}
                  </Text>
                  {issue.action && (
                    <Text color={c.secondary} fontSize={9}>
                      → {issue.action.description}
                      {issue.action.url ? ` (${issue.action.url})` : ''}
                    </Text>
                  )}
                </YStack>
              ))}
            </YStack>
          )}
        </ResourceCard>
      ) : null}
    </ToolCallCard>
  );
}
