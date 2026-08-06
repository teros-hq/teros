/**
 * GitHub Renderer — Branches.
 */

import { GitBranch } from '../../primitives';
import { ScrollView, Text, YStack } from 'tamagui';

import {
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
  ResourceCard,
  colors as globalColors,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  GITHUB_PALETTE,
  type GitHubBranch,
  GitHubToolShell,
  branchChipProps,
  scrollStyle,
  shortSha,
} from './shared';

// list-branches
export function ListBranchesRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<GitHubBranch[]>(output) : null;
  const branches = Array.isArray(parsed) ? parsed : [];
  return (
    <GitHubToolShell toolName={toolName} status={status} description={`${branches.length} branch${branches.length === 1 ? '' : 'es'}`}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && branches.length === 0 && <Empty message="No branches." />}
      {!error && status === 'completed' && branches.length > 0 && (
        <ScrollView style={scrollStyle(360)}>
          <YStack>
            {branches.map((b) => {
              const chip = branchChipProps(b);
              return (
                <EntityRow
                  key={b.name}
                  leading={<IconTile icon={<GitBranch size={11} color={GITHUB_PALETTE.neutral} />} accent={GITHUB_PALETTE.neutral} size={24} />}
                  title={b.name}
                  subtitle={b.commit?.sha ? shortSha(b.commit.sha) : undefined}
                  badges={b.protected ? <IconChip icon={chip.icon} text={chip.text} accent={chip.accent} /> : null}
                />
              );
            })}
          </YStack>
        </ScrollView>
      )}
    </GitHubToolShell>
  );
}

// get-branch
export function GetBranchRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<GitHubBranch>(output) : null;
  const branch = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'name' in (parsed as object)
    ? (parsed as GitHubBranch)
    : null;
  const rows: KeyValueRow[] = [];
  if (branch?.commit?.sha) rows.push({ key: 'head sha', value: shortSha(branch.commit.sha) });
  if (typeof branch?.protected === 'boolean') rows.push({ key: 'protected', value: branch.protected ? 'yes' : 'no' });

  return (
    <GitHubToolShell toolName={toolName} status={status} defaultExpanded>
      {error && <ErrorBlock error={error} />}
      {!error && branch && (
        <ResourceCard
          leading={<IconTile icon={<GitBranch size={14} color={GITHUB_PALETTE.brand} />} accent={GITHUB_PALETTE.brand} size={28} />}
          title={branch.name}
        >
          <KeyValueGrid rows={rows} />
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}

// create-branch
interface CreateBranchResult {
  ref?: string;
  object?: { sha: string };
}

export function CreateBranchRenderer({ toolName, status, output, error, duration, input }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<CreateBranchResult>(output) : null;
  const result = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as CreateBranchResult) : null;
  const branchName = (input?.branch as string | undefined) ?? result?.ref?.replace(/^refs\/heads\//, '');
  const fromBranch = (input?.from_branch as string | undefined) ?? 'main';
  return (
    <GitHubToolShell toolName={toolName} status={status}>
      {error && <ErrorBlock error={error} />}
      {!error && result && (
        <ResourceCard
          leading={<IconTile icon={<GitBranch size={14} color={GITHUB_PALETTE.success} />} accent={GITHUB_PALETTE.success} size={28} />}
          title={branchName ?? '?'}
          subtitle={`from ${fromBranch}`}
          verb="created"
        >
          {result.object?.sha && (
            <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono">
              sha {shortSha(result.object.sha)}
            </Text>
          )}
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}
