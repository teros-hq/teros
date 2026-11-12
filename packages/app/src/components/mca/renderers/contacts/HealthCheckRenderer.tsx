/**
 * Google Contacts Renderer - Health Check
 *
 * Pattern E (guide §6): the badge encodes the state. Output shape from
 * HealthCheckBuilder (mca-sdk/src/health.ts):
 *   { status: 'ready' | 'degraded' | 'not_ready', issues?: [...], version?, uptime? }
 */

import type React from 'react';

import type { ToolCallRendererProps } from '../../types';
import { Badge, ErrorBlock, KeyValueGrid, SuccessBlock, ToolCallCard } from '../../primitives';
import { parseOutput } from './shared';

interface HealthIssue {
  code?: string;
  message?: string;
  action?: { type?: string; description?: string; url?: string };
}

interface HealthCheckResult {
  status?: string;
  issues?: HealthIssue[];
  version?: string;
  uptime?: number;
}

function healthVariant(healthStatus: string): 'success' | 'warning' | 'error' | 'gray' {
  if (healthStatus === 'ready') return 'success';
  if (healthStatus === 'degraded') return 'warning';
  if (healthStatus === 'not_ready') return 'error';
  return 'gray';
}

export function HealthCheckRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const result = output ? parseOutput<HealthCheckResult>(output) : null;
  const data = result && typeof result === 'object' ? result : null;

  const healthStatus = data?.status ?? 'unknown';
  const issues = Array.isArray(data?.issues) ? (data.issues as HealthIssue[]) : [];

  let badge: React.ReactNode = null;
  if (status === 'pending_permission') {
    badge = <Badge text="awaiting" variant="warning" />;
  } else if (status === 'completed' && data) {
    badge = <Badge text={healthStatus} variant={healthVariant(healthStatus)} />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description =
    status === 'failed'
      ? 'Failed to check connection'
      : status === 'completed' && data
        ? healthStatus === 'ready'
          ? 'Connected to Google Contacts'
          : 'Google Contacts connection issues'
        : 'Check Google Contacts connection';

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
      {status === 'failed' && error && <ErrorBlock error={error} />}
      {status === 'completed' && data && (
        <>
          {healthStatus === 'ready' ? (
            <SuccessBlock message="OAuth credentials verified" />
          ) : (
            issues.map((issue, idx) => (
              <ErrorBlock
                key={`${issue.code ?? 'issue'}-${idx}`}
                title={issue.code ?? 'issue'}
                message={issue.message ?? ''}
                hint={issue.action?.description}
              />
            ))
          )}
          <KeyValueGrid
            rows={[
              { key: 'status', value: healthStatus },
              ...(data.version ? [{ key: 'version', value: data.version, mono: true }] : []),
              ...(typeof data.uptime === 'number' ? [{ key: 'uptime', value: `${data.uptime}s` }] : []),
            ]}
          />
        </>
      )}
    </ToolCallCard>
  );
}
