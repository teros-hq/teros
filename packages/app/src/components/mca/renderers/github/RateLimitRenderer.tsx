/**
 * GitHub Renderer — get-rate-limit. Shows per-bucket budgets in a
 * Specsheet so the agent (and the user looking at the tool call) can see
 * exactly how much budget is left in core/search/graphql/code_search.
 */

import { Activity } from '../../primitives';

import {
  ErrorBlock,
  IconTile,
  ResourceCard,
  Specsheet,
  type SpecsheetSection,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { GITHUB_PALETTE, GitHubToolShell, relativeTime } from './shared';

interface BucketLimit {
  limit: number;
  remaining: number;
  used: number;
  reset: number;
}

interface RateLimitResult {
  resources: Record<string, BucketLimit>;
  rate?: BucketLimit;
}

function bucketAccent(bucket: BucketLimit): string {
  const ratio = bucket.remaining / Math.max(bucket.limit, 1);
  if (ratio < 0.1) return GITHUB_PALETTE.failed;
  if (ratio < 0.3) return GITHUB_PALETTE.warning;
  return GITHUB_PALETTE.success;
}

function bucketSpecsheet(name: string, bucket: BucketLimit): SpecsheetSection {
  const resetIso = new Date(bucket.reset * 1000).toISOString();
  return {
    title: name,
    rows: [
      { key: 'remaining', value: `${bucket.remaining} / ${bucket.limit}` },
      { key: 'used', value: String(bucket.used) },
      { key: 'reset', value: relativeTime(resetIso) ?? resetIso },
    ],
  };
}

const BUCKET_PRIORITY = ['core', 'search', 'graphql', 'code_search'];

export function RateLimitRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<RateLimitResult>(output) : null;
  const result =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'resources' in (parsed as object)
      ? (parsed as RateLimitResult)
      : null;

  const sections: SpecsheetSection[] = [];
  if (result?.resources) {
    for (const key of BUCKET_PRIORITY) {
      const bucket = result.resources[key];
      if (bucket) sections.push(bucketSpecsheet(key, bucket));
    }
    for (const [key, bucket] of Object.entries(result.resources)) {
      if (!BUCKET_PRIORITY.includes(key)) sections.push(bucketSpecsheet(key, bucket));
    }
  }

  const core = result?.resources?.core;
  const accent = core ? bucketAccent(core) : GITHUB_PALETTE.queued;

  return (
    <GitHubToolShell toolName={toolName} status={status} defaultExpanded>
      {error && <ErrorBlock error={error} />}
      {!error && result && (
        <ResourceCard
          leading={<IconTile icon={<Activity size={14} color={accent} />} accent={accent} size={28} />}
          title="Rate limit budget"
          subtitle={
            core
              ? `core: ${core.remaining}/${core.limit} remaining`
              : undefined
          }
        >
          <Specsheet sections={sections} />
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}
