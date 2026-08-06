/**
 * Notion Renderer - Users & Comments Operations
 *
 * Handles: list-users, get-user, get-me, list-comments, create-comment,
 * update-comment, delete-comment
 */

import { Bot, User } from '../../primitives';
import { ErrorBlock, SuccessBlock, ToolCallCard } from '../../primitives';
import type React from 'react';
import { useState } from 'react';
import { ScrollView } from 'react-native';
import { Image, Text, XStack, YStack } from 'tamagui';

import { countBadgeVariant, Empty, formatCountBadge } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  colors,
  ExpandedBody,
  ExpandedContainer,
  formatDate,
  HeaderRow,
  type NotionComment,
  type NotionUser,
  parseOutput,
  truncate,
  useNotionColors,
} from './shared';

// ============================================================================
// Content Blocks
// ============================================================================

interface UserListBlockProps {
  users: NotionUser[];
}

function UserListBlock({ users }: UserListBlockProps) {
  const c = useNotionColors();
  const colors = useNotionColors();
  return (
    <ScrollView
      style={{ maxHeight: 250, backgroundColor: c.bgInner, borderRadius: 5 }}
      showsVerticalScrollIndicator={true}
    >
      <YStack paddingVertical={4}>
        {users.map((user) => (
          <XStack
            key={user.id}
            alignItems="center"
            gap={10}
            paddingVertical={6}
            paddingHorizontal={10}
            borderBottomWidth={1}
            borderBottomColor={c.border}
          >
            {user.avatarUrl ? (
              <Image
                source={{ uri: user.avatarUrl }}
                width={20}
                height={20}
                borderRadius={10}
              />
            ) : user.type === 'bot' ? (
              <XStack
                width={20}
                height={20}
                borderRadius={10}
                backgroundColor={c.badges.info.bg}
                alignItems="center"
                justifyContent="center"
              >
                <Bot size={12} color={c.badges.info.text} />
              </XStack>
            ) : (
              <XStack
                width={20}
                height={20}
                borderRadius={10}
                backgroundColor={c.badges.gray.bg}
                alignItems="center"
                justifyContent="center"
              >
                <User size={12} color={c.badges.gray.text} />
              </XStack>
            )}
            <Text flex={1} color={c.text} fontSize={11}>
              {user.name || 'Unknown'}
            </Text>
            <XStack
              backgroundColor={user.type === 'bot' ? c.badges.info.bg : c.badges.gray.bg}
              paddingHorizontal={5}
              paddingVertical={1}
              borderRadius={3}
            >
              <Text 
                fontSize={8} 
                color={user.type === 'bot' ? c.badges.info.text : c.badges.gray.text}
              >
                {user.type || 'person'}
              </Text>
            </XStack>
          </XStack>
        ))}
      </YStack>
    </ScrollView>
  );
}

interface UserDetailBlockProps {
  user: NotionUser;
}

function UserDetailBlock({ user }: UserDetailBlockProps) {
  const c = useNotionColors();
  const colors = useNotionColors();
  return (
    <YStack
      backgroundColor={c.bgInner}
      borderRadius={5}
      paddingVertical={10}
      paddingHorizontal={12}
      gap={8}
    >
      <XStack alignItems="center" gap={12}>
        {user.avatarUrl ? (
          <Image
            source={{ uri: user.avatarUrl }}
            width={32}
            height={32}
            borderRadius={16}
          />
        ) : user.type === 'bot' ? (
          <XStack
            width={32}
            height={32}
            borderRadius={16}
            backgroundColor={c.badges.info.bg}
            alignItems="center"
            justifyContent="center"
          >
            <Bot size={18} color={c.badges.info.text} />
          </XStack>
        ) : (
          <XStack
            width={32}
            height={32}
            borderRadius={16}
            backgroundColor={c.badges.gray.bg}
            alignItems="center"
            justifyContent="center"
          >
            <User size={18} color={c.badges.gray.text} />
          </XStack>
        )}
        <YStack flex={1}>
          <Text color={c.text} fontSize={12} fontWeight="500">
            {user.name || 'Unknown'}
          </Text>
          <Text color={c.text3} fontSize={9}>
            {user.type === 'bot' ? 'Bot' : 'Person'}
          </Text>
        </YStack>
      </XStack>
      <Text color={c.text3} fontSize={9} fontFamily="$mono">
        ID: {user.id}
      </Text>
    </YStack>
  );
}

interface CommentListBlockProps {
  comments: NotionComment[];
}

function CommentListBlock({ comments }: CommentListBlockProps) {
  const c = useNotionColors();
  const colors = useNotionColors();
  return (
    <ScrollView
      style={{ maxHeight: 250, backgroundColor: c.bgInner, borderRadius: 5 }}
      showsVerticalScrollIndicator={true}
    >
      <YStack paddingVertical={4}>
        {comments.map((comment) => {
          // New curated shape (TER-272): plainText + authorId.
          // Legacy shape: text + createdBy.name.
          const body = comment.plainText ?? comment.text ?? '';
          const authorLabel =
            comment.createdBy?.name ??
            (comment.authorId ? `user ${comment.authorId.slice(0, 8)}` : 'Unknown');
          return (
            <YStack
              key={comment.id}
              paddingVertical={8}
              paddingHorizontal={10}
              borderBottomWidth={1}
              borderBottomColor={c.border}
              gap={4}
            >
              <XStack alignItems="center" gap={8}>
                <Text color={c.text2} fontSize={10} fontWeight="500">
                  {authorLabel}
                </Text>
                {comment.createdTime && (
                  <Text color={c.text3} fontSize={9}>
                    {formatDate(comment.createdTime)}
                  </Text>
                )}
              </XStack>
              <Text color={c.text} fontSize={10}>
                {body || '(No content)'}
              </Text>
            </YStack>
          );
        })}
      </YStack>
    </ScrollView>
  );
}

