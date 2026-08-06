/**
 * GitHub Renderer — Releases.
 */

import { Tag } from '../../primitives';
import { ScrollView, Text, YStack } from 'tamagui';

import { MarkdownContent } from '../../../chat/bubbles/MarkdownContent';
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
  type GitHubRelease,
  GitHubToolShell,
  relativeTime,
  releaseChipProps,
  scrollStyle,
} from './shared';

// list-releases
export function ListReleasesRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<GitHubRelease[]>(output) : null;
  const releases = Array.isArray(parsed) ? parsed : [];
  return (
    <GitHubToolShell toolName={toolName} status={status} description={`${releases.length} release${releases.length === 1 ? '' : 's'}`}>
      {error && <ErrorBlock error={error} />}
      {!error && status === 'completed' && releases.length === 0 && <Empty message="No releases." />}
      {!error && status === 'completed' && releases.length > 0 && (
        <ScrollView style={scrollStyle(360)}>
          <YStack>
            {releases.map((r) => {
              const chip = releaseChipProps(r);
              return (
                <EntityRow
                  key={r.id}
                  leading={<IconTile icon={<Tag size={11} color={chip.accent} />} accent={chip.accent} size={24} />}
                  title={r.name?.trim() || r.tag_name}
                  subtitle={[r.tag_name, relativeTime(r.published_at) ?? relativeTime(r.created_at)].filter(Boolean).join(' · ')}
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

// create-release
export function CreateReleaseRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<GitHubRelease>(output) : null;
  const release = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'tag_name' in (parsed as object)
    ? (parsed as GitHubRelease)
    : null;
  const chip = release ? releaseChipProps(release) : null;
  const rows: KeyValueRow[] = [];
  if (release?.tag_name) rows.push({ key: 'tag', value: release.tag_name });
  if (release?.published_at) rows.push({ key: 'published', value: relativeTime(release.published_at) ?? release.published_at });
  if (release?.author?.login) rows.push({ key: 'author', value: `@${release.author.login}` });

  return (
    <GitHubToolShell toolName={toolName} status={status}>
      {error && <ErrorBlock error={error} />}
      {!error && release && (
        <ResourceCard
          leading={<IconTile icon={<Tag size={14} color={chip?.accent ?? GITHUB_PALETTE.merged} />} accent={chip?.accent ?? GITHUB_PALETTE.merged} size={28} />}
          title={release.name?.trim() || release.tag_name}
          subtitle={release.tag_name}
          verb="created"
          meta={chip ? <IconChip {...chip} /> : null}
        >
          <KeyValueGrid rows={rows} />
          {release.body ? (
            <ScrollView style={scrollStyle(280)}>
              <MarkdownContent text={release.body} />
            </ScrollView>
          ) : (
            <Text color={globalColors.muted} fontSize={10} fontStyle="italic">
              No release notes.
            </Text>
          )}
        </ResourceCard>
      )}
    </GitHubToolShell>
  );
}
