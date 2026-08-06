/**
 * Health Check Renderer — `-health-check`.
 *
 * Every MCA ships the SDK `-health-check` tool; its output shape is
 * `HealthCheckResult = { status, issues?, version?, uptime? }`. Keeping a
 * dedicated renderer (instead of the FallbackRenderer) follows the MCA gotcha
 * "-health-check siempre en RENDERERS map".
 */

import type React from 'react';
import { Text, YStack } from 'tamagui';
import { Badge, ErrorBlock, KeyValueGrid, type KeyValueRow, ToolCallCard } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { useNetlifyColors } from './shared';

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

const STATUS_BADGE: Record<HealthStatus, { text: string; variant: 'success' | 'warning' | 'error' }> = {
  ready: { text: 'healthy', variant: 'success' },
  degraded: { text: 'degraded', variant: 'warning' },
  not_ready: { text: 'not ready', variant: 'error' },
};

function formatUptime(seconds?: number): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function parseResult(output?: string): HealthCheckResult | null {
  if (!output) return null;
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === 'object' && 'status' in parsed) return parsed as HealthCheckResult;
  } catch {
    /* not JSON */
  }
  return null;
}

export function HealthCheckRenderer({
  status,
  output,
  error,
  appIcon,
}: ToolCallRendererProps): React.ReactElement {
  const c = useNetlifyColors();
  const result = parseResult(output);
  const healthStatus: HealthStatus = result?.status ?? 'ready';
  const issues = result?.issues ?? [];
  const meta = STATUS_BADGE[healthStatus];

  const badge =
    status === 'failed' ? (
      <Badge text="failed" variant="error" />
    ) : status === 'pending' || status === 'running' ? (
      // In flight: the default 'ready' status hasn't been reported yet, so
      // showing "healthy" would be premature. Surface a neutral "checking".
      <Badge text="checking" variant="info" />
    ) : (
      <Badge text={meta.text} variant={meta.variant} />
    );

  const rows: KeyValueRow[] = [];
  if (result?.version) rows.push({ key: 'version', value: result.version });
  const uptime = formatUptime(result?.uptime);
  if (uptime) rows.push({ key: 'uptime', value: uptime });

  return (
    <ToolCallCard status={status} verb="Check health" badge={badge} iconUri={appIcon}>
      <YStack gap={8}>
        {error && <ErrorBlock error={error} />}
        {rows.length > 0 && <KeyValueGrid rows={rows} />}
        {issues.length > 0 && (
          <YStack gap={6}>
            {issues.map((issue, i) => (
              <YStack
                key={`${issue.code}-${i}`}
                gap={3}
                padding={8}
                borderRadius={5}
                backgroundColor={c.bgInner}
                borderWidth={1}
                borderColor={c.border}
              >
                <Badge text={issue.code} variant="warning" />
                <Text color={c.text} fontSize={10}>
                  {issue.message}
                </Text>
                {issue.action && (
                  <Text color={c.text2} fontSize={9}>
                    → {issue.action.description}
                  </Text>
                )}
              </YStack>
            ))}
          </YStack>
        )}
      </YStack>
    </ToolCallCard>
  );
}
