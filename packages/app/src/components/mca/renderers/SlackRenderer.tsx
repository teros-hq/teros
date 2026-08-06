/**
 * Slack MCA — Tool Call Renderer entry point.
 *
 * Dispatches each tool call to a dedicated sub-renderer by short name.
 * 20/20 tools covered. `FallbackRenderer` is a dev-only warning signalling
 * a missing entry in the RENDERERS map — in production it should never
 * render.
 *
 * Sub-renderers compose exclusively the global primitives (ResourceCard,
 * EntityRow, IconChip, IconTile, Avatar, KeyValueGrid, PillList, ActionBadge,
 * DualEntity, MetaStrip) plus prop factories from `./slack/shared`. Brand
 * identity comes from three places only:
 *   - logo via `iconUri={SLACK_ICON}` (set by `SlackToolShell`).
 *   - palette constants from `./slack/shared` (Aubergine + 4 hash colors).
 *   - dynamic colors from the backend (channel privacy, user presence,
 *     file mimetype) mapped to brand-aligned accents in `shared.tsx`.
 */

import { CheckCircle2, ExternalLink, Hash, XCircle } from '@tamagui/lucide-icons';
import type React from 'react';
import { Linking, ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import { MarkdownContent } from '../../chat/bubbles/MarkdownContent';
import {
  ActionBadge,
  Avatar,
  Badge,
  colors as globalColors,
  DualEntity,
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  JsonPreview,
  KeyValueGrid,
  type KeyValueRow,
  MetaStrip,
  parseOutput,
  PillList,
  ResourceCard,
  Specsheet,
  type SpecsheetSection,
  SuccessBlock,
  ToolCallCard,
} from '../primitives';
import {
  channelDisplayName,
  channelLeadingProps,
  fileTypeAccent,
  formatBytes,
  formatDate,
  formatRelativeTime,
  getShortToolName,
  getToolLabel,
  presenceChipProps,
  reactionChipProps,
  scrollStyle,
  shortId,
  SLACK_BRAND,
  SLACK_ICON,
  type SlackChannel,
  type SlackFile,
  type SlackMessage,
  type SlackPresence,
  type SlackReaction,
  type SlackSearchFileHit,
  type SlackSearchMessageHit,
  type SlackTeam,
  type SlackUser,
  slackErrorPresentation,
  SlackToolShell,
  toolStatusForPrimitive,
  tsText,
  unwrap,
  unwrapList,
  useScrollStyle,
  useSlackColors,
  userBotChipProps,
  userDisplayName,
} from './slack/shared';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';

// ============================================================================
// Common helpers
// ============================================================================

function ErrorWithHint({
  error,
  toolName,
}: {
  error: string | undefined | null;
  toolName?: string;
}) {
  if (!error) return null;
  const presentation = slackErrorPresentation(error, toolName);
  if (!presentation) {
    return <ErrorBlock error={error} />;
  }
  // Surface a human title + human sentence as the primary content. The raw
  // upstream string ("not_authorized" etc.) goes to `details` (rendered
  // subdued) so power users / debugging still have it without hitting the
  // primary user with snake_case codes.
  return (
    <ErrorBlock
      title={presentation.title}
      message={presentation.message}
      hint={presentation.hint}
      details={presentation.details}
    />
  );
}

function externalLink(url: string | null | undefined, label = 'open') {
  if (!url) return null;
  return (
    <XStack
      gap={3}
      alignItems="center"
      onPress={() => Linking.openURL(url)}
      cursor="pointer"
      hoverStyle={{ opacity: 0.7 }}
    >
      <Text color={SLACK_BRAND.aubergine} fontSize={9} fontFamily="$mono">
        {label}
      </Text>
      <ExternalLink size={9} color={SLACK_BRAND.aubergine} />
    </XStack>
  );
}

// ============================================================================
// HEALTH CHECK
// ============================================================================

type HealthStatus = 'ready' | 'not_ready' | 'degraded';
type HealthActionType = 'user_action' | 'admin_action' | 'auto_retry';

interface HealthIssue {
  code: string;
  message: string;
  action?: { type: HealthActionType; description: string; url?: string };
}

interface HealthCheckResult {
  status: HealthStatus;
  issues?: HealthIssue[];
  version?: string;
  uptime?: number;
}

const HEALTH_ACCENT: Record<HealthStatus, string> = {
  ready: SLACK_BRAND.green,
  degraded: SLACK_BRAND.yellow,
  not_ready: SLACK_BRAND.red,
};

const HEALTH_TITLE: Record<HealthStatus, string> = {
  ready: 'Healthy',
  degraded: 'Degraded',
  not_ready: 'Not ready',
};

function issueAccent(code: string): string {
  if (code.startsWith('AUTH_')) return SLACK_BRAND.red;
  if (code === 'DEPENDENCY_UNAVAILABLE' || code === 'RATE_LIMITED') return SLACK_BRAND.yellow;
  if (code === 'SYSTEM_CONFIG_MISSING' || code === 'USER_CONFIG_MISSING') return SLACK_BRAND.yellow;
  return globalColors.muted;
}

function formatUptime(seconds: number | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function HealthCheckRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<HealthCheckResult>(output) : null;
  const result =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'status' in (parsed as any)
      ? (parsed as HealthCheckResult)
      : null;

  const healthStatus: HealthStatus = result?.status ?? 'ready';
  const issues = result?.issues ?? [];
  const healthy = healthStatus === 'ready' && issues.length === 0;
  const accent = HEALTH_ACCENT[healthStatus];
  const title = HEALTH_TITLE[healthStatus];

  const rows: KeyValueRow[] = [];
  if (result?.version) rows.push({ key: 'version', value: result.version });
  const uptime = formatUptime(result?.uptime);
  if (uptime) rows.push({ key: 'uptime', value: uptime });

  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && !healthy}
    >
      <ErrorWithHint error={error} toolName={toolName} />
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
          subtitle={result?.version ? `Slack MCA v${result.version}` : undefined}
          meta={<IconChip text={healthStatus.toUpperCase()} accent={accent} />}
        >
          {rows.length > 0 && <KeyValueGrid rows={rows} />}
          {healthy && <SuccessBlock message="All checks passed." />}
          {issues.length > 0 && (
            <YStack gap={6}>
              <Text
                color={globalColors.secondary}
                fontSize={9}
                fontFamily="$mono"
                textTransform="uppercase"
              >
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
    </SlackToolShell>
  );
}

// ============================================================================
// CHANNELS
// ============================================================================

function channelMetaCount(channel: SlackChannel): React.ReactNode {
  if (channel.numMembers == null) return null;
  return (
    <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
      {channel.numMembers} {channel.numMembers === 1 ? 'member' : 'members'}
    </Text>
  );
}

function ListChannelsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const { scrollbarColor } = useSlackColors();
  const parsed = output ? parseOutput(output) : null;
  const { items, total, nextCursor } = unwrapList<SlackChannel>(parsed, 'channels');
  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && items.length > 0}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && (
        <YStack gap={4}>
          {items.length === 0 ? (
            <Empty message="No channels match the filter." />
          ) : (
            <ScrollView style={scrollStyle(420, scrollbarColor)}>
              <YStack gap={2}>
                {items.map((ch) => {
                  const lead = channelLeadingProps(ch);
                  return (
                    <EntityRow
                      key={ch.id}
                      leading={<IconTile accent={lead.accent} icon={lead.icon} size={22} />}
                      title={channelDisplayName(ch)}
                      subtitle={ch.topic || ch.purpose || undefined}
                      badges={
                        ch.isArchived ? (
                          <IconChip text="ARCHIVED" accent={globalColors.muted} />
                        ) : null
                      }
                      meta={channelMetaCount(ch)}
                    />
                  );
                })}
              </YStack>
            </ScrollView>
          )}
          {(total != null || nextCursor) && (
            <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
              {total != null ? `${total} channels` : null}
              {nextCursor ? ` · more available (cursor: ${shortId(nextCursor)})` : null}
            </Text>
          )}
        </YStack>
      )}
    </SlackToolShell>
  );
}

function GetChannelRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput(output) : null;
  const channel = unwrap<SlackChannel>(parsed, 'channel', 'id');

  /** Channel detail as 3-section `Specsheet` — identity / metadata / content. */
  const sections: SpecsheetSection[] = [];
  if (channel) {
    sections.push({
      title: 'Identity',
      rows: [
        { key: 'name', value: channelDisplayName(channel) },
        { key: 'id', value: channel.id },
      ],
    });
    const metadata: SpecsheetSection['rows'] = [];
    if (channel.numMembers != null) metadata.push({ key: 'members', value: String(channel.numMembers) });
    if (channel.creator) metadata.push({ key: 'creator', value: channel.creator });
    if (channel.created) metadata.push({ key: 'created', value: formatDate(channel.created) });
    if (metadata.length > 0) sections.push({ title: 'Metadata', rows: metadata });

    const content: SpecsheetSection['rows'] = [];
    if (channel.topic) content.push({ key: 'topic', value: channel.topic });
    if (channel.purpose) content.push({ key: 'purpose', value: channel.purpose });
    if (content.length > 0) sections.push({ title: 'Content', rows: content });
  }

  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && channel && (
        <ResourceCard
          leading={(() => {
            const l = channelLeadingProps(channel);
            return <IconTile accent={l.accent} icon={l.icon} size={26} />;
          })()}
          title={channelDisplayName(channel)}
          subtitle={channel.topic || channel.purpose || undefined}
          meta={
            <XStack gap={4}>
              {channel.isPrivate ? (
                <IconChip text="PRIVATE" accent={SLACK_BRAND.aubergine} />
              ) : (
                <IconChip text="PUBLIC" accent={SLACK_BRAND.green} />
              )}
              {channel.isArchived ? (
                <IconChip text="ARCHIVED" accent={globalColors.muted} />
              ) : null}
            </XStack>
          }
        >
          {sections.length > 0 && <Specsheet sections={sections} />}
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

function CreateChannelRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput(output) : null;
  const channel = unwrap<SlackChannel>(parsed, 'channel', 'id');
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && channel && (
        <ResourceCard
          leading={(() => {
            const l = channelLeadingProps(channel);
            return <IconTile accent={l.accent} icon={l.icon} size={26} />;
          })()}
          title={channelDisplayName(channel)}
          subtitle={channel.topic || undefined}
          verb="created"
          meta={
            channel.isPrivate ? (
              <IconChip text="PRIVATE" accent={SLACK_BRAND.aubergine} />
            ) : null
          }
        />
      )}
    </SlackToolShell>
  );
}

function ArchiveChannelRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput(output) : null;
  const channel = unwrap<SlackChannel>(parsed, 'channel', 'id');
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && channel && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.muted}
              icon={<Hash size={12} color={globalColors.muted} />}
              size={26}
            />
          }
          title={channelDisplayName(channel)}
          subtitle={shortId(channel.id)}
          verb="archived"
        />
      )}
    </SlackToolShell>
  );
}

function JoinChannelRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput(output) : null;
  const channel = unwrap<SlackChannel>(parsed, 'channel', 'id');
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && channel && (
        <ResourceCard
          leading={(() => {
            const l = channelLeadingProps(channel);
            return <IconTile accent={l.accent} icon={l.icon} size={26} />;
          })()}
          title={channelDisplayName(channel)}
          verb="added"
          subtitle={channel.numMembers != null ? `${channel.numMembers} members` : undefined}
        />
      )}
    </SlackToolShell>
  );
}

interface InviteResult {
  channel: SlackChannel;
  invitedUserIds: string[];
  alreadyInChannel?: unknown;
}

function InviteToChannelRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<InviteResult>(output) : null;
  const result =
    parsed && typeof parsed === 'object' && 'channel' in (parsed as any)
      ? (parsed as InviteResult)
      : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && result && (
        <ResourceCard
          leading={(() => {
            const l = channelLeadingProps(result.channel);
            return <IconTile accent={l.accent} icon={l.icon} size={26} />;
          })()}
          title={channelDisplayName(result.channel)}
          subtitle={`${result.invitedUserIds.length} user${
            result.invitedUserIds.length !== 1 ? 's' : ''
          } invited`}
          verb="added"
        >
          {result.invitedUserIds.length > 0 && (
            <PillList items={result.invitedUserIds.map((id) => shortId(id, 6, 4))} />
          )}
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// MESSAGES
// ============================================================================

function reactionsRow(reactions: SlackReaction[] | undefined): React.ReactNode {
  if (!reactions || reactions.length === 0) return null;
  return (
    <XStack gap={4} flexWrap="wrap">
      {reactions.map((r) => (
        <IconChip key={r.name} {...reactionChipProps(r)} />
      ))}
    </XStack>
  );
}

/**
 * Compact message metadata as horizontal pills for `MetaStrip` — replaces
 * the prior trio of `tsText + formatRelativeTime + messageBadges`. Empty
 * keys are filtered so the strip doesn't show "0 replies" or "undefined".
 */
function messageMetaItems(m: SlackMessage): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  out.push({ key: 'ts', value: m.ts });
  if (m.createdAt) out.push({ key: 'at', value: formatRelativeTime(m.createdAt) ?? '' });
  if (m.threadTs && m.replyCount && m.replyCount > 0) {
    out.push({ key: 'replies', value: String(m.replyCount) });
  }
  if (m.subtype) out.push({ key: 'subtype', value: m.subtype.toUpperCase() });
  return out.filter((i) => i.value);
}

function messageBadges(message: SlackMessage): React.ReactNode {
  const badges: React.ReactNode[] = [];
  if (message.threadTs && message.replyCount && message.replyCount > 0) {
    badges.push(
      <IconChip
        key="replies"
        text={`${message.replyCount} ${message.replyCount === 1 ? 'reply' : 'replies'}`}
        accent={SLACK_BRAND.blue}
      />,
    );
  }
  if (message.subtype) {
    badges.push(
      <IconChip
        key="subtype"
        text={message.subtype.toUpperCase()}
        accent={globalColors.muted}
      />,
    );
  }
  if (badges.length === 0) return null;
  return <XStack gap={4}>{badges}</XStack>;
}

