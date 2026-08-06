/**
 * GitHub Renderer — Health check.
 *
 * Output shape: `{ status, issues?, version?, uptime? }` (the SDK contract).
 * Account info (installation_id, repository_count, account) is NOT surfaced
 * here — `get-installation-context` is the canonical tool for that.
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
import { GITHUB_PALETTE, GitHubToolShell, formatDuration } from './shared';

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
  ready: GITHUB_PALETTE.success,
  degraded: GITHUB_PALETTE.warning,
  not_ready: GITHUB_PALETTE.failed,
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
  if (code.startsWith('AUTH_')) return GITHUB_PALETTE.failed;
  if (code === 'PERMISSION_DENIED') return GITHUB_PALETTE.failed;
  if (code.includes('RATE_LIMIT')) return GITHUB_PALETTE.warning;
  if (code === 'SYSTEM_NOT_CONFIGURED') return GITHUB_PALETTE.warning;
  return GITHUB_PALETTE.neutral;
}

function rows(result: HealthCheckResult): KeyValueRow[] {
  const out: KeyValueRow[] = [];
  if (result.version) out.push({ key: 'version', value: result.version });
  if (typeof result.uptime === 'number') {
    const f = formatDuration(result.uptime * 1000);
    if (f) out.push({ key: 'uptime', value: f });
  }
  return out;
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
  const accent = STATUS_ACCENT[healthStatus];
  const title = STATUS_TITLE[healthStatus];
  const all = rows(result ?? { status: healthStatus });

  return (
    <GitHubToolShell
      toolName={toolName}
      status={status}
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
          subtitle={result?.version ? `GitHub MCA v${result.version}` : undefined}
          meta={<IconChip text={STATUS_LABEL[healthStatus]} accent={accent} />}
        >
          {all.length > 0 && <KeyValueGrid rows={all} />}
          {healthy && <SuccessBlock message="All checks passed." />}
          {issues.length > 0 && (
            <YStack gap={6}>
              <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono" textTransform="uppercase">
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
    </GitHubToolShell>
  );
}
