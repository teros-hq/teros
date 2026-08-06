/**
 * GitHub Renderer — Actions / Workflows.
 */

import { Pause, Play, RefreshCw, Workflow } from '../../primitives';
import { ScrollView, Text, YStack } from 'tamagui';

import {
  CodeFingerprint,
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  ResourceCard,
  Specsheet,
  type SpecsheetSection,
  colors as globalColors,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  GITHUB_PALETTE,
  type GitHubJob,
  type GitHubWorkflow,
  type GitHubWorkflowRun,
  GitHubToolShell,
  formatDuration,
  relativeTime,
  runStatusChipProps,
  scrollStyle,
  shortSha,
} from './shared';

// list-workflows
interface WorkflowsPayload {
  total_count?: number;
  workflows?: GitHubWorkflow[];
}

export function ListWorkflowsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<WorkflowsPayload | GitHubWorkflow[]>(output) : null;
  const workflows: GitHubWorkflow[] = Array.isArray(parsed)
    ? parsed
    : parsed && 'workflows' in (parsed as object)
      ? (parsed as WorkflowsPayload).workflows ?? []
      : [];

  return (
    <GitHubToolShell toolName={toolName} status={status} description={`${workflows.length} workflow${workflows.length === 1 ? '' : 's'}`}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && workflows.length === 0 && <Empty message="No workflows." />}
      {!error && status === 'completed' && workflows.length > 0 && (
        <ScrollView style={scrollStyle(360)}>
          <YStack>
            {workflows.map((w) => (
              <EntityRow
                key={w.id}
                leading={<IconTile icon={<Workflow size={11} color={GITHUB_PALETTE.brand} />} accent={GITHUB_PALETTE.brand} size={24} />}
                title={w.name}
                subtitle={w.path}
                badges={w.state ? <IconChip text={w.state} accent={w.state === 'active' ? GITHUB_PALETTE.success : GITHUB_PALETTE.neutral} /> : null}
              />
            ))}
          </YStack>
        </ScrollView>
      )}
    </GitHubToolShell>
  );
}

// list-workflow-runs
interface RunsPayload {
  total_count?: number;
  workflow_runs?: GitHubWorkflowRun[];
}

export function ListWorkflowRunsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<RunsPayload | GitHubWorkflowRun[]>(output) : null;
  const runs: GitHubWorkflowRun[] = Array.isArray(parsed)
    ? parsed
    : parsed && 'workflow_runs' in (parsed as object)
      ? (parsed as RunsPayload).workflow_runs ?? []
      : [];

  return (
    <GitHubToolShell toolName={toolName} status={status} description={`${runs.length} run${runs.length === 1 ? '' : 's'}`}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && runs.length === 0 && <Empty message="No workflow runs." />}
      {!error && status === 'completed' && runs.length > 0 && (
        <ScrollView style={scrollStyle(360)}>
          <YStack>
            {runs.map((r) => {
              const chip = runStatusChipProps(r);
              return (
                <EntityRow
                  key={r.id}
                  leading={<IconTile label={String(r.run_number ?? '?')} accent={chip.accent} size={24} />}
                  title={r.display_title ?? r.name ?? `Run #${r.run_number}`}
                  subtitle={[r.head_branch, r.head_sha ? shortSha(r.head_sha) : null, relativeTime(r.created_at)].filter(Boolean).join(' · ')}
                  badges={<IconChip icon={chip.icon} text={chip.text} accent={chip.accent} />}
                />
              );
            })}
          </YStack>
        </ScrollView>
      )}
    </GitHubToolShell>
  );
}

// get-workflow-run
function runSpecsheet(run: GitHubWorkflowRun): SpecsheetSection[] {
  const sections: SpecsheetSection[] = [];

  const identity: SpecsheetSection = {
    title: 'Identity',
    rows: [
      { key: 'run number', value: `#${run.run_number ?? '?'}` },
      { key: 'status', value: run.status },
    ],
  };
  if (run.conclusion) identity.rows.push({ key: 'conclusion', value: run.conclusion });
  sections.push(identity);

  const trigger: SpecsheetSection = { title: 'Trigger', rows: [] };
  if (run.event) trigger.rows.push({ key: 'event', value: run.event });
  if (run.head_branch) trigger.rows.push({ key: 'branch', value: run.head_branch });
  if (run.head_sha) {
    trigger.rows.push({
      key: 'head sha',
      value: <CodeFingerprint hash={run.head_sha} algorithm="SHA-1" accent={GITHUB_PALETTE.queued} />,
    });
  }
  if (trigger.rows.length > 0) sections.push(trigger);

  const timing: SpecsheetSection = { title: 'Timing', rows: [] };
  if (run.run_started_at && run.updated_at) {
    const started = Date.parse(run.run_started_at);
    const updated = Date.parse(run.updated_at);
    if (Number.isFinite(started) && Number.isFinite(updated)) {
      const elapsed = formatDuration(updated - started);
      if (elapsed) timing.rows.push({ key: 'duration', value: elapsed });
    }
  }
  const created = relativeTime(run.created_at);
  if (created) timing.rows.push({ key: 'created', value: created });
  if (timing.rows.length > 0) sections.push(timing);

  return sections;
}