interface SendMessageResult {
  ts: string;
  channel: string;
  message: SlackMessage | null;
  permalink: string | null;
}

function SendMessageRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<SendMessageResult>(output) : null;
  const result =
    parsed && typeof parsed === 'object' && 'ts' in (parsed as any)
      ? (parsed as SendMessageResult)
      : null;
  const text = result?.message?.text ?? '';

  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && !!text}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && result && (
        <ResourceCard
          leading={
            <IconTile
              accent={SLACK_BRAND.aubergine}
              icon={<Hash size={12} color={SLACK_BRAND.aubergine} />}
              size={26}
            />
          }
          title={shortId(result.channel, 6, 4)}
          subtitle={tsText(result.ts)}
          verb="created"
          meta={externalLink(result.permalink, 'permalink')}
        >
          {text ? (
            <YStack
              gap={4}
              padding={8}
              borderRadius={5}
              backgroundColor={`${SLACK_BRAND.aubergine}10`}
              borderLeftWidth={2}
              borderLeftColor={SLACK_BRAND.aubergine}
            >
              <MarkdownContent text={text} />
            </YStack>
          ) : null}
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

interface SendThreadResult {
  ts: string;
  channel: string;
  threadTs: string;
  broadcast: boolean;
  message: SlackMessage | null;
}

function SendThreadReplyRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<SendThreadResult>(output) : null;
  const result =
    parsed && typeof parsed === 'object' && 'threadTs' in (parsed as any)
      ? (parsed as SendThreadResult)
      : null;

  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && !!result?.message?.text}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && result && (
        <ResourceCard
          leading={
            <IconTile
              accent={SLACK_BRAND.aubergine}
              icon={<Hash size={12} color={SLACK_BRAND.aubergine} />}
              size={26}
            />
          }
          title={shortId(result.channel, 6, 4)}
          subtitle={
            <XStack gap={4} alignItems="center">
              {tsText(result.ts)}
              <Text color={globalColors.muted} fontSize={9}>
                in thread {shortId(result.threadTs, 6, 4)}
              </Text>
            </XStack>
          }
          verb="created"
          meta={
            result.broadcast ? (
              <IconChip text="BROADCAST" accent={SLACK_BRAND.yellow} />
            ) : null
          }
        >
          {result.message?.text ? (
            <YStack
              gap={4}
              padding={8}
              borderRadius={5}
              backgroundColor={`${SLACK_BRAND.aubergine}10`}
              borderLeftWidth={2}
              borderLeftColor={SLACK_BRAND.aubergine}
            >
              <MarkdownContent text={result.message.text} />
            </YStack>
          ) : null}
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

interface ListMessagesResult {
  messages: SlackMessage[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  isThread: boolean;
}

function ListMessagesRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const { scrollbarColor } = useSlackColors();
  const parsed = output ? parseOutput<ListMessagesResult>(output) : null;
  const result =
    parsed && typeof parsed === 'object' && 'messages' in (parsed as any)
      ? (parsed as ListMessagesResult)
      : null;
  const messages = result?.messages ?? [];

  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && messages.length > 0}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && (
        <YStack gap={4}>
          {messages.length === 0 ? (
            <Empty message="No messages in the time range." />
          ) : (
            <ScrollView style={scrollStyle(440, scrollbarColor)}>
              <YStack gap={4}>
                {messages.map((m) => (
                  <YStack
                    key={m.ts}
                    gap={3}
                    padding={6}
                    borderRadius={5}
                    backgroundColor={`${SLACK_BRAND.aubergine}08`}
                  >
                    <XStack gap={8} alignItems="center" flexWrap="wrap">
                      <Avatar name={m.userName ?? m.user ?? '?'} size={22} />
                      <Text color={globalColors.primary} fontSize={10} fontWeight="600">
                        {m.userName ?? m.user ?? 'unknown'}
                      </Text>
                      <MetaStrip items={messageMetaItems(m)} />
                    </XStack>
                    {m.text ? <MarkdownContent text={m.text} /> : null}
                    {reactionsRow(m.reactions)}
                  </YStack>
                ))}
              </YStack>
            </ScrollView>
          )}
          {(result?.total != null || result?.nextCursor) && (
            <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
              {result?.total != null ? `${result.total} messages` : null}
              {result?.isThread ? ' · thread' : ''}
              {result?.nextCursor ? ` · more available` : ''}
            </Text>
          )}
        </YStack>
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// REACTIONS
// ============================================================================

interface ReactionResult {
  channel: string;
  timestamp: string;
  name: string;
}

function AddReactionRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<ReactionResult>(output) : null;
  const r =
    parsed && typeof parsed === 'object' && 'name' in (parsed as any)
      ? (parsed as ReactionResult)
      : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && r && (
        <ResourceCard
          leading={
            <IconTile
              accent={SLACK_BRAND.yellow}
              icon={<Text fontSize={14}>🙂</Text>}
              size={26}
            />
          }
          title={`:${r.name}:`}
          subtitle={
            <XStack gap={4} alignItems="center">
              {tsText(r.timestamp)}
              <Text color={globalColors.muted} fontSize={9}>
                in {shortId(r.channel, 6, 4)}
              </Text>
            </XStack>
          }
          verb="added"
        />
      )}
    </SlackToolShell>
  );
}

function RemoveReactionRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const parsed = output ? parseOutput<ReactionResult>(output) : null;
  const r =
    parsed && typeof parsed === 'object' && 'name' in (parsed as any)
      ? (parsed as ReactionResult)
      : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && r && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.muted}
              icon={<Text fontSize={14}>🙂</Text>}
              size={26}
            />
          }
          title={`:${r.name}:`}
          subtitle={
            <XStack gap={4} alignItems="center">
              {tsText(r.timestamp)}
              <Text color={globalColors.muted} fontSize={9}>
                in {shortId(r.channel, 6, 4)}
              </Text>
            </XStack>
          }
          verb="removed"
        />
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// USERS
// ============================================================================

function userBadges(user: SlackUser): React.ReactNode {
  const badges: React.ReactNode[] = [];
  const bot = userBotChipProps(user);
  if (bot) badges.push(<IconChip key="bot" {...bot} />);
  if (user.isOwner) badges.push(<IconChip key="owner" text="OWNER" accent={SLACK_BRAND.yellow} />);
  else if (user.isAdmin) badges.push(<IconChip key="admin" text="ADMIN" accent={SLACK_BRAND.blue} />);
  if (user.deleted)
    badges.push(<IconChip key="deleted" text="DEACTIVATED" accent={globalColors.muted} />);
  if (badges.length === 0) return null;
  return <XStack gap={4}>{badges}</XStack>;
}

function ListUsersRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const { scrollbarColor } = useSlackColors();
  const parsed = output ? parseOutput(output) : null;
  const { items, total, nextCursor } = unwrapList<SlackUser>(parsed, 'users');
  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && items.length > 0}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && (
        <YStack gap={4}>
          {items.length === 0 ? (
            <Empty message="No users found." />
          ) : (
            <ScrollView style={scrollStyle(440, scrollbarColor)}>
              <YStack gap={2}>
                {items.map((u) => (
                  <EntityRow
                    key={u.id}
                    leading={
                      <Avatar src={u.imageUrl ?? undefined} name={userDisplayName(u)} size={22} />
                    }
                    title={userDisplayName(u)}
                    subtitle={u.email ?? u.name}
                    badges={userBadges(u)}
                    meta={
                      u.tz ? (
                        <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
                          {u.tz}
                        </Text>
                      ) : null
                    }
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
          {(total != null || nextCursor) && (
            <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
              {total != null ? `${total} users` : null}
              {nextCursor ? ` · more available` : null}
            </Text>
          )}
        </YStack>
      )}
    </SlackToolShell>
  );
}

function GetUserRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput(output) : null;
  const user = unwrap<SlackUser>(parsed, 'user', 'id');

  /** User detail as 3-section `Specsheet` — identity (who), presence (where/when), role (what). */
  const sections: SpecsheetSection[] = [];
  if (user) {
    const identity: SpecsheetSection['rows'] = [];
    identity.push({ key: 'displayName', value: user.displayName ?? user.name });
    if (user.realName) identity.push({ key: 'realName', value: user.realName });
    if (user.email) identity.push({ key: 'email', value: user.email });
    sections.push({ title: 'Identity', rows: identity });

    const presence: SpecsheetSection['rows'] = [];
    if (user.statusText) {
      presence.push({ key: 'status', value: `${user.statusEmoji ?? ''} ${user.statusText}`.trim() });
    }
    if (user.tz) presence.push({ key: 'tz', value: user.tz });
    if (presence.length > 0) sections.push({ title: 'Presence', rows: presence });

    const role: SpecsheetSection['rows'] = [];
    if (user.title) role.push({ key: 'title', value: user.title });
    if (user.isAdmin) role.push({ key: 'admin', value: 'yes' });
    if (user.isOwner) role.push({ key: 'owner', value: 'yes' });
    if (user.isBot) role.push({ key: 'bot', value: 'yes' });
    if (role.length > 0) sections.push({ title: 'Role', rows: role });
  }

  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && user && (
        <ResourceCard
          leading={<Avatar src={user.imageUrl ?? undefined} name={userDisplayName(user)} size={32} />}
          title={userDisplayName(user)}
          subtitle={user.email ?? user.name}
          meta={userBadges(user)}
        >
          {sections.length > 0 && <Specsheet sections={sections} />}
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

function GetUserPresenceRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const { text3 } = useSlackColors();
  const parsed = output ? parseOutput<SlackPresence>(output) : null;
  const p =
    parsed && typeof parsed === 'object' && 'user' in (parsed as any)
      ? (parsed as SlackPresence)
      : null;
  const chip = presenceChipProps(p?.presence, text3);

  const metaItems: { key: string; value: string; accent?: string }[] = [];
  if (p) {
    if (chip?.text)
      metaItems.push({ key: 'presence', value: chip.text, accent: chip.accent });
    if (p.lastActivity) {
      const rel = formatRelativeTime(p.lastActivity);
      if (rel) metaItems.push({ key: 'lastActivity', value: rel });
    }
    if (p.connectionCount != null)
      metaItems.push({ key: 'connections', value: String(p.connectionCount) });
    if (p.autoAway) metaItems.push({ key: 'autoAway', value: 'yes' });
    if (p.manualAway) metaItems.push({ key: 'manualAway', value: 'yes' });
  }

  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && p && (
        <ResourceCard
          leading={
            <IconTile
              accent={chip?.accent ?? globalColors.muted}
              icon={<Text fontSize={14}>{p.online ? '🟢' : '⚫'}</Text>}
              size={26}
            />
          }
          title={shortId(p.user, 6, 4)}
          subtitle={chip?.text}
          meta={chip ? <IconChip {...chip} /> : null}
        >
          {metaItems.length > 0 && <MetaStrip items={metaItems} />}
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// FILES
// ============================================================================

function fileRows(file: SlackFile): KeyValueRow[] {
  const rows: KeyValueRow[] = [];
  if (file.prettyType) rows.push({ key: 'type', value: file.prettyType });
  else if (file.mimetype) rows.push({ key: 'mimetype', value: file.mimetype });
  if (file.size != null) rows.push({ key: 'size', value: formatBytes(file.size) });
  if (file.user) rows.push({ key: 'user', value: file.userName ?? file.user });
  if (file.createdAt) rows.push({ key: 'created', value: formatDate(file.createdAt) });
  if (file.channels && file.channels.length > 0)
    rows.push({ key: 'channels', value: `${file.channels.length}` });
  return rows;
}

function fileLeading(file: SlackFile, size = 26, neutralColor?: string): React.ReactNode {
  const accent = fileTypeAccent(file.mimetype, file.fileType, neutralColor);
  const initial = (file.name?.[0] ?? '?').toUpperCase();
  return <IconTile accent={accent} label={initial} size={size} />;
}

function UploadFileRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const { text3 } = useSlackColors();
  const parsed = output ? parseOutput<SlackFile>(output) : null;
  const file =
    parsed && typeof parsed === 'object' && 'id' in (parsed as any) ? (parsed as SlackFile) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && file && (
        <ResourceCard
          leading={fileLeading(file, undefined, text3)}
          title={file.title || file.name || shortId(file.id)}
          subtitle={file.prettyType ?? file.mimetype ?? undefined}
          verb="created"
          meta={externalLink(file.permalink, 'open')}
        >
          {fileRows(file).length > 0 && <KeyValueGrid rows={fileRows(file)} />}
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

function ListFilesRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const { scrollbarColor, text3 } = useSlackColors();
  const parsed = output ? parseOutput(output) : null;
  const { items, total } = unwrapList<SlackFile>(parsed, 'files');
  const paging = (parsed && typeof parsed === 'object' ? (parsed as any).paging : null) as
    | { count?: number; total?: number; page?: number; pages?: number }
    | null;
  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && items.length > 0}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && (
        <YStack gap={4}>
          {items.length === 0 ? (
            <Empty message="No files match the filter." />
          ) : (
            <ScrollView style={scrollStyle(440, scrollbarColor)}>
              <YStack gap={2}>
                {items.map((f) => (
                  <EntityRow
                    key={f.id}
                    leading={fileLeading(f, 22, text3)}
                    title={f.title || f.name || shortId(f.id)}
                    subtitle={f.prettyType ?? f.mimetype}
                    badges={
                      f.size != null ? (
                        <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
                          {formatBytes(f.size)}
                        </Text>
                      ) : null
                    }
                    meta={externalLink(f.permalink, 'open')}
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
          <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
            {total != null ? `${total} files` : null}
            {paging?.pages && paging.pages > 1
              ? ` · page ${paging.page ?? 1}/${paging.pages}`
              : ''}
          </Text>
        </YStack>
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// SEARCH
// ============================================================================

function SearchMessagesRenderer({
  toolName,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const { scrollbarColor } = useSlackColors();
  const parsed = output ? parseOutput(output) : null;
  const matches = ((parsed as any)?.matches ?? []) as SlackSearchMessageHit[];
  const total = (parsed as any)?.total as number | undefined;
  const page = (parsed as any)?.page as number | undefined;

  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && matches.length > 0}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && (
        <YStack gap={4}>
          {matches.length === 0 ? (
            <Empty message="No matches." />
          ) : (
            <ScrollView style={scrollStyle(440, scrollbarColor)}>
              <YStack gap={4}>
                {matches.map((m) => {
                  const hitMeta: { key: string; value: string }[] = [{ key: 'ts', value: m.ts }];
                  if (m.score != null)
                    hitMeta.push({ key: 'score', value: m.score.toFixed(2) });
                  return (
                    <YStack
                      key={`${m.channel}-${m.ts}`}
                      gap={3}
                      padding={6}
                      borderRadius={5}
                      backgroundColor={`${SLACK_BRAND.aubergine}08`}
                    >
                      <XStack gap={8} alignItems="center" flexWrap="wrap">
                        <Avatar name={m.userName ?? m.user ?? '?'} size={20} />
                        <Text color={SLACK_BRAND.green} fontSize={9} fontWeight="600">
                          #{m.channelName}
                        </Text>
                        <Text color={globalColors.primary} fontSize={9}>
                          {m.userName ?? m.user ?? 'unknown'}
                        </Text>
                        <MetaStrip items={hitMeta} />
                        {externalLink(m.permalink, 'open')}
                      </XStack>
                      <MarkdownContent text={m.text} />
                    </YStack>
                  );
                })}
              </YStack>
            </ScrollView>
          )}
          <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
            {total != null ? `${total} total` : null}
            {page ? ` · page ${page}` : ''}
          </Text>
        </YStack>
      )}
    </SlackToolShell>
  );
}

function SearchFilesRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const { scrollbarColor, text3 } = useSlackColors();
  const parsed = output ? parseOutput(output) : null;
  const matches = ((parsed as any)?.matches ?? []) as SlackSearchFileHit[];
  const total = (parsed as any)?.total as number | undefined;
  const page = (parsed as any)?.page as number | undefined;

  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && matches.length > 0}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && (
        <YStack gap={4}>
          {matches.length === 0 ? (
            <Empty message="No matches." />
          ) : (
            <ScrollView style={scrollStyle(440, scrollbarColor)}>
              <YStack gap={2}>
                {matches.map((f) => {
                  const metaPills: { key: string; value: string }[] = [];
                  if (f.mimetype) metaPills.push({ key: 'type', value: f.mimetype });
                  if (f.createdAt) {
                    const rel = formatRelativeTime(f.createdAt);
                    if (rel) metaPills.push({ key: 'created', value: rel });
                  }
                  if (f.score != null)
                    metaPills.push({ key: 'score', value: f.score.toFixed(2) });
                  return (
                    <EntityRow
                      key={f.id}
                      leading={fileLeading(
                        { id: f.id, name: f.name, mimetype: f.mimetype },
                        22,
                        text3,
                      )}
                      title={f.title || f.name}
                      subtitle={f.mimetype}
                      meta={
                        <XStack gap={6} alignItems="center">
                          {metaPills.length > 0 && <MetaStrip items={metaPills} />}
                          {externalLink(f.permalink, 'open')}
                        </XStack>
                      }
                    />
                  );
                })}
              </YStack>
            </ScrollView>
          )}
          <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
            {total != null ? `${total} total` : null}
            {page ? ` · page ${page}` : ''}
          </Text>
        </YStack>
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// TEAM
// ============================================================================

function GetTeamInfoRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? parseOutput<SlackTeam>(output) : null;
  const team =
    parsed && typeof parsed === 'object' && 'id' in (parsed as any) ? (parsed as SlackTeam) : null;

  /** Team detail as 2-section `Specsheet` — identity (who) + enterprise (where). */
  const sections: SpecsheetSection[] = [];
  if (team) {
    const identity: SpecsheetSection['rows'] = [{ key: 'name', value: team.name }];
    if (team.domain) identity.push({ key: 'domain', value: `${team.domain}.slack.com` });
    if (team.emailDomain) identity.push({ key: 'emailDomain', value: team.emailDomain });
    sections.push({ title: 'Identity', rows: identity });

    if (team.enterpriseName) {
      sections.push({
        title: 'Enterprise',
        rows: [{ key: 'name', value: team.enterpriseName }],
      });
    }
  }

  const teamUrl = team?.domain ? `https://${team.domain}.slack.com` : null;

  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && team && (
        <ResourceCard
          leading={<Avatar src={team.iconUrl ?? undefined} name={team.name} size={32} />}
          title={team.name}
          subtitle={team.domain ? `${team.domain}.slack.com` : undefined}
          meta={externalLink(teamUrl, 'open')}
        >
          {sections.length > 0 && <Specsheet sections={sections} />}
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// REGISTRY — 20/20 coverage
// ============================================================================

// ============================================================================
// COMMIT 1: Messages — update, delete, permalink, schedule, list-scheduled, delete-scheduled, ephemeral
// ============================================================================

interface UpdateMessageOutput {
  ts: string;
  channel: string;
  text: string;
  message: SlackMessage | null;
}

function UpdateMessageRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as UpdateMessageOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={SLACK_BRAND.aubergine}
              icon={<Text fontSize={12}>✎</Text>}
              size={26}
            />
          }
          title="Message updated"
          subtitle={`#${shortId(parsed.channel, 6, 4)} · ${parsed.ts}`}
          verb="updated"
        >
          {parsed.text && <MarkdownContent text={parsed.text} />}
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

interface DeleteMessageOutput {
  channel: string;
  ts: string;
  deleted: boolean;
}

function DeleteMessageRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as DeleteMessageOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.red}
              icon={<XCircle size={14} color={globalColors.red} />}
              size={26}
            />
          }
          title="Message deleted"
          subtitle={`#${shortId(parsed.channel, 6, 4)} · ${parsed.ts}`}
          verb="deleted"
        />
      )}
    </SlackToolShell>
  );
}

interface GetPermalinkOutput {
  channel: string;
  ts: string;
  permalink: string | null;
}

function GetPermalinkRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as GetPermalinkOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={SLACK_BRAND.aubergine}
              icon={<ExternalLink size={12} color={SLACK_BRAND.aubergine} />}
              size={26}
            />
          }
          title="Permalink"
          subtitle={`#${shortId(parsed.channel, 6, 4)} · ${parsed.ts}`}
          meta={externalLink(parsed.permalink, 'open')}
        />
      )}
    </SlackToolShell>
  );
}

