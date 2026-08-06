/**
 * Conversations MCA - Custom Tool Call Renderer
 *
 * Ultra Compact design for Conversations tool calls.
 * Covers all 9 tools:
 *   - search-messages
 *   - list-channels
 *   - get-channel-messages
 *   - get-channel-summary
 *   - create-conversation
 *   - delegate-task
 *   - send-message
 *   - rename-channel
 *   - import-attachment
 */

import { ExternalLink, type McaStatusType, ToolCallCard, useColors } from '../primitives';
import { colors } from '../primitives/colors';
import type React from 'react';
import {   ScrollView } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { Text, XStack, YStack } from 'tamagui';
import { useTilingStore } from '../../../store/tilingStore';
import { useWorkspaceStore } from '../../../store/workspaceStore';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';

// ============================================================================
// Colors — Renderer UX Guide v2 §5.
// ============================================================================
// Hook that returns the Conversations renderer palette. Semantic brand
// hex (violet/green/red/amber) are theme-agnostic; surface tokens
// (text/bg/border/chevron) come from `useColors()` and switch on theme.

function useConversationsColors() {
  const c = useColors();
  return {
    // Brand — soft violet for "conversations" (theme-agnostic)
    brand: '#a78bfa',
    brandDim: 'rgba(167,139,250,0.15)',

    // Status dot (semantic theme-agnostic)
    success: '#22c55e',
    running: colors.indigo,
    failed: '#ef4444',

    glowSuccess: 'rgba(34,197,94,0.5)',
    glowRunning: 'rgba(94,106,210,0.5)',
    glowFailed: 'rgba(239,68,68,0.5)',

    // Badges (re-using the theme-adaptive badge palette from useColors())
    badgeViolet: { text: c.badges.info.text, bg: 'rgba(139,92,246,0.15)' },
    badgeBlue: c.badges.info,
    badgeGreen: c.badges.ok,
    badgeRed: c.badges.err,
    badgeGray: c.badges.gray,
    badgeAmber: c.badges.warn,

    // Text (theme-adaptive)
    primary: c.text2,
    secondary: c.text2,
    muted: c.text3,
    bright: c.text,

    // Backgrounds (theme-adaptive)
    bgInner: c.bgInner,
    bgInnerDark: c.bgInner,
    border: c.border,
    borderLight: c.borderStrong,
    chevron: c.text3,
  };
}

// ============================================================================
// Conversations Icon
// ============================================================================

function ConversationsIcon({ size = 16 }: { size?: number }) {
  // Brand color is semantic theme-agnostic — hardcoded so this stateless
  // SVG primitive doesn't need to subscribe to the theme via useColors().
  const brand = '#a78bfa';
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
        stroke={brand}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={8} cy={10} r={1} fill={brand} />
      <Circle cx={12} cy={10} r={1} fill={brand} />
      <Circle cx={16} cy={10} r={1} fill={brand} />
    </Svg>
  );
}

// ============================================================================
// Utilities
// ============================================================================