export function GetWorkflowRunRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<GitHubWorkflowRun>(output) : null;
  const run = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'status' in (parsed as object)
    ? (parsed as GitHubWorkflowRun)
    : null;
  const chip = run ? runStatusChipProps(run) : null;

  return (
    <GitHubToolShell toolName={toolName} status={status} defaultExpanded>
      {error && <ErrorBlock error={error} />}
      {!error && run && (
        <ResourceCard
          leading={<IconTile label={String(run.run_number ?? '?')} accent={chip?.accent ?? GITHUB_PALETTE.brand} size={28} />}
          title={run.display_title ?? run.name ?? `Run #${run.run_number}`}
          subtitle={`#${run.run_number}`}
          meta={chip ? <IconChip icon={chip.icon} text={chip.text} accent={chip.accent} /> : null}
        >
          <Specsheet sections={runSpecsheet(run)} />
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}

// list-workflow-run-jobs
interface JobsPayload {
  total_count?: number;
  jobs?: GitHubJob[];
}

export function ListWorkflowRunJobsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<JobsPayload | GitHubJob[]>(output) : null;
  const jobs: GitHubJob[] = Array.isArray(parsed)
    ? parsed
    : parsed && 'jobs' in (parsed as object)
      ? (parsed as JobsPayload).jobs ?? []
      : [];

  return (
    <GitHubToolShell toolName={toolName} status={status} description={`${jobs.length} job${jobs.length === 1 ? '' : 's'}`}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && jobs.length === 0 && <Empty message="No jobs." />}
      {!error && status === 'completed' && jobs.length > 0 && (
        <ScrollView style={scrollStyle(420)}>
          <YStack>
            {jobs.map((j) => {
              const chip = runStatusChipProps(j);
              const elapsed = j.started_at && j.completed_at
                ? formatDuration(Date.parse(j.completed_at) - Date.parse(j.started_at))
                : null;
              return (
                <EntityRow
                  key={j.id}
                  leading={<IconTile icon={<Workflow size={11} color={chip.accent} />} accent={chip.accent} size={24} />}
                  title={j.name}
                  subtitle={[j.steps ? `${j.steps.length} step${j.steps.length === 1 ? '' : 's'}` : null, elapsed].filter(Boolean).join(' · ')}
                  badges={<IconChip icon={chip.icon} text={chip.text} accent={chip.accent} />}
                />
              );
            })}
          </YStack>
        </ScrollView>
      )}
    </GitHubToolShell>
  );
}

// trigger-workflow
export function TriggerWorkflowRenderer({ toolName, status, output, error, duration, input }: ToolCallRendererProps) {
  const workflowId = input?.workflow_id as string | undefined;
  const ref = (input?.ref as string | undefined) ?? 'main';
  return (
    <GitHubToolShell toolName={toolName} status={status}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <ResourceCard
          leading={<IconTile icon={<Play size={14} color={GITHUB_PALETTE.queued} />} accent={GITHUB_PALETTE.queued} size={28} />}
          title={workflowId ?? 'workflow'}
          subtitle={`on ${ref}`}
          verb="created"
          meta={<IconChip text="dispatched" accent={GITHUB_PALETTE.queued} />}
        >
          <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono">
            workflow_dispatch event sent — runs may take a moment to appear.
          </Text>
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}

// rerun-workflow-run
export function RerunWorkflowRunRenderer({ toolName, status, output, error, duration, input }: ToolCallRendererProps) {
  const runId = input?.run_id as number | undefined;
  const mode = (input?.mode as string | undefined) ?? 'failed';
  return (
    <GitHubToolShell toolName={toolName} status={status}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <ResourceCard
          leading={<IconTile icon={<RefreshCw size={14} color={GITHUB_PALETTE.warning} />} accent={GITHUB_PALETTE.warning} size={28} />}
          title={`Run #${runId}`}
          subtitle={mode === 'all' ? 're-running all jobs' : 're-running failed jobs'}
          verb="updated"
        />
      )}
    </GitHubToolShell>
  );
}

// cancel-workflow-run
export function CancelWorkflowRunRenderer({ toolName, status, output, error, duration, input }: ToolCallRendererProps) {
  const runId = input?.run_id as number | undefined;
  return (
    <GitHubToolShell toolName={toolName} status={status}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && (
        <ResourceCard
          leading={<IconTile icon={<Pause size={14} color={GITHUB_PALETTE.cancelled} />} accent={GITHUB_PALETTE.cancelled} size={28} />}
          title={`Run #${runId}`}
          subtitle="cancellation requested"
          verb="archived"
        />
      )}
    </GitHubToolShell>
  );
}