interface ScheduleMessageOutput {
  channel: string;
  scheduledMessageId: string;
  postAt: number;
  postAtIso: string | null;
}

function ScheduleMessageRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as ScheduleMessageOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.amber}
              icon={<Text fontSize={12}>⏱</Text>}
              size={26}
            />
          }
          title="Message scheduled"
          subtitle={`#${shortId(parsed.channel, 6, 4)} · id ${shortId(parsed.scheduledMessageId, 4, 3)}`}
          verb="created"
        >
          {parsed.postAtIso && (
            <MetaStrip items={[
              { key: 'post at', value: parsed.postAtIso },
              { key: 'in', value: formatRelativeTime(parsed.postAtIso) ?? '' },
            ].filter((i) => i.value)} />
          )}
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

interface ScheduledItem {
  id: string;
  channelId: string;
  postAt: number | null;
  postAtIso: string | null;
  text: string;
}

interface ListScheduledOutput {
  messages: ScheduledItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

function ListScheduledRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const { scrollbarColor } = useSlackColors();
  const parsed = output ? (parseOutput(output) as ListScheduledOutput | null) : null;
  const items = parsed?.messages ?? [];
  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && items.length > 0}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && (
        <YStack gap={4}>
          {items.length === 0 ? (
            <Empty message="No scheduled messages." />
          ) : (
            <ScrollView style={scrollStyle(440, scrollbarColor)}>
              <YStack>
                {items.map((m) => (
                  <EntityRow
                    key={m.id}
                    leading={
                      <IconTile
                        accent={globalColors.amber}
                        icon={<Text fontSize={12}>⏱</Text>}
                        size={22}
                      />
                    }
                    title={m.text || '(no text)'}
                    subtitle={`#${shortId(m.channelId, 6, 4)}`}
                    meta={
                      <MetaStrip
                        items={[
                          { key: 'at', value: m.postAtIso ?? '' },
                          { key: 'in', value: m.postAtIso ? (formatRelativeTime(m.postAtIso) ?? '') : '' },
                        ].filter((i) => i.value)}
                      />
                    }
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
          {parsed?.hasMore && (
            <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
              + more available (use cursor to paginate)
            </Text>
          )}
        </YStack>
      )}
    </SlackToolShell>
  );
}

interface DeleteScheduledOutput {
  channel: string;
  scheduledMessageId: string;
  deleted: boolean;
}

function DeleteScheduledRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as DeleteScheduledOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.red}
              icon={<XCircle size={14} color={globalColors.red} />}
              size={26}
            />
          }
          title="Scheduled message cancelled"
          subtitle={`#${shortId(parsed.channel, 6, 4)} · id ${shortId(parsed.scheduledMessageId, 4, 3)}`}
          verb="deleted"
        />
      )}
    </SlackToolShell>
  );
}

interface SendEphemeralOutput {
  channel: string;
  user: string;
  messageTs: string | null;
}

function SendEphemeralRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as SendEphemeralOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={SLACK_BRAND.aubergine}
              icon={<Text fontSize={12}>👁</Text>}
              size={26}
            />
          }
          title="Ephemeral message"
          subtitle={`#${shortId(parsed.channel, 6, 4)} → ${shortId(parsed.user, 4, 3)}`}
          verb="created"
          meta={
            <Badge text="EPHEMERAL" variant="warning" />
          }
        />
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// COMMIT 2: Pins + Bookmarks
// ============================================================================

interface PinResult {
  channel: string;
  timestamp: string;
  pinned?: boolean;
  unpinned?: boolean;
}

function PinMessageRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as PinResult | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={SLACK_BRAND.aubergine}
              icon={<Text fontSize={12}>📌</Text>}
              size={26}
            />
          }
          title="Message pinned"
          subtitle={`#${shortId(parsed.channel, 6, 4)} · ${parsed.timestamp}`}
          verb="added"
        />
      )}
    </SlackToolShell>
  );
}

function UnpinMessageRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as PinResult | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.muted}
              icon={<Text fontSize={12}>📌</Text>}
              size={26}
            />
          }
          title="Message unpinned"
          subtitle={`#${shortId(parsed.channel, 6, 4)} · ${parsed.timestamp}`}
          verb="removed"
        />
      )}
    </SlackToolShell>
  );
}

interface PinItem {
  type: 'message' | 'file';
  createdAt: string | null;
  createdBy: string | null;
  message?: SlackMessage;
  file?: SlackFile;
}

interface ListPinsOutput {
  pins: PinItem[];
  count: number;
}

function ListPinsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const { scrollbarColor } = useSlackColors();
  const parsed = output ? (parseOutput(output) as ListPinsOutput | null) : null;
  const pins = parsed?.pins ?? [];
  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && pins.length > 0}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && (
        <YStack gap={4}>
          {pins.length === 0 ? (
            <Empty message="No pins in this channel." />
          ) : (
            <ScrollView style={scrollStyle(440, scrollbarColor)}>
              <YStack>
                {pins.map((p, i) => {
                  const isMsg = p.type === 'message';
                  const title = isMsg
                    ? (p.message?.text || '(no text)')
                    : (p.file?.name || p.file?.title || '(file)');
                  const subtitle = isMsg
                    ? p.message?.userName ?? p.message?.user ?? undefined
                    : p.file?.prettyType ?? p.file?.mimetype ?? undefined;
                  return (
                    <EntityRow
                      // biome-ignore lint/suspicious/noArrayIndexKey: stable order from API
                      key={i}
                      leading={
                        <IconTile
                          accent={SLACK_BRAND.aubergine}
                          icon={<Text fontSize={12}>{isMsg ? '💬' : '📎'}</Text>}
                          size={22}
                        />
                      }
                      title={title}
                      subtitle={subtitle}
                      meta={
                        <MetaStrip
                          items={[
                            { key: 'type', value: p.type.toUpperCase() },
                            ...(p.createdAt ? [{ key: 'pinned', value: formatRelativeTime(p.createdAt) ?? '' }] : []),
                          ].filter((it) => it.value)}
                        />
                      }
                    />
                  );
                })}
              </YStack>
            </ScrollView>
          )}
        </YStack>
      )}
    </SlackToolShell>
  );
}

interface CuratedBookmark {
  id: string;
  channelId: string;
  title: string;
  link: string;
  emoji: string | null;
  type: string;
  dateCreated: string | null;
  dateUpdated: string | null;
  rank: string | null;
}

function AddBookmarkRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as CuratedBookmark | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={SLACK_BRAND.green}
              icon={<Text fontSize={12}>{parsed.emoji ? '🔖' : '🔖'}</Text>}
              size={26}
            />
          }
          title={parsed.title}
          subtitle={`#${shortId(parsed.channelId, 6, 4)}`}
          verb="added"
          meta={externalLink(parsed.link, 'open')}
        />
      )}
    </SlackToolShell>
  );
}

interface RemoveBookmarkOutput {
  channel: string;
  bookmarkId: string;
  removed: boolean;
}

function RemoveBookmarkRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as RemoveBookmarkOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.muted}
              icon={<Text fontSize={12}>🔖</Text>}
              size={26}
            />
          }
          title="Bookmark removed"
          subtitle={`#${shortId(parsed.channel, 6, 4)} · ${shortId(parsed.bookmarkId, 4, 3)}`}
          verb="removed"
        />
      )}
    </SlackToolShell>
  );
}

interface ListBookmarksOutput {
  bookmarks: CuratedBookmark[];
  count: number;
}

function ListBookmarksRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const { scrollbarColor } = useSlackColors();
  const parsed = output ? (parseOutput(output) as ListBookmarksOutput | null) : null;
  const bookmarks = parsed?.bookmarks ?? [];
  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && bookmarks.length > 0}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && (
        <YStack gap={4}>
          {bookmarks.length === 0 ? (
            <Empty message="No bookmarks." />
          ) : (
            <ScrollView style={scrollStyle(360, scrollbarColor)}>
              <YStack>
                {bookmarks.map((b) => (
                  <EntityRow
                    key={b.id}
                    leading={
                      <IconTile
                        accent={SLACK_BRAND.green}
                        icon={<Text fontSize={12}>🔖</Text>}
                        size={22}
                      />
                    }
                    title={b.title}
                    subtitle={b.link}
                    meta={externalLink(b.link, 'open')}
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
        </YStack>
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// COMMIT 3: Files — get-file, delete-file
// ============================================================================

interface GetFileOutput {
  file: SlackFile | null;
  comments?: { id: string; user: string | null; comment: string; createdAt: string | null }[];
}

function GetFileRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const { text3 } = useSlackColors();
  const parsed = output ? (parseOutput(output) as GetFileOutput | null) : null;
  const file = parsed?.file ?? null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && file && (
        <ResourceCard
          leading={fileLeading(file, 28, text3)}
          title={file.title || file.name || shortId(file.id)}
          subtitle={file.prettyType ?? file.mimetype ?? undefined}
          meta={externalLink(file.permalink, 'open')}
        >
          {fileRows(file).length > 0 && <KeyValueGrid rows={fileRows(file)} />}
          {parsed?.comments && parsed.comments.length > 0 && (
            <YStack gap={3} marginTop={6}>
              <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
                Comments ({parsed.comments.length})
              </Text>
              {parsed.comments.slice(0, 10).map((c) => (
                <XStack key={c.id} gap={6} alignItems="flex-start">
                  <Text color={globalColors.muted} fontSize={9} fontFamily="$mono" minWidth={56}>
                    {shortId(c.user ?? '?', 4, 3)}
                  </Text>
                  <Text flex={1} color={globalColors.primary} fontSize={10}>
                    {c.comment}
                  </Text>
                </XStack>
              ))}
            </YStack>
          )}
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

interface DeleteFileOutput {
  fileId: string;
  deleted: boolean;
}

function DeleteFileRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as DeleteFileOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.red}
              icon={<XCircle size={14} color={globalColors.red} />}
              size={26}
            />
          }
          title="File deleted"
          subtitle={shortId(parsed.fileId, 6, 4)}
          verb="deleted"
        />
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// COMMIT 4: Channels complete — leave, members, open-dm
// ============================================================================

interface LeaveChannelOutput {
  channelId: string;
  notInChannel: boolean;
}

function LeaveChannelRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as LeaveChannelOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.muted}
              icon={<Hash size={12} color={globalColors.muted} />}
              size={26}
            />
          }
          title="Left channel"
          subtitle={shortId(parsed.channelId, 6, 4)}
          verb="removed"
        />
      )}
    </SlackToolShell>
  );
}

interface ListChannelMembersOutput {
  channelId: string;
  members: string[];
  count: number;
  nextCursor: string | null;
  hasMore: boolean;
}

function ListChannelMembersRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const { scrollbarColor } = useSlackColors();
  const parsed = output ? (parseOutput(output) as ListChannelMembersOutput | null) : null;
  const members = parsed?.members ?? [];
  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && members.length > 0}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <YStack gap={4}>
          <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
            #{shortId(parsed.channelId, 6, 4)} · {parsed.count} members
          </Text>
          {members.length === 0 ? (
            <Empty message="No members." />
          ) : (
            <ScrollView style={scrollStyle(360, scrollbarColor)}>
              <YStack gap={1}>
                {members.map((uid) => (
                  <XStack key={uid} gap={6} alignItems="center" paddingVertical={2}>
                    <Avatar name={uid} size={18} />
                    <Text color={globalColors.primary} fontSize={10} fontFamily="$mono">
                      {uid}
                    </Text>
                  </XStack>
                ))}
              </YStack>
            </ScrollView>
          )}
          {parsed.hasMore && (
            <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
              + more available (use cursor to paginate)
            </Text>
          )}
        </YStack>
      )}
    </SlackToolShell>
  );
}

interface OpenDmOutput {
  channel: SlackChannel;
  alreadyOpen: boolean;
  noOp: boolean;
}

function OpenDmRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as OpenDmOutput | null) : null;
  const channel = parsed?.channel ?? null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && channel && (
        <ResourceCard
          leading={(() => {
            const l = channelLeadingProps(channel);
            return <IconTile accent={l.accent} icon={l.icon} size={26} />;
          })()}
          title={channelDisplayName(channel)}
          subtitle={shortId(channel.id, 6, 4)}
          verb={parsed?.alreadyOpen ? undefined : 'created'}
          meta={
            parsed?.alreadyOpen ? (
              <Badge text="EXISTING" variant="gray" />
            ) : (
              <Badge text="NEW" variant="success" />
            )
          }
        />
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// COMMIT 5: Users complete — profile.get, profile.set
// ============================================================================

interface CuratedProfile {
  userId: string | null;
  realName: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  statusText: string | null;
  statusEmoji: string | null;
  statusExpiration: string | null;
  imageUrl: string | null;
  tz: string | null;
  customFields: Record<string, { value: string; alt?: string }> | null;
}

function GetUserProfileRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as CuratedProfile | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={<Avatar src={parsed.imageUrl ?? undefined} name={parsed.realName || parsed.displayName || '?'} size={32} />}
          title={parsed.realName || parsed.displayName || shortId(parsed.userId ?? '?')}
          subtitle={parsed.title ?? undefined}
        >
          <Specsheet
            sections={(() => {
              const identity: { key: string; value: string }[] = [];
              if (parsed.displayName) identity.push({ key: 'display', value: parsed.displayName });
              if (parsed.email) identity.push({ key: 'email', value: parsed.email });
              if (parsed.phone) identity.push({ key: 'phone', value: parsed.phone });
              if (parsed.tz) identity.push({ key: 'timezone', value: parsed.tz });

              const status: { key: string; value: string }[] = [];
              if (parsed.statusText) status.push({ key: 'text', value: parsed.statusText });
              if (parsed.statusEmoji) status.push({ key: 'emoji', value: parsed.statusEmoji });
              if (parsed.statusExpiration) status.push({ key: 'expires', value: parsed.statusExpiration });

              const customFields: { key: string; value: string }[] = parsed.customFields
                ? Object.entries(parsed.customFields).map(([k, v]) => ({ key: k, value: v.value ?? '' }))
                : [];

              const sections: SpecsheetSection[] = [];
              if (identity.length > 0) sections.push({ title: 'Identity', rows: identity });
              if (status.length > 0) sections.push({ title: 'Status', rows: status });
              if (customFields.length > 0) sections.push({ title: 'Custom Fields', rows: customFields });
              return sections;
            })()}
          />
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

interface UpdateUserProfileOutput {
  userId: string | null;
  updated: string[];
  profile: any;
}

function UpdateUserProfileRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as UpdateUserProfileOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={SLACK_BRAND.aubergine}
              icon={<Text fontSize={12}>✎</Text>}
              size={26}
            />
          }
          title="Profile updated"
          subtitle={parsed.userId ? `user ${shortId(parsed.userId, 4, 3)}` : 'authed user'}
          verb="updated"
          meta={
            parsed.updated.length > 0 ? (
              <PillList items={parsed.updated} max={6} accent={SLACK_BRAND.green} />
            ) : null
          }
        />
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// COMMIT 6: DND + reactions.get + team.preferences
// ============================================================================

interface SetDndOutput {
  snoozeEnabled: boolean;
  snoozeEndtime: string | null;
  snoozeRemaining: number | null;
}

function SetDndRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as SetDndOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.amber}
              icon={<Text fontSize={12}>🌙</Text>}
              size={26}
            />
          }
          title="DND enabled"
          subtitle={parsed.snoozeEndtime ?? undefined}
          verb="enabled"
          meta={
            parsed.snoozeEndtime ? (
              <MetaStrip
                items={[
                  { key: 'until', value: parsed.snoozeEndtime },
                  ...(parsed.snoozeEndtime
                    ? [{ key: 'in', value: formatRelativeTime(parsed.snoozeEndtime) ?? '' }]
                    : []),
                ].filter((i) => i.value)}
              />
            ) : null
          }
        />
      )}
    </SlackToolShell>
  );
}

function EndDndRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.green}
              icon={<Text fontSize={12}>☀</Text>}
              size={26}
            />
          }
          title="DND ended"
          verb="disabled"
        />
      )}
    </SlackToolShell>
  );
}

interface GetDndOutput {
  snoozeEnabled: boolean;
  snoozeEndtime: string | null;
  snoozeRemaining: number | null;
  nextDndStart: string | null;
  nextDndEnd: string | null;
}

function GetDndRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as GetDndOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={parsed.snoozeEnabled ? globalColors.amber : globalColors.green}
              icon={<Text fontSize={12}>{parsed.snoozeEnabled ? '🌙' : '☀'}</Text>}
              size={26}
            />
          }
          title={parsed.snoozeEnabled ? 'Currently in DND' : 'Available'}
          meta={
            <MetaStrip
              items={[
                { key: 'snooze', value: parsed.snoozeEnabled ? 'on' : 'off' },
                ...(parsed.snoozeEndtime ? [{ key: 'until', value: parsed.snoozeEndtime }] : []),
                ...(parsed.nextDndStart ? [{ key: 'next start', value: parsed.nextDndStart }] : []),
              ]}
            />
          }
        />
      )}
    </SlackToolShell>
  );
}

interface GetReactionsOutput {
  reactions: { name: string; count: number; users: string[] }[];
  type: 'message' | 'file';
  target: { channel?: string; timestamp?: string; file?: string };
}

function GetReactionsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as GetReactionsOutput | null) : null;
  const reactions = parsed?.reactions ?? [];
  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && reactions.length > 0}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && (
        <YStack gap={4}>
          <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
            {parsed?.type === 'message'
              ? `#${shortId(parsed.target.channel ?? '', 6, 4)} · ${parsed.target.timestamp ?? ''}`
              : `file ${shortId(parsed?.target.file ?? '', 6, 4)}`}
          </Text>
          {reactions.length === 0 ? (
            <Empty message="No reactions." />
          ) : (
            <YStack gap={2}>
              {reactions.map((r) => (
                <EntityRow
                  key={r.name}
                  leading={
                    <IconTile
                      accent={SLACK_BRAND.aubergine}
                      label={`:${r.name}:`}
                      size={22}
                    />
                  }
                  title={r.name}
                  subtitle={`${r.count} reactor${r.count === 1 ? '' : 's'}`}
                  meta={<PillList items={r.users} max={5} />}
                />
              ))}
            </YStack>
          )}
        </YStack>
      )}
    </SlackToolShell>
  );
}

interface GetTeamPreferencesOutput {
  locale: string | null;
  defaultChannels: string[];
  whoCanCreateChannels: string | null;
  whoCanArchiveChannels: string | null;
  whoCanCreateDms: string | null;
  msgEditWindowMins: number | null;
  allowMessageDeletion: boolean | null;
  allowCalls: boolean | null;
  allowHuddles: boolean | null;
  customTos: string | null;
}

function GetTeamPreferencesRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as GetTeamPreferencesOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={SLACK_BRAND.green}
              icon={<Text fontSize={12}>⚙</Text>}
              size={26}
            />
          }
          title="Workspace preferences"
        >
          <Specsheet
            sections={(() => {
              const locale: { key: string; value: string }[] = [];
              if (parsed.locale) locale.push({ key: 'locale', value: parsed.locale });
              if (parsed.defaultChannels.length > 0)
                locale.push({ key: 'default channels', value: `${parsed.defaultChannels.length}` });

              const policies: { key: string; value: string }[] = [];
              if (parsed.whoCanCreateChannels) policies.push({ key: 'create channels', value: parsed.whoCanCreateChannels });
              if (parsed.whoCanArchiveChannels) policies.push({ key: 'archive channels', value: parsed.whoCanArchiveChannels });
              if (parsed.whoCanCreateDms) policies.push({ key: 'create DMs', value: parsed.whoCanCreateDms });
              if (parsed.msgEditWindowMins != null)
                policies.push({ key: 'edit window', value: `${parsed.msgEditWindowMins} min` });

              const calls: { key: string; value: string }[] = [];
              if (parsed.allowCalls != null) calls.push({ key: 'calls', value: parsed.allowCalls ? 'enabled' : 'disabled' });
              if (parsed.allowHuddles != null) calls.push({ key: 'huddles', value: parsed.allowHuddles ? 'enabled' : 'disabled' });
              if (parsed.allowMessageDeletion != null)
                calls.push({ key: 'msg deletion', value: parsed.allowMessageDeletion ? 'allowed' : 'blocked' });

              const sections: SpecsheetSection[] = [];
              if (locale.length > 0) sections.push({ title: 'Locale', rows: locale });
              if (policies.length > 0) sections.push({ title: 'Policies', rows: policies });
              if (calls.length > 0) sections.push({ title: 'Calls & Messages', rows: calls });
              return sections;
            })()}
          />
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// COMMIT 7: Lists API (experimental, feature 2024+)
// ============================================================================