function getToolKey(toolName: string): string {
  // Tool names arrive as "{appInstanceName}_{tool-name}" (e.g. "conversations_delegate-task")
  // The separator is the FIRST underscore — same pattern as GmailRenderer.
  const idx = toolName.indexOf('_');
  return idx >= 0 ? toolName.slice(idx + 1) : toolName;
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function parseOutput(output?: string): any {
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch {
    return { text: output };
  }
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

function shortChannelId(id: string): string {
  // "ch_abc123def456" → "ch_abc1…"
  if (id.length <= 12) return id;
  return id.slice(0, 10) + '…';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================================================
// Shared primitives
// ============================================================================


type BadgeVariant = 'violet' | 'blue' | 'green' | 'red' | 'gray' | 'amber';

function Badge({ text, variant }: { text: string; variant: BadgeVariant }) {
  const c = useColors();
  const colors = useConversationsColors();
  const map: Record<BadgeVariant, { text: string; bg: string }> = {
    violet: colors.badgeViolet,
    blue: colors.badgeBlue,
    green: colors.badgeGreen,
    red: colors.badgeRed,
    gray: c.badges.gray,
    amber: colors.badgeAmber,
  };
  const { text: tc, bg } = map[variant];
  return (
    <XStack backgroundColor={bg} paddingHorizontal={5} paddingVertical={1} borderRadius={3}>
      <Text color={tc} fontSize={9} fontFamily="$mono">
        {text}
      </Text>
    </XStack>
  );
}





function InfoRow({ label, value }: { label: string; value: string }) {
  const c = useColors();
  const colors = useConversationsColors();
  return (
    <XStack gap={8} alignItems="flex-start">
      <Text color={c.text3} fontSize={9} width={70} flexShrink={0}>
        {label}
      </Text>
      <Text color={c.text2} fontSize={10} flex={1}>
        {value}
      </Text>
    </XStack>
  );
}

function ErrorBox({ error }: { error?: string }) {
  const colors = useConversationsColors();
  return (
    <YStack backgroundColor={colors.badgeRed.bg} borderRadius={5} padding={8}>
      <Text color={colors.badgeRed.text} fontSize={10}>
        {error || 'Failed'}
      </Text>
    </YStack>
  );
}

function SkeletonLines() {
  const c = useColors();
  const colors = useConversationsColors();
  return (
    <YStack backgroundColor={c.bgInner} borderRadius={5} padding={10} gap={6}>
      {[100, 90, 75].map((w, i) => (
        <YStack
          key={i}
          backgroundColor={c.border}
          height={9}
          width={`${w}%`}
          borderRadius={4}
        />
      ))}
    </YStack>
  );
}

// ============================================================================
// Sub-renderer props
// ============================================================================

// `expanded`/`onToggle` no longer threaded — ToolCallCard owns its state.
type SubProps = ToolCallRendererProps;

// ============================================================================
// search-messages
// ============================================================================

function SearchMessagesRenderer({ input, status, output, error, duration, appIcon }: SubProps) {
  const c = useColors();
  const colors = useConversationsColors();
  const query = (input?.query as string) || '';
  const parsed = parseOutput(output);
  const totalMatches: number = parsed?.totalMatches ?? 0;
  const results: any[] = parsed?.results ?? [];

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as BadgeVariant }
      : status === 'completed'
        ? { text: `${totalMatches} match${totalMatches !== 1 ? 'es' : ''}`, variant: 'violet' as BadgeVariant }
        : undefined;

  const header = { status, description: `Search: "${truncate(query, 35)}"`, duration, badge, appIcon };
  return (
    <ToolShell {...header}>
        <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8}>
          <Text color={c.text3} fontSize={9} marginBottom={3}>Query</Text>
          <Text color={c.text} fontSize={11} fontFamily="$mono">{query}</Text>
        </YStack>

        {status === 'running' && <SkeletonLines />}
        {status === 'failed' && <ErrorBox error={error} />}
        {status === 'completed' && results.length > 0 && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} overflow="hidden">
            <XStack padding={6} paddingHorizontal={10} borderBottomWidth={1} borderBottomColor={c.border} alignItems="center" gap={6}>
              <Text color={c.text3} fontSize={9} textTransform="uppercase" letterSpacing={0.3}>Results</Text>
              <Badge text={`${totalMatches}`} variant="violet" />
            </XStack>
            {results.map((r: any, i: number) => (
              <XStack
                key={i}
                padding={6}
                paddingHorizontal={10}
                borderBottomWidth={i < results.length - 1 ? 1 : 0}
                borderBottomColor={c.border}
                gap={8}
                alignItems="flex-start"
              >
                <Text color={colors.brand} fontSize={9} width={60} flexShrink={0}>{r.agentName || r.channelId}</Text>
                <Text color={c.text2} fontSize={10} flex={1}>
                  {r.matches?.[0]?.snippet ?? r.channelName}
                </Text>
                <Badge text={`${r.matches?.length ?? 0}`} variant="gray" />
              </XStack>
            ))}
          </YStack>
        )}
        {status === 'completed' && results.length === 0 && (
          <XStack backgroundColor={c.bgInner} borderRadius={5} padding={8} justifyContent="center">
            <Text color={c.text3} fontSize={10}>No matches found</Text>
          </XStack>
        )}
      </ToolShell>
  );
}

