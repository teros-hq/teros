/**
 * GitHub Renderer — Repositories.
 *
 * Covers list-repos, get-repo, create-repo, search-repos.
 */

import { GitFork, Star } from '../../primitives';
import { ScrollView, Text, YStack } from 'tamagui';

import { MarkdownContent } from '../../../chat/bubbles/MarkdownContent';
import {
  Avatar,
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  PillList,
  ResourceCard,
  Specsheet,
  type SpecsheetSection,
  colors as globalColors,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  GITHUB_PALETTE,
  type GitHubRepo,
  GitHubToolShell,
  getRepoFullName,
  relativeTime,
  repoVisibilityChipProps,
  scrollStyle,
} from './shared';

interface SearchReposPayload {
  total_count?: number;
  items?: GitHubRepo[];
}

function isSearchPayload(o: unknown): o is SearchReposPayload {
  return !!o && typeof o === 'object' && 'items' in (o as Record<string, unknown>);
}

function RepoRow({ repo }: { repo: GitHubRepo }) {
  const visibility = repoVisibilityChipProps(repo);
  const stars = repo.stargazers_count ?? 0;
  return (
    <EntityRow
      leading={
        repo.owner?.avatar_url ? (
          <Avatar src={repo.owner.avatar_url} size={20} />
        ) : (
          <IconTile label={repo.name?.[0] ?? '?'} accent={GITHUB_PALETTE.brand} size={24} />
        )
      }
      title={getRepoFullName(repo)}
      subtitle={repo.description ?? undefined}
      badges={
        <>
          <IconChip icon={visibility.icon} text={visibility.text} accent={visibility.accent} />
          {repo.language && <IconChip text={repo.language} accent={GITHUB_PALETTE.queued} />}
        </>
      }
      meta={
        stars > 0 ? (
          <IconChip
            icon={<Star size={9} color={globalColors.muted} />}
            text={stars >= 1000 ? `${(stars / 1000).toFixed(1)}k` : String(stars)}
            accent={globalColors.muted}
          />
        ) : null
      }
    />
  );
}

function RepoListImpl({
  toolName,
  status,
  output,
  error,
  duration,
  isSearch,
}: ToolCallRendererProps & { isSearch?: boolean }) {
  const parsed = output ? parseOutput<unknown>(output) : null;
  const repos: GitHubRepo[] = isSearch
    ? isSearchPayload(parsed)
      ? parsed.items ?? []
      : []
    : Array.isArray(parsed)
      ? (parsed as GitHubRepo[])
      : [];

  const total = isSearch && isSearchPayload(parsed) ? parsed.total_count ?? repos.length : repos.length;
  const description = isSearch ? `Search · ${total} repo${total === 1 ? '' : 's'}` : `${repos.length} repo${repos.length === 1 ? '' : 's'}`;

  return (
    <GitHubToolShell toolName={toolName} status={status} description={description}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && repos.length === 0 && <Empty message="No repositories." />}
      {!error && status === 'completed' && repos.length > 0 && (
        <ScrollView style={scrollStyle(360)}>
          <YStack>
            {repos.map((r) => (
              <RepoRow key={r.id ?? r.full_name} repo={r} />
            ))}
          </YStack>
        </ScrollView>
      )}
    </GitHubToolShell>
  );
}

export function ListReposRenderer(props: ToolCallRendererProps) {
  return <RepoListImpl {...props} />;
}

export function SearchReposRenderer(props: ToolCallRendererProps) {
  return <RepoListImpl {...props} isSearch />;
}

// =============================================================================
// get-repo
// =============================================================================

function repoSpecsheet(repo: GitHubRepo): SpecsheetSection[] {
  const sections: SpecsheetSection[] = [];

  const identity: SpecsheetSection = { title: 'Identity', rows: [] };
  identity.rows.push({ key: 'full name', value: getRepoFullName(repo) });
  if (repo.default_branch) identity.rows.push({ key: 'default branch', value: repo.default_branch });
  identity.rows.push({ key: 'visibility', value: repo.visibility ?? (repo.private ? 'private' : 'public') });
  sections.push(identity);

  const stats: SpecsheetSection = { title: 'Stats', rows: [] };
  if (typeof repo.stargazers_count === 'number') stats.rows.push({ key: 'stars', value: String(repo.stargazers_count) });
  if (typeof repo.forks_count === 'number') stats.rows.push({ key: 'forks', value: String(repo.forks_count) });
  if (typeof repo.open_issues_count === 'number') stats.rows.push({ key: 'open issues', value: String(repo.open_issues_count) });
  if (stats.rows.length > 0) sections.push(stats);

  const tech: SpecsheetSection = { title: 'Tech', rows: [] };
  if (repo.language) tech.rows.push({ key: 'language', value: repo.language });
  if (repo.license?.name) tech.rows.push({ key: 'license', value: repo.license.name });
  if (tech.rows.length > 0) sections.push(tech);

  const activity: SpecsheetSection = { title: 'Activity', rows: [] };
  const pushed = relativeTime(repo.pushed_at);
  const updated = relativeTime(repo.updated_at);
  if (pushed) activity.rows.push({ key: 'last push', value: pushed });
  if (updated && updated !== pushed) activity.rows.push({ key: 'updated', value: updated });
  if (activity.rows.length > 0) sections.push(activity);

  return sections;
}

export function GetRepoRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<GitHubRepo>(output) : null;
  const repo = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'full_name' in (parsed as object)
    ? (parsed as GitHubRepo)
    : null;
  const visibility = repo ? repoVisibilityChipProps(repo) : null;

  return (
    <GitHubToolShell toolName={toolName} status={status} defaultExpanded>
      {error && <ErrorBlock error={error} />}
      {!error && repo && (
        <ResourceCard
          leading={
            repo.owner?.avatar_url ? (
              <Avatar src={repo.owner.avatar_url} size={28} />
            ) : (
              <IconTile label={repo.name?.[0] ?? '?'} accent={GITHUB_PALETTE.brand} size={28} />
            )
          }
          title={getRepoFullName(repo)}
          subtitle={repo.description ?? undefined}
          meta={visibility ? <IconChip icon={visibility.icon} text={visibility.text} accent={visibility.accent} /> : null}
        >
          <Specsheet sections={repoSpecsheet(repo)} />
          {repo.topics && repo.topics.length > 0 && (
            <PillList items={repo.topics} accent={GITHUB_PALETTE.queued} max={10} />
          )}
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}

// =============================================================================
// create-repo
// =============================================================================

export function CreateRepoRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<GitHubRepo>(output) : null;
  const repo = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'full_name' in (parsed as object)
    ? (parsed as GitHubRepo)
    : null;
  const visibility = repo ? repoVisibilityChipProps(repo) : null;

  return (
    <GitHubToolShell toolName={toolName} status={status}>
      {error && <ErrorBlock error={error} />}
      {!error && repo && (
        <ResourceCard
          leading={<IconTile label={repo.name?.[0] ?? '?'} accent={GITHUB_PALETTE.success} size={28} />}
          title={getRepoFullName(repo)}
          subtitle={repo.description ?? undefined}
          verb="created"
          meta={visibility ? <IconChip {...visibility} /> : null}
        >
          {repo.html_url && (
            <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono">
              {repo.html_url}
            </Text>
          )}
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}