interface CuratedListShape {
  id: string;
  name: string;
  description: string | null;
  todoMode: boolean;
  schema: Array<{ id: string; name: string; type: string; required: boolean }>;
  itemCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface CuratedListItemShape {
  id: string;
  listId: string;
  fields: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
}

function listTile(): React.ReactNode {
  return (
    <IconTile
      accent={SLACK_BRAND.aubergine}
      icon={<Text fontSize={12}>📋</Text>}
      size={26}
    />
  );
}

function CreateListRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as CuratedListShape | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={listTile()}
          title={parsed.name}
          subtitle={parsed.description ?? `${parsed.schema.length} columns`}
          verb="created"
          meta={
            <MetaStrip
              items={[
                ...(parsed.todoMode ? [{ key: 'todo', value: 'enabled' }] : []),
                { key: 'columns', value: String(parsed.schema.length) },
              ]}
            />
          }
        >
          {parsed.schema.length > 0 && (
            <PillList
              items={parsed.schema.map((c) => `${c.name}:${c.type}`)}
              max={8}
              accent={SLACK_BRAND.green}
            />
          )}
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

function UpdateListRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as CuratedListShape | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={listTile()}
          title={parsed.name}
          subtitle={shortId(parsed.id, 6, 4)}
          verb="updated"
        />
      )}
    </SlackToolShell>
  );
}

interface DeleteListOutput {
  listId: string;
  deleted: boolean;
}

function DeleteListRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as DeleteListOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.red}
              icon={<XCircle size={14} color={globalColors.red} />}
              size={26}
            />
          }
          title="List deleted"
          subtitle={shortId(parsed.listId, 6, 4)}
          verb="deleted"
        />
      )}
    </SlackToolShell>
  );
}

function GetListRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as CuratedListShape | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={listTile()}
          title={parsed.name}
          subtitle={parsed.description ?? undefined}
        >
          <Specsheet
            sections={(() => {
              const sections: SpecsheetSection[] = [];
              const meta: { key: string; value: string }[] = [];
              if (parsed.itemCount != null) meta.push({ key: 'items', value: String(parsed.itemCount) });
              if (parsed.todoMode) meta.push({ key: 'todo mode', value: 'enabled' });
              if (parsed.createdAt) meta.push({ key: 'created', value: parsed.createdAt });
              if (parsed.updatedAt) meta.push({ key: 'updated', value: parsed.updatedAt });
              if (meta.length > 0) sections.push({ title: 'List', rows: meta });
              if (parsed.schema.length > 0) {
                sections.push({
                  title: 'Schema',
                  rows: parsed.schema.map((c) => ({
                    key: c.name,
                    value: `${c.type}${c.required ? ' (required)' : ''}`,
                  })),
                });
              }
              return sections;
            })()}
          />
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

interface ListListItemsOutput {
  listId: string;
  items: CuratedListItemShape[];
  count: number;
  nextCursor: string | null;
  hasMore: boolean;
}

function ListListItemsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const { scrollbarColor } = useSlackColors();
  const parsed = output ? (parseOutput(output) as ListListItemsOutput | null) : null;
  const items = parsed?.items ?? [];
  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && items.length > 0}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <YStack gap={4}>
          <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
            List {shortId(parsed.listId, 6, 4)} · {parsed.count} item{parsed.count === 1 ? '' : 's'}
          </Text>
          {items.length === 0 ? (
            <Empty message="No items." />
          ) : (
            <ScrollView style={scrollStyle(360, scrollbarColor)}>
              <YStack>
                {items.map((it) => {
                  const fieldEntries = Object.entries(it.fields).slice(0, 4);
                  return (
                    <EntityRow
                      key={it.id}
                      leading={listTile()}
                      title={shortId(it.id, 6, 4)}
                      subtitle={
                        fieldEntries.length > 0
                          ? fieldEntries.map(([k, v]) => `${k}=${String(v)}`).join(' · ')
                          : undefined
                      }
                      meta={
                        it.updatedAt ? (
                          <MetaStrip items={[{ key: 'updated', value: it.updatedAt }]} />
                        ) : null
                      }
                    />
                  );
                })}
              </YStack>
            </ScrollView>
          )}
          {parsed.hasMore && (
            <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
              + more available (use cursor to paginate)
            </Text>
          )}
        </YStack>
      )}
    </SlackToolShell>
  );
}

function CreateListItemRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as CuratedListItemShape | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={listTile()}
          title={`Item ${shortId(parsed.id, 6, 4)}`}
          subtitle={`list ${shortId(parsed.listId, 4, 3)}`}
          verb="created"
        >
          {Object.keys(parsed.fields).length > 0 && (
            <PillList
              items={Object.entries(parsed.fields).map(([k, v]) => `${k}=${String(v)}`)}
              max={6}
              accent={SLACK_BRAND.green}
            />
          )}
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

function UpdateListItemRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as CuratedListItemShape | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={listTile()}
          title={`Item ${shortId(parsed.id, 6, 4)}`}
          subtitle={`list ${shortId(parsed.listId, 4, 3)}`}
          verb="updated"
        >
          {Object.keys(parsed.fields).length > 0 && (
            <PillList
              items={Object.entries(parsed.fields).map(([k, v]) => `${k}=${String(v)}`)}
              max={6}
              accent={SLACK_BRAND.green}
            />
          )}
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

interface DeleteListItemOutput {
  listId: string;
  itemId: string;
  deleted: boolean;
}

function DeleteListItemRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as DeleteListItemOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.red}
              icon={<XCircle size={14} color={globalColors.red} />}
              size={26}
            />
          }
          title="Item deleted"
          subtitle={`${shortId(parsed.itemId, 4, 3)} · list ${shortId(parsed.listId, 4, 3)}`}
          verb="deleted"
        />
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// COMMIT 8: Canvas API (experimental, 2024+)
// ============================================================================

interface CuratedCanvasShape {
  id: string;
  title: string;
  channelId: string | null;
  isStandalone: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  ownerUserId: string | null;
}

function canvasTile(): React.ReactNode {
  return (
    <IconTile
      accent={SLACK_BRAND.green}
      icon={<Text fontSize={12}>📄</Text>}
      size={26}
    />
  );
}

function canvasMetaItems(c: CuratedCanvasShape): { key: string; value: string }[] {
  const items: { key: string; value: string }[] = [];
  items.push({ key: 'type', value: c.isStandalone ? 'standalone' : 'channel' });
  if (c.channelId) items.push({ key: 'channel', value: shortId(c.channelId, 4, 3) });
  if (c.updatedAt) items.push({ key: 'updated', value: c.updatedAt });
  return items;
}

function CreateCanvasRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as CuratedCanvasShape | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={canvasTile()}
          title={parsed.title || shortId(parsed.id, 6, 4)}
          subtitle={parsed.isStandalone ? 'standalone' : 'channel canvas'}
          verb="created"
          meta={<MetaStrip items={canvasMetaItems(parsed)} />}
        />
      )}
    </SlackToolShell>
  );
}

function EditCanvasRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as CuratedCanvasShape | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={canvasTile()}
          title={parsed.title || shortId(parsed.id, 6, 4)}
          subtitle={shortId(parsed.id, 6, 4)}
          verb="updated"
        />
      )}
    </SlackToolShell>
  );
}

interface DeleteCanvasOutput {
  canvasId: string;
  deleted: boolean;
}

function DeleteCanvasRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as DeleteCanvasOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.red}
              icon={<XCircle size={14} color={globalColors.red} />}
              size={26}
            />
          }
          title="Canvas deleted"
          subtitle={shortId(parsed.canvasId, 6, 4)}
          verb="deleted"
        />
      )}
    </SlackToolShell>
  );
}

function CreateChannelCanvasRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as CuratedCanvasShape | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={canvasTile()}
          title={parsed.title || shortId(parsed.id, 6, 4)}
          subtitle={parsed.channelId ? `#${shortId(parsed.channelId, 4, 3)}` : undefined}
          verb="created"
          meta={<MetaStrip items={canvasMetaItems(parsed)} />}
        />
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// COMMIT 9: Streaming chat (experimental, 2024+)
// ============================================================================

interface StartStreamOutput {
  streamId: string;
  channel: string;
  threadTs: string | null;
}

function streamTile(): React.ReactNode {
  return (
    <IconTile
      accent={globalColors.indigo}
      icon={<Text fontSize={12}>⚡</Text>}
      size={26}
    />
  );
}

function StartStreamRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as StartStreamOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={streamTile()}
          title="Stream started"
          subtitle={`#${shortId(parsed.channel, 6, 4)}${parsed.threadTs ? ` · thread ${parsed.threadTs}` : ''}`}
          verb="created"
          meta={
            <XStack gap={6} alignItems="center">
              <IconChip text="streaming" accent={globalColors.indigo} />
              <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
                id {shortId(parsed.streamId, 4, 3)}
              </Text>
            </XStack>
          }
        />
      )}
    </SlackToolShell>
  );
}

interface AppendStreamOutput {
  streamId: string;
  appended: boolean;
  length: number;
}

function AppendStreamRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as AppendStreamOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={streamTile()}
          title={`+${parsed.length} char${parsed.length === 1 ? '' : 's'}`}
          subtitle={`stream ${shortId(parsed.streamId, 4, 3)}`}
          verb="added"
          meta={<IconChip text="streaming" accent={globalColors.indigo} />}
        />
      )}
    </SlackToolShell>
  );
}

interface StopStreamOutput {
  streamId: string;
  stopped: boolean;
}

function StopStreamRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as StopStreamOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.green}
              icon={<CheckCircle2 size={14} color={globalColors.green} />}
              size={26}
            />
          }
          title="Stream stopped"
          subtitle={`stream ${shortId(parsed.streamId, 4, 3)}`}
          verb="disabled"
        />
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// COMMIT 10: Calls API (experimental)
// ============================================================================

interface CuratedCallParticipantShape {
  slackId: string | null;
  externalId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

interface CuratedCallShape {
  id: string;
  externalUniqueId: string | null;
  joinUrl: string | null;
  desktopAppJoinUrl: string | null;
  title: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  status: 'active' | 'ended' | string;
  participants: CuratedCallParticipantShape[];
}

function callTile(active: boolean): React.ReactNode {
  return (
    <IconTile
      accent={active ? globalColors.green : globalColors.muted}
      icon={<Text fontSize={12}>📞</Text>}
      size={26}
    />
  );
}

function AddCallRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as CuratedCallShape | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={callTile(parsed.status === 'active')}
          title={parsed.title || `call ${shortId(parsed.id, 4, 3)}`}
          subtitle={parsed.externalUniqueId ?? undefined}
          verb="created"
          meta={
            <XStack gap={6} alignItems="center">
              <IconChip
                text={parsed.status.toUpperCase()}
                accent={parsed.status === 'active' ? globalColors.green : globalColors.muted}
              />
              {externalLink(parsed.joinUrl, 'join')}
            </XStack>
          }
        />
      )}
    </SlackToolShell>
  );
}

interface EndCallOutput {
  callId: string;
  ended: boolean;
  duration: number | null;
}

function EndCallRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as EndCallOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={callTile(false)}
          title="Call ended"
          subtitle={shortId(parsed.callId, 6, 4)}
          verb="disabled"
          meta={
            parsed.duration != null ? (
              <IconChip text={`${Math.round(parsed.duration)}s`} accent={globalColors.muted} />
            ) : null
          }
        />
      )}
    </SlackToolShell>
  );
}

function UpdateCallRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as CuratedCallShape | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={callTile(parsed.status === 'active')}
          title={parsed.title || `call ${shortId(parsed.id, 4, 3)}`}
          subtitle={shortId(parsed.id, 6, 4)}
          verb="updated"
        />
      )}
    </SlackToolShell>
  );
}

function GetCallRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as CuratedCallShape | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={callTile(parsed.status === 'active')}
          title={parsed.title || `call ${shortId(parsed.id, 4, 3)}`}
          subtitle={parsed.externalUniqueId ?? undefined}
          meta={
            <XStack gap={6} alignItems="center">
              <IconChip
                text={parsed.status.toUpperCase()}
                accent={parsed.status === 'active' ? globalColors.green : globalColors.muted}
              />
              {externalLink(parsed.joinUrl, 'join')}
            </XStack>
          }
        >
          <Specsheet
            sections={(() => {
              const sections: SpecsheetSection[] = [];
              const meta: { key: string; value: string }[] = [];
              if (parsed.externalUniqueId) meta.push({ key: 'external id', value: parsed.externalUniqueId });
              if (parsed.dateStart) meta.push({ key: 'started', value: parsed.dateStart });
              if (parsed.dateEnd) meta.push({ key: 'ended', value: parsed.dateEnd });
              if (meta.length > 0) sections.push({ title: 'Call', rows: meta });
              if (parsed.participants.length > 0) {
                sections.push({
                  title: 'Participants',
                  rows: parsed.participants.slice(0, 8).map((p) => ({
                    key: p.slackId ?? p.externalId ?? '?',
                    value: p.displayName ?? '',
                  })),
                });
              }
              return sections;
            })()}
          />
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

interface AddCallParticipantsOutput {
  callId: string;
  added: number;
  participants: CuratedCallParticipantShape[];
}

function AddCallParticipantsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as AddCallParticipantsOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={callTile(true)}
          title={`+${parsed.added} participant${parsed.added === 1 ? '' : 's'}`}
          subtitle={`call ${shortId(parsed.callId, 4, 3)}`}
          verb="added"
          meta={
            <PillList
              items={parsed.participants.map((p) => p.displayName ?? p.slackId ?? p.externalId ?? '?')}
              max={6}
              accent={SLACK_BRAND.green}
            />
          }
        />
      )}
    </SlackToolShell>
  );
}

interface RemoveCallParticipantsOutput {
  callId: string;
  removed: number;
  participants: CuratedCallParticipantShape[];
}

function RemoveCallParticipantsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as RemoveCallParticipantsOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={callTile(true)}
          title={`-${parsed.removed} participant${parsed.removed === 1 ? '' : 's'}`}
          subtitle={`call ${shortId(parsed.callId, 4, 3)}`}
          verb="removed"
        />
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// COMMIT 13: Channels extended (rename, setPurpose, setTopic, kick, unarchive, mark)
// ============================================================================

function RenameChannelRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as SlackChannel | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={(() => {
            const l = channelLeadingProps(parsed);
            return <IconTile accent={l.accent} icon={l.icon} size={26} />;
          })()}
          title={channelDisplayName(parsed)}
          subtitle={shortId(parsed.id, 6, 4)}
          verb="renamed"
        />
      )}
    </SlackToolShell>
  );
}