// ============================================================================
// list-channels
// ============================================================================

function ListChannelsRenderer({ input, status, output, error, duration, appIcon }: SubProps) {
  const c = useColors();
  const colors = useConversationsColors();
  const parsed = parseOutput(output);
  const channels: any[] = parsed?.channels ?? [];
  const total: number = parsed?.total ?? channels.length;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as BadgeVariant }
      : status === 'completed'
        ? { text: `${total} conv${total !== 1 ? 's' : ''}`, variant: 'violet' as BadgeVariant }
        : undefined;

  const header = { status, description: 'List conversations', duration, badge, appIcon };
  return (
    <ToolShell {...header}>
        {status === 'running' && <SkeletonLines />}
        {status === 'failed' && <ErrorBox error={error} />}
        {status === 'completed' && channels.length > 0 && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} overflow="hidden">
            <XStack padding={6} paddingHorizontal={10} borderBottomWidth={1} borderBottomColor={c.border} alignItems="center" gap={6}>
              <Text color={c.text3} fontSize={9} textTransform="uppercase" letterSpacing={0.3}>Conversations</Text>
              <Badge text={`${total}`} variant="violet" />
            </XStack>
            {channels.map((ch: any, i: number) => (
              <XStack
                key={i}
                padding={6}
                paddingHorizontal={10}
                borderBottomWidth={i < channels.length - 1 ? 1 : 0}
                borderBottomColor={c.border}
                gap={8}
                alignItems="flex-start"
              >
                <YStack flex={1} gap={1}>
                  <Text color={c.text} fontSize={10} fontWeight="500">
                    {ch.name || shortChannelId(ch.channelId)}
                  </Text>
                  {ch.lastMessage?.content && (
                    <Text color={c.text3} fontSize={9}>
                      {ch.lastMessage.content}
                    </Text>
                  )}
                </YStack>
                <Badge text={ch.status || 'active'} variant={ch.status === 'closed' ? 'gray' : 'violet'} />
              </XStack>
            ))}
          </YStack>
        )}
        {status === 'completed' && channels.length === 0 && (
          <XStack backgroundColor={c.bgInner} borderRadius={5} padding={8} justifyContent="center">
            <Text color={c.text3} fontSize={10}>No conversations found</Text>
          </XStack>
        )}
      </ToolShell>
  );
}

// ============================================================================
// get-channel-messages
// ============================================================================

function GetChannelMessagesRenderer({ input, status, output, error, duration, appIcon }: SubProps) {
  const c = useColors();
  const colors = useConversationsColors();
  const channelId = (input?.channelId as string) || '';
  const parsed = parseOutput(output);
  const messages: any[] = parsed?.messages ?? [];
  const channelName: string = parsed?.channel?.name || shortChannelId(channelId);
  const hasMore: boolean = parsed?.hasMore ?? false;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as BadgeVariant }
      : status === 'completed'
        ? { text: `${messages.length} msg${messages.length !== 1 ? 's' : ''}`, variant: 'violet' as BadgeVariant }
        : undefined;

  const header = {
    status,
    description: `Messages: ${truncate(channelName, 30)}`,
    duration,
    badge,
    appIcon,  };
  return (
    <ToolShell {...header}>
        <InfoRow label="Channel" value={channelName} />
        {status === 'running' && <SkeletonLines />}
        {status === 'failed' && <ErrorBox error={error} />}
        {status === 'completed' && messages.length > 0 && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} overflow="hidden">
            <XStack padding={6} paddingHorizontal={10} borderBottomWidth={1} borderBottomColor={c.border} alignItems="center" gap={6}>
              <Text color={c.text3} fontSize={9} textTransform="uppercase" letterSpacing={0.3}>Messages</Text>
              {hasMore && <Badge text="more" variant="gray" />}
            </XStack>
            <ScrollView style={{ maxHeight: 200 }}>
              {messages.slice(0, 6).map((m: any, i: number) => (
                <XStack
                  key={i}
                  padding={6}
                  paddingHorizontal={10}
                  borderBottomWidth={i < Math.min(messages.length, 6) - 1 ? 1 : 0}
                  borderBottomColor={c.border}
                  gap={8}
                  alignItems="flex-start"
                >
                  <Text
                    color={m.role === 'user' ? colors.badgeBlue.text : colors.brand}
                    fontSize={9}
                    width={50}
                    flexShrink={0}
                  >
                    {m.role}
                  </Text>
                  <Text color={c.text2} fontSize={10} flex={1} numberOfLines={2}>
                    {truncate(
                      typeof m.content === 'string'
                        ? m.content
                        : m.content?.text || JSON.stringify(m.content),
                      80,
                    )}
                  </Text>
                </XStack>
              ))}
            </ScrollView>
          </YStack>
        )}
      </ToolShell>
  );
}

