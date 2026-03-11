/**
 * Notion Renderer - Users & Comments Operations
 *
 * Handles: list-users, get-user, get-me, list-comments, create-comment
 */

import { Bot, User } from '@tamagui/lucide-icons';
import type React from 'react';
import { useState } from 'react';
import { ScrollView } from 'react-native';
import { Image, Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  colors,
  ErrorBlock,
  ExpandedBody,
  ExpandedContainer,
  formatDate,
  HeaderRow,
  type NotionComment,
  type NotionUser,
  parseOutput,
  SuccessBlock,
  truncate,
} from './shared';

// ============================================================================
// Content Blocks
// ============================================================================

interface UserListBlockProps {
  users: NotionUser[];
}

function UserListBlock({ users }: UserListBlockProps) {
  return (
    <ScrollView
      style={{ maxHeight: 250, backgroundColor: colors.bgInner, borderRadius: 5 }}
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
            borderBottomColor={colors.border}
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
                backgroundColor={colors.badgeInfo.bg}
                alignItems="center"
                justifyContent="center"
              >
                <Bot size={12} color={colors.badgeInfo.text} />
              </XStack>
            ) : (
              <XStack
                width={20}
                height={20}
                borderRadius={10}
                backgroundColor={colors.badgeGray.bg}
                alignItems="center"
                justifyContent="center"
              >
                <User size={12} color={colors.badgeGray.text} />
              </XStack>
            )}
            <Text flex={1} color={colors.primary} fontSize={11}>
              {user.name || 'Unknown'}
            </Text>
            <XStack
              backgroundColor={user.type === 'bot' ? colors.badgeInfo.bg : colors.badgeGray.bg}
              paddingHorizontal={5}
              paddingVertical={1}
              borderRadius={3}
            >
              <Text 
                fontSize={8} 
                color={user.type === 'bot' ? colors.badgeInfo.text : colors.badgeGray.text}
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
  return (
    <YStack
      backgroundColor={colors.bgInner}
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
            backgroundColor={colors.badgeInfo.bg}
            alignItems="center"
            justifyContent="center"
          >
            <Bot size={18} color={colors.badgeInfo.text} />
          </XStack>
        ) : (
          <XStack
            width={32}
            height={32}
            borderRadius={16}
            backgroundColor={colors.badgeGray.bg}
            alignItems="center"
            justifyContent="center"
          >
            <User size={18} color={colors.badgeGray.text} />
          </XStack>
        )}
        <YStack flex={1}>
          <Text color={colors.bright} fontSize={12} fontWeight="500">
            {user.name || 'Unknown'}
          </Text>
          <Text color={colors.muted} fontSize={9}>
            {user.type === 'bot' ? 'Bot' : 'Person'}
          </Text>
        </YStack>
      </XStack>
      <Text color={colors.muted} fontSize={9} fontFamily="$mono">
        ID: {user.id}
      </Text>
    </YStack>
  );
}

interface CommentListBlockProps {
  comments: NotionComment[];
}

function CommentListBlock({ comments }: CommentListBlockProps) {
  return (
    <ScrollView
      style={{ maxHeight: 250, backgroundColor: colors.bgInner, borderRadius: 5 }}
      showsVerticalScrollIndicator={true}
    >
      <YStack paddingVertical={4}>
        {comments.map((comment) => (
          <YStack
            key={comment.id}
            paddingVertical={8}
            paddingHorizontal={10}
            borderBottomWidth={1}
            borderBottomColor={colors.border}
            gap={4}
          >
            <XStack alignItems="center" gap={8}>
              <Text color={colors.secondary} fontSize={10} fontWeight="500">
                {comment.createdBy?.name || 'Unknown'}
              </Text>
              {comment.createdTime && (
                <Text color={colors.muted} fontSize={9}>
                  {formatDate(comment.createdTime)}
                </Text>
              )}
            </XStack>
            <Text color={colors.primary} fontSize={10}>
              {comment.text || '(No content)'}
            </Text>
          </YStack>
        ))}
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
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  
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
    badge = <Badge text={`${users!.length} users`} variant="gray" />;
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
        {hasUsers && <UserListBlock users={users!} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function GetUserRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
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
        {isUser && <UserDetailBlock user={parsed as NotionUser} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function GetMeRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<NotionUser>(output) : null;
  const isUser = parsed && typeof parsed === 'object' && ('id' in parsed || 'bot' in parsed);

  const description = 'Get bot info';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="bot" variant="info" />;
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
        {isUser && <UserDetailBlock user={{ ...(parsed as any), type: 'bot' }} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function ListCommentsRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  
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
    badge = <Badge text={`${comments!.length} comments`} variant="gray" />;
  } else if (status === 'completed' && comments?.length === 0) {
    badge = <Badge text="no comments" variant="gray" />;
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
        {hasComments && <CommentListBlock comments={comments!} />}
        {status === 'completed' && comments?.length === 0 && (
          <XStack
            backgroundColor={colors.bgInner}
            borderRadius={5}
            paddingVertical={12}
            paddingHorizontal={10}
            justifyContent="center"
          >
            <Text color={colors.muted} fontSize={10}>
              No comments on this page
            </Text>
          </XStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function CreateCommentRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const description = input?.text 
    ? `Comment: ${truncate(input.text, 25)}`
    : 'Create comment';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="posted" variant="success" />;
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
        <SuccessBlock message="Comment posted successfully" />
        {input?.text && (
          <YStack
            backgroundColor={colors.bgInner}
            borderRadius={5}
            paddingVertical={8}
            paddingHorizontal={10}
          >
            <Text color={colors.primary} fontSize={10}>
              "{input.text}"
            </Text>
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}