interface PurposeOrTopicOutput {
  channelId: string;
  purpose?: string;
  topic?: string;
}

function SetChannelPurposeRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as PurposeOrTopicOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={SLACK_BRAND.aubergine}
              icon={<Hash size={12} color={SLACK_BRAND.aubergine} />}
              size={26}
            />
          }
          title="Channel purpose updated"
          subtitle={`#${shortId(parsed.channelId, 6, 4)}`}
          verb="updated"
        >
          {parsed.purpose && <Text color={globalColors.primary} fontSize={10}>{parsed.purpose}</Text>}
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

function SetChannelTopicRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as PurposeOrTopicOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={SLACK_BRAND.aubergine}
              icon={<Hash size={12} color={SLACK_BRAND.aubergine} />}
              size={26}
            />
          }
          title="Channel topic updated"
          subtitle={`#${shortId(parsed.channelId, 6, 4)}`}
          verb="updated"
        >
          {parsed.topic && <Text color={globalColors.primary} fontSize={10}>{parsed.topic}</Text>}
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

interface KickFromChannelOutput {
  channelId: string;
  userId: string;
  kicked: boolean;
}

function KickFromChannelRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as KickFromChannelOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.red}
              icon={<XCircle size={14} color={globalColors.red} />}
              size={26}
            />
          }
          title="User removed from channel"
          subtitle={`#${shortId(parsed.channelId, 6, 4)} → ${shortId(parsed.userId, 4, 3)}`}
          verb="removed"
        />
      )}
    </SlackToolShell>
  );
}

function UnarchiveChannelRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as SlackChannel | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={(() => {
            const l = channelLeadingProps(parsed);
            return <IconTile accent={l.accent} icon={l.icon} size={26} />;
          })()}
          title={channelDisplayName(parsed)}
          subtitle={shortId(parsed.id, 6, 4)}
          verb="enabled"
        />
      )}
    </SlackToolShell>
  );
}

interface MarkChannelReadOutput {
  channelId: string;
  timestamp: string;
  marked: boolean;
}

function MarkChannelReadRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as MarkChannelReadOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.green}
              icon={<CheckCircle2 size={14} color={globalColors.green} />}
              size={26}
            />
          }
          title="Channel marked as read"
          subtitle={`#${shortId(parsed.channelId, 6, 4)} · cursor ${parsed.timestamp}`}
        />
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// COMMIT 14: Files modern (upload) + public + remote files
// ============================================================================

interface GetUploadUrlOutput {
  uploadUrl: string;
  fileId: string;
  filename: string;
  length: number;
}

function GetUploadUrlRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as GetUploadUrlOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={SLACK_BRAND.aubergine}
              icon={<Text fontSize={12}>⬆</Text>}
              size={26}
            />
          }
          title={parsed.filename}
          subtitle={`${parsed.length} bytes · upload URL ready (step 1/2)`}
          verb="created"
          meta={
            <MetaStrip
              items={[
                { key: 'file id', value: shortId(parsed.fileId, 4, 3) },
                { key: 'size', value: formatBytes(parsed.length) },
              ]}
            />
          }
        />
      )}
    </SlackToolShell>
  );
}

interface CompleteUploadOutput {
  files: SlackFile[];
  count: number;
}

function CompleteUploadRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const { text3 } = useSlackColors();
  const parsed = output ? (parseOutput(output) as CompleteUploadOutput | null) : null;
  const files = parsed?.files ?? [];
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration} defaultExpanded={files.length > 0}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <YStack gap={4}>
          {files.length === 0 ? (
            <Empty message="No files completed." />
          ) : (
            <YStack>
              {files.map((f) => (
                <EntityRow
                  key={f.id}
                  leading={fileLeading(f, 22, text3)}
                  title={f.title || f.name || shortId(f.id)}
                  subtitle={f.prettyType ?? f.mimetype ?? undefined}
                  meta={externalLink(f.permalink, 'open')}
                />
              ))}
            </YStack>
          )}
        </YStack>
      )}
    </SlackToolShell>
  );
}

interface ShareFilePublicOutput {
  fileId: string;
  permalinkPublic: string | null;
}

function ShareFilePublicRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as ShareFilePublicOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.amber}
              icon={<Text fontSize={12}>🌐</Text>}
              size={26}
            />
          }
          title="File now public"
          subtitle={shortId(parsed.fileId, 6, 4)}
          verb="enabled"
          meta={parsed.permalinkPublic ? externalLink(parsed.permalinkPublic, 'open') : null}
        />
      )}
    </SlackToolShell>
  );
}

interface RevokeFilePublicOutput {
  fileId: string;
  revoked: boolean;
}

function RevokeFilePublicRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as RevokeFilePublicOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.muted}
              icon={<Text fontSize={12}>🔒</Text>}
              size={26}
            />
          }
          title="Public URL revoked"
          subtitle={shortId(parsed.fileId, 6, 4)}
          verb="disabled"
        />
      )}
    </SlackToolShell>
  );
}

interface CuratedRemoteFileShape {
  id: string;
  externalId: string | null;
  externalUrl: string | null;
  title: string;
  fileType: string | null;
  size: number | null;
  user: string | null;
  createdAt: string | null;
  permalink: string | null;
  channels: string[];
}

function remoteFileTile(): React.ReactNode {
  return (
    <IconTile
      accent={SLACK_BRAND.green}
      icon={<Text fontSize={12}>🔗</Text>}
      size={26}
    />
  );
}

interface ListRemoteFilesOutput {
  files: CuratedRemoteFileShape[];
  count: number;
  nextCursor: string | null;
  hasMore: boolean;
}

function ListRemoteFilesRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const { scrollbarColor } = useSlackColors();
  const parsed = output ? (parseOutput(output) as ListRemoteFilesOutput | null) : null;
  const files = parsed?.files ?? [];
  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && files.length > 0}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <YStack gap={4}>
          {files.length === 0 ? (
            <Empty message="No remote files." />
          ) : (
            <ScrollView style={scrollStyle(360, scrollbarColor)}>
              <YStack>
                {files.map((f) => (
                  <EntityRow
                    key={f.id}
                    leading={remoteFileTile()}
                    title={f.title}
                    subtitle={f.fileType ?? f.externalUrl ?? undefined}
                    meta={
                      <XStack gap={6} alignItems="center">
                        {f.fileType ? <IconChip text={f.fileType} accent={globalColors.muted} /> : null}
                        {externalLink(f.externalUrl, 'open')}
                      </XStack>
                    }
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
          {parsed.hasMore && (
            <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
              + more available (use cursor to paginate)
            </Text>
          )}
        </YStack>
      )}
    </SlackToolShell>
  );
}

function AddRemoteFileRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as CuratedRemoteFileShape | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={remoteFileTile()}
          title={parsed.title}
          subtitle={parsed.externalId ?? undefined}
          verb="created"
          meta={externalLink(parsed.externalUrl, 'open')}
        />
      )}
    </SlackToolShell>
  );
}

function UpdateRemoteFileRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as CuratedRemoteFileShape | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={remoteFileTile()}
          title={parsed.title}
          subtitle={parsed.externalId ?? shortId(parsed.id, 6, 4)}
          verb="updated"
        />
      )}
    </SlackToolShell>
  );
}

interface RemoveRemoteFileOutput {
  externalId: string | null;
  fileId: string | null;
  removed: boolean;
}

function RemoveRemoteFileRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as RemoveRemoteFileOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.red}
              icon={<XCircle size={14} color={globalColors.red} />}
              size={26}
            />
          }
          title="Remote file unlinked"
          subtitle={parsed.externalId ?? parsed.fileId ?? '?'}
          verb="removed"
        />
      )}
    </SlackToolShell>
  );
}

function ShareRemoteFileRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as CuratedRemoteFileShape | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={remoteFileTile()}
          title={parsed.title}
          subtitle={`shared to ${parsed.channels.length} channel${parsed.channels.length === 1 ? '' : 's'}`}
          verb="added"
          meta={
            parsed.channels.length > 0 ? (
              <PillList items={parsed.channels.map((c) => `#${shortId(c, 4, 3)}`)} max={5} />
            ) : null
          }
        />
      )}
    </SlackToolShell>
  );
}

function GetRemoteFileRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as CuratedRemoteFileShape | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={remoteFileTile()}
          title={parsed.title}
          subtitle={parsed.externalId ?? undefined}
          meta={externalLink(parsed.externalUrl, 'open')}
        >
          <Specsheet
            sections={(() => {
              const sections: SpecsheetSection[] = [];
              const meta: { key: string; value: string }[] = [];
              if (parsed.fileType) meta.push({ key: 'type', value: parsed.fileType });
              if (parsed.size != null) meta.push({ key: 'size', value: formatBytes(parsed.size) });
              if (parsed.createdAt) meta.push({ key: 'created', value: parsed.createdAt });
              if (parsed.user) meta.push({ key: 'user', value: parsed.user });
              if (meta.length > 0) sections.push({ title: 'File', rows: meta });
              if (parsed.channels.length > 0) {
                sections.push({
                  title: 'Shared in',
                  rows: parsed.channels.map((c) => ({ key: 'channel', value: c })),
                });
              }
              return sections;
            })()}
          />
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// COMMIT 15: Chat extras — meMessage, unfurl
// ============================================================================

interface SendMeMessageOutput {
  ts: string;
  channel: string;
}

function SendMeMessageRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as SendMeMessageOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={SLACK_BRAND.aubergine}
              icon={<Text fontSize={12}>/me</Text>}
              size={26}
            />
          }
          title="/me action sent"
          subtitle={`#${shortId(parsed.channel, 6, 4)} · ${parsed.ts}`}
          verb="created"
        />
      )}
    </SlackToolShell>
  );
}

interface UnfurlLinkOutput {
  channel: string;
  ts: string;
  unfurled: boolean;
  links: string[];
}

function UnfurlLinkRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as UnfurlLinkOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={SLACK_BRAND.green}
              icon={<ExternalLink size={12} color={SLACK_BRAND.green} />}
              size={26}
            />
          }
          title={`${parsed.links.length} link${parsed.links.length === 1 ? '' : 's'} unfurled`}
          subtitle={`#${shortId(parsed.channel, 6, 4)} · ${parsed.ts}`}
          verb="updated"
          meta={
            parsed.links.length > 0 ? <PillList items={parsed.links} max={4} /> : null
          }
        />
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// COMMIT 16: Users extras + reactions.list + dnd.teamInfo
// ============================================================================

interface ListUserChannelsOutput {
  userId: string | null;
  channels: SlackChannel[];
  count: number;
  nextCursor: string | null;
  hasMore: boolean;
}

function ListUserChannelsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const { scrollbarColor } = useSlackColors();
  const parsed = output ? (parseOutput(output) as ListUserChannelsOutput | null) : null;
  const channels = parsed?.channels ?? [];
  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && channels.length > 0}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <YStack gap={4}>
          <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
            {parsed.userId ? `user ${shortId(parsed.userId, 4, 3)} · ` : ''}
            {parsed.count} channel{parsed.count === 1 ? '' : 's'}
          </Text>
          {channels.length === 0 ? (
            <Empty message="No channels." />
          ) : (
            <ScrollView style={scrollStyle(360, scrollbarColor)}>
              <YStack>
                {channels.map((c) => (
                  <EntityRow
                    key={c.id}
                    leading={(() => {
                      const l = channelLeadingProps(c);
                      return <IconTile accent={l.accent} icon={l.icon} size={22} />;
                    })()}
                    title={channelDisplayName(c)}
                    subtitle={c.numMembers != null ? `${c.numMembers} members` : undefined}
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
          {parsed.hasMore && (
            <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
              + more available (use cursor to paginate)
            </Text>
          )}
        </YStack>
      )}
    </SlackToolShell>
  );
}

function DeleteUserPhotoRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.red}
              icon={<XCircle size={14} color={globalColors.red} />}
              size={26}
            />
          }
          title="Profile photo deleted"
          verb="deleted"
        />
      )}
    </SlackToolShell>
  );
}

interface CuratedIdentityShape {
  userId: string | null;
  name: string | null;
  email: string | null;
  teamId: string | null;
  teamName: string | null;
  teamDomain: string | null;
  imageUrl: string | null;
}

function GetUserIdentityRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as CuratedIdentityShape | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={<Avatar src={parsed.imageUrl ?? undefined} name={parsed.name ?? '?'} size={32} />}
          title={parsed.name ?? shortId(parsed.userId ?? '?', 4, 3)}
          subtitle={parsed.email ?? undefined}
        >
          <Specsheet
            sections={(() => {
              const sections: SpecsheetSection[] = [];
              const identity: { key: string; value: string }[] = [];
              if (parsed.userId) identity.push({ key: 'user id', value: parsed.userId });
              if (parsed.email) identity.push({ key: 'email', value: parsed.email });
              if (identity.length > 0) sections.push({ title: 'User', rows: identity });
              const team: { key: string; value: string }[] = [];
              if (parsed.teamId) team.push({ key: 'team id', value: parsed.teamId });
              if (parsed.teamName) team.push({ key: 'team name', value: parsed.teamName });
              if (parsed.teamDomain) team.push({ key: 'domain', value: `${parsed.teamDomain}.slack.com` });
              if (team.length > 0) sections.push({ title: 'Workspace', rows: team });
              return sections;
            })()}
          />
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

interface CuratedReactionItem {
  type: string;
  channel: string | null;
  ts: string | null;
  fileId: string | null;
  reaction: string;
}

interface ListMyReactionsOutput {
  userId: string | null;
  items: CuratedReactionItem[];
  count: number;
  paging: any;
}

function ListMyReactionsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const { scrollbarColor } = useSlackColors();
  const parsed = output ? (parseOutput(output) as ListMyReactionsOutput | null) : null;
  const items = parsed?.items ?? [];
  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && items.length > 0}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <YStack gap={4}>
          <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
            {parsed.count} reaction{parsed.count === 1 ? '' : 's'} given
          </Text>
          {items.length === 0 ? (
            <Empty message="No reactions." />
          ) : (
            <ScrollView style={scrollStyle(360, scrollbarColor)}>
              <YStack>
                {items.slice(0, 50).map((r, i) => (
                  <EntityRow
                    // biome-ignore lint/suspicious/noArrayIndexKey: composite key not stable
                    key={`${r.channel ?? r.fileId ?? '?'}-${r.ts ?? '?'}-${r.reaction}-${i}`}
                    leading={
                      <IconTile
                        accent={SLACK_BRAND.aubergine}
                        label={`:${r.reaction}:`}
                        size={22}
                      />
                    }
                    title={r.reaction}
                    subtitle={
                      r.type === 'message'
                        ? `#${shortId(r.channel ?? '?', 4, 3)} · ${r.ts ?? ''}`
                        : `file ${shortId(r.fileId ?? '?', 4, 3)}`
                    }
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
        </YStack>
      )}
    </SlackToolShell>
  );
}

interface TeamDndEntry {
  userId: string;
  snoozeEnabled: boolean;
  snoozeEndtime: string | null;
  nextDndStart: string | null;
  nextDndEnd: string | null;
}

interface GetTeamDndOutput {
  users: TeamDndEntry[];
  count: number;
}

function GetTeamDndRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as GetTeamDndOutput | null) : null;
  const users = parsed?.users ?? [];
  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && users.length > 0}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <YStack gap={4}>
          <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
            {parsed.count} user{parsed.count === 1 ? '' : 's'}
          </Text>
          {users.length === 0 ? (
            <Empty message="No DND data." />
          ) : (
            <YStack gap={2}>
              {users.map((u) => (
                <EntityRow
                  key={u.userId}
                  leading={
                    <IconTile
                      accent={u.snoozeEnabled ? globalColors.amber : globalColors.green}
                      icon={<Text fontSize={11}>{u.snoozeEnabled ? '🌙' : '☀'}</Text>}
                      size={22}
                    />
                  }
                  title={shortId(u.userId, 6, 4)}
                  subtitle={u.snoozeEnabled ? 'in DND' : 'available'}
                  meta={
                    u.snoozeEndtime ? (
                      <MetaStrip items={[{ key: 'until', value: u.snoozeEndtime }]} />
                    ) : null
                  }
                />
              ))}
            </YStack>
          )}
        </YStack>
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// COMMIT 17: Stars + Emoji custom
// ============================================================================

function starTile(): React.ReactNode {
  return (
    <IconTile
      accent={globalColors.amber}
      icon={<Text fontSize={12}>⭐</Text>}
      size={26}
    />
  );
}

interface StarOutput {
  type: string;
  target: { channel: string | null; timestamp: string | null; file: string | null; fileComment: string | null };
  starred?: boolean;
  unstarred?: boolean;
}

function starTargetSubtitle(target: StarOutput['target']): string {
  if (target.channel && target.timestamp) return `#${shortId(target.channel, 4, 3)} · ${target.timestamp}`;
  if (target.file) return `file ${shortId(target.file, 4, 3)}`;
  if (target.fileComment) return `file comment ${shortId(target.fileComment, 4, 3)}`;
  return '?';
}

function StarItemRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as StarOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={starTile()}
          title="Item saved"
          subtitle={starTargetSubtitle(parsed.target)}
          verb="added"
        />
      )}
    </SlackToolShell>
  );
}

function UnstarItemRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as StarOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.muted}
              icon={<Text fontSize={12}>⭐</Text>}
              size={26}
            />
          }
          title="Item unstarred"
          subtitle={starTargetSubtitle(parsed.target)}
          verb="removed"
        />
      )}
    </SlackToolShell>
  );
}

interface CuratedStarItem {
  type: string;
  channel: string | null;
  ts: string | null;
  fileId: string | null;
}

interface ListStarsOutput {
  items: CuratedStarItem[];
  count: number;
  nextCursor: string | null;
  hasMore: boolean;
}

function ListStarsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const { scrollbarColor } = useSlackColors();
  const parsed = output ? (parseOutput(output) as ListStarsOutput | null) : null;
  const items = parsed?.items ?? [];
  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && items.length > 0}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <YStack gap={4}>
          <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
            {parsed.count} item{parsed.count === 1 ? '' : 's'} saved
          </Text>
          {items.length === 0 ? (
            <Empty message="No saved items." />
          ) : (
            <ScrollView style={scrollStyle(360, scrollbarColor)}>
              <YStack>
                {items.map((it, i) => (
                  <EntityRow
                    // biome-ignore lint/suspicious/noArrayIndexKey: composite ordering
                    key={`${it.channel ?? it.fileId ?? '?'}-${it.ts ?? '?'}-${i}`}
                    leading={starTile()}
                    title={it.type.toUpperCase()}
                    subtitle={
                      it.channel && it.ts
                        ? `#${shortId(it.channel, 4, 3)} · ${it.ts}`
                        : it.fileId
                          ? `file ${shortId(it.fileId, 4, 3)}`
                          : '?'
                    }
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
          {parsed.hasMore && (
            <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
              + more available (use cursor to paginate)
            </Text>
          )}
        </YStack>
      )}
    </SlackToolShell>
  );
}

interface CuratedEmojiShape {
  name: string;
  url: string;
  isAlias: boolean;
  aliasFor: string | null;
}

interface ListEmojiOutput {
  emojis: CuratedEmojiShape[];
  count: number;
}

function ListEmojiRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const { scrollbarColor } = useSlackColors();
  const parsed = output ? (parseOutput(output) as ListEmojiOutput | null) : null;
  const emojis = parsed?.emojis ?? [];
  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && emojis.length > 0}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <YStack gap={4}>
          <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
            {parsed.count} custom emoji{parsed.count === 1 ? '' : 's'}
          </Text>
          {emojis.length === 0 ? (
            <Empty message="No custom emojis." />
          ) : (
            <ScrollView style={scrollStyle(360, scrollbarColor)}>
              <YStack>
                {emojis.slice(0, 100).map((e) => (
                  <EntityRow
                    key={e.name}
                    leading={
                      <IconTile
                        accent={SLACK_BRAND.aubergine}
                        label={`:${e.name}:`}
                        size={22}
                      />
                    }
                    title={e.name}
                    subtitle={e.isAlias ? `alias for :${e.aliasFor}:` : undefined}
                    meta={e.isAlias ? <IconChip text="ALIAS" accent={globalColors.muted} /> : null}
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
        </YStack>
      )}
    </SlackToolShell>
  );
}

interface AddEmojiOutput {
  name: string;
  isAlias: boolean;
  aliasFor: string | null;
  ok: boolean;
}

function AddEmojiRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as AddEmojiOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={SLACK_BRAND.green}
              label={`:${parsed.name}:`}
              size={26}
            />
          }
          title={`:${parsed.name}:`}
          subtitle={parsed.isAlias ? `alias for :${parsed.aliasFor}:` : 'uploaded image'}
          verb="created"
        />
      )}
    </SlackToolShell>
  );
}

interface RemoveEmojiOutput {
  name: string;
  removed: boolean;
}

function RemoveEmojiRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as RemoveEmojiOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.red}
              icon={<XCircle size={14} color={globalColors.red} />}
              size={26}
            />
          }
          title={`:${parsed.name}: removed`}
          verb="deleted"
        />
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// COMMIT 18: Team audit + bookmark edit + list fields + calls list (10 tools)
// ============================================================================

interface AccessLog {
  userId: string | null;
  username: string | null;
  dateFirst: string | null;
  dateLast: string | null;
  count: number;
  ip: string | null;
  country: string | null;
}

interface GetAccessLogsOutput {
  logs: AccessLog[];
  count: number;
  paging: any;
}

function GetAccessLogsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const { scrollbarColor } = useSlackColors();
  const parsed = output ? (parseOutput(output) as GetAccessLogsOutput | null) : null;
  const logs = parsed?.logs ?? [];
  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && logs.length > 0}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <YStack gap={4}>
          <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
            {parsed.count} login{parsed.count === 1 ? '' : 's'}
          </Text>
          {logs.length === 0 ? (
            <Empty message="No access logs." />
          ) : (
            <ScrollView style={scrollStyle(360, scrollbarColor)}>
              <YStack>
                {logs.slice(0, 50).map((l, i) => (
                  <EntityRow
                    // biome-ignore lint/suspicious/noArrayIndexKey: stable position
                    key={`${l.userId ?? '?'}-${l.dateLast ?? i}`}
                    leading={<Avatar name={l.username ?? l.userId ?? '?'} size={22} />}
                    title={l.username ?? shortId(l.userId ?? '?', 4, 3)}
                    subtitle={`${l.count} login${l.count === 1 ? '' : 's'} from ${l.country ?? '?'} (${l.ip ?? '?'})`}
                    meta={l.dateLast ? <MetaStrip items={[{ key: 'last', value: l.dateLast }]} /> : null}
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
        </YStack>
      )}
    </SlackToolShell>
  );
}

interface IntegrationLog {
  service: string | null;
  appId: string | null;
  date: string | null;
  changeType: string;
  user: string | null;
  userName: string | null;
}

interface GetIntegrationLogsOutput {
  logs: IntegrationLog[];
  count: number;
}

function GetIntegrationLogsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const { scrollbarColor } = useSlackColors();
  const parsed = output ? (parseOutput(output) as GetIntegrationLogsOutput | null) : null;
  const logs = parsed?.logs ?? [];
  return (
    <SlackToolShell
      toolName={toolName}
      status={status}
      duration={duration}
      defaultExpanded={status === 'completed' && logs.length > 0}
    >
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <YStack gap={4}>
          <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
            {parsed.count} integration event{parsed.count === 1 ? '' : 's'}
          </Text>
          {logs.length === 0 ? (
            <Empty message="No integration logs." />
          ) : (
            <ScrollView style={scrollStyle(360, scrollbarColor)}>
              <YStack>
                {logs.slice(0, 50).map((l, i) => (
                  <EntityRow
                    // biome-ignore lint/suspicious/noArrayIndexKey: stable position
                    key={`${l.appId ?? '?'}-${l.date ?? i}`}
                    leading={
                      <IconTile
                        accent={SLACK_BRAND.aubergine}
                        icon={<Text fontSize={11}>⚙</Text>}
                        size={22}
                      />
                    }
                    title={l.service ?? l.appId ?? '?'}
                    subtitle={`${l.changeType} · by ${l.userName ?? shortId(l.user ?? '?', 4, 3)}`}
                    meta={l.date ? <MetaStrip items={[{ key: 'when', value: l.date }]} /> : null}
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
        </YStack>
      )}
    </SlackToolShell>
  );
}

interface CuratedTeamProfileField {
  id: string;
  label: string;
  type: string;
  isHidden: boolean;
}

interface GetTeamProfileOutput {
  fields: CuratedTeamProfileField[];
  count: number;
}

function GetTeamProfileRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as GetTeamProfileOutput | null) : null;
  const fields = parsed?.fields ?? [];
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration} defaultExpanded={fields.length > 0}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={SLACK_BRAND.aubergine}
              icon={<Text fontSize={12}>👤</Text>}
              size={26}
            />
          }
          title="Custom profile fields"
          subtitle={`${parsed.count} field${parsed.count === 1 ? '' : 's'}`}
        >
          {fields.length === 0 ? (
            <Empty message="No custom fields." />
          ) : (
            <Specsheet
              sections={[
                {
                  title: 'Fields',
                  rows: fields.map((f) => ({
                    key: f.label,
                    value: `${f.type}${f.isHidden ? ' (hidden)' : ''}`,
                  })),
                },
              ]}
            />
          )}
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

function EditBookmarkRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as CuratedBookmark | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={SLACK_BRAND.green}
              icon={<Text fontSize={12}>{parsed.emoji ?? '🔖'}</Text>}
              size={26}
            />
          }
          title={parsed.title}
          subtitle={`#${shortId(parsed.channelId, 6, 4)}`}
          verb="updated"
          meta={externalLink(parsed.link, 'open')}
        />
      )}
    </SlackToolShell>
  );
}

interface CuratedListField {
  id: string;
  name: string;
  type: string;
  required: boolean;
  ordering: number | null;
}

interface ListListFieldsOutput {
  listId: string;
  fields: CuratedListField[];
  count: number;
}

function ListListFieldsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as ListListFieldsOutput | null) : null;
  const fields = parsed?.fields ?? [];
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration} defaultExpanded={fields.length > 0}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={listTile()}
          title={`List ${shortId(parsed.listId, 6, 4)}`}
          subtitle={`${parsed.count} column${parsed.count === 1 ? '' : 's'}`}
        >
          {fields.length === 0 ? (
            <Empty message="No fields." />
          ) : (
            <Specsheet
              sections={[
                {
                  title: 'Schema',
                  rows: fields.map((f) => ({
                    key: f.name,
                    value: `${f.type}${f.required ? ' (required)' : ''}`,
                  })),
                },
              ]}
            />
          )}
        </ResourceCard>
      )}
    </SlackToolShell>
  );
}

function CreateListFieldRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as any) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={listTile()}
          title={parsed.name ?? 'New column'}
          subtitle={parsed.type ?? undefined}
          verb="created"
          meta={
            parsed.required ? <Badge text="REQUIRED" variant="warning" /> : null
          }
        />
      )}
    </SlackToolShell>
  );
}

function UpdateListFieldRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as any) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={listTile()}
          title={parsed.name ?? `Field ${shortId(parsed.fieldId ?? parsed.id ?? '?', 4, 3)}`}
          verb="updated"
        />
      )}
    </SlackToolShell>
  );
}

interface DeleteListFieldOutput {
  listId: string;
  fieldId: string;
  deleted: boolean;
}

function DeleteListFieldRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as DeleteListFieldOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.red}
              icon={<XCircle size={14} color={globalColors.red} />}
              size={26}
            />
          }
          title="Column deleted"
          subtitle={`${shortId(parsed.fieldId, 4, 3)} · list ${shortId(parsed.listId, 4, 3)}`}
          verb="deleted"
        />
      )}
    </SlackToolShell>
  );
}