// ============================================================================
// get-channel-summary
// ============================================================================

function GetChannelSummaryRenderer({ input, status, output, error, duration, appIcon }: SubProps) {
  const c = useColors();
  const colors = useConversationsColors();
  const channelId = (input?.channelId as string) || '';
  const parsed = parseOutput(output);
  const name: string = parsed?.name || shortChannelId(channelId);
  const msgCount: number = parsed?.messageCount ?? 0;
  const lastMsg: string = parsed?.lastMessage?.content || '';

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as BadgeVariant }
      : status === 'completed'
        ? { text: `${msgCount} msg${msgCount !== 1 ? 's' : ''}`, variant: 'violet' as BadgeVariant }
        : undefined;

  const header = { status, description: `Summary: ${truncate(name, 30)}`, duration, badge, appIcon };
  return (
    <ToolShell {...header}>
        {status === 'running' && <SkeletonLines />}
        {status === 'failed' && <ErrorBox error={error} />}
        {status === 'completed' && parsed && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={5}>
            <InfoRow label="Name" value={name} />
            <InfoRow label="Messages" value={String(msgCount)} />
            {parsed.agentId && <InfoRow label="Agent" value={parsed.agentId} />}
            {lastMsg && <InfoRow label="Last msg" value={truncate(lastMsg, 80)} />}
          </YStack>
        )}
      </ToolShell>
  );
}

// ============================================================================
// create-conversation
// ============================================================================

function CreateConversationRenderer({ input, status, output, error, duration, appIcon }: SubProps) {
  const c = useColors();
  const colors = useConversationsColors();
  const agentId = (input?.agentId as string) || '';
  const name = (input?.name as string) || '';
  const parsed = parseOutput(output);
  const channelId: string = parsed?.channelId || '';

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as BadgeVariant }
      : status === 'completed'
        ? { text: 'created', variant: 'green' as BadgeVariant }
        : { text: 'creating…', variant: 'gray' as BadgeVariant };

  const header = {
    status,
    description: name ? `New conv: ${truncate(name, 35)}` : 'New conversation',
    duration,
    badge,
    appIcon,  };
  return (
    <ToolShell {...header}>
        {status === 'running' && <SkeletonLines />}
        {status === 'failed' && <ErrorBox error={error} />}
        {status === 'completed' && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={5}>
            {name && <InfoRow label="Name" value={name} />}
            {agentId && <InfoRow label="Agent" value={agentId} />}
            {channelId && <InfoRow label="Channel" value={shortChannelId(channelId)} />}
          </YStack>
        )}
      </ToolShell>
  );
}

// ============================================================================
// delegate-task
// ============================================================================

