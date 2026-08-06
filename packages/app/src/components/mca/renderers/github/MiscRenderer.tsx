/**
 * GitHub Renderer — Misc tools.
 *
 * Covers get-user, clone-repo, get-file-content, create-or-update-file,
 * search-code.
 */

import { File, FileCode, FolderDown, Search, User } from '../../primitives';
import { ScrollView, Text, YStack } from 'tamagui';

import { MarkdownContent } from '../../../chat/bubbles/MarkdownContent';
import {
  Avatar,
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  KeyValueGrid,
  type KeyValueRow,
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
  type GitHubUserRef,
  GitHubToolShell,
  scrollStyle,
} from './shared';

// =============================================================================
// get-installation-context (and deprecated alias get-user)
// =============================================================================

interface InstallationContextResult {
  app: { name: string; slug: string };
  installation: {
    id: string | number | null;
    account: string | null;
    repository_count: number;
    repositories: Array<{ full_name: string; private: boolean }>;
  };
  manage_url: string | null;
  install_url: string;
}

export function GetUserRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<InstallationContextResult>(output) : null;
  const ctx =
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    'installation' in (parsed as object)
      ? (parsed as InstallationContextResult)
      : null;

  const sections: SpecsheetSection[] = [];
  if (ctx) {
    const identity: SpecsheetSection = {
      title: 'App',
      rows: [{ key: 'name', value: ctx.app.name }, { key: 'slug', value: ctx.app.slug }],
    };
    sections.push(identity);

    const install: SpecsheetSection = { title: 'Installation', rows: [] };
    if (ctx.installation.account) {
      install.rows.push({ key: 'account', value: `@${ctx.installation.account}` });
    }
    if (ctx.installation.id !== null && ctx.installation.id !== undefined) {
      install.rows.push({ key: 'id', value: String(ctx.installation.id) });
    }
    install.rows.push({
      key: 'repos',
      value: String(ctx.installation.repository_count),
    });
    if (install.rows.length > 0) sections.push(install);
  }

  const repoFullNames = ctx?.installation.repositories.map((r) => r.full_name) ?? [];

  return (
    <GitHubToolShell toolName={toolName} status={status} defaultExpanded>
      {error && <ErrorBlock error={error} />}
      {!error && ctx && (
        <ResourceCard
          leading={
            <IconTile
              icon={<User size={14} color={GITHUB_PALETTE.brand} />}
              accent={GITHUB_PALETTE.brand}
              size={28}
            />
          }
          title={ctx.installation.account ? `@${ctx.installation.account}` : ctx.app.name}
          subtitle={`Teros ${ctx.app.name} · ${ctx.installation.repository_count} repos accessible`}
        >
          <Specsheet sections={sections} />
          {repoFullNames.length > 0 && (
            <YStack gap={4}>
              <Text
                color={globalColors.secondary}
                fontSize={9}
                fontFamily="$mono"
                textTransform="uppercase"
              >
                accessible repos ({repoFullNames.length})
              </Text>
              <PillList items={repoFullNames} accent={GITHUB_PALETTE.queued} max={20} />
            </YStack>
          )}
          <YStack gap={4}>
            {ctx.manage_url && (
              <Text color={globalColors.secondary} fontSize={9} fontFamily="$mono">
                manage: {ctx.manage_url}
              </Text>
            )}
            <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
              install more: {ctx.install_url}
            </Text>
          </YStack>
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}

// =============================================================================
// clone-repo
// =============================================================================

interface CloneResult {
  success?: boolean;
  path?: string;
  branch?: string;
  sha?: string;
  recentCommits?: string[];
}

export function CloneRepoRenderer({ toolName, status, output, error, duration, input }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<CloneResult>(output) : null;
  const result = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as CloneResult) : null;
  const repo = `${input?.owner ?? '?'}/${input?.repo ?? '?'}`;
  const rows: KeyValueRow[] = [];
  if (result?.path) rows.push({ key: 'path', value: result.path });
  if (result?.branch) rows.push({ key: 'branch', value: result.branch });
  if (result?.sha) rows.push({ key: 'head sha', value: result.sha.slice(0, 7) });

  return (
    <GitHubToolShell toolName={toolName} status={status}>
      {error && <ErrorBlock error={error} />}
      {!error && result && (
        <ResourceCard
          leading={<IconTile icon={<FolderDown size={14} color={GITHUB_PALETTE.merged} />} accent={GITHUB_PALETTE.merged} size={28} />}
          title={repo}
          subtitle={result.path}
          verb="created"
        >
          <KeyValueGrid rows={rows} />
          {result.recentCommits && result.recentCommits.length > 0 && (
            <YStack gap={4}>
              <Text
                color={globalColors.secondary}
                fontSize={9}
                fontFamily="$mono"
                textTransform="uppercase"
              >
                recent commits ({result.recentCommits.length})
              </Text>
              <YStack gap={2}>
                {result.recentCommits.map((line, i) => (
                  <Text
                    // biome-ignore lint/suspicious/noArrayIndexKey: stable ordered git log
                    key={`commit-${i}`}
                    color={globalColors.primary}
                    fontSize={10}
                    fontFamily="$mono"
                    numberOfLines={1}
                  >
                    {line}
                  </Text>
                ))}
              </YStack>
            </YStack>
          )}
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}

// =============================================================================
// get-file-content
// =============================================================================

interface FileContent {
  name?: string;
  path: string;
  sha: string;
  size: number;
  encoding?: string;
  content?: string;
  type?: string;
}

function decodeBase64(b64: string): string {
  try {
    if (typeof globalThis.atob === 'function') {
      const cleaned = b64.replace(/\s+/g, '');
      return globalThis.atob(cleaned);
    }
  } catch {
    /* fall through */
  }
  return b64;
}

export function GetFileContentRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<FileContent>(output) : null;
  const file = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'path' in (parsed as object)
    ? (parsed as FileContent)
    : null;

  const decoded = file?.encoding === 'base64' && file.content ? decodeBase64(file.content) : file?.content ?? '';
  const isMd = file?.path?.toLowerCase().endsWith('.md');

  const rows: KeyValueRow[] = [];
  if (file?.path) rows.push({ key: 'path', value: file.path });
  if (file?.sha) rows.push({ key: 'sha', value: file.sha.slice(0, 7) });
  if (typeof file?.size === 'number') rows.push({ key: 'size', value: `${file.size} bytes` });

  return (
    <GitHubToolShell toolName={toolName} status={status} defaultExpanded>
      {error && <ErrorBlock error={error} />}
      {!error && file && (
        <ResourceCard
          leading={<IconTile icon={<FileCode size={14} color={GITHUB_PALETTE.queued} />} accent={GITHUB_PALETTE.queued} size={28} />}
          title={file.name ?? file.path.split('/').pop() ?? file.path}
          subtitle={file.path}
        >
          <KeyValueGrid rows={rows} />
          {decoded && (
            <ScrollView style={scrollStyle(360)}>
              {isMd ? (
                <MarkdownContent text={decoded} />
              ) : (
                <Text color={globalColors.primary} fontSize={10} fontFamily="$mono" lineHeight={14}>
                  {decoded}
                </Text>
              )}
            </ScrollView>
          )}
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}

// =============================================================================
// create-or-update-file
// =============================================================================

interface FileWriteResult {
  content?: { name?: string; path?: string; sha?: string; size?: number; html_url?: string };
  commit?: { sha: string; message: string; html_url?: string };
}

export function CreateOrUpdateFileRenderer({ toolName, status, output, error, duration, input }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<FileWriteResult>(output) : null;
  const result = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as FileWriteResult) : null;
  const path = result?.content?.path ?? (input?.path as string | undefined) ?? '?';
  const branch = (input?.branch as string | undefined) ?? 'default branch';
  const isUpdate = !!input?.sha;
  const rows: KeyValueRow[] = [];
  if (result?.commit?.sha) rows.push({ key: 'commit', value: result.commit.sha.slice(0, 7) });
  if (result?.content?.sha) rows.push({ key: 'file sha', value: result.content.sha.slice(0, 7) });
  rows.push({ key: 'branch', value: branch });

  return (
    <GitHubToolShell toolName={toolName} status={status}>
      {error && <ErrorBlock error={error} />}
      {!error && result && (
        <ResourceCard
          leading={<IconTile icon={<File size={14} color={GITHUB_PALETTE.warning} />} accent={GITHUB_PALETTE.warning} size={28} />}
          title={path}
          subtitle={result.commit?.message ?? (input?.message as string | undefined)}
          verb={isUpdate ? 'updated' : 'created'}
        >
          <KeyValueGrid rows={rows} />
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}

// =============================================================================
// search-code
// =============================================================================

interface CodeSearchPayload {
  total_count?: number;
  items?: Array<{
    name: string;
    path: string;
    sha: string;
    repository?: { full_name: string };
    html_url?: string;
  }>;
}

export function SearchCodeRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<CodeSearchPayload>(output) : null;
  const items = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'items' in (parsed as object)
    ? ((parsed as CodeSearchPayload).items ?? [])
    : [];
  const total = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'total_count' in (parsed as object)
    ? ((parsed as CodeSearchPayload).total_count ?? items.length)
    : items.length;

  return (
    <GitHubToolShell toolName={toolName} status={status} description={`Search · ${total} match${total === 1 ? '' : 'es'}`}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && items.length === 0 && <Empty message="No matches." />}
      {!error && status === 'completed' && items.length > 0 && (
        <ScrollView style={scrollStyle(360)}>
          <YStack>
            {items.map((it) => (
              <EntityRow
                key={`${it.repository?.full_name ?? ''}-${it.path}-${it.sha}`}
                leading={<IconTile icon={<Search size={11} color={GITHUB_PALETTE.queued} />} accent={GITHUB_PALETTE.queued} size={24} />}
                title={it.path}
                subtitle={it.repository?.full_name}
                meta={
                  <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
                    {it.sha.slice(0, 7)}
                  </Text>
                }
              />
            ))}
          </YStack>
        </ScrollView>
      )}
    </GitHubToolShell>
  );
}