// ============================================================================
// COMMIT 19: Slack Connect + Auth (7 tools)
// ============================================================================

interface CuratedConnectInvite {
  inviteId: string;
  status: string | null;
  channel: string | null;
  teamId: string | null;
  invitedTeamId: string | null;
  invitedUser: string | null;
  dateCreated: string | null;
  expirationAt: string | null;
}

interface ListConnectInvitesOutput {
  invites: CuratedConnectInvite[];
  count: number;
  nextCursor: string | null;
  hasMore: boolean;
}

function connectTile(): React.ReactNode {
  return (
    <IconTile
      accent={SLACK_BRAND.green}
      icon={<Text fontSize={12}>🌐</Text>}
      size={26}
    />
  );
}

function ListConnectInvitesRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const { scrollbarColor } = useSlackColors();
  const parsed = output ? (parseOutput(output) as ListConnectInvitesOutput | null) : null;
  const invites = parsed?.invites ?? [];
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration} defaultExpanded={invites.length > 0}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <YStack gap={4}>
          <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
            {parsed.count} invite{parsed.count === 1 ? '' : 's'} pending
          </Text>
          {invites.length === 0 ? (
            <Empty message="No pending invites." />
          ) : (
            <ScrollView style={scrollStyle(360, scrollbarColor)}>
              <YStack>
                {invites.map((i) => (
                  <EntityRow
                    key={i.inviteId}
                    leading={connectTile()}
                    title={`Invite ${shortId(i.inviteId, 4, 3)}`}
                    subtitle={i.invitedTeamId ? `team ${shortId(i.invitedTeamId, 4, 3)}` : undefined}
                    meta={
                      <MetaStrip
                        items={[
                          ...(i.status ? [{ key: 'status', value: i.status }] : []),
                          ...(i.expirationAt ? [{ key: 'expires', value: i.expirationAt }] : []),
                        ]}
                      />
                    }
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
          {parsed.hasMore && (
            <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
              + more available (use cursor to paginate)
            </Text>
          )}
        </YStack>
      )}
    </SlackToolShell>
  );
}

interface InviteSharedOutput {
  channel: string;
  inviteId: string;
  link: string | null;
  isLegacySharedChannel: boolean;
}

function InviteSharedRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as InviteSharedOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={connectTile()}
          title="Connect invite sent"
          subtitle={`#${shortId(parsed.channel, 6, 4)} · invite ${shortId(parsed.inviteId, 4, 3)}`}
          verb="created"
          meta={parsed.link ? externalLink(parsed.link, 'copy link') : null}
        />
      )}
    </SlackToolShell>
  );
}

interface AcceptSharedInviteOutput {
  channelId: string | null;
  inviteId: string | null;
  accepted: boolean;
}

function AcceptSharedInviteRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as AcceptSharedInviteOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={connectTile()}
          title="Invite accepted"
          subtitle={parsed.channelId ? `#${shortId(parsed.channelId, 4, 3)}` : 'channel joined'}
          verb="enabled"
        />
      )}
    </SlackToolShell>
  );
}

interface DeclineSharedInviteOutput {
  inviteId: string;
  declined: boolean;
}

function DeclineSharedInviteRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as DeclineSharedInviteOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.red}
              icon={<XCircle size={14} color={globalColors.red} />}
              size={26}
            />
          }
          title="Invite declined"
          subtitle={shortId(parsed.inviteId, 4, 3)}
          verb="removed"
        />
      )}
    </SlackToolShell>
  );
}

interface ApproveSharedInviteOutput {
  inviteId: string;
  approved: boolean;
}

function ApproveSharedInviteRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as ApproveSharedInviteOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.green}
              icon={<CheckCircle2 size={14} color={globalColors.green} />}
              size={26}
            />
          }
          title="Invite approved"
          subtitle={shortId(parsed.inviteId, 4, 3)}
          verb="granted"
        />
      )}
    </SlackToolShell>
  );
}

interface RevokeAuthOutput {
  revoked: boolean;
  test: boolean;
}

function RevokeAuthRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const parsed = output ? (parseOutput(output) as RevokeAuthOutput | null) : null;
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <ResourceCard
          leading={
            <IconTile
              accent={globalColors.red}
              icon={<XCircle size={14} color={globalColors.red} />}
              size={26}
            />
          }
          title={parsed.test ? 'Token validated (not revoked)' : 'Token revoked'}
          verb={parsed.test ? undefined : 'revoked'}
          meta={parsed.test ? <Badge text="TEST" variant="gray" /> : null}
        />
      )}
    </SlackToolShell>
  );
}

interface CuratedAuthTeam {
  id: string;
  name: string;
  domain: string | null;
  iconUrl: string | null;
  enterpriseId: string | null;
}

interface ListAuthTeamsOutput {
  teams: CuratedAuthTeam[];
  count: number;
  nextCursor: string | null;
  hasMore: boolean;
}

function ListAuthTeamsRenderer({ toolName, status, output, error, duration }: ToolCallRendererProps) {
  const { scrollbarColor } = useSlackColors();
  const parsed = output ? (parseOutput(output) as ListAuthTeamsOutput | null) : null;
  const teams = parsed?.teams ?? [];
  return (
    <SlackToolShell toolName={toolName} status={status} duration={duration} defaultExpanded={teams.length > 0}>
      <ErrorWithHint error={error} toolName={toolName} />
      {!error && status === 'completed' && parsed && (
        <YStack gap={4}>
          <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
            {parsed.count} workspace{parsed.count === 1 ? '' : 's'}
          </Text>
          {teams.length === 0 ? (
            <Empty message="No workspaces." />
          ) : (
            <ScrollView style={scrollStyle(360, scrollbarColor)}>
              <YStack>
                {teams.map((t) => (
                  <EntityRow
                    key={t.id}
                    leading={<Avatar src={t.iconUrl ?? undefined} name={t.name} size={22} />}
                    title={t.name}
                    subtitle={t.domain ? `${t.domain}.slack.com` : undefined}
                    meta={
                      t.enterpriseId ? (
                        <IconChip text="ENTERPRISE" accent={SLACK_BRAND.green} />
                      ) : null
                    }
                  />
                ))}
              </YStack>
            </ScrollView>
          )}
          {parsed.hasMore && (
            <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
              + more available (use cursor to paginate)
            </Text>
          )}
        </YStack>
      )}
    </SlackToolShell>
  );
}

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  '-health-check': HealthCheckRenderer,
  // Channels
  'list-channels': ListChannelsRenderer,
  'get-channel': GetChannelRenderer,
  'create-channel': CreateChannelRenderer,
  'archive-channel': ArchiveChannelRenderer,
  'join-channel': JoinChannelRenderer,
  'invite-to-channel': InviteToChannelRenderer,
  'leave-channel': LeaveChannelRenderer,
  'list-channel-members': ListChannelMembersRenderer,
  'open-dm': OpenDmRenderer,
  'rename-channel': RenameChannelRenderer,
  'set-channel-purpose': SetChannelPurposeRenderer,
  'set-channel-topic': SetChannelTopicRenderer,
  'kick-from-channel': KickFromChannelRenderer,
  'unarchive-channel': UnarchiveChannelRenderer,
  'mark-channel-read': MarkChannelReadRenderer,
  // Messages
  'send-message': SendMessageRenderer,
  'send-thread-reply': SendThreadReplyRenderer,
  'list-messages': ListMessagesRenderer,
  'update-message': UpdateMessageRenderer,
  'delete-message': DeleteMessageRenderer,
  'get-permalink': GetPermalinkRenderer,
  'schedule-message': ScheduleMessageRenderer,
  'list-scheduled-messages': ListScheduledRenderer,
  'delete-scheduled-message': DeleteScheduledRenderer,
  'send-ephemeral': SendEphemeralRenderer,
  'send-me-message': SendMeMessageRenderer,
  'unfurl-link': UnfurlLinkRenderer,
  // Pins
  'pin-message': PinMessageRenderer,
  'unpin-message': UnpinMessageRenderer,
  'list-pins': ListPinsRenderer,
  // Bookmarks
  'add-bookmark': AddBookmarkRenderer,
  'remove-bookmark': RemoveBookmarkRenderer,
  'list-bookmarks': ListBookmarksRenderer,
  'edit-bookmark': EditBookmarkRenderer,
  // Reactions
  'add-reaction': AddReactionRenderer,
  'remove-reaction': RemoveReactionRenderer,
  'get-reactions': GetReactionsRenderer,
  'list-my-reactions': ListMyReactionsRenderer,
  // Users
  'list-users': ListUsersRenderer,
  'get-user': GetUserRenderer,
  'get-user-presence': GetUserPresenceRenderer,
  'get-user-profile': GetUserProfileRenderer,
  'update-user-profile': UpdateUserProfileRenderer,
  'list-user-channels': ListUserChannelsRenderer,
  'delete-user-photo': DeleteUserPhotoRenderer,
  'get-user-identity': GetUserIdentityRenderer,
  // Files
  'upload-file': UploadFileRenderer,
  'list-files': ListFilesRenderer,
  'get-file': GetFileRenderer,
  'delete-file': DeleteFileRenderer,
  'get-upload-url': GetUploadUrlRenderer,
  'complete-upload': CompleteUploadRenderer,
  'share-file-public': ShareFilePublicRenderer,
  'revoke-file-public': RevokeFilePublicRenderer,
  'list-remote-files': ListRemoteFilesRenderer,
  'add-remote-file': AddRemoteFileRenderer,
  'update-remote-file': UpdateRemoteFileRenderer,
  'remove-remote-file': RemoveRemoteFileRenderer,
  'share-remote-file': ShareRemoteFileRenderer,
  'get-remote-file': GetRemoteFileRenderer,
  // Search
  'search-messages': SearchMessagesRenderer,
  'search-files': SearchFilesRenderer,
  // Team
  'get-team-info': GetTeamInfoRenderer,
  'get-team-preferences': GetTeamPreferencesRenderer,
  'get-team-profile': GetTeamProfileRenderer,
  'get-access-logs': GetAccessLogsRenderer,
  'get-integration-logs': GetIntegrationLogsRenderer,
  // Stars
  'star-item': StarItemRenderer,
  'unstar-item': UnstarItemRenderer,
  'list-stars': ListStarsRenderer,
  // Emoji
  'list-emoji': ListEmojiRenderer,
  'add-emoji': AddEmojiRenderer,
  'remove-emoji': RemoveEmojiRenderer,
  // DND
  'set-dnd': SetDndRenderer,
  'end-dnd': EndDndRenderer,
  'get-dnd': GetDndRenderer,
  'get-team-dnd': GetTeamDndRenderer,
  // Lists (experimental)
  'create-list': CreateListRenderer,
  'update-list': UpdateListRenderer,
  'delete-list': DeleteListRenderer,
  'get-list': GetListRenderer,
  'list-list-items': ListListItemsRenderer,
  'create-list-item': CreateListItemRenderer,
  'update-list-item': UpdateListItemRenderer,
  'delete-list-item': DeleteListItemRenderer,
  'list-list-fields': ListListFieldsRenderer,
  'create-list-field': CreateListFieldRenderer,
  'update-list-field': UpdateListFieldRenderer,
  'delete-list-field': DeleteListFieldRenderer,
  // Canvas (experimental)
  'create-canvas': CreateCanvasRenderer,
  'edit-canvas': EditCanvasRenderer,
  'delete-canvas': DeleteCanvasRenderer,
  'create-channel-canvas': CreateChannelCanvasRenderer,
  // Streaming chat (experimental)
  'start-stream': StartStreamRenderer,
  'append-stream': AppendStreamRenderer,
  'stop-stream': StopStreamRenderer,
  // Calls (experimental)
  'add-call': AddCallRenderer,
  'end-call': EndCallRenderer,
  'update-call': UpdateCallRenderer,
  'get-call': GetCallRenderer,
  'add-call-participants': AddCallParticipantsRenderer,
  'remove-call-participants': RemoveCallParticipantsRenderer,
  // Slack Connect
  'list-connect-invites': ListConnectInvitesRenderer,
  'invite-shared': InviteSharedRenderer,
  'accept-shared-invite': AcceptSharedInviteRenderer,
  'decline-shared-invite': DeclineSharedInviteRenderer,
  'approve-shared-invite': ApproveSharedInviteRenderer,
  // Auth
  'revoke-auth': RevokeAuthRenderer,
  'list-auth-teams': ListAuthTeamsRenderer,
};

// ============================================================================
// FallbackRenderer — dev-only warning
// ============================================================================

function FallbackRenderer({ toolName, status, output, error }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName);

  const badge = __DEV__ ? (
    <Badge text="no renderer" variant="error" />
  ) : status === 'completed' ? (
    <Badge text="done" variant="success" />
  ) : status === 'failed' ? (
    <Badge text="failed" variant="error" />
  ) : null;

  return (
    <ToolCallCard
      status={toolStatusForPrimitive(status)}
      description={getToolLabel(toolName)}
      iconUri={SLACK_ICON}
      badge={badge}
      defaultExpanded={__DEV__}
    >
      {__DEV__ && (
        <YStack
          backgroundColor="rgba(239,68,68,0.12)"
          borderRadius={5}
          padding={8}
          borderWidth={1}
          borderColor="rgba(239,68,68,0.3)"
          gap={2}
        >
          <Text color={globalColors.badgeError.text} fontSize={10} fontWeight="600">
            [dev] Missing sub-renderer for "{shortName}"
          </Text>
          <Text color={globalColors.secondary} fontSize={9}>
            Register it in the RENDERERS map in SlackRenderer.tsx.
          </Text>
        </YStack>
      )}
      {output && <JsonPreview value={output} />}
      {error && <ErrorBlock error={error} />}
    </ToolCallCard>
  );
}

// ============================================================================
// Entry point
// ============================================================================

function SlackRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] ?? FallbackRenderer;
  return <Renderer {...props} />;
}

export const SlackToolCallRenderer = withPermissionSupport(SlackRendererBase);
export default SlackToolCallRenderer;