function DelegateTaskRenderer({ input, status, output, error, duration, appIcon }: SubProps) {
  const c = useColors();
  const colors = useConversationsColors();
  const prompt = (input?.prompt as string) || '';
  const taskName = (input?.taskName as string) || '';
  const agentId = (input?.agentId as string) || '';
  const parsed = parseOutput(output);
  const channelId: string = parsed?.channelId || '';

  const openWindow = useTilingStore((s) => s.openWindow);

  const handleOpenSubConversation = () => {
    if (!channelId) return;
    openWindow('chat', { channelId, agentId: agentId || undefined }, true);
  };

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as BadgeVariant }
      : status === 'completed'
        ? { text: 'delegated', variant: 'amber' as BadgeVariant }
        : { text: 'delegating…', variant: 'gray' as BadgeVariant };

  const header = {
    status,
    description: taskName ? `Delegate: ${truncate(taskName, 32)}` : `Delegate: ${truncate(prompt, 32)}`,
    duration,
    badge,
    appIcon,  };
  return (
    <ToolShell {...header}>
        {status === 'running' && <SkeletonLines />}
        {status === 'failed' && <ErrorBox error={error} />}
        {status === 'completed' && (
          <>
            <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={5}>
              {taskName && <InfoRow label="Task" value={taskName} />}
              {agentId && <InfoRow label="Agent" value={agentId} />}
              {channelId && <InfoRow label="Channel" value={shortChannelId(channelId)} />}
            </YStack>
            {prompt && (
              <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8}>
                <Text color={c.text3} fontSize={9} marginBottom={4}>Prompt</Text>
                <Text color={c.text2} fontSize={10} numberOfLines={4} lineHeight={15}>
                  {truncate(prompt, 200)}
                </Text>
              </YStack>
            )}
            {channelId && (
              <XStack
                backgroundColor={colors.brandDim}
                borderRadius={5}
                paddingVertical={6}
                paddingHorizontal={10}
                alignItems="center"
                gap={6}
                onPress={handleOpenSubConversation}
                cursor="pointer"
                pressStyle={{ opacity: 0.7 }}
                hoverStyle={{ backgroundColor: 'rgba(167,139,250,0.22)' }}
              >
                <ExternalLink size={11} color={colors.brand} />
                <Text color={colors.brand} fontSize={10} fontWeight="500" flex={1}>
                  {taskName ? truncate(taskName, 40) : 'Open sub-conversation'}
                </Text>
                <Text color={c.text3} fontSize={9} fontFamily="$mono">
                  {shortChannelId(channelId)}
                </Text>
              </XStack>
            )}
          </>
        )}
      </ToolShell>
  );
}

// ============================================================================
// send-message
// ============================================================================

function SendMessageRenderer({ input, status, output, error, duration, appIcon }: SubProps) {
  const c = useColors();
  const colors = useConversationsColors();
  const channelId = (input?.channelId as string) || '';
  const message = (input?.message as string) || '';
  const parsed = parseOutput(output);
  const success: boolean = parsed?.success ?? false;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as BadgeVariant }
      : status === 'completed' && success
        ? { text: 'sent', variant: 'green' as BadgeVariant }
        : status === 'completed'
          ? { text: 'error', variant: 'red' as BadgeVariant }
          : undefined;

  const header = {
    status,
    description: `Send: ${truncate(message, 40)}`,
    duration,
    badge,
    appIcon,  };
  return (
    <ToolShell {...header}>
        <InfoRow label="Channel" value={shortChannelId(channelId)} />
        {status === 'running' && <SkeletonLines />}
        {status === 'failed' && <ErrorBox error={error} />}
        {status === 'completed' && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8}>
            <Text color={c.text3} fontSize={9} marginBottom={4}>Message</Text>
            <Text color={c.text2} fontSize={10} numberOfLines={4} lineHeight={15}>
              {truncate(message, 200)}
            </Text>
          </YStack>
        )}
      </ToolShell>
  );
}

// ============================================================================
// rename-channel
// ============================================================================

function RenameChannelRenderer({ input, status, output, error, duration, appIcon }: SubProps) {
  const c = useColors();
  const colors = useConversationsColors();
  const channelId = (input?.channelId as string) || '';
  const name = (input?.name as string) || '';
  const parsed = parseOutput(output);
  const success: boolean = parsed?.success ?? false;

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as BadgeVariant }
      : status === 'completed' && success
        ? { text: 'renamed', variant: 'green' as BadgeVariant }
        : status === 'completed'
          ? { text: 'error', variant: 'red' as BadgeVariant }
          : undefined;

  const header = {
    status,
    description: name ? `Rename → "${truncate(name, 35)}"` : 'Rename conversation',
    duration,
    badge,
    appIcon,  };
  return (
    <ToolShell {...header}>
        {status === 'running' && <SkeletonLines />}
        {status === 'failed' && <ErrorBox error={error} />}
        {status === 'completed' && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={5}>
            <InfoRow label="Channel" value={shortChannelId(channelId)} />
            <InfoRow label="New name" value={name} />
          </YStack>
        )}
      </ToolShell>
  );
}