// ============================================================================
// Renderers
// ============================================================================

export function ListUsersRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useNotionColors();

  const parsed = output
    ? parseOutput<{ results?: NotionUser[]; users?: NotionUser[] } | NotionUser[]>(output)
    : null;

  let users: NotionUser[] | null = null;
  if (parsed && typeof parsed === 'object') {
    if ('results' in parsed && Array.isArray(parsed.results)) {
      users = parsed.results;
    } else if ('users' in parsed && Array.isArray(parsed.users)) {
      users = parsed.users;
    } else if (Array.isArray(parsed)) {
      users = parsed;
    }
  }

  const hasUsers = users && users.length > 0;

  const description = 'List users';

  let badge: React.ReactNode = null;
  if (status === 'completed' && hasUsers) {
    badge = (
      <Badge
        text={formatCountBadge(users!.length, 'user')}
        variant={countBadgeVariant(users!.length)}
      />
    );
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        {hasUsers && <UserListBlock users={users!} />}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function GetUserRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useNotionColors();

  const parsed = output ? parseOutput<NotionUser>(output) : null;
  const isUser = parsed && typeof parsed === 'object' && 'id' in parsed;

  const description = 'Get user';

  let badge: React.ReactNode = null;
  if (status === 'completed' && isUser) {
    const user = parsed as NotionUser;
    badge = <Badge text={truncate(user.name || 'Unknown', 15)} variant="info" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        {isUser && <UserDetailBlock user={parsed as NotionUser} />}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function GetMeRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useNotionColors();

  const parsed = output ? parseOutput<NotionUser>(output) : null;
  const isUser = parsed && typeof parsed === 'object' && ('id' in parsed || 'bot' in parsed);

  const description = 'Get bot info';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="bot" variant="info" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        {isUser && <UserDetailBlock user={{ ...(parsed as any), type: 'bot' }} />}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function ListCommentsRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useNotionColors();

  const parsed = output
    ? parseOutput<{ results?: NotionComment[]; comments?: NotionComment[] } | NotionComment[]>(output)
    : null;

  let comments: NotionComment[] | null = null;
  if (parsed && typeof parsed === 'object') {
    if ('results' in parsed && Array.isArray(parsed.results)) {
      comments = parsed.results;
    } else if ('comments' in parsed && Array.isArray(parsed.comments)) {
      comments = parsed.comments;
    } else if (Array.isArray(parsed)) {
      comments = parsed;
    }
  }

  const hasComments = comments && comments.length > 0;

  const description = 'List comments';

  let badge: React.ReactNode = null;
  if (status === 'completed' && hasComments) {
    badge = (
      <Badge
        text={formatCountBadge(comments!.length, 'comment')}
        variant={countBadgeVariant(comments!.length)}
      />
    );
  } else if (status === 'completed' && comments?.length === 0) {
    badge = <Badge text="no comments" variant="gray" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        {hasComments && <CommentListBlock comments={comments!} />}
        {status === 'completed' && comments?.length === 0 && (
          <Empty message="No comments yet" />
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function CreateCommentRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useNotionColors();
  const colors = useNotionColors();

  const description = input?.text
    ? `Comment: ${truncate(input.text, 25)}`
    : 'Create comment';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="posted" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }



  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
        <SuccessBlock message="Comment posted successfully" />
        {input?.text && (
          <YStack
            backgroundColor={c.bgInner}
            borderRadius={5}
            paddingVertical={8}
            paddingHorizontal={10}
          >
            <Text color={c.text} fontSize={10}>
              "{input.text}"
            </Text>
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function UpdateCommentRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const c = useNotionColors();
  const [expanded, setExpanded] = useState(false);

  const previewText: string =
    typeof input?.text === 'string'
      ? input.text
      : Array.isArray(input?.richText)
        ? input.richText
            .map((seg: any) => seg?.text?.content ?? seg?.plain_text ?? '')
            .join('')
        : '';

  const description = previewText
    ? `Edit comment: ${truncate(previewText, 25)}`
    : 'Edit comment';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="updated" variant="info" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const headerProps = {
    status,
    description,
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        {previewText && (
          <YStack
            backgroundColor={c.bgInner}
            borderRadius={5}
            paddingVertical={8}
            paddingHorizontal={10}
          >
            <Text color={c.text3} fontSize={9} textTransform="uppercase" letterSpacing={0.5}>
              New body
            </Text>
            <Text color={c.text} fontSize={10}>
              {previewText}
            </Text>
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function DeleteCommentRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const commentId =
    typeof input?.commentId === 'string' ? truncate(input.commentId, 12) : 'comment';
  const description = `Delete ${commentId}`;

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="deleted" variant="error" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const headerProps = {
    status,
    description,
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <SuccessBlock message="Comment deleted." />
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}
