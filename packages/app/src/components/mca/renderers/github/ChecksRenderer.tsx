/**
 * GitHub Renderer — Check Runs (App-only).
 *
 * Covers create-check-run and update-check-run. Composes ResourceCard +
 * ActionBadge + IconChip with `runStatusChipProps` for state coloring.
 */

import { CheckSquare } from '../../primitives';
import { ScrollView } from 'tamagui';

import { MarkdownContent } from '../../../chat/bubbles/MarkdownContent';
import {
  ErrorBlock,
  IconChip,
  IconTile,
  ResourceCard,
  Specsheet,
  type SpecsheetSection,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  GITHUB_PALETTE,
  type GitHubRunConclusion,
  type GitHubRunStatus,
  GitHubToolShell,
  relativeTime,
  runStatusChipProps,
  scrollStyle,
  shortSha,
} from './shared';

interface CheckRunResult {
  id: number;
  name: string;
  head_sha: string;
  status: GitHubRunStatus;
  conclusion: GitHubRunConclusion;
  started_at?: string;
  completed_at?: string;
  html_url?: string;
  output?: { title?: string; summary?: string; text?: string };
}

function checkSpecsheet(check: CheckRunResult, sha?: string): SpecsheetSection[] {
  const sections: SpecsheetSection[] = [];
  const identity: SpecsheetSection = {
    title: 'Identity',
    rows: [
      { key: 'check id', value: `#${check.id}` },
      { key: 'name', value: check.name },
      { key: 'status', value: check.status },
    ],
  };
  if (check.conclusion) identity.rows.push({ key: 'conclusion', value: check.conclusion });
  sections.push(identity);

  const target: SpecsheetSection = { title: 'Target', rows: [] };
  if (sha ?? check.head_sha) target.rows.push({ key: 'head sha', value: shortSha(sha ?? check.head_sha) });
  if (check.started_at) target.rows.push({ key: 'started', value: relativeTime(check.started_at) ?? check.started_at });
  if (check.completed_at) target.rows.push({ key: 'completed', value: relativeTime(check.completed_at) ?? check.completed_at });
  if (target.rows.length > 0) sections.push(target);

  return sections;
}

function CheckRunBody({ check }: { check: CheckRunResult }) {
  const chip = runStatusChipProps({ status: check.status, conclusion: check.conclusion });
  return (
    <ResourceCard
      leading={<IconTile icon={<CheckSquare size={14} color={chip.accent} />} accent={chip.accent} size={28} />}
      title={check.name}
      subtitle={check.output?.title ?? undefined}
      meta={<IconChip icon={chip.icon} text={chip.text} accent={chip.accent} />}
    >
      <Specsheet sections={checkSpecsheet(check)} />
      {check.output?.summary && (
        <ScrollView style={scrollStyle(220)}>
          <MarkdownContent text={check.output.summary} />
        </ScrollView>
      )}
      {check.output?.text && (
        <ScrollView style={scrollStyle(220)}>
          <MarkdownContent text={check.output.text} />
        </ScrollView>
      )}
    </ResourceCard>
  );
}

export function CreateCheckRunRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<CheckRunResult>(output) : null;
  const check =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'id' in (parsed as object)
      ? (parsed as CheckRunResult)
      : null;
  return (
    <GitHubToolShell toolName={toolName} status={status}>
      {error && <ErrorBlock error={error} />}
      {!error && check && <CheckRunBody check={check} />}
    </GitHubToolShell>
  );
}

export function UpdateCheckRunRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<CheckRunResult>(output) : null;
  const check =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'id' in (parsed as object)
      ? (parsed as CheckRunResult)
      : null;
  return (
    <GitHubToolShell toolName={toolName} status={status}>
      {error && <ErrorBlock error={error} />}
      {!error && check && <CheckRunBody check={check} />}
    </GitHubToolShell>
  );
}