// ============================================================================
// import-attachment
// ============================================================================

function ImportAttachmentRenderer({ input, status, output, error, duration, appIcon }: SubProps) {
  const c = useColors();
  const colors = useConversationsColors();
  const filename = (input?.filename as string) || '';
  const destPath = (input?.destPath as string) || '';
  const parsed = parseOutput(output);
  const success: boolean = parsed?.success ?? false;
  const workspacePath: string = parsed?.workspacePath || '';
  const size: number | null = typeof parsed?.size === 'number' ? parsed.size : null;
  const mime: string = parsed?.mime || '';

  const badge =
    status === 'failed'
      ? { text: 'failed', variant: 'red' as BadgeVariant }
      : status === 'completed' && success
        ? { text: 'imported', variant: 'green' as BadgeVariant }
        : status === 'completed'
          ? { text: 'error', variant: 'red' as BadgeVariant }
          : { text: 'importing…', variant: 'gray' as BadgeVariant };

  const header = {
    status,
    description: `Import to workspace: ${truncate(filename, 32)}`,
    duration,
    badge,
    appIcon,
  };
  return (
    <ToolShell {...header}>
      <InfoRow label="File" value={filename} />
      {destPath ? <InfoRow label="Dest" value={destPath} /> : null}
      {status === 'running' && <SkeletonLines />}
      {status === 'failed' && <ErrorBox error={error} />}
      {status === 'completed' && success && (
        <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={5}>
          <InfoRow label="Saved to" value={workspacePath || filename} />
          {mime ? <InfoRow label="Type" value={mime} /> : null}
          {size != null ? <InfoRow label="Size" value={formatBytes(size)} /> : null}
        </YStack>
      )}
    </ToolShell>
  );
}

// ============================================================================
// Main Renderer
// ============================================================================

function ConversationsRendererBase(props: ToolCallRendererProps) {
  const { appIcon } = props;
  const toolKey = getToolKey(props.toolName);
  const subProps: SubProps = { ...props };

  switch (toolKey) {
    case 'search-messages':
      return <SearchMessagesRenderer {...subProps} />;
    case 'list-channels':
      return <ListChannelsRenderer {...subProps} />;
    case 'get-channel-messages':
      return <GetChannelMessagesRenderer {...subProps} />;
    case 'get-channel-summary':
      return <GetChannelSummaryRenderer {...subProps} />;
    case 'create-conversation':
      return <CreateConversationRenderer {...subProps} />;
    case 'delegate-task':
      return <DelegateTaskRenderer {...subProps} />;
    case 'send-message':
      return <SendMessageRenderer {...subProps} />;
    case 'rename-channel':
      return <RenameChannelRenderer {...subProps} />;
    case 'import-attachment':
      return <ImportAttachmentRenderer {...subProps} />;
    default:
      return null;
  }
}


// ============================================================================
// ToolShell — compose-only adapter over <ToolCallCard>
// ============================================================================
//
// Sub-renderers feed `headerProps` from their existing computation; this
// shell hands status/description/badge to the canonical primitive. The
// `duration`/`expanded`/`onToggle` keys are silently ignored (the primitive
// owns its own state).

interface ToolShellHeaderProps {
  status: McaStatusType;
  description: string;
  duration?: number;
  badge?: { text: string; variant: BadgeVariant };
  expanded?: boolean;
  onToggle?: () => void;
  isInContainer?: boolean;
  irreversible?: boolean;
  appIcon?: string;
}

function ToolShell({
  status,
  description,
  badge,
  irreversible,
  appIcon,
  children,
}: ToolShellHeaderProps & { children?: React.ReactNode }) {
  return (
    <ToolCallCard
      status={status}
      description={description}
      iconUri={appIcon}
      badge={badge ? <Badge text={badge.text} variant={badge.variant} /> : null}
      irreversible={irreversible}
    >
      {children}
    </ToolCallCard>
  );
}

export const ConversationsToolCallRenderer = withPermissionSupport(ConversationsRendererBase);
export default ConversationsToolCallRenderer;
